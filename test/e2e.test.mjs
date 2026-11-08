// 端到端测试：启动一个模拟 NAS（按真实 OpenCLI 协议解码 protobuf），通过 MCP stdio 调用全部工具。
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { encodeMessage, decodeMessage, methodSchema } from '../lib/protobuf.js'

const catalog = JSON.parse(readFileSync(new URL('../lib/catalog.json', import.meta.url)))
const TOKEN = 'ugpoa_v1.test.secret'
const files = new Map()
const dirs = new Set(['/volume1/share'])
const notFound = (res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"code":"grpc_error","message":"Err - code: 1302, message: Path does not exist"}') }

const nas = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"code":"unauthorized","message":"bad token"}') }
    const method = req.url.split('/').pop()
    const { inputType, outputType } = methodSchema(catalog, 'ugidl.filesystem.Filesystem', method)
    const r = decodeMessage(catalog, inputType, Buffer.concat(chunks))
    let out = {}
    if (method === 'CreateDir') {
      if (dirs.has(r.path)) { res.writeHead(200, { 'x-grpc-code': '6', 'content-type': 'application/json' }); return res.end('{"code":"grpc_error","message":"exists"}') }
      dirs.add(r.path)
    }
    if (method === 'Stat' && !dirs.has(r.path) && !files.has(r.path)) return notFound(res)
    if (method === 'CreateFile') files.set(r.path, Buffer.from(r.content || '', 'base64'))
    if (method === 'WriteFile') { if (!files.has(r.path)) return notFound(res); files.set(r.path, Buffer.from(r.content, 'base64')) }
    if (method === 'ReadFile') {
      const d = files.get(r.path); if (!d) return notFound(res)
      const s = d.subarray(Number(r.offset), Number(r.offset) + Number(r.length))
      out = { data: s.toString('base64'), eof: Number(r.offset) + s.length >= d.length }
    }
    res.writeHead(200, { 'content-type': 'application/x-protobuf', 'x-grpc-code': '0' })
    res.end(encodeMessage(catalog, outputType, out))
  })
})
await new Promise((r) => nas.listen(0, '127.0.0.1', r))
const endpoint = `http://127.0.0.1:${nas.address().port}`

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../index.js', import.meta.url))],
    env: { ...process.env, UGREEN_NAS_ENDPOINT: endpoint, UGREEN_NAS_TOKEN: TOKEN, ...env },
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  return client
}

let failed = 0
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + detail}`); if (!cond) failed++ }
const run = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content[0].text } }

const c = await connect({ UGREEN_NAS_WRITE_ROOT: '/volume1/share/Claude备份' })
const tools = (await c.listTools()).tools.map((t) => t.name).sort()
check('exposes exactly 5 tools', tools.join() === 'nas_list,nas_mkdir,nas_read,nas_stat,nas_write', tools.join())

const p = '/volume1/share/Claude备份/2026-11-08/areas/测试.md'
let r = await run(c, 'nas_write', { path: p, content: '---\nname: 测试\n---\n你好' })
check('creates new file via CreateFile', !r.err && JSON.parse(r.text).created === true, r.text)
r = await run(c, 'nas_read', { path: p })
check('reads back UTF-8 text', !r.err && JSON.parse(r.text).text === '---\nname: 测试\n---\n你好', r.text)
r = await run(c, 'nas_write', { path: p, content: '\n追加', mode: 'append' })
r = await run(c, 'nas_read', { path: p })
check('append keeps old content', JSON.parse(r.text).text.endsWith('你好\n追加'), r.text)
r = await run(c, 'nas_write', { path: p, content: 'X' })
check('overwrites existing file via WriteFile', !r.err && JSON.parse(r.text).created === false, r.text)
r = await run(c, 'nas_write', { path: '/volume1/share/other.txt', content: 'x' })
check('rejects writes outside WRITE_ROOT', r.err && /只允许写入/.test(r.text), r.text)
r = await run(c, 'nas_write', { path: '/volume1/share/Claude备份/../x', content: 'x' })
check('rejects ..', r.err, r.text)
r = await run(c, 'nas_write', { path: 'relative.txt', content: 'x' })
check('rejects relative paths', r.err, r.text)
r = await run(c, 'nas_mkdir', { path: '/volume1/share/Claude备份/2026-11-08' })
check('mkdir on existing dir is ok', !r.err, r.text)
r = await run(c, 'nas_read', { path: '/volume1/share/Claude备份/none.txt' })
check('missing file reports error', r.err && /1302/.test(r.text), r.text)
await c.close()

const bad = await connect({ UGREEN_NAS_TOKEN: 'ugpoa_v1.wrong.token', UGREEN_NAS_WRITE_ROOT: '${user_config.write_root}' })
r = await run(bad, 'nas_stat', { path: '/volume1/share' })
check('401 gives token hint', r.err && /HTTP 401/.test(r.text) && /令牌/.test(r.text), r.text)
await bad.close()

nas.close()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
