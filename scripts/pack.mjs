// 打包 Claude 桌面版扩展：检查版本号一致 → 安装运行依赖 → 跑测试 → 生成 ugreen-nas.mcpb
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
const pkg = read('package.json')
const manifest = read('manifest.json')
if (pkg.version !== manifest.version) {
  console.error(`版本号不一致：package.json=${pkg.version}，manifest.json=${manifest.version}，请改成一样的再打包`)
  process.exit(1)
}
const sh = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit' }) }
sh('npm install --omit=dev --no-audit --no-fund')
sh('npm test')
sh('npx -y @anthropic-ai/mcpb@2 validate manifest.json')
sh('npx -y @anthropic-ai/mcpb@2 pack . ugreen-nas.mcpb')
console.log(`\n已生成 ugreen-nas.mcpb（v${pkg.version}）`)
