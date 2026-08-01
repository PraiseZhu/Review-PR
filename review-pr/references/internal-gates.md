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
- `admins`：结构性 BLOCKED 三层分级合并策略的信任名单（缺失/为空 = fail-closed），
  与 `selfFixAuthors` 各自独立、不互相推导，见下方「作者侧与仓库侧 gate」；
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

PR 合并后运行 `close-product-issue.mjs <PR>`；auto 收尾可再运行 `--sweep`，关闭网页
手动合并留下的悬挂 issue。

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
  `pre-merge-check.mjs` 返回 `selfMergeAvailable=true` 后直接用
  `gh pr merge --admin --delete-branch` 合并。条件：viewer = author、author 在
  `selfFixAuthors`、无冲突、thread 全 resolve、独立审查零 P0/P1。auto 模式可执行。
- fork PR 有 workflow 等待批准时，不把它打回作者。只有 PR 未修改
  `.github/workflows/`、`.github/actions/` 等 CI 文件才可 auto approve；
  改过 CI 文件则跳过并点名维护者手动处理。
- `gate.blockClass=structural-check` 表示 required check 永远不返回结果，不是作者代码
  问题。CI 无失败、thread 全 resolve、当前账号具备 bypass 权限**且**
  `structuralBlock.requiredCheckRules` 全部命中 `structuralBypassAllowlist` 是三条路径
  共同的机械前提；机械前提满足后，「谁来担保没有真实 review 也能合」按三层分级（判定
  逻辑单一来源在 `scripts/lib.mjs` 的 `decideStructuralBypassRoute`，`context.mjs` 的
  `auto` 分流与 `pre-merge-check.mjs` 的 `structuralBypassAvailable` 都调用它，防两处
  判据漂移）：
  1. `reviewDecision=APPROVED`（真实 GitHub review，任何作者都适用，不看 `admins`）
     → 直接 `gh pr merge --admin`；
  2. 缺 `APPROVED` 但作者在 `admins` 名单（典型是 ownPr——GitHub 422 禁止对自己的 PR
     提交 APPROVE，`reviewDecision` 永远拿不到）→ **不直接合并**，`auto.action=review`
     进入本轮独立审查；审查通过（零 P0/P1）后，合并阶段认「本轮审查实际跑完且干净」
     为 `APPROVED` 的等价物（`pre-merge-check.mjs` 返回
     `structuralBypassAvailable=true, structuralBypassBasis='admin-trust'`），再走
     `gh pr merge --admin`。这一步「审查是否跑过 / 结论是否干净」是语义判断，脚本
     无法验证，只守机械前提这一半——调用方（agent）必须先在本轮独立审查里确认零
     P0/P1，才能消费 `admin-trust` 结论去合并，不能因为作者是 `admins` 成员就跳过
     这轮审查直接合（那是下面「授权快速合并通道」才有的权限，两者不可混用）；
  3. 既无 `APPROVED` 也非 `admins` 名单 → 跳过并报告，不自动合并。`admins` 缺失/为空
     时全部按第 3 条处理（fail-closed）。
  2026-08-01 前的实现只判机械前提、完全不看 `reviewDecision`，属 fail-open：曾在
  `reviewDecision` 为空（零 approving review）的情况下直接 `gh pr merge --admin`
  合入，是本次修复的核心动机。
- **授权快速合并通道**（`context.mjs` 的 `authorizedFastMerge` / `auto.action=
  authorized-fast-merge`，判定逻辑单一来源在 `scripts/lib.mjs` 的
  `findApproveMergeAuthorization`（授权本身是否有效）与
  `evaluateAuthorizedFastMerge`（机械前提是否满足））：`admins` 名单成员（GitHub
  login，机器人自己发的评论不算）在 PR 评论里发出 `/approve-merge` 命令（独占
  一行，允许行内追加说明文字），且该评论晚于最后一次 push（早于最后一次 push
  视为已作废，需重发；`authorizedFastMerge.staleComments` 记录这类过期候选），
  构成「人工已过安全与代码审查」的明确授权，可跳过**阶段二独立审查**与
  `securityReviewPaths` 门直接进合并。这是**紧急通道**——2026-08-01 owner 拍板：
  「特别要紧的 PR 要立即合，只要 CI 绿 + 明确授权」，管理员显式授权即自担责任，
  机器的职责从「拦」变成「留痕」，因此阻断面比阶段二正常审查窄得多：
  - **任何情况不可绕过**只剩三类：泄密硬门（`security.hardHits`）未命中；无冲突
    （`mergeStateStatus` 不为 `DIRTY`，物理不可合，GitHub 层面就合不了，授权解不了
    这个）；head 上**required** 检查（`isRequired` 由 `fetchHeadCheckContexts` 的
    GraphQL 查询按 check 逐条标注，与 `classifyStatusRollup` 消费的
    `--json statusCheckRollup` 不带该字段、看不出 required/非 required 之分）全绿
    ——CI 口径是硬指标,不因授权而放宽;
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
  - `pre-merge-check.mjs` 在合并前用同一对函数现场重新检测（不信任 scan 时缓存，
    TOCTOU 保护：授权评论可能在 scan 之后才发出，也可能因为 scan 之后又推了新
    commit 而作废），返回 `authorizedFastMergeAvailable`；该脚本不重判格式门
    （由更上游的 `context.mjs` 判过），`authorizedFastMergeInfo.reportOnly.
    formatIssues` 恒为空数组。
- `gate.blockClass=ci-unknown` 表示 CI 状态读取失败（权限/网络/解析问题），**不是**
  structural-check——即便当前账号对某必需检查有 bypass 权限，也不得据此自动合并
  未知 CI 状态的 PR；跳过等下一轮重新探测。
- `format.hitsServer=true` 时，作者必须在 PR 中声明已按项目流程通知 Lizi；缺失时即使
  代码审查通过也走 3B，要求真实回复后再 resolve。当前仓库 `serverPaths` 为空时该门
  不触发，但不要从 skill 中删除。
- 审查 agent 发现实质重构了他人历史功能且没有与原作者对齐证据时走 3B，要求补充
  原作者沟通、必要性、阶段、测试范围和测试结果；自我重构与单一主目的的必要连带改动
  不误伤。

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
6. 脚本错误或宿主超时按 scheduler 协议阻止本轮，不释放别人的锁。

这个 precheck 不重复产品/架构语义判断，避免 hook 与 `context.mjs` 双份逻辑漂移；
6 小时心跳保证停滞提醒和 issue sweep 不会被空转指纹饿死。
