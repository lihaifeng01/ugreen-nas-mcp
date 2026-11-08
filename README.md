# ugreen-nas-mcp

让 Claude（或任何 MCP 客户端）通过绿联 UGOS Pro 的「访问令牌」读写 NAS 文件。

不需要 SSH，也不用交出 NAS 账号密码：用的是 UGOS Pro 给第三方 Agent 提供的 OpenCLI 接口（HTTPS + Bearer 令牌 + protobuf），权限由令牌控制。

只有 5 个工具，**没有删除、移动、Docker、应用管理等能力**：

| 工具 | 作用 |
|---|---|
| `nas_list` | 列目录 |
| `nas_stat` | 查看文件/文件夹属性 |
| `nas_read` | 读文件（单次 ≤1MB，可分段） |
| `nas_write` | 新建 / 覆盖 / 追加文件（≤8MB，自动建父目录） |
| `nas_mkdir` | 建文件夹 |

已在 UGOS Pro 1.21.0.80330 + macOS 上的 Claude 桌面版实测通过。

## 1. 在 NAS 上创建令牌

控制面板 → 账号设置 → 访问令牌 → 创建访问令牌：

- 业务权限只勾 **文件管理（Files）** 里的这 4 项：
  - 列表与属性
  - 读取与下载
  - 上传
  - 创建文件夹
- 其他应用（Docker、控制面板、应用中心等）都不要勾
- 令牌只显示一次，先复制保存好；建好后权限不能修改，缺权限只能重建

绿联的令牌不能按文件夹限权：给了 Files 权限，就能访问该账号能访问的所有文件。所以本服务提供「允许写入的目录」（`UGREEN_NAS_WRITE_ROOT`）把写入限制在一个目录里。也建议在 NAS 上建一个普通（非管理员）账号专门生成这个令牌。

## 2. 安装

### 方式一：Claude 桌面版扩展（推荐）

1. 从 [Releases](../../releases) 下载 `ugreen-nas.mcpb`
2. 双击安装（或拖到 Claude 桌面版 设置 → 扩展）。会提示「未签名」，属于正常情况
3. 在设置页填写：
   - **NAS 地址**：局域网 IP（如 `192.168.1.10`，自动用 `https://…:9443`）、UGREENlink/DDNS 域名或完整 URL
   - **访问令牌**
   - **允许写入的目录**（建议）：如 `/volume1/共享文件夹/Claude备份`
   - **校验 HTTPS 证书**：见下文「证书校验」
4. 启用扩展，完全退出（⌘Q）后重开 Claude

扩展使用 Claude 自带的 Node.js，电脑上不用另装 Node。

### 方式二：手动配置（Claude Code 或其他 MCP 客户端）

需要 Node.js 20+：

```bash
git clone https://github.com/lihaifeng01/ugreen-nas-mcp.git
cd ugreen-nas-mcp && npm install
```

Claude Code：

```bash
claude mcp add ugreen-nas \
  -e UGREEN_NAS_ENDPOINT=192.168.1.10 \
  -e UGREEN_NAS_TOKEN=ugpoa_v1.xxx.xxx \
  -e "UGREEN_NAS_WRITE_ROOT=/volume1/共享文件夹/Claude备份" \
  -- node /path/to/ugreen-nas-mcp/index.js
```

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "ugreen-nas": {
      "command": "node",
      "args": ["/path/to/ugreen-nas-mcp/index.js"],
      "env": {
        "UGREEN_NAS_ENDPOINT": "192.168.1.10",
        "UGREEN_NAS_TOKEN": "ugpoa_v1.xxxxxxxx.xxxxxxxx",
        "UGREEN_NAS_WRITE_ROOT": "/volume1/共享文件夹/Claude备份"
      }
    }
  }
}
```

| 环境变量 | 说明 |
|---|---|
| `UGREEN_NAS_ENDPOINT` | NAS 地址（同上） |
| `UGREEN_NAS_TOKEN` | 访问令牌 |
| `UGREEN_NAS_WRITE_ROOT` | 可选，强烈建议：只允许在此目录下写入 |
| `UGREEN_NAS_VERIFY_TLS` | `true`/`1` 时校验证书，仅对域名生效 |
| `UGREEN_NAS_TIMEOUT_MS` | 请求超时，默认 20000 |

## 3. 路径怎么写

- 共享文件夹：`/volume1/<共享文件夹名>/...`
- 个人文件夹：`/home/<NAS用户名>/...`
- **不能**直接用 `/volume1` 根目录（NAS 会拒绝）
- 路径必须是绝对路径，不允许 `..`

## 4. macOS 局域网访问（自动处理）

macOS 的「本地网络」隐私限制会拦截 Claude 桌面版启动的 MCP 进程访问局域网 IP（报 `EHOSTUNREACH`），而且 Claude 不出现在「本地网络」设置里，无法手动授权。

遇到这种情况，本服务会自动注册一个用户级 launchd 任务 `com.ugreen-nas-mcp.forward`：launchd 在 `127.0.0.1:19443` 监听，每个连接用系统自带的 `/usr/bin/nc` 转发到 NAS，然后改走本机转发并重试。

- 不需要额外软件，也不需要管理员密码
- 只监听本机回环地址；只转发原始 TCP，TLS 端到端透传，转发看不到令牌和内容
- 只在 macOS + 局域网 IP + 被拦截时启用；之后启动会直接复用

卸载：

```bash
launchctl bootout gui/$(id -u)/com.ugreen-nas-mcp.forward
rm ~/Library/LaunchAgents/com.ugreen-nas-mcp.forward.plist
```

## 5. 证书校验

- **局域网 IP**：一律不校验。NAS 用自签证书，证书里也不含 IP，校验必然失败；流量仍是 HTTPS 加密的
- **域名（外网）**：按「校验 HTTPS 证书」开关。走外网时建议打开，防止中间人截获令牌，前提是该域名有正规证书（UGOS 可申请 Let's Encrypt）。只有自签证书时不建议关掉校验去走外网

## 6. 示例：备份 Claude 记忆

> 把你的记忆文件全部备份到 NAS 的 /volume1/共享文件夹/Claude备份/今天日期/ 下，保持原来的目录结构

也可以让 Claude 建一个每天运行的定时任务来自动备份。

## 常见错误

| 报错 | 处理 |
|---|---|
| HTTP 401 | 令牌错误、过期或被停用，重新创建 |
| HTTP 403 `token does not grant this method` | 令牌没勾对应权限（见第 1 节），需要重建令牌 |
| HTTP 403 `Access not allowed` | 路径不允许，例如用了 `/volume1` 根目录 |
| `EHOSTUNREACH` | macOS 本地网络拦截，见第 4 节；若自动转发也失败，按报错里的命令手动执行 |
| `self signed certificate` | 对域名开启了证书校验，但证书是自签的 |
| 无法连接 NAS | 检查地址、9443 端口，电脑与 NAS 是否同一网络 |
| 响应解码失败 | NAS 系统升级后 schema 变了，需要更新 `lib/catalog.json` |

## 实现说明

- 新文件用 `Filesystem/CreateFile` 创建：`WriteFile` 只能覆盖已存在的文件，对新路径会返回 `1302 Path does not exist`
- 追加 = 读出旧内容 → 拼接 → 整体覆盖（与服务端的 md5 一致性校验无关）
- `lib/catalog.json` 只保留文件相关的 6 个方法及其消息类型

## 致谢

协议分析、protobuf 编解码（`lib/protobuf.js`）、HTTP 客户端（`lib/opencli.js`，有修改）和 schema（`lib/catalog.json`，已裁剪）来自 [dsh-ugreen-nas](https://github.com/BuvkB/dsh-ugreen-nas)（MIT，© 2026 BuvkB），许可见 `LICENSE.dsh-ugreen-nas`。

## License

MIT
