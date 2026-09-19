# Review rule map

这张表只负责导航，不复制规则正文。每次审查都读取命中的原文及其 `Review 清单`；
规则变化后不需要同步本文件，只有路径归属变化才更新映射。

## 所有 PR

- `AGENTS.md`：仓库边界、工作流、安全底线和 Git 交付规则。
- `docs/dev-rules/development-workflow.md`：PR 模板事实源、验证真实性、P0/P1/P2 和
  review gate。
- `.github/PULL_REQUEST_TEMPLATE.md`：Title、Description 三大段和风险字段。

## 按改动路径读取

| 命中路径或主题 | 必读规则 |
|---|---|
| 任意 Desktop / Main / Renderer / preload / BrowserWindow / WebView / 导航 / IPC / CSP | `docs/dev-rules/electron-security-and-process-boundaries.md`、`docs/dev-rules/engineering-conventions.md` |
| `apps/desktop/src/main/`、共享 package、布局树、package 依赖方向 | `docs/dev-rules/architecture-invariants.md`、`docs/dev-rules/desktop-development.md` |
| 凭证、授权、用户数据、临时文件、测试 fixture、运行时落盘 | `docs/dev-rules/credentials-and-local-storage.md` |
| SQLite、Drizzle schema、migration、companion script、数据库访问 | `docs/dev-rules/database-and-migrations.md` |
| 媒体、附件、缓存、`cindy-media://`、引用回收、协议解析 | `docs/dev-rules/media-storage-and-protocols.md` |
| `packages/maker-core`、prompt、tool/MCP、translator、event loop、model、usage | `docs/dev-rules/maker-core-and-agent-behavior.md` |
| 插件、`.cindy`、Ghost、manifest、sandbox、能力 slot、FORGE_GUIDE | `docs/dev-rules/plugin-security-and-authoring.md` |
| `cindy-updater`、更新服务 | `docs/dev-rules/cindy-updater.md` |
| `cindy-protocol`、submodule、device-link、relay、tunnel、wire protocol | `docs/dev-rules/protocol-and-submodules.md` |
| `apps/mobile/`、Mobile 入口或跨端控制 | `docs/dev-rules/mobile-development.md`、`docs/dev-rules/remote-and-mobile-adaptation.md` |
| workdir、agent 进程、会话数据、SSH 远程、IPC push/invoke、手机版入口 | `docs/dev-rules/remote-and-mobile-adaptation.md` |
| Settings、配置文件、profile、agent/MCP/provider 开关 | `docs/dev-rules/configuration-and-overrides.md` |
| Orca、多 Agent 协同、maker-ipc/orca、orca-workflow | `docs/dev-rules/orca-team-architecture.md` |
| UI、布局、组件、动效或界面文案 | `DESIGN.md`（**强制**：所有 UI 改动必须符合，违反记 P1，见 SKILL 第 4 节第 7 条）、`docs/design-rules/cindy-design-system.md`、`docs/dev-rules/engineering-conventions.md` |
| 产品能力、Core/Agent/Skill/插件归属、跨端体验 | `docs/product-rules/core-product-principles.md` |
| 安装、依赖、submodule 初始化或新 worktree | `docs/dev-rules/environment-setup.md` |

若一个文件命中多行，全部读取；若规则正文引用了另一份事实源，继续读取被直接引用的
文件或代码。规则的增量适用原则有效：不要用新规则审判 PR 未触碰的历史代码。

## 审查时的固定问题

1. PR 是否只做一个可说明的目的，Description 是否与 diff、测试和风险一致？
2. 共享符号、状态、协议、配置、持久化数据和错误路径的读方是否都被检查？
3. 权限、凭证、用户数据、远程边界和跨平台行为是否安全且可回滚？
4. 需要测试的 main、IPC、migration、协议、UI/i18n、Mobile 和远程路径是否有实际证据？
5. 是否把组织或个人流程塞进 Core，或把已有 Agent 能力重复实现到客户端？
6. UI 改动是否附了截图／录屏或改动后界面的 HTML 页面，证据内容是否与 diff 逐项
   对应，界面是否逐条符合 `DESIGN.md` 与 `cindy-design-system.md`？（证据缺失不
   阻断——context.mjs 标记 uiEvidenceMissing，主 agent 发非阻断提醒评论请作者补充，
   见 SKILL 3.2；已附证据的一致性与规范符合性由审查 agent 判，不符为 P1 级）
7. 改到 `apps/mobile` 的原生配置、依赖、config plugin 或原生模块时，是否会改变 runtime
   fingerprint（触发冷更）？是否必要、Description 是否写清了为什么冷更不可避免、存量装机
   影响与发版节奏？（判据见 `docs/dev-rules/mobile-development.md` 的「冷更边界」；非必要
   触发冷更记 P1。谁提的都不豁免，把关人是否已针对冷更确认由前置门判，见 SKILL 3.4）
8. 是否发现 P0/P1；若只有 P2，结论必须是通过且不发送 P2？
