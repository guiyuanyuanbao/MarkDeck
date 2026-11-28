<p align="center">
  <img src="docs/logo.png" width="140" alt="MarkDeck logo" />
</p>

<h1 align="center">MarkDeck</h1>

<p align="center">
  自托管的书签同步中枢 —— 一个 Go 单二进制 + 浏览器插件 + Android App<br/>
  让你的书签在 Chrome、Edge 和手机之间<b>双向实时同步、离线可用</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/CI-GitHub_Actions-blue" />
  <img src="https://img.shields.io/badge/Go-1.26-00ADD8" />
  <img src="https://img.shields.io/badge/Vue-3-42B883" />
  <img src="https://img.shields.io/badge/Flutter-3.38-02569B" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

## 为什么是 MarkDeck

| 痛点 | MarkDeck 的答案 |
|---|---|
| Chrome 和 Edge 的书签互不同步 | 一套服务端打通所有 Chromium 内核浏览器，手机端同步纳入同一棵树 |
| 不想为同步书签登录 Google/Microsoft 账号 | 自托管，数据完全在你手里 |
| 浏览器同步没有回收站，误删即丢 | 服务端回收站 + 每日快照，随时恢复 |
| 换浏览器/换电脑/换手机迁移书签麻烦 | 新设备配对一次，自动全量同步 |
| 书签越攒越乱 | 全文搜索、标签系统、死链检测、重复清理、拖拽排序 |

## 功能

**同步核心**（插件与手机端共用同一套对账引擎）
- 🔁 双向实时同步：WebSocket 推送，任何一端变更秒级到达其他设备
- 📴 离线可用：断联时改动保存在本地，恢复后自动对账重放（浏览/搜索/新增/编辑始终可用）
- ⚖️ 冲突自动裁决：Last-Writer-Wins，确定性收敛
- 🧬 快照对账引擎：每次同步 = 三方对账（上次快照 / 服务端树 / 本地树），映射关系从数据即时推导、无持久映射表可漂移 —— 一次升级自动治愈历史遗留的任何映射损伤
- ↕️ 排序双向同步：任意端拖拽换序，位置按整桶重写推送，其余端按 rank 吸收
- 📑 规范化「其他书签」：所有设备的浏览器其他书签共享服务端唯一文件夹，跨设备互通
- 🚨 同步冲突检测：自动发现与浏览器自带书签同步打架产生的重复书签，一键跳转关闭

**管理页面**（Vue3，嵌入单二进制）
- 📂 文件夹树 + 拖拽整理（插行排序 / 拖入文件夹）+ 批量操作（移动 / 删除 / 打标签）
- 🔍 全文搜索（FTS5 trigram，中文与子串友好）+ 标签筛选
- 🗑️ 回收站（恢复 / 彻底删除）
- 🏷️ 标签管理：重命名、合并、删除
- 🌐 真实站点图标（favicon）自动抓取缓存，插件反向捐图
- 🛠️ 工具中心：死链检测（区分真死链与反爬拦截）、重复书签合并、同名文件夹合并
- 📥 浏览器书签导入（Chrome/Edge/Firefox HTML，URL 去重）、HTML/JSON 导出
- 💾 快照备份：每日自动 + 手动，保留 30 份，可下载可恢复
- ⚙️ 设置中心：账户（密码 / TOTP）、设备同步（配对码 / 吊销）、网络代理

**Android App**（Flutter，与插件逐场景差分测试同一引擎）
- 📱 底部四 Tab：书签 / 回收站 / 标签 / 我的；无多余顶栏，层级贴合手机习惯
- 🔀 网格 / 列表双视图，原地长按拖动排序（插行 + 拖入文件夹，与网页同语义）
- 🔍 本地镜像全文搜索，离线浏览 / 搜索 / 编辑，恢复联网自动对账
- 📲 系统分享面板一键收藏（「分享 → MarkDeck」）
- 👤 我的页聚合：同步状态、管理员登录（会话持久化，Keystore 加密）、配色主题（四套）、解除配对
- 🔒 管理功能门控：回收站 / 工具 / 导入导出 / 设备管理需管理员登录，未登录可见不可用

**安全**
- 🔐 argon2id 密码、登录限速锁定、会话 + CSRF
- 🔢 可选 TOTP 两步验证
- 🔑 设备配对：一次性配对码 → 长期令牌（服务端只存哈希），随时吊销
- 🧾 三条鉴权通道严格分离：设备令牌（插件 + App 同步面）、管理员会话（后台管理面）、公开静态面

## 快速开始（Docker，推荐）

```bash
mkdir markdeck && cd markdeck
# 下载 docker-compose.yml（见仓库根目录），然后：
docker compose up -d
```

打开 `http://localhost:8990`，首次运行创建管理员密码，完成。

- **浏览器端**：管理页面 → 设置 → 设备同步 → 生成配对码 → 在 Chrome/Edge 安装插件（[Releases](../../releases) 下载 zip 解压加载）→ 填入地址与配对码。
- **手机端**：桌面端生成配对码 → [Releases](../../releases) 下载 `markdeck-android-*.apk` 侧载安装（允许未知来源）→ App 填入服务器地址与配对码。支持任意 App「分享 → MarkDeck」快速收藏、点书签跳系统浏览器、离线使用。

> ⚠️ **与浏览器自带书签同步二选一**：如果浏览器账号同步（Chrome Sync / Edge 同步）开着，请在浏览器设置中关闭「书签」一项（密码、历史不受影响），避免两套同步互相覆盖。插件检测到重复书签时会自动提醒并提供一键跳转。

## 源码构建

依赖：Go 1.26+、Node 22+、Flutter 3.38+（Android App）

```bash
cd web && npm ci && npm run build          # 管理页面 → 嵌入二进制
cd ../server && go build -o markdeck ./cmd/markdeck
MARKDECK_ADDR=127.0.0.1:8990 MARKDECK_DATA=./data ./markdeck
```

插件：`cd extension && npm ci && npm run build` → 加载 `extension/dist`。

Android App：

```bash
cd app
flutter pub get && flutter pub run build_runner build --delete-conflicting-outputs   # drift 代码生成
flutter build apk --release --build-name="$(cat ../VERSION)"    # 版本号随仓库 VERSION
```

产物：`app/build/app/outputs/flutter-apk/app-release.apk`。启动图标由 `flutter_launcher_icons` 从 `assets/logo.png` 生成（改动 logo 后执行 `dart run flutter_launcher_icons`）。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MARKDECK_ADDR` | `127.0.0.1:8990` | HTTP 监听地址 |
| `MARKDECK_DATA` | `./data` | 数据目录（SQLite + 快照） |
| `MARKDECK_BASE_URL` | 空 | 对外地址；HTTPS 时 Cookie 加 Secure、TOTP 链接用它 |
| `MARKDECK_SESSION_TTL_HOURS` | `336` | 登录会话有效期（默认 14 天） |

## 部署建议

- **务必走 HTTPS**：Caddy/Nginx 反代 + `MARKDECK_BASE_URL=https://…`
- **备份**：`MARKDECK_DATA` 目录含全部数据（DB + 快照），快照功能本身已每日备份
- **最小权限**：插件只请求你填写的服务器域名的权限；设备令牌可随时在管理页吊销；管理员能力（工具 / 快照 / 导入导出 / 设备管理）在服务端与客户端双侧受会话约束

## 架构与同步协议

```
web/          Vue3 + Element Plus 管理页面（构建产物嵌入 Go 二进制）
extension/    MV3 插件（同步核心纯 TS 可单测，chrome.* 适配层分离）
app/          Flutter Android App（Dart 移植同一对账引擎，SQLite 镜像 +
              分享收藏 + 离线可用，差分夹具与 TS 引擎逐场景比对）
server/
  internal/
    store/          SQLite（WAL）、全局修订号变更日志、FTS5
    sync/           WebSocket hub（修订号广播）
    api/            REST + 快照式对账同步（LWW 裁决）
    auth/           argon2id、会话/CSRF、TOTP、设备令牌、限速
    favicon/        站点图标抓取缓存（单飞、正负缓存）
    importexport/   Netscape HTML 导入导出、URL 规范化去重
    tools/          死链扫描、重复发现、快照
```

**同步协议**：服务端为唯一事实源，全局单调修订号。各端对账引擎按三份树（base 快照 / 服务端树 / 本地树）计算差异，一次 `GET /api/sync/tree` 拉取全量状态、一次 `POST /api/sync/apply` 批量提交变更（单事务，服务端 LWW 裁决后返回权威状态）。排序是协议的一部分：拖拽端整桶重写 `position` 后由引擎推送 position-only 更新，其余端按 rank 吸收。WebSocket 广播 `{"t":"rev","rev":M}` 触发对账，1 分钟兜底轮询。协议细节见 [docs/protocol.md](docs/protocol.md)。多设备端到端同步（双向、删除传播、冲突收敛、离线重放、设备吊销、排序收敛）有自动化测试覆盖。

## 版本与发布

CI 全自动：push 到 `main` → 测试通过 → 补丁版本自动 +1 → 多架构 Docker 镜像推 GHCR（`latest` + 精确版本）→ 插件 zip、Android APK 与三平台二进制发 GitHub Release。详见 [VERSIONING.md](VERSIONING.md)。

## 开发

```bash
cd server && go test ./... && golangci-lint run   # 后端（lint 门禁见 server/.golangci.yml）
cd web && npm run lint && npm run typecheck && npm test && npm run build       # 前端
cd extension && npm run lint && npm test && npm run build          # 插件
cd app && flutter analyze && flutter test                          # Android App（含差分引擎比对与排序回归矩阵）
```

## License

[MIT](LICENSE) © guiyuanyuanbao
