# MarkDeck

自托管浏览器书签同步服务 —— 一个 Go 二进制 + 浏览器插件，让你的书签栏在所有设备间双向同步、离线可用。

![status](https://img.shields.io/badge/status-beta-orange) ![go](https://img.shields.io/badge/Go-1.23-00ADD8) ![vue](https://img.shields.io/badge/Vue-3-42B883)

## 功能特性

**同步**
- 🔁 **双向实时同步**：WebSocket 推送修订号，任何一端变更秒级到达其他端与浏览器
- 📴 **离线可用**：插件与服务器失联时，本地改动持久化在离线队列，恢复后自动重放合并
- ⚖️ **冲突自动裁决**：Last-Writer-Wins（时间戳 + 设备 ID 决胜），确定性可复现
- 🧹 **删除同步**：墓碑机制保证删除在所有设备生效，回收站可反悔

**管理页面（Vue3）**
- 📂 文件夹树 + 拖拽整理 + 批量操作（移动 / 删除 / 打标签）
- 🔍 全文搜索（FTS5 trigram，中文与子串友好）+ 标签筛选
- 🗑️ 回收站（恢复 / 彻底删除）
- 🏷️ 标签管理：重命名、合并、删除，全量生效
- 🛠️ 工具中心：死链检测（HEAD→GET，并发限速）、重复书签发现与一键合并
- 📥 导入浏览器书签（Chrome/Edge/Firefox 的 Netscape HTML，URL 去重）、HTML/JSON 导出
- 💾 快照备份：每日自动 + 手动，保留 30 份，可下载可恢复（恢复前自动再备份）
- 🔐 安全：argon2id 密码、登录限速锁定、会话 + CSRF、可选 TOTP 两步验证、设备令牌随时吊销

**浏览器插件（Chrome / Edge, Manifest V3）**
- 弹窗快速收藏当前页 + 本地即时搜索（天然离线）
- 配对码接入（一次性 6 位码 → 长期设备令牌，服务端只存哈希）
- 断网不丢数据：MV3 service worker 被杀也不丢（队列落盘）

## 快速开始

### Docker（推荐）

```bash
docker compose up -d
# 打开 http://localhost:8990，首次运行会要求创建管理员密码
```

### 源码构建

依赖：Go 1.23+ 与 Node 22+

```bash
# 1. 构建管理页面（输出到 server/internal/webapp/dist，go:embed 会打包进二进制）
cd web && npm ci && npm run build

# 2. 构建服务端
cd ../server && go build -o markdeck ./cmd/markdeck

# 3. 运行
MARKDECK_ADDR=127.0.0.1:8990 MARKDECK_DATA=./data ./markdeck
```

### 安装浏览器插件

1. 打开管理页面 → **设置 → 设备同步 → 生成配对码**
2. Chrome / Edge 进入 `chrome://extensions`，开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/dist`
3. 插件设置页填入服务器地址 + 配对码 → 配对成功后自动开始首次同步

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MARKDECK_ADDR` | `127.0.0.1:8990` | HTTP 监听地址 |
| `MARKDECK_DATA` | `./data` | 数据目录（SQLite + 快照） |
| `MARKDECK_BASE_URL` | 空 | 对外访问地址（HTTPS 时 Cookie 加 Secure，otpauth 链接用它） |
| `MARKDECK_SESSION_TTL_HOURS` | `336` | 登录会话有效期（默认 14 天） |

## 部署建议

- **务必走 HTTPS**：用 Caddy / Nginx 反代并签发证书，然后设置 `MARKDECK_BASE_URL=https://…`
- 数据目录定期备份（快照功能已内置每日备份，也可自行备份数据目录）
- 插件只请求用户填写的服务器域名的 `optional_host_permissions`，不越权

## 架构

```
web/          Vue3 + Element Plus 管理页面（构建产物嵌入 Go 二进制）
extension/    MV3 插件（同步核心纯 TS 可单测，chrome.* 适配层分离）
server/
  cmd/markdeck/     入口
  internal/
    store/          SQLite 存储层、修订号变更日志、FTS5
    sync/           WebSocket hub（修订号广播）
    api/            REST 路由 + 同步 pull/push（LWW 裁决）
    auth/           argon2id、会话/CSRF、TOTP、设备令牌、限速
    importexport/   Netscape HTML 导入导出、URL 规范化去重
    tools/          死链扫描、重复发现、快照
```

**同步协议**：服务端为唯一事实源，全局单调修订号（`changes.seq`）。客户端 `GET /api/sync/pull?since=N` 增量拉取，`POST /api/sync/push` 提交本地操作（服务端 LWW 裁决后返回权威状态）。WebSocket 广播 `{"t":"rev","rev":M}`，客户端收到后拉取增量；`chrome.alarms` 5 分钟兜底轮询。

## 开发

```bash
cd server && go test ./...          # 后端单测
cd web && npm run typecheck && npm run build
cd extension && npm test && npm run build
```

## License

MIT
