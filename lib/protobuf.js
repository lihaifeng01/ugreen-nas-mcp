/**
 * Minimal protobuf wire codec driven by a compact descriptor catalog.
 *
 * The catalog is generated from the UGOS application binaries; it contains
 * message fields, enum value names and service method signatures. This module
 * deliberately implements only the protobuf features the UGREEN OpenCLI
 * read-only methods use: varints, fixed32/64, length-delimited strings/bytes,
 * nested messages, enums, repeated fields and map entries.
 */

const WIRE = {
  DOUBLE: 1, FLOAT: 5, INT64: 0, UINT64: 0, INT32: 0, FIXED64: 1, FIXED32: 5,
  BOOL: 0, STRING: 2, GROUP: 3, MESSAGE: 2, BYTES: 2, UINT32: 0, ENUM: 0,
  SFIXED32: 5, SFIXED64: 1, SINT32: 0, SINT64: 0,
}

const NUMERIC = new Set([
  'DOUBLE', 'FLOAT', 'INT64', 'UINT64', 'INT32', 'FIXED64', 'FIXED32', 'BOOL',
  'UINT32', 'ENUM', 'SFIXED32', 'SFIXED64', 'SINT32', 'SINT64',
])

const cleanType = (name) => String(name || '').replace(/^\.+/, '')

function writeVarint(value) {
  let v = BigInt(value)
  if (v < 0n) v = BigInt.asUintN(64, v)
  const bytes = []
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}

function zigzag(value, bits) {
  const v = BigInt(value)
  return BigInt.asUintN(bits, (v << 1n) ^ (v >> BigInt(bits - 1)))
}

class Reader {
  constructor(buffer) { this.buf = buffer; this.pos = 0 }
  get eof() { return this.pos >= this.buf.length }
  varint() {
    let result = 0n; let shift = 0n; let byte
    do {
      if (this.pos >= this.buf.length) throw new Error('protobuf: truncated varint')
      byte = this.buf[this.pos++]
      result |= BigInt(byte & 0x7f) << shift
      shift += 7n
      if (shift > 70n) throw new Error('protobuf: varint too long')
    } while (byte & 0x80)
    return result
  }
  bytes() {
    const len = Number(this.varint())
    if (len < 0 || this.pos + len > this.buf.length) throw new Error('protobuf: truncated bytes')
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }
  fixed32() {
    if (this.pos + 4 > this.buf.length) throw new Error('protobuf: truncated fixed32')
    const out = this.buf.readUInt32LE(this.pos); this.pos += 4; return out
  }
  fixed64() {
    if (this.pos + 8 > this.buf.length) throw new Error('protobuf: truncated fixed64')
    const out = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return out
  }
  skip(wireType) {
    if (wireType === 0) { this.varint(); return }
    if (wireType === 1) { this.pos += 8; return }
    if (wireType === 2) { this.bytes(); return }
    if (wireType === 5) { this.pos += 4; return }
    throw new Error('protobuf: unsupported wire type ' + wireType)
  }
}

function numberOrString(value) {
  const n = typeof value === 'bigint' ? value : BigInt(value)
  return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n.toString()
}

function enumNumber(catalog, typeName, value) {
  if (typeof value === 'number') return value
  const name = String(value ?? '')
  const values = catalog.enums?.[cleanType(typeName)] || []
  const idx = values.indexOf(name)
  if (idx >= 0) return idx
  const n = Number(name)
  return Number.isFinite(n) ? n : 0
}

function enumName(catalog, typeName, value) {
  const values = catalog.enums?.[cleanType(typeName)] || []
  return values[Number(value)] ?? Number(value)
}

function encodeScalar(catalog, type, typeName, value) {
  switch (type) {
    case 'STRING': return Buffer.from(String(value), 'utf8')
    case 'BYTES': return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'base64')
    case 'BOOL': return writeVarint(value ? 1 : 0)
    case 'ENUM': return writeVarint(enumNumber(catalog, typeName, value))
    case 'SINT32': return writeVarint(zigzag(Number(value), 32))
    case 'SINT64': return writeVarint(zigzag(BigInt(value), 64))
    case 'INT32': case 'INT64': case 'UINT32': case 'UINT64': return writeVarint(BigInt(value))
    case 'FIXED32': case 'SFIXED32': {
      const b = Buffer.alloc(4); b.writeUInt32LE(Number(value) >>> 0); return b
    }
    case 'FIXED64': case 'SFIXED64': {
      const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b
    }
    case 'FLOAT': {
      const b = Buffer.alloc(4); b.writeFloatLE(Number(value)); return b
    }
    case 'DOUBLE': {
      const b = Buffer.alloc(8); b.writeDoubleLE(Number(value)); return b
    }
    case 'MESSAGE': return encodeMessage(catalog, typeName, value)
    default: throw new Error('protobuf: unsupported field type ' + type)
  }
}

function fieldValue(obj, field) {
  if (!obj || typeof obj !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(obj, field.name)) return obj[field.name]
  if (field.jsonName && Object.prototype.hasOwnProperty.call(obj, field.jsonName)) return obj[field.jsonName]
  return undefined
}

function encodeField(catalog, field, value) {
  const type = field.type
  const target = catalog.messages?.[cleanType(field.typeName)]
  // Map 字段以普通对象传入；必须在数组守卫之前处理，否则整段被静默丢弃。
  if (field.repeated && type === 'MESSAGE' && target?.mapEntry && value && typeof value === 'object' && !Array.isArray(value)) {
    const parts = []
    for (const [key, val] of Object.entries(value)) {
      const entry = encodeMessage(catalog, field.typeName, { key, value: val })
      parts.push(writeVarint(field.number << 3 | 2), writeVarint(entry.length), entry)
    }
    return Buffer.concat(parts)
  }
  if (field.repeated) {
    if (!Array.isArray(value)) return Buffer.alloc(0)
    if (NUMERIC.has(type) && type !== 'STRING' && type !== 'BYTES' && type !== 'MESSAGE') {
      const payload = Buffer.concat(value.map((item) => encodeScalar(catalog, type, field.typeName, item)))
      return Buffer.concat([writeVarint(field.number << 3 | 2), writeVarint(payload.length), payload])
    }
    const parts = []
    for (const item of value) {
      const payload = encodeScalar(catalog, type, field.typeName, item)
      parts.push(writeVarint(field.number << 3 | (WIRE[type] ?? 2)), writeVarint(payload.length), payload)
    }
    return Buffer.concat(parts)
  }
  const payload = encodeScalar(catalog, type, field.typeName, value)
  if (type === 'MESSAGE' || type === 'STRING' || type === 'BYTES') {
    return Buffer.concat([writeVarint(field.number << 3 | 2), writeVarint(payload.length), payload])
  }
  return Buffer.concat([writeVarint(field.number << 3 | WIRE[type]), payload])
}

export function encodeMessage(catalog, typeName, value) {
  const schema = catalog.messages?.[cleanType(typeName)]
  if (!schema) return Buffer.alloc(0)
  const parts = []
  for (const field of schema.fields || []) {
    const v = fieldValue(value, field)
    if (v === undefined || v === null) continue
    if (field.repeated && Array.isArray(v) && v.length === 0) continue
    parts.push(encodeField(catalog, field, v))
  }
  return Buffer.concat(parts)
}

function decodeScalar(catalog, field, reader, wireType) {
  const type = field.type
  switch (type) {
    case 'STRING': return reader.bytes().toString('utf8')
    case 'BYTES': return reader.bytes().toString('base64')
    case 'BOOL': return Boolean(Number(reader.varint()))
    case 'ENUM': return enumName(catalog, field.typeName, reader.varint())
    case 'SINT32': {
      const n = reader.varint(); return Number((n >> 1n) ^ -(n & 1n))
    }
    case 'SINT64': {
      const n = reader.varint(); return numberOrString((n >> 1n) ^ -(n & 1n))
    }
    case 'INT32': return Number(BigInt.asIntN(32, reader.varint()))
    case 'UINT32': return Number(BigInt.asUintN(32, reader.varint()))
    case 'INT64': return numberOrString(BigInt.asIntN(64, reader.varint()))
    case 'UINT64': return numberOrString(BigInt.asUintN(64, reader.varint()))
    case 'FIXED32': return reader.fixed32()
    case 'SFIXED32': return reader.fixed32() | 0
    case 'FIXED64': return numberOrString(reader.fixed64())
    case 'SFIXED64': return numberOrString(BigInt.asIntN(64, reader.fixed64()))
    case 'FLOAT': {
      if (wireType !== 5) throw new Error('protobuf: bad float wire type')
      if (reader.pos + 4 > reader.buf.length) throw new Error('protobuf: truncated float')
      const v = reader.buf.readFloatLE(reader.pos); reader.pos += 4; return v
    }
    case 'DOUBLE': {
      if (wireType !== 1) throw new Error('protobuf: bad double wire type')
      if (reader.pos + 8 > reader.buf.length) throw new Error('protobuf: truncated double')
      const v = reader.buf.readDoubleLE(reader.pos); reader.pos += 8; return v
    }
    case 'MESSAGE': return decodeMessage(catalog, field.typeName, reader.bytes())
    default: throw new Error('protobuf: unsupported field type ' + type)
  }
}

export function decodeMessage(catalog, typeName, buffer) {
  const schema = catalog.messages?.[cleanType(typeName)]
  if (!schema) return {}
  const out = {}
  const reader = new Reader(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []))
  while (!reader.eof) {
    const tag = Number(reader.varint())
    const fieldNumber = Math.floor(tag / 8)
    const wireType = tag % 8
    const field = (schema.fields || []).find((f) => f.number === fieldNumber)
    if (!field) { reader.skip(wireType); continue }
    const target = catalog.messages?.[cleanType(field.typeName)]
    if (field.repeated && target?.mapEntry) {
      const entry = decodeMessage(catalog, field.typeName, reader.bytes())
      out[field.name] ||= {}
      out[field.name][String(entry.key ?? '')] = entry.value
      continue
    }
    if (field.repeated && NUMERIC.has(field.type) && wireType === 2) {
      const payload = reader.bytes()
      const sub = new Reader(payload)
      out[field.name] ||= []
      while (!sub.eof) out[field.name].push(decodeScalar(catalog, field, sub, WIRE[field.type]))
      continue
    }
    const value = decodeScalar(catalog, field, reader, wireType)
    if (field.repeated) { out[field.name] ||= []; out[field.name].push(value) }
    else out[field.name] = value
  }
  return out
}

export function methodSchema(catalog, serviceName, methodName) {
  const svc = catalog.services?.[serviceName]
  const method = svc?.methods?.[methodName]
  if (!method) throw new Error(`unknown OpenCLI method: ${serviceName}/${methodName}`)
  return {
    method,
    inputType: cleanType(method.input),
    outputType: cleanType(method.output),
  }
}
