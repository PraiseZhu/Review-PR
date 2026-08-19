# Cindy 维护者专用 gate

本文件描述 Cindy 维护流程。它不是公开贡献指南；实现依赖本 Skill 的
`scripts/`、`config/pr-rules.json` 和宿主提供的通知能力。

## 单一配置来源

所有名单、路径和阈值只读 Skill 私有的 `config/pr-rules.json`：

- `productWhitelist`、`uiPaths`、`uiExcludePaths`：产品/UI gate（`uiExcludePaths`
  是 `uiPaths` 内的排除前缀，多语言 locale 等纯文案数据不算 UI 改动）；
- `archGate.whitelist`、`corePaths`、`coreDiffLines`、`refactorDiffLines`、
  `anyTypeDiffLines`：技术架构 gate；
- `archGate.coldUpdatePaths`、`coldUpdateGuardMarker`、`coldUpdateApprovers`：mobile 冷更
  gate（`coldUpdateApprovers` 是冷更唯一的放行人名单，与技术白名单分开配置）；
- `ciSensitivePaths`：workflow approval 安全门；
- `serverPaths`：Server 发布通知 gate；
- `selfFixAuthors`：自己的 PR 不走 GitHub 自审死锁和无效催办；
- `admins`：结构性 BLOCKED 三层分级合并策略的 **admin-trust 作者名单**（缺失/为空/
  配置形态非法 = fail-closed，经 `normalizeLoginList` 兜底），与 `selfFixAuthors`/
  `mergeAuthorization.breakGlassApprovers` 各自独立、不互相推导；**admins 只描述
  「作者在名单」这条 admin-trust 路径，不承担 `/approve-merge` 放行职责**（那是
  `mergeAuthorization.breakGlassApprovers` 的），见下方「作者侧与仓库侧 gate」；
- `mergeAuthorization` 对象：合并授权策略相关键统一收纳在这里（
  `ownAccountApprovalRequiresAck` / `breakGlassApprovers` /
  `requireAutomatedReviewForAutoMerge`），解析见 `scripts/lib.mjs` 的
  `resolveMergeAuthorizationPolicy`；目标仓库必须用同一嵌套形态配置，放顶层不会生效
  （会退回兼容默认并告警）；**本容器整体必须是 object**——string/number/boolean/
  array 等非 plain object = 容器级 malformed，不抛错、整体 fail-closed
  （`requireAutomatedReviewForAutoMerge` 按 true、`breakGlassApprovers` 按 [] 且
  不回退 admins 扩大发令名单）并显著告警点名容器必须 object，绝不静默当合法配置；
- `mergeAuthorization.breakGlassApprovers`：`/approve-merge` 授权快速合并通道的放行
  人名单（GitHub login；字段缺省/未配置 = 兼容期回退到 `admins` 名单作为发令名单并
  输出 warning；显式留空 [] = fail-closed，无人可下达 `/approve-merge`；与 `admins`
  各自独立、不互相推导）。它是**唯一**免阶段二独立审查的例外——正常自动合并必经
  阶段二自动化审查（目标仓库可配 `mergeAuthorization.requireAutomatedReviewForAutoMerge`
  强制该前提），只有名单成员在 PR 评论发出精确独占一行的
  `/approve-merge <当前 head 完整 40 位 SHA>` 才能跳过，见下方「授权快速合并通道」；
- `mergeAuthorization.requireAutomatedReviewForAutoMerge`：中性默认 `false` = 行为
  不变（键缺失 = false 兼容；键存在但值非 boolean——null/string/number/object 等
  显式 malformed——fail-closed 按 true 处理并显著告警，绝不静默放宽）；置 `true` 时
  正常自动合并（approved shortcut / admin-trust 等免人工路径）必须以阶段二自动化
  审查实际跑完且 clean 为前提，`reviewDecision=APPROVED` 不再单独构成无条件放行；
  唯一不受本键约束的是 `mergeAuthorization.breakGlassApprovers` 经 `/approve-merge`
  下达的 authorized-fast-merge；
- `slackSyncBots`、`slackSenderAliases`、`feishuNotify`：
  讨论 issue 和飞书通知归属、收件人与去重配置；
- `staleAuthorReminder`：作者侧停滞提醒阈值（`exemptAuthors` 命中直接跳过催办并清
  去重状态，留空 = 无豁免）；
- `structuralBypassAllowlist`：`gate.blockClass=structural-check` 自动 admin bypass
  合并时的必需检查类型白名单（未配置时默认 `code_scanning`/`code_quality`，见
  SKILL 5.3）；
- `securityReviewPaths`：自动化自身敏感路径，命中转人工（留空 = 门关闭，见
  SKILL 3.8「审查执行环境安全」）；
- `loopPrExclusion`：与目标仓库自有的自动修 bug loop 共存的排除规则（缺省或 `null`
  = 整套机制关闭，见 SKILL 3.7「Loop 托管 PR 排除」）。

配置变化后先检查 JSON 和相关脚本，再运行 review；不要在 SKILL.md 中写死人名、
群名、邮箱、阈值或路径。

## 确定性脚本

脚本输出 JSON，是判定和副作用的唯一实现；主 agent 负责读取结果、语义判断和文案：

| 场景 | 脚本 |
|---|---|
| 调度预检 | `node "<SKILL_ROOT>/scripts/pre-check.mjs" --repo-root "<目标仓库>"` |
| 锁、环境、候选 | `prepare.mjs`、`pick.mjs`、`refresh-lock.mjs`（长轮心跳）、`release-lock.mjs` |
| 单 PR / 批量扫描 | `context.mjs <PR> --scan`、`context.mjs --scan-all` |
| 检出与清理 | `checkout.mjs`、`cleanup.mjs` |
| 产品/架构 hold、放行、收尾 | `product-hold.mjs`、`product-release.mjs`、`close-product-issue.mjs` |
| fork workflow 放行 | `approve-workflows.mjs` |
| 合并前复核、self-approve | `pre-merge-check.mjs`、`self-approve.mjs` |
| 阶段二审查输出裁决 + 回执（唯一 clean 写者） | `consume-review-output.mjs`（SC-R1b） |
| 阶段二回执的 dirty 记录 / 查看 | `write-review-receipt.mjs`（`--verdict dirty --p0p1-count <N> [--head <sha>]`；`--get` 查看；**public CLI 禁 `--verdict clean`**） |
| resolve 催办、停滞判断、身份解析 | `notify-author-resolve.mjs`、`remind-stale-author.mjs`、`resolve-author-feishu.mjs` |
| 合并后健康检查 | `typecheck-merged.mjs` |
| 合并致谢播报 | `notify-merge-ack.mjs`（`loopPrExclusion.mergeAckNotify.notifyModule` 未配置时 no-op） |
| 汇总 JSON 落盘（不进会话末尾） | `run-log.mjs` |
| 自进化台账（SKILL 第 8 节） | `evolution-note.mjs`（写盘后自动提交推送台账到 skills 仓库 main） |
| Skill 仓库自同步 | `sync-skill-repo.mjs`（`pull` 已内置于 pre-check/prepare；`push` 用于 8.3 落地后回推，best-effort 不阻塞） |
| 跟进 worktree／分支回收（SKILL 5.4） | `fix-worktree-cleanup.mjs`（每轮 sweep 后 `--scan` 全量；`--pr <N>` 定点；`--dry-run` 预览） |

能由脚本确定的字段不要重新用 `grep`、手写 `gh api` 或模型猜测实现。脚本不可用时，
报告阻断原因；只有读元数据、diff 和评论等脚本未覆盖内容才使用 `gh` 兜底。

## 产品 / UI gate

### 判定顺序

1. 读取 `context` 的 `productGate`，先看 `exempt`：作者在白名单、白名单成员
   APPROVE 或白名单成员标回 Ready 任一成立即放行。
2. 未豁免时看 `needsProductCheck`。只有 `feat` 或命中 `uiPaths` 才进入语义判断。
3. `discussionIssue.whitelistComments` 或 `prWhitelistComments`（白名单成员直接在
   PR 评论区的回复，脚本已剔除自动化账号自己发的评论和带隐藏标记的评论）不为空时，
   逐条判定是否明确同意推进，任一来源明确同意即放行；Slack 同步消息只有脚本成功
   归属到白名单成员才算，同步身份不明的消息不算。
4. issue 读取失败（`whitelistComments=null`）不能当作“没有同意”，应进入异常汇总并
   等下一轮重试。
5. 真正的产品/UI 修改才 hold；Bugfix、已有功能补充、纯技术重构、性能、测试、构建
   和文档不受本 gate 限制。

### hold 与 release

产品/UI 改动在白名单明确同意前，不进入自动代码审查，也不合并：

```text
product-hold.mjs
  → 创建讨论 issue
  → 在 PR 评论告知作者
  → 转 draft
```

主 agent 提供 `issueTitle`、`issueBody`、`commentBody`，评论中的 issue 链接使用
`{{ISSUE_URL}}` 占位符。脚本负责隐藏标记、去重和 footer，不能自己重复创建 issue。

auto 每轮消费 `heldDraftResults`：

- 讨论 issue 或 PR 评论区白名单明确同意（`prWhitelistComments`），或 `exempt=true`
  → `product-release.mjs` 自动恢复 Ready，作者无需操作；
- 未同意 → 保持 draft，不重复评论、不催作者；
- issue 读取失败 → 汇总异常，不放行、不重复 hold。

**持久放行**：跨 commit 持久的载体是**放行标记**（signoff-release marker 评论，白名单
明确同意后由维护者按本 SKILL 发出，评论作者须为 admins 名单成员）——被标记确认过的
**门类**跨 commit 持久放行，作者再 push 不重新亮门；**未确认过的新门类首次触发仍拦**
（确认只放行它当时覆盖的门类，不连带放行之后新出现的门类，如旧的 security 确认不会
放行新出现的 rules 门）。这是本仓对上游（PR 全局持久）的刻意收窄，不是与上游对齐。
**Approve 不跨 commit 持久**：admin Approve 绑定当前 head oid（adminsApprovedCurrentHead），
只一次性确认当前 head 上已触发的门类；作者再 push 后若该门类没有放行标记，门重新亮。
**安全 / 规则门当前 head 的同意来源**（与 Approve 并列，不假冒 `approve-current-head`）：
讨论 issue 白名单留言（含已归属 Slack 同步评论）经 `isExplicitSignoffConsent` 判定明确同意，
且评论 `created_at >=` 该 head 首次出现时间。读取失败（`whitelistComments=null`）不得当无同意放行。
否定句（「我不同意」「先别放」）不放行。issue/Slack 同意不写入跨 commit 持久标记。
产品 / 架构门既有留言口径不变：脚本只给 `whitelistComments` 原料，语义仍由主 agent 判。
当前接线到本机制的触发门类为 security / rules；product / arch 走 signoff-hold 既有流程，
coldUpdate / pluginBase 为上游口径，本仓无对应接线。

**放行时关闭讨论 issue（决策已落地，执行接线随 signoff-release.mjs 另立 PR）**：放行
生效时的关闭**决策**已随 scan 输出（closeOnRelease）落地——只认 hold marker 的评论
作者 ∈ admins 名单成员（本机制 viewer 账号在 admins 名单内，故机制自建 marker 可通过
校验；marker 文本形状可被任何有评论权限的账号复制，身份不可伪造）；close 的**执行动作**
（关 issue 与失败原因进轮次汇总）随 signoff-release 写入脚本另立 PR 接线，接线前自动
关闭未生效。

PR 合并后仍可运行 `close-product-issue.mjs <PR>` 兜底；auto 收尾可再运行 `--sweep`，
关闭网页手动合并留下的悬挂 issue。

### 通知

只有 `product-hold.mjs` 返回 `issueCreated=true` 才发送一次产品讨论群通知和作者私聊；
`alreadyHeld`、重复 hold 或 release 不重新通知。交互模式展示收件人和完整文案后确认，
auto 模式按配置直接发送；身份解析失败要如实写入汇总，不能猜收件人。文案措辞固定为
SKILL「对外话术与人格边界」模板 D（人格关闭，第一句先澄清"不是代码问题"）。

## 技术架构 gate

产品 gate 优先，二者不会同时进入 action。读取 `archGate`：

- 核心路径改动量达到 `coreDiffLines`；
- `refactor` diff 达到 `refactorDiffLines`；
- 任意类型 diff 达到 `anyTypeDiffLines`；
- **mobile 冷更**：`archGate.coldUpdate.trigger` 非空（见下）。

任一触发且未被技术白名单、Approve 或 Ready 信号豁免时，由主 agent 判断是否真是较大
架构调整。较大调整使用同一套 `product-hold.mjs --kind arch`、讨论 issue、转 draft、
`product-release.mjs` 和合并后关闭 issue；局部实现、普通改动和机械性大 diff 回到
`auto.fallback` 的正常审查路径。

架构 hold 的通知发给技术把关人，不发产品群；去重锚点仍是 `issueCreated=true`。

### mobile 冷更（runtime fingerprint）触发器

指纹一变，存量装机拿不到本次及后续 OTA 热更，只能等冷更出包。代价与技术框架变动同级，
因此走同一道门，但判定口径不同：**不看改动大小，也不受本门常规豁免**。仓库侧规则是
`docs/dev-rules/mobile-development.md` 的「冷更边界」。

放行口径（`needsColdUpdateCheck=true` 时 `archGate.exempt` 恒为 `false`）：

- **作者身份不构成豁免**。谁改手机端会触发冷更的代码都要进一步确认——作者在
  `archGate.whitelist` 里、有白名单成员的普通 Approve、白名单成员把 PR 标回 Ready，
  一律不算放行（`coldUpdate.exemptOverridden=true` 表示确实有这些信号但已作废）。
- **唯一放行信号**是 `coldUpdate.approvers` 里的把关人**明确针对冷更**的表态：留言要能看出
  他知道这次会冷更并同意；“看过了 / 可以合 / LGTM”不算。候选材料已收进
  `coldUpdate.approverComments`（`from` 区分讨论 issue 与 PR 评论），逐条语义判定，拿不准
  从严 hold。
- `approvers` 名单内成员**自己提的 PR 同样要有一条显式确认**，不能靠身份过。
- 脚本不采集 review 正文，把关人只点 Approve 不留言不构成同意。
- `approverComments` 里 `viaViewerAccount=true` 的条目是把关人经本流程自动化账号发出的评论
  （把关人常与自动化账号同一身份）：正文要确认是人肉表态，hold 告知／resolve 催办这类
  自动化文案不构成同意。

`archGate.coldUpdate` 提供两级信号：

- `guard`：PR 上 fingerprint guard sticky comment 的结论（CI 真算过 base(main) 与合并
  结果两份指纹），权威，压过路径启发式两个方向——说变则即使没碰配置路径也算（原生依赖
  可能只体现在 lockfile 上），说没变则路径命中也不算（`eas.json` 的 `beta-*` profile、
  被 `app.config.js` 剥离的字段都是指纹中性的）。`source=marker` 读的是机器可读行，
  `heading` 是老版评论的文案兜底，`unparsed` = 读不出（按未知处理，不得当作“没变”）。
  `staleVsHead=true` 表示结论比最新 commit 旧，不能拿旧结论放行。
- `files`：命中 `archGate.coldUpdatePaths` 的文件，是没有 guard 结论时的启发式网。

对应两种 trigger 的处置：

| trigger | 语义判断 | 处置 |
|---|---|---|
| `cold-update-confirmed` | 只判两件事：把关人是否已针对冷更明确确认；Description 是否写清了为什么冷更不可避免、存量装机影响、发版节奏 | 未确认 → `product-hold.mjs --kind arch`，并在 issue／评论中要求补齐上述说明。**不得**因为 diff 小、只改一行配置、或作者是白名单成员就放行 |
| `cold-update-suspect` | 先判这次改动是否真的进 resolved config、真的动指纹（判据见「冷更边界」） | 确属动指纹 → 同 confirmed 口径；确属指纹中性 → 回 `auto.fallback`；拿不准从严 hold |

合并前复核时，冷更类 hold 必须已拿到把关人针对冷更的明确确认才能合并，不能用“合并后再看
发版”绕过；`selfFixAuthors` 的自合并路径（`selfMergeAvailable`）同样不豁免本门。

## 作者侧与仓库侧 gate

- `selfFixAuthors` 的 PR 如果卡在格式、审查问题、冲突、CI、未 resolve thread 或停滞，
  不提交无效的 `REQUEST_CHANGES`，也不催本人；按 SKILL 5.4「自动跟进修复
  （fix-handoff）」把卡点投递给独立跟进会话，绑定与去重由 `fix-session-state.mjs`
  管理，循环跟进直到 PR 被合并。CI pending 仅等待，不投递。PR 合并／关闭后遗留的
  跟进 worktree 与本地分支由 `fix-worktree-cleanup.mjs` 回收（每轮 sweep 后
  `--scan`），不回收会随 PR 数量线性膨胀；安全判定全在脚本内。
- `selfFixAuthors` 自己的 PR 审查通过时：GitHub 不允许同账号 approve 自己的 PR，
  `pre-merge-check.mjs` 返回 `selfMergeAvailable=true` 后经唯一合并出口执行
  `node "<SKILL_ROOT>/scripts/merge-pr.mjs" <PR> --strategy <s> --match-head <headRefOid>
  --basis self-merge --admin --delete-branch`（SC-C：所有合并一律经该出口，不得直接
  `gh pr merge`，见 SKILL 5.8；`headRefOid` 取 `pre-merge-check.mjs` 本次判定输出的那份，做判定与执行之间的
  原子护栏——判定之后若又有人推了新 commit，`--match-head-commit` 会让 `gh` 直接
  拒绝合并,不会把新代码在没重新判定的情况下合进去）。条件：viewer = author、
  author 在 `selfFixAuthors`、无冲突、thread 全 resolve、独立审查零 P0/P1。
  auto 模式可执行。
- fork PR 有 workflow 等待批准时，不把它打回作者。只有 PR 未修改
  `.github/workflows/`、`.github/actions/` 等 CI 文件才可 auto approve；
  改过 CI 文件则跳过并点名维护者手动处理。
- `gate.blockClass=structural-check` 表示 required check 永远不返回结果，不是作者代码
  问题。判定该 blockClass 本身用 `scripts/lib.mjs` 的 `classifyBlockedStatus`（第②层
  可达性修复，见下方）；CI 无失败、thread 全 resolve、当前账号具备 bypass 权限**且**
  `structuralBlock.requiredCheckRules` 全部命中 `structuralBypassAllowlist` 是三条路径
  共同的机械前提；机械前提满足后，「谁来担保没有真实 review 也能合」按三层分级（判定
  逻辑单一来源在 `scripts/lib.mjs` 的 `decideStructuralBypassRoute`，`context.mjs` 的
  `auto` 分流与 `pre-merge-check.mjs` 的 `structuralBypassReady` 都调用它，防两处
  判据漂移）：
  1. approved shortcut 成立（2026-08-04 SC-B：`reviewDecision=APPROVED` 聚合裁决 ∧
     approve 绑定当前 head ∧ own-account 配置约束通过，由 `evaluateApprovalBasis` +
     `resolveApprovedShortcut` 机器判定，任何作者都适用，不看 `admins`）
     → 经唯一出口 `merge-pr.mjs <PR> --strategy <s> --match-head <headRefOid> --basis approved --admin`；
  2. 缺 `APPROVED` 但作者在 `admins` 名单（典型是 ownPr——GitHub 422 禁止对自己的 PR
     提交 APPROVE，`reviewDecision` 永远拿不到）→ **不直接合并**，`auto.action=review`
     进入本轮独立审查；审查输出必须交给
     `consume-review-output.mjs`（唯一 clean 写者，SC-R1b）裁决并落回执，
     合并阶段 `pre-merge-check.mjs` 核验回执的
     `headRefOid`/`snapshotHash`/`ledgerHash` 与当前重建值一致、`verdict=clean`、且台账
     `effective-open=0 ∧ accepted-risk=0`（`isReviewReceiptClean` + receiptGate）后才
     返回 `structuralBypassReady=true, structuralBypassBasis='admin-trust'`，再经唯一
     出口 `merge-pr.mjs <PR> --strategy <s> --match-head <headRefOid> --basis admin-trust --admin`。「审查是否跑过 / 结论
     是否干净」是语义判断，脚本本身判断不了代码好不好——回执就是这半判断留下的、
     可核验的凭证；无回执 / 回执针对旧 head（审查通过后又推了新 commit）/
     `verdict≠clean` 时 `structuralBypassReady` 恒为 `false`，必须回到独立审查
     重新做、重新落回执，不能因为作者是 `admins` 成员就跳过审查直接合（那是下面
     「授权快速合并通道」才有的权限，两者不可混用）；
  3. 既无 `APPROVED` 也非 `admins` 名单 → 跳过并报告，不自动合并。`admins` 缺失/为空
     时全部按第 3 条处理（fail-closed，`normalizeLoginList` 兜非数组/混入非字符串等
     非法配置形态，不抛错也不当合法名单用，但会显著标记配置错误）。
  2026-08-01 前的实现只判机械前提、完全不看 `reviewDecision`，属 fail-open：曾在
  `reviewDecision` 为空（零 approving review）的情况下直接 `gh pr merge --admin`
  合入，是本次修复的核心动机。
  **第②层可达性修复（2026-08-02）**：`classifyBlockedStatus` 之前的实现里，
  `reviewDecision='REVIEW_REQUIRED'`/`null` 时会直接短路判 `blockClass=
  'awaiting-approval'`，从不往下探测是否存在真实的结构性 blocker（未 resolve
  thread / CI / 永不上报的必需检查）。在**不要求 approve** 的仓库（如
  mivo-canvas，分支保护只挂了 code_scanning/code_quality/copilot_code_review
  三个从不上报结果的门，没有 required-approving-review 规则）里，`reviewDecision`
  恒为 `REVIEW_REQUIRED`/`null`，短路判定的结果是这类仓库的 `blockClass` 永远到
  不了 `'structural-check'`，上面第 2 条的 `admin-trust` 路由因此永久不可达，即便
  作者在 `admins` 名单也没有任何合并出口。修复方式：approval 维度只影响「最终怎么
  归类」，不再决定「要不要往下探测」——unresolved thread / CI 失败或还在跑 / 结构性
  探测这几层，不管 `reviewDecision` 是什么都必须走一遍；只有走到最后、什么真实问题
  都排查不出时，`reviewDecision` 才用来决定归到 `'awaiting-approval'`（真的只是缺
  approve）还是 `'structural-check'`（存在真实的永不上报门，不管有没有 approve 都
  要走三层分级合并路由）。新增枚举值 `'blocked-unexplained'`：走完全部已知维度都
  查不出原因但仍 `BLOCKED` 的异常兜底，fail-closed，不可 bypass、不催办。
- `gate.blockClass=ci-unknown` 表示 CI 状态读取失败（权限/网络/解析问题），**不是**
  structural-check——即便当前账号对某必需检查有 bypass 权限，也不得据此自动合并
  未知 CI 状态的 PR；跳过等下一轮重新探测。
- **required 完整性核验**（`scripts/lib.mjs` 的 `fetchExpectedRequiredContexts` +
  `classifyRequiredChecks` 第二参 `expectedRequiredNames`）：一条必需检查如果从未
  开始跑（工作流触发条件没命中、还没创建 check-run 等），就根本不会出现在
  `fetchHeadCheckContexts` 的结果里——既不在 failed 也不在 pending，单看这份结果
  会误判「没有已知问题」=全绿。`fetchExpectedRequiredContexts` 读取分支保护
  `required_status_checks` 规则要求的完整 context 名单，与实际观测到的集合做差，
  缺失的一律按 `requiredPending` 处理（未上报≠绿）。该端点读取失败时返回 `null`，
  调用方必须把 `requiredChecks` 整体判为 `null`（未证明全绿），不能悄悄跳过完整性
  核验；空集合只有在端点**确实读到了、只是没有 required_status_checks 类型规则**
  时才成立，不能把"读取失败"和"规则本来就没配"混为一谈。`fetchHeadCheckContexts`
  本身也已改为完整分页（`pageInfo.hasNextPage`/`endCursor` 循环取全），任一页读取
  异常都整体返回 `null`，不返回"读到一半"的部分结果——部分结果若被当作完整集合
  消费，后面没读到的页面里若有失败检查，会被误判为不存在，这与只查前 100 条是
  同一类风险。
- **安全与隐私内容扫描 fail-closed 化**（`scripts/lib.mjs` 的
  `scanPrSensitiveContent`，`context.mjs` 与 `pre-merge-check.mjs` 共用同一份判据，
  防两处漂移）：此前 `pre-merge-check.mjs` 对「是否有泄密硬命中」恒传 `false`，
  完全不扫描，假设上游 `context.mjs` 已经拦过一轮——但授权快速合并通道恰恰是**跳过
  阶段二独立审查**的紧急通道，合并前必须独立复核（TOCTOU：授权评论可能在
  `context.mjs` 的 scan 之后才发出）。`scanPrSensitiveContent` 返回
  `{ scanned, error, hardHitCount, softHitCount, hardHits, softHits }`；
  `scanned=false`（diff 拉取失败等）必须让调用方判「未证明无泄露」，fail-closed
  不放行，**绝不能**当「无命中」处理，`evaluateAuthorizedFastMerge` 的
  `security.scanned` 参数就是接这个字段。
- `format.hitsServer=true` 时，作者必须在 PR 中声明已按项目流程通知 Lizi；缺失时即使
  代码审查通过也走 3B，要求真实回复后再 resolve。当前仓库 `serverPaths` 为空时该门
  不触发，但不要从 skill 中删除。
- 审查 agent 发现实质重构了他人历史功能且没有与原作者对齐证据时走 3B，要求补充
  原作者沟通、必要性、阶段、测试范围和测试结果；自我重构与单一主目的的必要连带改动
  不误伤。
- **授权快速合并通道**（`context.mjs` 的 `authorizedFastMerge` / `auto.action=
  authorized-fast-merge`，判定逻辑单一来源在 `scripts/lib.mjs` 的
  `findApproveMergeAuthorization`（授权本身是否有效）与
  `evaluateAuthorizedFastMerge`（机械前提是否满足））。**P2-4：与上面第②条
  `admin-trust`（`review-pending-admin-bypass`）是两条完全不同、互不替代的路由，
  别概括成一句**——上面那条看的是 PR **作者**是否在 `admins` 名单（admin-trust），
  触发后仍要走完阶段二独立审查、核验回执干净才能合，本条不豁免代码质量；本条看的是
  有没有 `mergeAuthorization.breakGlassApprovers` 名单的**评论者**在这条 PR 下发出
  授权命令，触发后
  **跳过**阶段二独立审查，是审查流程本身的例外通道，不是"换一种方式证明审查过"——
  正常自动合并必经阶段二自动化审查（目标仓库可配
  `mergeAuthorization.requireAutomatedReviewForAutoMerge` 强制该前提，键缺失 =
  false 兼容；键存在但值非 boolean = fail-closed 按 true 处理并显著告警），人工
  `/approve-merge` break-glass 是**唯一**免阶段二独立审查的
  例外。具体：`mergeAuthorization.breakGlassApprovers` 名单成员（GitHub login，机器人
  自己发的评论不算）在 PR 评论里发出精确独占一行的
  `/approve-merge <当前 headRefOid 完整 40 位 SHA>` 命令（SC-A 2026-08-04：授权按
  head SHA 绑定，SHA 精确等于当前 head 才有效，push/force-push 换 head 即天然作废、
  需对新 head 重发），构成「人工已过安全与
  代码审查」的明确授权，可跳过**阶段二独立审查**与 `securityReviewPaths` 门直接进
  合并（合并本身仍经唯一出口 `merge-pr.mjs --basis authorized-fast-merge --admin`，
  见 SKILL 5.8）。这是
  **紧急通道**——2026-08-01 owner 拍板：「特别要紧的 PR 要立即合，只要 CI 绿 +
  明确授权」，管理员显式授权即自担责任，机器的职责从「拦」变成「留痕」，因此阻断面
  比阶段二正常审查窄得多：
  - **命令匹配口径**（2026-08-02 owner 拍板收紧，推翻此前"允许行内追加说明"的
    裁决——被审核方给出的实例证伪：允许行内追加说明会把"讨论这条命令"（如"我觉得
    可以发 /approve-merge 了，但再看一眼"）误判成"下达这条命令"）：先剔除 fenced
    code block（``` /~~~ 围栏）与 blockquote（以 `>` 开头的行）——展示/引用不算
    下达；剩余每行 trim 后必须**精确匹配** `/approve-merge <40 位十六进制 SHA>`
    （大小写敏感的命令词 + 恰一个空格 + 完整 SHA，不含任何行内追加说明）才算命中，
    判定逻辑见 `parseApproveMergeShaCommands` / `findApproveMergeAuthorization`；
    旧裸格式 `/approve-merge`（不带 SHA）不再构成授权，计入
    `authorizedFastMerge.legacyBareComments`（context 输出）供提醒发令者按新格式
    重发——不静默丢弃；
  - **已编辑的评论一律拒绝**（`updatedAt!==createdAt` 视为「事后编辑过」，即使
    编辑内容本身未变也拒绝并计入 `authorizedFastMerge.editedComments`，要求重发
    新评论而不是编辑旧评论）——授权命令的可信前提是「发出瞬间即为最终内容」，允许
    编辑会让人先发无害内容、事后改成命令来绕过时序/绑定检查；
  - **时效判定退役，改为 head SHA 绑定**（SC-A 2026-08-04，替代 2026-08-02 的
    `computeLatestPushDate` 方案）：命令 SHA 精确等于当前 `headRefOid` 才有效，
    不等即计入 `authorizedFastMerge.staleComments`（需对新 head 重发）。原因：
    旧时效锚点依赖的 `Commit.pushedDate` 已被 GitHub 标记废弃——#469 实测 12 个
    commit 全部返回 null，普通 PR（无 force-push 事件）上 `latestPushDate` 恒为
    空,时效判定在生产上事实失效;SHA 绑定同时天然免疫「授权后又推新代码」（换
    head 即作废）与本地时间伪造（SHA 不可伪造指向），语义更强且不依赖任何已废弃
    数据源；
  - **任何情况不可绕过**只剩三类：泄密硬门（`security.hardHits`）未命中**且**扫描
    真的**成功完成**（`security.scanned=true`；`scanned=false` 如 diff 拉取失败等
    一律 fail-closed，不当"无命中"处理，见上方「安全与隐私内容扫描 fail-closed
    化」）；无冲突（`mergeStateStatus` 不为 `DIRTY`，物理不可合，GitHub 层面就合
    不了，授权解不了这个）；head 上**required** 检查（`isRequired` 由
    `fetchHeadCheckContexts` 的 GraphQL 查询按 check 逐条标注，与
    `classifyStatusRollup` 消费的 `--json statusCheckRollup` 不带该字段、看不出
    required/非 required 之分）全绿——且经过完整性核验（见上方「required 完整性
    核验」，未上报的必需检查按未全绿处理）——CI 口径是硬指标,不因授权而放宽;
  - **不阻断，但必须显著写进报告与汇总**（`authorizedFastMerge.reportOnly` /
    `authorizedFastMergeInfo.reportOnly`，字段：`formatIssues`、
    `unresolvedThreadCount`、`nonRequiredFailures`；不能悄悄吞掉，`--details`
    必须包含非空项）：格式门未通过、未 resolve thread、非 required 第三方检查
    （如 Greptile）失败——这三类此前（2026-08-01 首版实现）曾被当作硬阻断，owner
    拍板收窄：授权解的是「要不要再跑一轮独立审查、要不要等这些收尾问题」，紧急
    通道的语义就是人压过流程；
  - 产品/UI 门与技术架构门优先级高于本通道——`context.mjs` 里授权覆盖发生在产品/
    架构门包裹**之前**，命中产品/架构门时会被后者整体覆盖，本通道只解决「要不要
    再审代码」，不解决「这次改动该不该推进」这类更上游的产品方向判断；
  - `pre-merge-check.mjs` 在合并前用同一套函数现场重新检测（不信任 scan 时缓存，
    TOCTOU 保护：授权评论可能在 scan 之后才发出，也可能因为 scan 之后又推了新
    commit 而作废，或被事后编辑），返回 `authorizedFastMergeAvailable`；该脚本
    对当前 head 真实重新跑一遍安全扫描（不再假设上游已扫过），但不重判格式门
    （由更上游的 `context.mjs` 判过），`authorizedFastMergeInfo.reportOnly.
    formatIssues` 恒为空数组。

## 审查能力层(SC-R1..R8,2026-08-05)

审查链路上机器强制的部分,与 T1(语义判断)边界:

| 环节 | 脚本 | 机器保证 | 不保证(T1) |
|---|---|---|---|
| 确定性 preflight | `review-preflight.mjs` | 已知硬模式零漏报;归因只算新增行;parser 缺失/语法错 → incomplete → invalid | 新型问题、alias 间接持有的对象 |
| 任务构建 | `build-review-task.mjs`(唯一) | 必答项/未决 findingId/hazard/分片真实注入正文 | 审查者是否真读懂 |
| 输出契约 | `lib.review-consume.mjs` | 单一 JSON、闭集、同轮引用可解析 | 结论对不对 |
| 裁决与回执 | `consume-review-output.mjs`(唯一 clean 写者) | verdict 由内容推导;clean 三条件;非法输出撤销同 snapshot 旧 clean;3 次非法 → blocked | — |
| 未决核销 | `lib.findings-ledger.mjs` | 逐条 disposition;同 snapshot 禁自证已修;preflight 项只由规则重跑核销 | disposition 的理由是否成立 |
| 覆盖回执 | `lib.review-profiles.mjs` + consumer | 每个 coverage key 恰一个 segment owner;逐段精确集合相等 | "声称读过"≠"读懂了" |
| 分段投递 | `deliver-review-segment.mjs` + 投递台账 | key/必答项/负向 key 明细与**每段 patch 内容**只能经投递出口取得(task/prompt 只留计数+承诺;第 4 轮核验:投的是可审查内容——hunk 带 path/行区间/immutable patch,file 带 changeType/modes);出口只接受下一序号;consumer 以台账为顺序基准,零投递/缺段/冒领即 invalid | **不能证明模型是分段读的**——编排方仍可先调 N 次再一次性喂;机器守住的是"没投递过不能声称覆盖" |
| 负向证据 | R6 分类器 + consumer | required key 只能由 executed 满足;对象/快照/run 引用一致;判定语料按**语句窗口**而非单行(多行断言/整文件删除/CI 守卫删除都算) | **不验证命令真的执行过**——无执行 wrapper,一致伪报是 T1 上限;分类器方向上**偏多要**(窗口可能带进邻近语句) |
| 权威推导 | `lib.review-requirements.mjs`(唯一) | coverage/分片/必答/required 由 consumer 从 immutable objects **重算**并与 task 逐组比对;task 文件不是可信来源 | — |
| 泄密硬门 | `pre-merge-check.mjs` 的 `securityGate` | 全局前置:scan 未完成或硬命中 >0 时四条 merge 路由(普通/self/structural admin-bypass/authorized-fast)逐一显式拒 | 扫描模式本身的覆盖面 |
| 逃逸闭环 | `record-escaped-finding.mjs` + `merge-pr.mjs`(生产触发)+ `pre-check.mjs`(轮次重放) | 双状态机不可跳步;激活核验 fixHead **与** originHead **与**同仓;promote 目标须在注册表内存在且 landed profile 必带 checkId(第 4 轮核验);hazardId 绑稳定事件身份(自由文本只作 evidence);ack 严格晚于 push,`nothing-to-push` 须凭远端核验;合并成功即触发激活,轮次开始的重放先于 no-candidates/unchanged 持久 skip(inbox 不会饿死) | "这次算不算逃逸" |
| clean 新鲜度绑定 | `lib.mjs` isReviewReceiptClean + premerge 现场重算 | clean 回执七项绑定 {source, schemaVersion, outputHash, snapshotHash, ledgerHash, escapeSourceHash, knownHazardsHash};后两项是逃逸数据源与命中路径 hazards 的**全内容**哈希(第 4 轮核验:同 ID 内容漂移、clean 后 body/issue/canonical 变化都打 stale);premerge 重算失败 → 期望值 null → fail-closed | 内容语义是否真的变了风险 |
| **预扫标注(R1,2026-08-05 final SC v2)** | `prepare/record-prescan-segment.mjs`(准备+记录)+ `deliver-review-segment.mjs`(按段投递)+ consumer/receipt/premerge 三层重验 | artifact 绑定 input/policy/snapshot 三 hash,事后篡改可检(SC-7);跨段隔离(第 1 段看不到后续段文件,机器重算段归属不信自报);敏感内容命中零外发(SC-4);enabled 时正式 reviewer 必须逐条 disposition(prescanAssessments,SC-5);clean 回执条件性绑 prescanHash 第八项(SC-6.2);premerge 现场重读 artifact+重算 policyHash(SC-6.3);默认 `enabled:false`,与基线逐字节一致(SC-1) | **观察内容本身的语义正确性不可权威重算**——机器不能验证"陈旧注释"这个判断对不对,只能验证"这份观察从生成到消费全程未被篡改、且被正式审查席看过并给出处置"。observation 本身**永不直接驱动 dirty**,只有正式 `findingFamilies` 才计入裁决;**enabled 缺席不降低任何既有机器保证**——disabled 时全部现有 gate 行为不变 |

`snapshotHash = hash(baseRefOid, mergeBaseOid, headOid, diffDigest)` 是全链路的新鲜度
锚点(SC-R8):base 前进而 head 不变时旧证据/旧回执一律 stale。patch 出自 immutable git
objects,不吃可变工作树。

**同源的确切范围(第 2 轮核验修订,不冒称"全流程")**:阶段二的 preflight / 任务构建 /
覆盖 manifest / 负向证据锚点,以及 `pre-merge-check` 的安全扫描,共用**同一份**由
`buildDiffSnapshot` 出的快照并绑定 snapshotHash。**阶段一 `context.mjs` 的安全扫描不在
此范围内**——它在拿到 base oid 之前就要跑,走的是 `gh pr diff` 退路,`scanned` 语义不变
但**不参与 snapshotHash 绑定**。静态 inventory 钉死"snapshot builder 之外零 PR diff 抓取
形态"指的是 scripts 层不再各自抓 diff,不等于阶段一那次扫描也有快照身份;行为级验收见
`tests/snapshot-drift-e2e.test.mjs`(base 前进 head 不变时四方全部反应)。

## 维护者 precheck

目标仓库 scheduler 应注册安装后的 Skill 绝对路径：

```text
node "<SKILL_ROOT>/scripts/pre-check.mjs" --repo-root "<目标仓库>"
```

判定顺序：

1. 有效 review 锁仍在 60 分钟 TTL 内 → exit `2`，静默跳过；
2. GitHub 无 open PR（包括 draft）→ exit `2`；
3. 其余情况执行 `context.mjs --scan-all`，由会话内流程决定产品/架构 hold、CI、
   thread、冲突和审查走向；
4. 上轮全量扫描全是 skip，且 PR 状态指纹、被 hold issue 的 `updatedAt` 都没有变化，
   且 state 未超过 6 小时 → exit `2`；
5. 无法证明“没有活”（gh 不可用、网络失败、state 缺失或损坏）→ exit `0`，让会话
   内流程复核并汇总异常；
6. 脚本错误或宿主超时：宿主按 scheduler 协议 **fail-open** 仍创建会话（只认「明确
   exit 2」为跳过，见 SKILL §1），不释放别人的锁。

这个 precheck 不重复产品/架构语义判断，避免 hook 与 `context.mjs` 双份逻辑漂移；
6 小时心跳保证停滞提醒和 issue sweep 不会被空转指纹饿死。

**手动验证调度 / 改频后确认判定，必须加 `--probe-only`**（SC-D 2026-08-04）：真只读
模式——不 pull skill 仓、不 spawn 合并致谢补发、import 层零本地状态写（连状态目录都
不创建），只输出带 `probeOnly:true` 的 decision JSON。生产 scheduler **不要**注册此
flag（生产轮次需要那些副作用各自的职责）。
