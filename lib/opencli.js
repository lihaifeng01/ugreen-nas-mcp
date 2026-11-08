/**
 * UGREEN NAS OpenCLI HTTP client.
 *
 * The public OpenCLI endpoint is:
 *   {endpoint}/ugreen/opencli/v1/{socket_id}/{full_method}
 *
 * Where full_method is the gRPC method path without its leading slash, e.g.
 * app.App/GetAppStatus. The request body is raw protobuf (not JSON), and the
 * access token is accepted only in the Authorization header.
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { encodeMessage, decodeMessage, methodSchema } from './protobuf.js'

const USER_AGENT = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return `ugreen-nas-mcp/${pkg.version || '0.0.0'}`
  } catch { return 'ugreen-nas-mcp' }
})()

export class OpenCLIError extends Error {
  constructor(message, { code = 'opencli_error', status, requestId, cause } = {}) {
    super(message)
    this.name = 'OpenCLIError'
    this.code = code
    this.status = status
    this.requestId = requestId
    if (cause) this.cause = cause
  }
}

export function normalizeEndpoint(input) {
  let value = String(input || '').trim()
  if (!value) return ''
  if (value.startsWith('//')) value = value.slice(2)
  if (!/^https?:\/\//i.test(value)) {
    const isBareHost = /^[a-z0-9.-]+(:\d+)?$/i.test(value)
    if (!isBareHost) throw new OpenCLIError('NAS 地址格式不正确，支持 IP、UGREENlink ID、DDNS 或完整 URL', { code: 'bad_endpoint' })
    const hasPort = /:\d+$/.test(value)
    const isIp = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(value)
    // Device console listens on 9443; a bare LAN IP is the normal first setup.
    // UGREENlink/DDNS hostnames normally sit behind 443.
    value = isIp && !hasPort ? `https://${value}:9443` : `https://${value}`
  }
  return value.replace(/\/+$/, '')
}

export class OpenCLIClient {
  constructor({ endpoint, token, timeoutMs = 15000, rejectUnauthorized = false } = {}) {
    this.endpoint = normalizeEndpoint(endpoint)
    this.token = String(token || '').trim()
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000
    this.rejectUnauthorized = Boolean(rejectUnauthorized)
    /** 可选：实际连接的地址（如本机转发 127.0.0.1:19443），URL/Host 头保持原 NAS 地址 */
    this.connectTo = null
  }

  get configured() { return Boolean(this.endpoint && this.token) }

  async call({ socketId, service, method, request = {}, catalog }) {
    if (!this.configured) throw new OpenCLIError('NAS 地址或访问令牌未配置', { code: 'not_configured' })
    const { inputType, outputType } = methodSchema(catalog, service, method)
    const body = encodeMessage(catalog, inputType, request || {})
    const url = new URL(this.endpoint)
    const fullMethod = `/${service}/${method}`.replace(/^\/+/, '')
    const path = `${url.pathname.replace(/\/$/, '')}/ugreen/opencli/v1/${encodeURIComponent(socketId)}/${fullMethod}`
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/x-protobuf',
      Accept: 'application/x-protobuf',
      'X-OpenCLI-Body-Format': 'protobuf',
      'Content-Length': String(body.length),
      'User-Agent': USER_AGENT,
    }
    const response = await this.request(url, path, headers, body)
    const grpcCode = response.headers['x-grpc-code']
    if (response.statusCode === 200 && (grpcCode === undefined || grpcCode === '0')) {
      try {
        return { value: decodeMessage(catalog, outputType, response.body), raw: response.body, headers: response.headers }
      } catch (error) {
        throw new OpenCLIError(`OpenCLI 响应解码失败: ${error.message}`, { code: 'decode_failed', status: response.statusCode })
      }
    }
    let parsed
    try { parsed = JSON.parse(response.body.toString('utf8')) } catch { parsed = null }
    const message = parsed?.message || parsed?.code || `OpenCLI HTTP ${response.statusCode}`
    throw new OpenCLIError(message, {
      code: parsed?.code || (grpcCode ? `grpc_${grpcCode}` : 'http_error'),
      status: response.statusCode,
      requestId: parsed?.request_id || response.headers['x-request-id'],
    })
  }

  request(url, path, headers, body) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'http:' ? http : https
      const req = lib.request({
        protocol: url.protocol,
        hostname: this.connectTo?.host || url.hostname,
        port: this.connectTo?.port || url.port || (url.protocol === 'http:' ? 80 : 443),
        path,
        method: 'POST',
        headers: { ...headers, Host: url.host },
        ...(this.connectTo && !/^[\d.]+$/.test(url.hostname) ? { servername: url.hostname } : {}),
        agent: false,
        rejectUnauthorized: this.rejectUnauthorized,
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new OpenCLIError(`OpenCLI 请求超时（${this.timeoutMs}ms）`, { code: 'timeout' }))
      })
      req.on('error', (error) => {
        if (error instanceof OpenCLIError) reject(error)
        else reject(new OpenCLIError(`无法连接 NAS: ${error.message}`, { code: 'network', cause: error }))
      })
      req.end(body)
    })
  }
}