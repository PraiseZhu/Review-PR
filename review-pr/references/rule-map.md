# Review rule map（Mivo：xindong/mivo-canvas-plugin）

这张表只负责导航，不复制规则正文。每次审查都读取命中的原文；规则变化后不需要同步本文件，
只有路径归属变化才更新映射。来源是 Mivo 根 `AGENTS.md` 的「改什么，先读哪里」。
[MIVO-PATCH rule-map] 上游这份是 Cindy 仓的映射，Mivo 整份替换。
[MIVO-PATCH p2-blocking] UI 规则行与核对清单第 8 条按 P0/P1/P2 报告并阻断，P3 不报。

## 所有 PR

- `AGENTS.md`：仓库边界、数据与宿主契约、验证与命令、PR 与审查规则。
- `CLAUDE.md`：项目约定、敏感数据保护、测试与守卫。
- `CONTRIBUTING.md`：贡献流程与 PR 模板事实源。
- `.github/pull_request_template.md`：Title、Description 三大段（这次改了什么 / 怎么验证的 / 风险）。

## 按改动路径读取

| 命中路径或主题 | 必读规则 |
|---|---|
| 面板、设置页、宿主卡、CSS、主题、动效或 UI 文案（`cindyplugin/`、`src/ui/`、`src/app/`、`*.css`） | `cindyplugin/DESIGN.md`（**强制**：UI 改动必须符合；违反时按统一分级判，按统一分级判 P0/P1/P2；PR 正文或维护者裁定写明的有意设计不算违反，有疑问写进「待 owner 确认」）及其引用的 `docs/design.md` |
| 用户操作、成功/跳过/失败反馈、日志或诊断 | `docs/development-logging.md`；生产查询另读 `docs/ops/plugin-debug-log-query.md` |
| 保存、加载、恢复、删除、归档、迁移或卸载重装（`src/store/`、`src/lib/persist*`、`cindyplugin/src/persist/`、`shared/persist-contract.ts`） | `docs/decisions/library-canvas-store.md`，需要全景时读 `docs/decisions/library-canvas-store-overview.md` |
| 图片导入、原件、媒体 URL、双写、上传/归档队列或清理 | `docs/ops/image-store-library-default.md`，按改动查 `docs/ops/image-store-slo.md` 及对应 image-store 专题 |
| 生图、编辑、批次、重试、取消、恢复、落点或视口 | `docs/decisions/generation-activity-contract.md`、`docs/decisions/generation-placement-contract.md`、`docs/decisions/canvas-work-view-contract.md` 中相关部分 |
| 配方、参考图或 prompt 组装（`server/recipes/`、`server/routes/recipes.ts`） | `docs/recipes-authoring.md` 与实际契约代码 |
| BFF、鉴权、服务器资产或 persist 模式（`server/`） | `docs/ops/bff-deployment.md`、`docs/ops/image-store-p3-auth-gate.md` 和对应资产专题 |
| 插件 manifest、版本、构建、测试包、安装或市场发布 | `docs/ops/plugin-release.md`；宿主适配另读 `cindyplugin/README.md` |
| 跨仓移植 | `docs/sync/plugin-sync-guide.md` 与 `docs/sync/plugin-sync-state.json` |
| PR、CI、审查机、接单或自动化（`scripts/`、`agent-use/`、`docs/loops/`） | `CONTRIBUTING.md`、`agent-use/docs/pr-rules.json` 与真实 workflow；命中对应功能时再读 `docs/loops/review-pr-setup.md`、`docs/loops/bug-doctor-intake.md` |
| 四语文案（`src/i18n/`、`cindyplugin/src/i18n/`） | `AGENTS.md`「不得破坏的数据与宿主契约」的 i18n 条目；用 `npm run verify:i18n` 的结果核对 |

若一个文件命中多行，全部读取；若规则正文引用了另一份事实源，继续读取被直接引用的文件或代码。
规则的增量适用原则有效：不要用新规则审判 PR 未触碰的历史代码。文件在 base 上不存在时，在
Verification 里如实写明，不凭记忆补规则。

## 审查时的固定问题

1. PR 是否只做一个可说明的目的，Description 是否与 diff、测试和风险一致？
2. 共享符号、状态、持久化数据、协议、配置和错误路径的读方是否都被检查？
3. 读不到档案、鉴权失败、hydration 未完成是否被当成「空库」？确认前是否以缺席判删除？（违反记 P1）
4. 这次改动是否放松了安全边界、引入了危险写法、新增了第三方依赖，或让用户数据、凭证、
   prompt 流向了新的地方（日志、广播、KV、外部请求）？（重档专项：security 触发的 riskySoftHits
   逐条定性、新增依赖来源核查、跑 `scripts/security-scan.mjs`；确认的后门／数据外发／越权记 P0。
   工具未执行必须在 Verification 如实写明，不得写成「已扫描无问题」）
5. 新增或修改的用户可见操作，成功、跳过、失败路径是否都有 `debugLogger`，需要即时反馈的是否有
   `toastFeedback`？（缺失导致失败不可见记 P1）
6. 生图提交、轮询重试、生成结果提交是否保持幂等与批次归属，会不会重复扣费或复活已取消的占位？
7. UI 改动附的证据（截图／录屏／HTML）与 diff 是否一致，有没有明显违反 `cindyplugin/DESIGN.md`
   的硬伤（绕过 token 的硬编码颜色、自造组件顶替设计系统组件等，记 P1）？证据缺失不阻断。
8. 是否发现已证实的 P0/P1/P2；存在任一则 changes-requested；均无才通过；P3 不报？
