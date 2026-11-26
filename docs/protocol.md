# MarkDeck 同步协议

单一权威描述。改协议 = 改这里 + 三端实现 + golden 契约测试。

**约定来源**（改动时同步更新）：

- 服务端 ops/结果结构：`server/internal/store/batch.go`（`BatchOp` / `BatchResult`）
- 服务端路由：`server/internal/api/sync.go`
- 插件 op 类型：`extension/src/reconcile.ts`（`ServerOp` / `ServerNode` / `Base`）
- Web 类型：`web/src/api/client.ts`（`Bookmark` 等，注释标注 "mirroring server models"）
- **golden 契约测试**：`server/internal/store/contract_test.go` +
  `server/internal/store/testdata/*.golden.json`（插件侧镜像断言在
  `extension/tests/protocol.wire.test.ts`）。任一端改 JSON 字段而不改
  golden 与对端，CI 直接红。

## 端点

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/sync/tree` | session 或 device token | 全量活树 + head + othersId |
| POST | `/api/sync/apply` | 同上 | 批量 ops，单事务，返回逐条结果 + head |
| GET | `/api/sync/status` | 同上 | 诊断用：head + 节点数 |
| WS | `/api/ws` | 同上 | 修订号广播 |

已废弃（0.1.0 重写时移除，勿再引用）：`GET /api/sync/pull?since=N`、`POST /api/sync/push`（旧增量拉取/逐事件推送协议）。

## 核心模型

- **身份**：服务器 UUID 全局唯一。客户端之间没有 id 映射表（0.0.x 系列九个
  补丁版本都在和 id 映射漂移作斗争后于 0.1.0 整体移除）。
- **事实源**：服务端 SQLite 单一事实源，全局单调修订号（`bookmarks.revision`
  的最大值即 head）。
- **Base 快照**：每个设备持久化 `md_base` = 上次成功对账时的服务端树 +
  每行绑定的本地 chrome id。对账失败永不推进 base —— 下一次自动重新计划
  相同 ops，离线编辑无需队列即可重放。
- **Touch 日志**：`md_touch` = 本地编辑时间戳流水（localId → {at, ...}），
  供 LWW 时钟使用，可跨 MV3 SW 重启存活。不是 op 队列。

## 对账流程（插件）

```
取服务端树(GET /api/sync/tree) ─┐
取本地树(chrome.bookmarks)     ─┼→ planSync(纯函数) → chromeOps[] + serverOps[]
读 base + touch                 ─┘
1. 先推 serverOps → POST /api/sync/apply（服务端 LWW 逐条裁决）
2. 再应用 chromeOps → chrome.bookmarks 本地写入
3. 双侧成功 → 推进 base = 新服务端树 + 新绑定；清 touch
```

`planSync` 幂等：对相同三棵树重复计划得到零 ops。

## LWW 裁决规则（服务端 `UpdateLWWBase` / `applyBatchOp`）

1. `cur.UpdatedAt > in.UpdatedAt` → 服务端胜。
2. 同秒且不同设备 → 看 `ObservedRevision`（op 作者基于的 change-log 版本）：
   `baseRev >= cur.Revision` 是合法的后续编辑，客户端胜；否则客户端败
   （防"离线删除 vs 快照恢复"竞态）。
3. 同设备同秒 → 设备自己的后写胜（编辑链）。
4. 未来时钟 >5 分钟钳制到 `at+300`。

`Undelete: true` 表示"本地编辑胜过服务端删除"——行的墓碑被复活。

## WS 帧

服务端 → 客户端，文本帧：`{"t":"rev","rev":<int64>}`。
慢客户端广播被丢弃（send chan 满），靠 alarm 轮询收敛。
1 分钟 alarm（`md-poll`）兜底 MV3 SW 休眠。

## 其他书签绑定（结构式）

服务端固定 id `md-others` 为唯一"其他书签"容器（`store.CanonicalOthersID`）。
`/api/sync/tree` 返回 `othersId`，设备把浏览器的"其他书签"根结构化绑定到它
——不是存映射，绑定随每次成功对账原子重写。

## URL 归一化（判同）

三处实现，语义不同（勿合并）：

| 位置 | 用途 | 规则 |
|---|---|---|
| `importexport.CanonicalURL`（Go） | 服务端导入去重 + tools.FindDuplicates | 小写 scheme+host、去 www.、剥跟踪参数、去根路径尾斜杠 |
| `reconcile.normBookmarkUrl`（TS） | 插件 adoption 匹配 | 同上 + **整 URL 小写 + percent-decode**（Chrome 对非 ASCII 会 percent-encode）|
| `store.normMigrateURL`（Go） | 迁移期 holder 内合并 | 仅 trim+lowercase+尾斜杠 |

## 配对流程

1. Web 管理页生成 6 位配对码（有效期 5 分钟，`auth/manager.go NewPairCode`）。
2. 插件 options 页：探测 `GET /api/auth/state` → `POST /api/pair`（服务器地址+配对码+设备名）。
3. 服务端发设备令牌；插件首次全量拉取导入，然后进入常规对账循环。
4. **重配对必清 `md_base`**：旧 base 描述的是旧设备令牌下的世界。
