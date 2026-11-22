# 版本规划与发布流程

MarkDeck 使用 **语义化版本（SemVer）+ CI 自动提升最小版本**。

## 版本规则

```
v1.2.3
  │ │ └── 补丁版本：每次 CI 自动构建成功后 +1（bug 修复、小调整）
  │ └──── 次版本：手动提升（新功能）
  └────── 主版本：手动提升（破坏性变更）
```

- 镜像 tag：`ghcr.io/<owner>/markdeck:latest`（永远指向最新稳定版）+ `ghcr.io/<owner>/markdeck:1.2.3`（精确版本，用于回滚/锁定）
- 浏览器插件 zip 附件到 GitHub Release，文件名带版本号

## 发布流程（全自动）

1. **触发**：push 到 `main` 分支即触发 CI
2. **测试**：Go 测试 + 插件 Vitest + typecheck 全部通过
3. **提升版本**：CI 读取仓库中的 `VERSION` 文件，补丁版本 +1，写回并提交（`[skip ci]` 防止循环），打 tag `v1.2.4`
4. **构建**：
   - 多架构 Docker 镜像（linux/amd64 + arm64）推送到 GHCR，打 `latest` + `v1.2.4` 两个 tag
   - 浏览器插件 zip（Chrome/Edge 通用）上传到 GitHub Release `v1.2.4`
   - 三平台裸二进制（linux/amd64、linux/arm64、windows/amd64）作为 Release 附件

## 手动提升次/主版本

想发布新功能版本时，手动修改仓库根目录的 `VERSION` 文件（如 `1.2.3` → `1.3.0`）并 push——CI 会以此为基线提升补丁版本。

## 首次发布

`VERSION` 文件初始为 `0.0.0`，首次 push 到 main 即产出 `v0.0.1`。
