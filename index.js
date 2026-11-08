#!/usr/bin/env node
/**
 * ugreen-nas-mcp — 绿联 NAS 文件读写 MCP 服务（stdio）
 *
 * 用 UGOS Pro「访问令牌」调用 NAS 的 OpenCLI 接口，只暴露：
 *   nas_list / nas_stat / nas_read / nas_write / nas_mkdir
 * 不提供删除、移动、Docker、应用管理等能力。
 *
 * 环境变量：
 *   UGREEN_NAS_ENDPOINT   NAS 地址：局域网 IP（默认端口 9443）、DDNS 或完整 URL
 *   UGREEN_NAS_TOKEN      访问令牌 ugpoa_v1.xxx.xxx
 *   UGREEN_NAS_WRITE_ROOT （可选，强烈建议）只允许在这个目录下写入/建目录
 *   UGREEN_NAS_VERIFY_TLS （可选）设为 1 时校验证书；默认不校验（NAS 多为自签证书）
 *   UGREEN_NAS_TIMEOUT_MS （可选）请求超时，默认 20000
 *
 * 协议、codec 与 schema 来自 dsh-ugreen-nas（MIT, © 2026 BuvkB）。
 */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { OpenCLIClient, OpenCLIError } from './lib/opencli.js'
import { ensureForwarder, isLanBlockError, isPrivateIPv4 } from './lib/lan-forward.js'

const catalog = JSON.parse(readFileSync(new URL('./lib/catalog.json', import.meta.url), 'utf8'))
const SOCKET = 'ugreen.filemgr.internal.grpc'
const SERVICE = 'ugidl.filesystem.Filesystem'
const MAX_WRITE = 8 * 1024 * 1024
const READ_CHUNK = 1024 * 1024

// 未填写的扩展设置可能以空串或未替换的 ${user_config.x} 形式传入，统一视为未设置
const env = (name) => {
  const v = String(process.env[name] ?? '').trim()
  return v.startsWith('${') ? '' : v
}

const client = new OpenCLIClient({
  endpoint: env('UGREEN_NAS_ENDPOINT'),
  token: env('UGREEN_NAS_TOKEN'),
  timeoutMs: Number(env('UGREEN_NAS_TIMEOUT_MS')) || 20000,
  rejectUnauthorized: false,
})

// 证书校验只对外网域名生效：局域网 IP 的 NAS 证书都是自签的，且证书里不含 IP，必然校验失败
const VERIFY_SETTING = env('UGREEN_NAS_VERIFY_TLS')
try {
  const host = client.endpoint ? new URL(client.endpoint).hostname : ''
  client.rejectUnauthorized = ['1', 'true'].includes(VERIFY_SETTING.toLowerCase()) && !isPrivateIPv4(host) && !/^127\./.test(host)
} catch { /* 地址无效时由调用报错 */ }

const WRITE_ROOT = env('UGREEN_NAS_WRITE_ROOT')
  ? posix.normalize(env('UGREEN_NAS_WRITE_ROOT')).replace(/\/+$/, '')
  : ''

const rawCall = async (method, request) => (await client.call({ socketId: SOCKET, service: SERVICE, method, request, catalog })).value

// macOS 会拦截 Claude 子进程访问局域网 IP（EHOSTUNREACH）。遇到时自动注册
// launchd 本地转发（见 lib/lan-forward.js），改走 127.0.0.1 并重试一次。
let forwardNote = ''
async function call(method, request) {
  try {
    return await rawCall(method, request)
  } catch (error) {
    const target = client.endpoint ? new URL(client.endpoint) : null
    if (client.connectTo || process.platform !== 'darwin' || !target || !isPrivateIPv4(target.hostname) || !isLanBlockError(error)) throw error
    client.connectTo = ensureForwarder({ host: target.hostname, port: target.port || (target.protocol === 'http:' ? 80 : 443) })
    forwardNote = `已启用本地转发 127.0.0.1:${client.connectTo.port} → ${target.host}`
    return await rawCall(method, request)
  }
}

// 进程启动时若转发任务已存在，直接使用，避免每次先撞一次拦截
if (process.platform === 'darwin' && client.endpoint) {
  try {
    const t = new URL(client.endpoint)
    if (isPrivateIPv4(t.hostname)) {
      const { execFileSync } = await import('node:child_process')
      const { readFileSync: rf } = await import('node:fs')
      const os = await import('node:os')
      const { LABEL, LOCAL_PORT, buildPlist } = await import('./lib/lan-forward.js')
      const plistPath = `${os.homedir()}/Library/LaunchAgents/${LABEL}.plist`
      const port = t.port || (t.protocol === 'http:' ? 80 : 443)
      if (rf(plistPath, 'utf8') === buildPlist({ host: t.hostname, port })) {
        execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' })
        client.connectTo = { host: '127.0.0.1', port: LOCAL_PORT }
      }
    }
  } catch { /* 没有现成的转发，按直连处理 */ }
}

function cleanPath(p) {
  const raw = String(p || '').trim()
  if (!raw.startsWith('/')) throw new Error(`路径必须是绝对路径（以 / 开头）：${raw}`)
  if (raw.split('/').includes('..')) throw new Error(`路径中不允许出现 ..：${raw}`)
  return posix.normalize(raw).replace(/(.)\/+$/, '$1')
}

function checkWritable(p) {
  if (!WRITE_ROOT) return
  if (p !== WRITE_ROOT && !p.startsWith(WRITE_ROOT + '/')) {
    throw new Error(`只允许写入 ${WRITE_ROOT} 之下（UGREEN_NAS_WRITE_ROOT），拒绝写入：${p}`)
  }
}

function explain(error) {
  if (error instanceof OpenCLIError) {
    const hints = {
      not_configured: '请在 MCP 配置里设置 UGREEN_NAS_ENDPOINT 和 UGREEN_NAS_TOKEN。',
      network: '连不上 NAS：检查地址/端口（局域网 IP 默认 9443），以及电脑和 NAS 是否在同一网络。',
      timeout: '请求超时：检查网络，或调大 UGREEN_NAS_TIMEOUT_MS。',
      decode_failed: '响应解码失败：NAS 系统版本可能与内置 schema 不一致。',
    }
    let hint = hints[error.code] || ''
    if (error.status === 401) hint = '令牌无效或已过期，请到 NAS 控制面板 → 账号设置 → 访问令牌 重新创建。'
    if (/certificate|self.signed|CERT_/i.test(error.message)) hint = `证书校验失败（当前校验开关=${VERIFY_SETTING || '未设置'}）：NAS 使用自签证书时请在扩展设置里关闭「校验 HTTPS 证书」，并重启 Claude。`
    if (error.status === 403) hint = '权限不足：令牌没勾选对应的 Files 权限，或路径不允许（不能用 /volume1 根目录，请用 /home/<用户名>/... 或共享文件夹路径）。'
    return `${error.message}${error.status ? `（HTTP ${error.status}）` : ''}${error.requestId ? ` request_id=${error.requestId}` : ''}${hint ? `\n${hint}` : ''}`
  }
  return error?.message || String(error)
}

const ok = (value) => {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (forwardNote) { text += `\n（${forwardNote}）`; forwardNote = '' }
  return { content: [{ type: 'text', text }] }
}
const fail = (error) => ({ isError: true, content: [{ type: 'text', text: explain(error) }] })
const wrap = (fn) => async (args) => { try { return ok(await fn(args)) } catch (e) { return fail(e) } }

async function readAll(path, limit) {
  let buf = Buffer.alloc(0)
  let offset = 0
  for (;;) {
    const r = await call('ReadFile', { path, offset, length: READ_CHUNK, is_dry_run: false })
    const data = r.data ? Buffer.from(r.data, 'base64') : Buffer.alloc(0)
    buf = Buffer.concat([buf, data])
    offset += data.length
    if (r.eof || data.length === 0) return buf
    if (buf.length > limit) throw new Error(`文件超过 ${limit} 字节，无法追加，请改用覆盖写入`)
  }
}

async function ensureDir(path) {
  try {
    await call('CreateDir', { path, make_all: true, is_dry_run: false })
  } catch (error) {
    // 目录已存在时部分版本会报错；确认一下它确实是目录即可
    try { await call('Stat', { path }) } catch { throw error }
  }
}

const server = new McpServer({ name: 'ugreen-nas', version: '0.2.2' })

server.registerTool('nas_list', {
  title: '列出 NAS 目录',
  description: '列出绿联 NAS 上某个文件夹的内容。不传 path 时列出个人文件夹根目录（可用 rootType 切换到共享文件夹等）。注意不能直接列 /volume1。',
  inputSchema: {
    path: z.string().optional().describe('绝对路径，例如 /home/<用户名>/Claude备份'),
    rootType: z.number().int().optional().describe('不传 path 时的根目录：2 个人文件夹（默认）、3 共享文件夹、6 外部设备'),
    page: z.number().int().optional().describe('页码，默认 1'),
    limit: z.number().int().optional().describe('每页条数，默认 200'),
  },
  annotations: { readOnlyHint: true },
}, wrap(async ({ path, rootType, page, limit }) => {
  const p = path ? cleanPath(path) : ''
  const r = await call('CategoryOrFileDirList', {
    path: p, root_type: p ? 0 : (rootType || 2), page: Math.max(page || 1, 1), limit: limit ?? 200,
  })
  const data = r.data || r
  const list = data.file_list || data
  return { path: list.top_path || p || '(root)', total: list.total, entries: list.files || list.entries || [] }
}))

server.registerTool('nas_stat', {
  title: '查看 NAS 文件属性',
  description: '查看绿联 NAS 上文件或文件夹的属性（是否存在、类型、大小、修改时间）。',
  inputSchema: { path: z.string().describe('绝对路径') },
  annotations: { readOnlyHint: true },
}, wrap(async ({ path }) => {
  const r = await call('Stat', { path: cleanPath(path) })
  return r.stat || r
}))

server.registerTool('nas_read', {
  title: '读取 NAS 文件',
  description: '读取绿联 NAS 上的文件。文本直接返回；二进制返回 base64。单次最多 1MB，更大的文件用 offset 分段读。',
  inputSchema: {
    path: z.string().describe('绝对路径'),
    offset: z.number().int().min(0).optional().describe('起始字节，默认 0'),
    length: z.number().int().min(1).max(READ_CHUNK).optional().describe('读取字节数，默认 262144'),
  },
  annotations: { readOnlyHint: true },
}, wrap(async ({ path, offset, length }) => {
  const p = cleanPath(path)
  const r = await call('ReadFile', { path: p, offset: offset || 0, length: length || 262144, is_dry_run: false })
  const data = r.data ? Buffer.from(r.data, 'base64') : Buffer.alloc(0)
  const text = data.toString('utf8')
  const isText = !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text) && Buffer.from(text, 'utf8').equals(data)
  return { path: p, offset: offset || 0, bytes: data.length, eof: r.eof ?? null, ...(isText ? { text } : { base64: r.data || '' }) }
}))

server.registerTool('nas_write', {
  title: '写入 NAS 文件',
  description: '在绿联 NAS 上新建或覆盖一个文件（mode=overwrite），或追加到末尾（mode=append）。父目录不存在会自动创建。文本直接传 content；二进制用 base64 并设 isBase64=true。单个文件最大 8MB。',
  inputSchema: {
    path: z.string().describe('目标文件的绝对路径'),
    content: z.string().describe('文件内容（文本，或 isBase64 时的 base64）'),
    isBase64: z.boolean().optional().describe('content 是否为 base64，默认 false'),
    mode: z.enum(['overwrite', 'append']).optional().describe('默认 overwrite'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}, wrap(async ({ path, content, isBase64, mode }) => {
  const p = cleanPath(path)
  checkWritable(p)
  const incoming = isBase64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
  let final = incoming
  const dir = posix.dirname(p)
  if (mode === 'append') {
    let existing = Buffer.alloc(0)
    try { existing = await readAll(p, MAX_WRITE) } catch (e) {
      if (!(e?.status === 404 || e?.code === 'grpc_5' || /1302|does not exist/i.test(e?.message || ''))) throw e
    }
    final = Buffer.concat([existing, incoming])
  }
  if (final.length > MAX_WRITE) throw new Error(`内容 ${final.length} 字节，超过单文件 8MB 上限`)
  if (dir !== '/') await ensureDir(dir)
  // NAS 的 WriteFile 只能覆盖已存在的文件（新文件报 1302 Path does not exist），
  // 新文件要用 CreateFile 带内容创建。
  let exists = true
  try { await call('Stat', { path: p }) } catch (e) {
    if (e?.status === 404 || e?.code === 'grpc_5' || /1302|does not exist/i.test(e?.message || '')) exists = false
    else throw e
  }
  if (!exists) {
    await call('CreateFile', { path: p, mode: 0o660, content: final.toString('base64'), exclusive: false, is_dry_run: false })
  } else {
    await call('WriteFile', {
      path: p, content: final.toString('base64'), mode: 'WRITE_FILE_MODE_OVERWRITE',
      offset: 0, is_dry_run: false, total_size: final.length,
    })
  }
  return { ok: true, path: p, bytes: final.length, mode: mode || 'overwrite', created: !exists }
}))

server.registerTool('nas_mkdir', {
  title: '在 NAS 上建文件夹',
  description: '在绿联 NAS 上创建文件夹，父目录不存在会一并创建。',
  inputSchema: { path: z.string().describe('绝对路径') },
  annotations: { readOnlyHint: false, idempotentHint: true },
}, wrap(async ({ path }) => {
  const p = cleanPath(path)
  checkWritable(p)
  await ensureDir(p)
  return { ok: true, path: p }
}))

await server.connect(new StdioServerTransport())
