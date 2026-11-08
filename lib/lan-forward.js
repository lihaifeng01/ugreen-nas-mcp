/**
 * macOS 局域网转发：绕过「本地网络」权限对 Claude 子进程的拦截。
 *
 * Claude 桌面版启动的 MCP 进程（及其子进程）访问局域网 IP 会被 macOS 拦截
 * （EHOSTUNREACH），且 Claude 不出现在「本地网络」设置里，无法手动授权。
 *
 * 这里注册一个用户级 launchd 任务：launchd 在 127.0.0.1:<port> 监听，
 * 每个连接以 inetd 方式启动系统自带的 /usr/bin/nc 转发到 NAS。
 * 该任务由 launchd 拉起，不属于 Claude 的进程树；TLS 端到端透传，
 * 转发只做原始 TCP，看不到令牌和内容。只监听本机回环地址。
 *
 * 卸载：launchctl bootout gui/$(id -u)/com.ugreen-nas-mcp.forward
 *       rm ~/Library/LaunchAgents/com.ugreen-nas-mcp.forward.plist
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LABEL = 'com.ugreen-nas-mcp.forward'
export const LOCAL_PORT = 19443

const PRIVATE_V4 = /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/

export function isPrivateIPv4(host) {
  return PRIVATE_V4.test(String(host || ''))
}

export function isLanBlockError(error) {
  const code = error?.cause?.code || error?.code
  return code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function buildPlist({ host, port, localPort = LOCAL_PORT }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/nc</string>
    <string>${esc(host)}</string>
    <string>${esc(port)}</string>
  </array>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockNodeName</key>
      <string>127.0.0.1</string>
      <key>SockServiceName</key>
      <string>${esc(localPort)}</string>
      <key>SockType</key>
      <string>stream</string>
    </dict>
  </dict>
  <key>inetdCompatibility</key>
  <dict>
    <key>Wait</key>
    <false/>
  </dict>
</dict>
</plist>
`
}

/**
 * 确保转发任务存在且指向当前 NAS。返回本机转发地址 { host, port }。
 * 目标没变且任务已加载时不做任何改动。
 */
export function ensureForwarder({ host, port }) {
  if (process.platform !== 'darwin') throw new Error('本地转发只在 macOS 上需要')
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const file = path.join(dir, `${LABEL}.plist`)
  const plist = buildPlist({ host, port })
  const domain = `gui/${process.getuid()}`
  const loaded = () => {
    try { execFileSync('/bin/launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'ignore' }); return true } catch { return false }
  }
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (current === plist && loaded()) return { host: '127.0.0.1', port: LOCAL_PORT }

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, plist, { mode: 0o644 })
  try { execFileSync('/bin/launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }) } catch { /* 未加载 */ }
  try {
    execFileSync('/bin/launchctl', ['bootstrap', domain, file], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error.message
    throw new Error(`注册本地转发失败：${detail}\n可在终端手动执行：launchctl bootstrap ${domain} ${file}`)
  }
  return { host: '127.0.0.1', port: LOCAL_PORT }
}
