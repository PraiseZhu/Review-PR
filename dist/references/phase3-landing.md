# 阶段三：落地、合并、打回与核销

> 本文件由 `SKILL.md` 渐进披露拆出，正文与拆分前逐字一致。从 `SKILL.md` 按需 Read，不要经其它 reference 二次跳转。

## Contents

- 5. 阶段三：落地
- 5.0 收敛检查点与同 family 复发
- 5.1 通过：批准并合并
- 5.2 不通过：请求修改
- 5.3 维护者专用分流
- 5.4 自动跟进修复（fix-handoff）：已停用，禁止开跟进会话
- 5.5 冲突代合并（主干侧解决，不推作者分支）
- 5.6 代修合并（merge-then-fix，仅交互模式）
- 5.7 收敛止损（收敛检查点与红色通报，机器侧触发）
- 5.8 合并出口与审计（SC-C,2026-08-04 #469 复盘）
- 5.9 open-findings 核销门与逃逸学习闭环（SC-R5/R7，2026-08-05）

---

## 5. 阶段三：落地

阶段三任何 GitHub 写操作（review / comment / issue）前，对该候选再跑一次轻量 head 复核（`gh pr view <N> --json headRefOid` 或 `context.mjs <N> --scan`）。head 与扫描快照不一致 → 退回阶段一重新分类，禁止对着过期 head 发打回。

### 5.0 收敛检查点与同 family 复发

跨轮次的概念，5.2（打回）用这套识别机制。5.4 已停用，不再有自修动作。

**收敛检查点**：某一轮独立审查报告显示某个 family（第 4 节第 6 条）的全部
manifestations 已确认修复——该 family 不再出现在本轮 findings，或本轮 Verification
明确核实通过——这一刻起这个 family 记为"已收敛"。这一步只是"这一轮没再出现"的
事实记录，不代表它以后不会复发——复发后到底算不算"真的曾经收敛过"，见下面的
persistent/reopened 分类（D3，2026-08-02 gpt 阻断修正）。

**识别同 family 复发（事实来源是 per-PR convergence state，不是评论历史）**：
`family_id` 只在单份报告内唯一、不跨轮持久（每轮审查 agent 独立生成，数字可能撞、
也可能对不上同一个不变量），不能拿它做跨轮识别"这是不是同一个 family"。跨轮识别
按下面两级判定，事实来源是该 PR 的 convergence state（存这个 PR 的历史 family
记录，机制细节见状态维护方）：

1. **一级（确定性，机器可断言）**：本轮新 family 的一句话不变量喂给
   `invariantKey(invariant)`（`lib.review-output-shape.mjs` 导出的跨轮 join key
   **权威实现**——对完整归一化文本算 SHA-256、不截断，见该文件头部说明）算出
   key；命中 state 里该 PR 的历史 key，直接判定为"同 family 复发"，不需要模型
   介入。（`invariantSlug` 现在**只用于**下面 marker 的人类可读展示，不是身份
   判定——早前误把截断到 64 字符的 `invariantSlug` 当身份用，gpt 实跑复现两条
   仅尾部不同的 invariant 会被误判成同一 family，已纠正。）
2. **二级（T1 语义判断兜底，仅一级未命中时触发）**：key 未命中不等于一定是新
   family——可能只是这轮复述换了标点或说法，落在归一化的已知盲区里（见
   `invariantKey` 头部注释的"已知限制"）。此时 state 提供该 PR 的历史
   `invariant` 原文清单，主 agent 逐条比对语义是否等价——这一步仍是审查 agent 的
   语义判断（同第 4 节第 6 条的归族判断，机器不能代它下结论），判等价则判定复发，
   并给出引用的历史记录（`priorHead`/`priorKey`）；机器侧只核验主 agent 给出的
   引用在 state 里是否真实存在，不代它下结论、也不越权做语义匹配本身。
3. **两级都判断不了** → 当新 family 处理，宁可多报一条新 family，绝不静默吞掉
   一次复发。
4. state 按判定路径记录 `matchedBy: 'key' | 'semantic' | 'same-round' | null`（字段名
   随 state 内部的 camelCase 约定，见 4.2；`null` = 该家族的第一条 occurrence），供之后
   统计二级命中频率，评估归一化规则是否需要加强。`'same-round'` 是同一轮内两条
   finding 归一化后撞同一 key 的情形——既不算跨轮复发也不重复计新家族，只是同一轮
   报告里两条表述被机械识别成同一个不变量的簿记结果，只补记 occurrence，不产生
   `recurrenceType`。

**persistent vs reopened（D3，2026-08-02 gpt 阻断修正）**：命中一级或二级只说明
"这个 key 以前出现过"，不说明"它是不是真的消失过一次"——两者后果不同，混为一谈
会让"持续没修好"被误说成"已收敛后复发"，错误触发只该在真复发时触发的升级路径。
凡是命中一级/二级的 occurrence，state 都会带一个 `recurrenceType`：

- **`reopened`（真复发）**：上一次 occurrence 所在的 head 与当前 head 之间，
  存在至少一个**已经跑过独立审查、且记录在 state 里**的中间 head 不含这个
  family——有真实证据证明它确实消失过一次。此时才可以说"上一轮已收敛"，才走
  下面的升级路径。
- **`persistent`（持续未修）**：找不到这样的中间 head（相邻两轮就复发，或中间
  已审的 head 全都仍带着这个 family）——这个问题从未真的消失过，不是"收敛后又
  复发"，只是一直没修好。**仍是 P0/P1、仍计入 p0p1Count、仍使这轮判 dirty、仍
  阻断合并、仍不算新 family**——这些判定一条都不因为分类而改变；但打回文案/
  升级卡片**不得**声称"已收敛"，也**不触发**下面的升级路径（它本来就没收敛过，
  没有"再次出现"这件事，升级阶梯解决的是"为什么修好的东西又坏了"，不适用于
  "一直没修好"）。
- **边界（fail 方向）**：分类只看 state 里**已经记录**的审查轮次——被 cron 跳过、
  没跑审查的 head 不提供任何证据（既不证明修好也不证明没修好），不能被当成
  "干净的中间轮"。找不到证据时一律判 `persistent`，宁可少触发一次升级，也不能
  谎称"已经收敛过"。

`<!-- family-anchor: <invariantKey> -->` 这条机器可读注释的职责是**thread 连续性
锚点**：family 首次被判定 dirty 时嵌入评论正文顶部，供后续轮次定位同一 thread
追加（复用/更新同一条既有评论，定位到同 marker 的 thread 追加，或
`gh pr comment --edit-last`，不新开无关评论）；它**不是**复发的检测源（检测源是
上面两级判定），也不改动 PR 作者的 body。

**marker 里必须是 `invariantKey`（`ik1-` + 完整 64 位 hex），不是 `invariantSlug`。**
2026-08-02 对抗审阻断修正：初版 marker 里放的是 `invariantSlug` 的输出，理由是
「slug 只是展示文本，撞了不影响判定结果」。**这个理由是错的。** marker 是**机器读取**
用来定位 thread 的，它就是一个跨轮 join key——`invariantSlug` 截断到 64 字符，两条前 64 字
相同的 invariant 会算出同一个 marker，于是 family B 的更新会被追加进 family A 的 thread。
身份**判定**确实已经不吃 slug 了（那部分修对了），但 thread **投递位置**会错，
这不是「展示文本重复」。同一个根因（拿截断值当跨轮身份）在这里换了个地方活着。

**legacy 的 slug marker 一律不匹配**：不做 fallback 兼容——为了认出旧评论去匹配旧 marker，
等于把碰撞请回来。旧 marker 匹配不上的代价是**新开一条评论**；这是有意选择：多一条评论是
良性退化，写进错误的 thread 不是。人类可读的 slug 可以照常写在评论**正文**里，
但不得作为机器匹配的依据。

判定复发后：
- **`recurrenceType: 'reopened'`**：作者在不在 `selfFixAuthors` 都按「对外话术与人格边界」
  模板 A 追加"收敛检查点请求"段（建议不是要求）。**禁止**再走已停用的 5.4 升级阶梯去开跟进会话。
- **`recurrenceType: 'persistent'`**：不走升级阶梯，也不在文案里说"已收敛"——
  按普通 P0/P1 打回处理即可，措辞上可以指出"这个问题从上一轮起就一直存在，
  之前的修法没有覆盖到当前这条触发路径"（如实描述"持续未修"，不是"收敛后复发"）。

### 5.1 通过：批准并合并
<!-- dist:strip:start preview-5.1 -->

只有同时满足以下条件才进入 3A：

- 格式门通过；
- 产品/UI 与技术架构 gate 已豁免，或白名单已在讨论 issue / PR 评论区明确同意并已恢复 Ready；
- 前置 gate 全部通过；
- 独立审查报告没有 P0/P1；
- 主 agent 已复核报告；
- required checks 通过，分支可合并；
- review 权限和合并策略明确。

交互模式按顺序确认”提交 approve / 合并 / 评论”。auto 模式只审不合：条件全部可证时
只落 clean 回执并写入汇总，**不**调用 `merge-pr.mjs` / `gh pr merge`；不使用强制合并、绕过 required checks 或自动批准修改过的 CI。结构性
`BLOCKED` 按三层分级（approved shortcut 成立（`reviewDecision=APPROVED` 聚合裁决
∧ approve 绑定当前 head ∧ own-account 配置约束通过，见下方 'approved' 成立条件）/
作者在 `admins` 名单且本轮审查通过并已落回执 / 均不满足）判断能否 `--admin`，判定逻辑单一来源在
`scripts/lib.mjs` 的 `decideStructuralBypassRoute`（结构性 blocker 探测本身用
`classifyBlockedStatus`，approval 维度不再决定要不要探测，只决定探测完怎么归类），
完整安全条件见 [references/internal-gates.md](internal-gates.md)
「作者侧与仓库侧 gate」，否则跳过。
合并使用仓库允许的默认策略，不自行改变项目策略。**`pre-merge-check.mjs` 返回的
`headRefOid` 必须原样带进 `merge-pr.mjs` 的 `--match-head`**（判定与执行之间的
原子护栏；wrapper 内部转成 `gh` 的 `--match-head-commit` 执行）：

```bash
gh pr review <N> --approve --body “<简短、基于事实的结论>”
node "<SKILL_ROOT>/scripts/merge-pr.mjs" <N> --strategy <squash|merge|rebase> \
  --match-head <headRefOid> --basis approved --delete-branch --mode interactive
```

**selfFixAuthors 自有 PR 的 self-merge**：当 `pre-merge-check` 返回
`selfMergeAvailable=true` 时（viewer = PR author 且 author 在 `selfFixAuthors`，
**且 PR 的 `isDraft` 字段严格等于 `false`**——这是硬门槛，draft 状态的自修复
PR 拿不到 `selfMergeAvailable=true`，必须先 mark ready 才可能被判定为可合；
判定用 `m.isDraft === false` 而非 `!m.isDraft`，字段读不到（`undefined`）时
同样不放行，fail-closed），GitHub 不允许同账号 approve，直接使用 `--admin`
合并：

```bash
node "<SKILL_ROOT>/scripts/merge-pr.mjs" <N> --strategy <squash|merge|rebase> \
  --match-head <headRefOid> --basis self-merge --admin --delete-branch --mode interactive
```

此路径仅在审查通过（零 P0/P1）、无冲突、thread 全 resolve 时启用。auto 模式
**不**执行 self-merge（只审不合）；交互模式不需要额外确认（selfFixAuthors 本身即维护者授权）。合并后同样
跑一次上方的 `notify-merge-ack.mjs` 播报步骤。

**admins 名单的结构性 BLOCKED 分级合并**：与上面的 selfFixAuthors self-merge 是
两条独立路径（不共享名单，也不互相推导），专门解「机械前提满足但缺
`reviewDecision=APPROVED`」这个口子（典型是 ownPr——GitHub 422 禁止对自己的 PR
提交 APPROVE，`reviewDecision` 永远拿不到；也可能是没人来 approve 的普通协作
PR）。此路由曾有一处可达性缺口：`reviewDecision=REVIEW_REQUIRED`/`null` 时若直接
短路判「缺 approval」、从不往下探测是否存在真实的结构性 blocker，在**不要求
approve** 的仓库里（`reviewDecision` 恒为空）会让本路由永久不可达——已修复，
approval 维度现在只影响「最终怎么归类」，不影响「要不要探测」（见
`classifyBlockedStatus`）。`context.mjs` 对结构性 BLOCKED 且作者在 `admins` 名单的
PR 给 `auto.action=review`（**不是**直接跳到合并，也**不是**
`skip-structural-block`），带 `auto.structuralBypassPending=true`：

1. 照常走阶段二独立审查；
2. 审查输出交给**唯一消费出口**裁决并落回执（SC-R1b：`write-review-receipt.mjs` 的
   public CLI 已**禁止** `--verdict clean`，clean 只能由 consumer 依据机器 verdict 写）：

   ```bash
   node "<SKILL_ROOT>/scripts/consume-review-output.mjs" <N> --output <rro-1.json> \
     --mode interactive --base <baseRefOid> --head <headRefOid> \
     --task <task.json> --preflight <preflight.json>
   ```

   退出码 0 = `clean`（已写带七项绑定的 clean 回执：{source, schemaVersion, outputHash,
   snapshotHash, ledgerHash, escapeSourceHash, knownHazardsHash}——后两项是逃逸数据源与
   命中路径 known hazards 的**全内容**哈希，clean 之后 PR body/关联 issue/canonical 变化
   都会让 pre-merge 的现场重算对不上而打 stale）；2 = `dirty`/`invalid`/`blocked`
   （已写 non-clean 回执，覆盖撤销同 snapshot 的旧 clean）。不能跳过这一步直接进第 3 步；
3. 调 `pre-merge-check.mjs` 复核，若返回
   `structuralBypassReady=true, structuralBypassBasis='admin-trust'`，执行：

   ```bash
   node "<SKILL_ROOT>/scripts/merge-pr.mjs" <N> --strategy <squash|merge|rebase> \
     --match-head <headRefOid> --basis admin-trust --admin --delete-branch --mode interactive
   ```

   脚本已经核验过回执的 `headRefOid` 与当前 head 一致且 `verdict=clean`（此前
   脚本只看机械前提就判 `true`，完全不管审查是否真的跑过、跑完后结论如何，是
   已修复的 fail-open 口子），不需要 agent 自己再确认；`structuralBypassReady=
   false` 时（无回执 / 回执针对旧 head / `verdict≠clean`）必须回到第 1 步重新
   审查、重新落回执，不能凭记忆认为"审过了就该行"；
4. 审查不通过（有 P0/P1）→ 按 5.2 正常打回，`admins` 身份不豁免代码质量要求。

`structuralBypassBasis='approved'` 时不受此限，**仅交互模式**可直接合、不必等这轮审查、也不需要
回执（auto 只审不合，见 §0 / 6.1）；但 **'approved' 的成立条件自 2026-08-04（#469 复盘）起是条件式,不再等于
`reviewDecision=APPROVED`**,由 `evaluateApprovalBasis` + `resolveApprovedShortcut`
（lib.mjs,context.mjs 与 pre-merge-check.mjs 共用,禁止各写判据）机器判定:
- `reviewDecision === 'APPROVED'`（GitHub 聚合裁决）是**必要但不充分**的合取条件
  （2026-08-04 复审修订）——它把审批数量、Code Owner、dismiss 规则都算在内,单条
  current-head approve 替代不了它(仓库要求 2 个 approval 时 1 条 approve 的聚合态
  仍是 REVIEW_REQUIRED,此时放行等于用 --admin 绕过未满足的 review 规则);反过来它
  单独也不充分——#469 正是 `reviewDecision=APPROVED` 但 approve 绑定旧 head;
- approve 必须**绑定当前 head**（`review.commit.oid === headRefOid`;approve 之后
  又 push/force-push 的旧 approve 一律 stale,不作数——fail-closed,commit 缺失/
  分页不完整同拒）;
- current-head approve 若**只来自巡审账号自己**（own-account,机器只认账号,分不清
  同账号下是真人还是自动化会话——同账号一律收紧是意图不是误杀）,且目标仓库配置
  `mergeAuthorization.ownAccountApprovalRequiresAck: true`,则还需
  `mergeAuthorization.breakGlassApprovers` 成员对当前
  head 发 `/approve-merge <head SHA>` 才成立;配置未开时保持现状放行;
- 存在**非巡审账号**的 current-head approve（independent）→ 任何配置下都成立。

**授权快速合并通道**（契约：正常交互合并必经阶段二自动化审查，本 skill 的 auto 永不合；目标仓库可配
`mergeAuthorization.requireAutomatedReviewForAutoMerge: true` 把该前提从意图变成
强制门（键缺失 = false 兼容；键存在但值非 boolean——null/string/number/object 等
显式 malformed——fail-closed 按 true 处理并显著告警，绝不静默放宽；
`mergeAuthorization` 容器整体也必须是 object——string/number/boolean/array 等非
plain object = 容器级 malformed，不抛错、整体 fail-closed（require 按 true、
`breakGlassApprovers` 按 [] 且不回退 admins）并显著告警点名容器必须 object）；人工
`/approve-merge` break-glass 是**唯一**免阶段二独立审查的例外（仅交互/人手可执行，auto 只落回执、不合）。P2-4：与上面的
「admins 名单的结构性 BLOCKED 分级合并」是两条完全不同、互不替代的路由，触发条件
不同、后果也不同，不要概括成一句——上面那条看的是 PR **作者**是否在 `admins` 名单
（admin-trust），触发后仍要走完阶段二独立审查、落回执才能合；本条看的是有没有
`mergeAuthorization.breakGlassApprovers` 名单的**评论者**在这条 PR 下发出授权命令，
触发后**跳过**
阶段二独立审查）：`mergeAuthorization.breakGlassApprovers` 名单成员在 PR 评论里发出
精确独占一行的
`/approve-merge <完整 40 位 head SHA>` 命令（先剔除 fenced code block 与 blockquote，
剩余每行 trim 后必须精确匹配该格式，不含任何行内追加说明——「独占一行」语义沿用
owner 2026-08-02 的收紧裁决；**授权绑定 head SHA，SC-A 2026-08-04**：命令里的 SHA
必须精确等于当前 `headRefOid` 才有效，push/force-push 换 head 即天然作废、需对新
head 重发。旧的「须晚于最后一次真实 push」时效判定已废除——它依赖的
`Commit.pushedDate` 被 GitHub 标记废弃、#469 实测 12 个 commit 全 null，普通 PR 上
会把全部授权误判 stale。旧裸格式 `/approve-merge`（不带 SHA）不再构成授权，脚本记
`legacyBare` 供提醒重发；评论若被编辑过——`updatedAt!==createdAt`——一律拒绝，
要求重发新评论，不接受编辑旧评论），构成「人工已过安全与代码审查」的明确授权。这是**紧急通道**——owner 2026-08-01 拍板：
管理员显式授权即自担责任，机器的职责从「拦」变成「留痕」。`context.mjs` 给
`auto.action=review-complete-hold-merge`（有 `/approve-merge` 授权）时，auto **仍不合**，
只写入汇总等交互/人手按下面命令合；交互模式才跳过阶段二、复核机械前提后合并：

```bash
node "<SKILL_ROOT>/scripts/merge-pr.mjs" <N> --strategy <squash|merge|rebase> \
  --match-head <headRefOid> --basis authorized-fast-merge --admin --delete-branch --mode interactive
```

若候选是 t2 loop 托管 PR（见 3.7「Loop 托管 PR 排除」），**本通道不适用**——
`pre-merge-check.mjs` 会直接返回 `authorizedFastMergeAvailable=false`
（`blockedReason=loop-managed-pr-fast-merge-forbidden`），必须改走正常审查
路径，不能靠一句 `/approve-merge <sha>` 绕过。

判定逻辑单一来源在 `scripts/lib.mjs` 的 `findApproveMergeAuthorization`（授权
本身是否有效）与 `evaluateAuthorizedFastMerge`（机械前提），`pre-merge-check.mjs`
在合并前用同一对函数重新现场检测，不信任 scan 时缓存，并对当前 head 真实重新跑
一遍安全与隐私内容扫描（此前本脚本对"是否有泄密硬命中"恒传 `false`、完全不扫描，
是本紧急通道最大的 fail-open 缺口，已修复）。**任何情况不可绕过**只剩三类：
安全与隐私门硬命中（`security.hardHits`；且扫描必须真的**成功完成**——
`security.scanned=false`，如 diff 拉取失败，一律 fail-closed 当"未证明无泄露"
处理，绝不能当"无命中"放行，需重试）、无冲突（`mergeStateStatus` 不为 `DIRTY`，
物理不可合）、head 上 required 检查全绿（完整性核验：与分支保护实际要求的
context 名单做差，从未上报过的必需检查按 pending 处理，不因"没出现在已上报清单
里"就当绿）。**不阻断但必须显著写进汇总与合并致谢**（`authorizedFastMerge.
reportOnly` / `authorizedFastMergeInfo.reportOnly`，不能悄悄吞掉）：格式门未
通过、未 resolve thread、非 required 第三方检查（如 Greptile）失败——授权解的是
「要不要再审、要不要等这些收尾问题」，不是「PR 本身物理上能不能合」。产品/UI 门
与技术架构门优先级高于本通道——命中时按 3.4 正常 hold，本通道只解决「要不要再审
代码」，不解决「这次改动该不该推进」。合并后同样跑一次 `notify-merge-ack.mjs`
播报步骤，`--details` 必须包含 `reportOnly` 里非空的项。

方括号中的策略必须先按仓库设置和维护者约定选择一个，不要由 skill 自行改变合并策略。
若仓库启用 merge queue 或命令被保护规则拒绝，记录状态并结束，不反复重试或绕过保护。
合并后重新读取 PR 状态和 base 分支健康状态，再写最终总结；随后运行一次
`node "<SKILL_ROOT>/scripts/notify-merge-ack.mjs" <N> --summary "<一句话改动摘要>" --details "<改动要点>"`
发合并致谢播报（`loopPrExclusion.mergeAckNotify.notifyModule` 未配置时该脚本
no-op，`posted:false`，不影响合并本身；loop 托管的 PR 有自己的播报，脚本内部已
判定跳过，见 3.7）。两个参数的口径：
- `--summary`：一句话说清这个 PR 对使用者的影响（进主消息正文，跟在致谢后）；
- `--details`：3-5 行改动要点，每行一条、`• ` 开头，面向来审阅的人写"改了什么/
  为什么"，从你刚完成的审查结论里提炼，不写行号不贴代码，零表情。仅当播报
  通道为 Slack Web API（notify.env 配了 `SLACK_BOT_TOKEN`+`SLACK_CHANNEL_ID`）
  时它会作为主消息的 thread 回复发出；webhook 通道拿不到消息 ts 无法 thread，
  此时 details 静默不发，不要把要点挪进 --summary 凑长度。

<!-- dist:strip:end preview-5.1 -->
### 5.2 不通过：请求修改
<!-- dist:strip:start preview-5.2 -->

存在任一 P0/P1 时，按「对外话术与人格边界」模板 A 起草简洁、可执行的 review
（人格淡，傲娇最多一处半句，结尾必须消除"要去求人重审"的心理负担）：

- 每条意见绑定文件和行号；说明现象、影响、触发条件和建议验证；
- 先列阻断问题，再列必须补充的测试或说明；不写 P2；
- 不重复历史上已解决且已验证的意见；
- 不泄露凭证、内部路径或审查 agent 的隐含推理。

**交互模式先分叉再动作**：起草打回前，先把 P0/P1 清单报告给用户，再用
`AskUserQuestion` 给出三个选项：

1. **打回请作者修**（默认）——走下方 `REQUEST_CHANGES`；
2. **代修合并**——按 5.6 先合并、后在默认分支修复全部问题并评论告知作者；
   仅当 5.6 的边界条件全部满足时才提供该选项（安全硬命中、gate 未过等场景不提供）；
3. **只报告不动作**。

作者在 `selfFixAuthors` 时也不开跟进会话（5.4 已停用）；交互模式只报告卡点，
不提供「开跟进会话」选项。代修合并仍按 5.6 边界，不因 selfFix 改道。

选择打回时，确认后执行，`event` 按 `context` 的 `auto.ownPr` 二选一——`ownPr=false`
（打回别人的 PR）用 `REQUEST_CHANGES`；`ownPr=true`（viewer 与 PR 作者是同一个 GitHub
账号，本流程的自动化账号打回自己开的 PR）GitHub 硬性禁止对自己的 PR 提交
`REQUEST_CHANGES` / `APPROVE`（API 直接 422），改发 `COMMENT`（仍带完整问题清单与行级
comment，只是事件类型不同）：

```bash
# ownPr=false → --request-changes；ownPr=true → --comment（GitHub 禁止对自己的 PR 提交
# REQUEST_CHANGES/APPROVE）。行为不因 auto/交互模式而异——这是 API 硬限制，不是策略选择。
gh pr review <N> [--request-changes|--comment] --body "<问题清单>"
```

能稳定锚定代码行时使用 GitHub review thread；无法锚定时用顶层 review，不能伪造行号。
auto 模式只在没有相同未解决 review、且本次确有新的 P0/P1 时提交；否则跳过写入并汇总。
auto 模式没有代修合并——该路径仅限交互模式由用户逐次授权。

**`ownPr=true` 时的特殊后果**：真正挡住合并的不是 `event` 类型，而是仓库分支保护规则
是否配了 `required_review_thread_resolution`——只要提交的 review 里有 `comments[]`
生成的行级 thread 处于未 resolve，`mergeStateStatus` 就会停在 `BLOCKED`，与 `event`
是 `REQUEST_CHANGES` 还是 `COMMENT` 无关；`ownPr=false` 时 GitHub 还会额外靠
`reviewDecision=CHANGES_REQUESTED` 挡一层，`COMMENT` 事件不产生这层阻塞。因此
`ownPr=true` 时要把每条 `[阻断]`/`[必改]` 尽最大努力锚成行级评论；**锚不到行、只落进
body 总述的意见，若仓库没有该项 required check，就没有任何机制挡住合并**——必须在
1.7 报告与汇总里以「需要你」开头显著提示，提醒自己合并前手动确认已处理。

<!-- dist:strip:end preview-5.2 -->
### 5.3 维护者专用分流

- `format.hitsServer=true` 且没有作者已通知 Lizi 的证据：无论代码审查是否通过，都走
  Server gate 的 3B，不得 auto 放行。
- `selfFixAuthors` 的作者侧问题不提交对自己无效的 `REQUEST_CHANGES`（GitHub 会 422），
  只在汇总里点名卡点；**禁止按 5.4 开跟进会话**。审查通过后仍可正常合并（含 5.1 的 self-merge）。
- fork workflow 待批准执行 `approve-workflows.mjs`；PR 改过 CI 文件时 auto 跳过并在
  汇总点名维护者。
- `gate.blockClass=structural-check` 不是作者代码问题；机械前提（bypass 权限**且**
  `structuralBlock.requiredCheckRules` 全部命中 `pr-rules.json` 的
  `structuralBypassAllowlist`，未配置时默认 `code_scanning`/`code_quality`）之外，
  还要满足三层分级之一（approved shortcut 成立（`reviewDecision=APPROVED` 聚合裁决
  ∧ approve 绑定当前 head ∧ own-account 配置约束通过，见 5.1），或作者在 `admins`
  名单且已有针对**当前 head** 的 `verdict=clean` 审查回执（本轮独立审查通过后由
  `write-review-receipt.mjs` 落盘））才能 admin merge，否则跳过，不把它写成 P1 打回——详见 5.1「admins
  名单的结构性 BLOCKED 分级合并」与
  [references/internal-gates.md](internal-gates.md)。
- `gate.blockClass=ci-unknown`（CI 状态读取失败：权限/网络/解析问题）不是
  structural-check，绝不可 bypass、不催办——本轮跳过，下一轮重新探测。
- 命中 `loopPrExclusion` 且判定为 loop 自管（`skip-loop-managed`）：不审、不合、
  不催，交给该 loop 自己收尾（详见「Loop 托管 PR 排除」）；未配置该键时此分支永不触发。
- 命中 `securityReviewPaths`（`security-gate`）或 `ruleFiles.required`（`rules-gate`）：
  按维护者确认门（signoff）hold——挂 `awaiting-discussion` 标签 + 开讨论 issue +
  状态评论，admins Approve 即放行（门类持久——跨 commit 靠放行标记，Approve 绑定当前
  head，见 3.4），放行前不自动审、不自动合、放行
  后按 `auto.fallback` 继续（详见「审查执行环境安全」「审查规则文档门」）；未配置
  对应键时这些分支永不触发；`mergeAuthorization.breakGlassApprovers` 名单成员发
  `/approve-merge <当前 head 完整 40 位 SHA>` 授权时，auto 标 `review-complete-hold-merge`、**仍不合**；
  交互/人手才按 5.1「授权快速合并通道」合。
- 产品/架构 hold、issue release、通知、self-merge（仅交互）和收尾 issue 的详细动作均按
  [references/internal-gates.md](internal-gates.md) 执行，脚本返回错误时
  不重复写入或猜测成功。

### 5.4 自动跟进修复（fix-handoff）：已停用，禁止开跟进会话
<!-- dist:strip:start preview-5.4 -->

**停用（2026-09-03）**：本流程**不得**为任何 PR 开、复用或 jump 跟进修复会话。
禁止调用宿主 handoff / `send_to_session`（create 或 jump）去修 PR。
`selfFixAuthors` 命中时同样禁止。没有「跟进会话」这条出路。
卡点只写汇总 / 打回，等人处理。巡审会话自己也不改 PR 代码。

`fix-session-state.mjs` 的 `get` / `set` 已拒绝投递（`shouldDispatch` 恒 false；
`set` 直接失败）。不要把旧绑定、`shouldDispatch` 或「还在修」当成可以开会话。
每轮阶段一扫描后只允许：

```text
node "<SKILL_ROOT>/scripts/fix-session-state.mjs" sweep --open <open PR 列表>
node "<SKILL_ROOT>/scripts/fix-worktree-cleanup.mjs" --scan
```

sweep 只清已合并／关闭 PR 的历史绑定；cleanup 只回收托管目录里的历史 worktree
（`.cindy-worktrees`、`.xdt-worktrees`、`.claude/worktrees`、`.worktrees/review-pr`、
`REVIEW_PR_WORKTREE_ROOTS`）。两者都不是投递入口。安全边界全在脚本里：默认分支、
locked、含 cwd 的树永不碰；查不到对应 PR 的不动。失败不阻塞本轮。

交互模式走到该打回／该等作者的分叉时：只报告卡点，不问「要开跟进会话吗」，
也不提供该选项。auto 同样禁止投递，卡点进汇总「需人处理」；auto 禁止
`merge-pr.mjs` / `gh pr merge` / 5.5 主干 push。

<!-- dist:strip:end preview-5.4 -->
### 5.5 冲突代合并（主干侧解决，不推作者分支）
<!-- dist:strip:start preview-5.5 -->

当前账号没有向他人 PR 分支推送的权限，因此**永远不向 PR head 分支推代码、不
rebase、不 force-push**。冲突的代处理只有一条路：在主干侧做一次"带冲突解决的
合并"——本地把 PR 分支 merge 进默认分支、在 merge commit 里解决冲突、验证后推送
默认分支；PR 的 commit 进入默认分支后 GitHub 会自动把该 PR 标记为 merged。

**进入门槛只有一条**：独立审查已通过（0 P0/P1），且格式门、产品/架构 gate、
thread resolve、required checks 等其余条件**全部**满足——唯一剩下的阻断就是与
base 的冲突。任何其他 gate 未过的 PR 一律不代解冲突，照常走打回/跳过。
交互模式唯一例外：审查存在 P0/P1 时，经用户在 5.2 分叉里明确选择，可升级为 5.6
代修合并（合并后在默认分支修复问题）；auto 模式无此例外。

满足门槛后，冲突性质只决定由谁执行：

- **机械冲突**（lockfile 重新生成、相邻行互不相关的改动、与 3.6 依赖链中已合入
  代码的重复上下文等）：交互模式确认后执行；auto 模式**不**执行（只审不合，写入汇总等交互/人手合）；
- **语义冲突**（需要在两种业务逻辑之间做取舍）：交互模式先展示冲突文件和解决
  方案，经确认后执行；auto 模式不擅自取舍——一律写入汇总点名维护者（5.4 已停用，
  `selfFixAuthors` 也不另开会话）；
- 拿不准算语义冲突。

**执行步骤（在隔离 worktree，不碰主工作树）**：

1. 新建 worktree 检出最新默认分支；fetch PR head（`refs/pull/<N>/head`）；
2. `git merge --no-ff <PR head SHA>`，merge message 写
   `Merge pull request #<N> from <headRef>`（保证 GitHub 关联到 PR）；
3. 只解决机械冲突；解完运行与风险匹配的验证——至少 typecheck/构建，命中测试路径
   则跑对应测试，可复用 `typecheck-merged.mjs` 的检查口径；验证失败即 abort，
   不推送半成品；
4. push 默认分支（普通 push，不 force）；被分支保护拒绝时放弃并报告，不绕过；
5. push 后用 `gh pr view <N>` 确认 PR 已被标记 merged；确认后按正常收尾：评论说明
   "以主干合并方式落地，解决了 <文件列表> 的冲突，验证：<命令与结果>"，删除远程
   分支（若为同仓分支），运行 `close-product-issue.mjs` 等收尾脚本；
6. merge commit 里除冲突解决外不夹带任何其他改动；同一轮只对一个 PR 做主干侧
   合并，完成并确认后再处理下一个，避免主干连续变基造成误判。

**汇总要求**：走本路径落地的 PR 在汇总中标注"主干代合并"，写明冲突文件与验证
结果；abort 的写明"语义冲突，转作者"。

<!-- dist:strip:end preview-5.5 -->
### 5.6 代修合并（merge-then-fix，仅交互模式）
<!-- dist:strip:start preview-5.6 -->

帮别人合并时审查发现 P0/P1、或还叠着冲突，而维护者不想再和作者往返——可以选择
"先合并、后修复"：先按 5.5 的主干侧合并把 PR 落进默认分支（冲突只在 merge commit
里解决），再在默认分支上把审查发现的问题全部修掉，验证通过后一次推送，最后评论
告知作者。全程不向 PR head 分支推任何东西。

**边界（任一不满足即不提供本选项）**：

- 仅交互模式；auto 模式一律不走本路径（auto 仍按 5.2/5.5 处理，5.4 已停用）；
- 安全与隐私门硬命中（`security.hardHits`）的 PR 绝不走本路径——合并会把凭证永久
  带进默认分支历史；照常按 3.1 打回清历史并轮换。审查定性为真实凭证/隐私数据的
  P0 同理；
- 产品/UI 与技术架构 gate 必须已豁免或已获白名单同意，不能用"合并后我来改"绕过
  讨论流程；
- required checks 失败或仍在运行时不合并；结构性 `BLOCKED` 仍按
  [references/internal-gates.md](internal-gates.md) 的 admin 条件；
- 修复量必须在"本轮能改完、能验证"的范围内：问题多到接近重写、或涉及连维护者也
  拿不准的语义/产品取舍时不硬修，回到 5.2 打回或先与作者讨论；
- 作者在 `selfFixAuthors` 时不走本路径（5.4 已停用，不开跟进会话；卡点只报告）；
- 每步写操作（合并落地的推送、评论、删远程分支）仍逐项 `AskUserQuestion` 确认。

**触发**：交互模式、作者不在 `selfFixAuthors`、审查报告存在 P0/P1（可同时叠加与
base 的冲突），用户在 5.2 的分叉里明确选择"代修合并"。

**执行步骤（隔离 worktree，不碰主工作树）**：

1. 与用户逐条过一遍修复范围：每个 P0/P1 的 `path:line`、现象与打算的修法，以及
   冲突文件清单（如有）；用户可以剔除某些条目改为评论里提醒作者后续处理，但 P0
   不允许剔除——P0 修不了就整体放弃本路径；
2. 按 5.5 步骤 1–2 在隔离 worktree 检出最新默认分支、fetch `refs/pull/<N>/head`、
   `git merge --no-ff <PR head SHA>`，merge message 写
   `Merge pull request #<N> from <headRef>`；merge commit 里只解决冲突，无冲突则
   干净 merge，绝不夹带问题修复；
3. 在同一 worktree 里把确认过的问题逐条修复，作为 merge commit 之后的独立
   follow-up commit——一般一个逻辑问题一个 commit，message 用
   `fix after #<N>: <对应意见摘要>`；修复遵守 AGENTS.md、docs/dev-rules 与命中的
   专项规则，不借机重构无关代码；
4. 运行与风险匹配的验证：至少 typecheck/构建（可复用 `typecheck-merged.mjs`
   口径），命中测试路径则跑对应测试。验证失败先修到过；修不动就整体放弃——丢弃
   worktree 里未推送的 commit，回到 5.2 打回，不推半成品；
5. 合并与修复全部在本地完成后，经用户确认**一次 push** 默认分支（merge commit +
   follow-up commits 一起，普通 push 不 force），避免默认分支出现已知有问题的
   中间状态；被分支保护拒绝就放弃并报告，不绕过；
6. push 后用 `gh pr view <N>` 确认 PR 已被标记 merged；删除远程分支（同仓分支且
   确认后）、运行 `close-product-issue.mjs` 等收尾脚本；
7. **回复作者（必做，经确认后发）**：在 PR 上发一条评论，内容包括：
   - 已代为合并（主干侧 merge），冲突解决的文件列表（如有）；
   - 逐条列出代修的问题：`path:line`、现象与影响、修法、对应 follow-up commit
     短 sha，方便作者对照学习；
   - 实际运行的验证命令与结果；
   - 用户剔除、留给作者后续处理的条目（如有）单独列出；
   - 语气按"帮忙落地 + 供参考"写，不指责；安全类条目按 3.1 输出纪律只写
     文件/行号/类型，不复述命中原文。

**汇总要求**：走本路径的 PR 在最终结论/汇总中标注"代修合并"，写明冲突文件数、
代修问题数（P0/P1 计数）、follow-up commit 列表与验证结果，以及告知评论已发/未发。

<!-- dist:strip:end preview-5.6 -->
### 5.7 收敛止损（收敛检查点与红色通报，机器侧触发）

本节消费 4.2 `record-convergence-round.mjs` 返回的 `checkpointRequired` /
`notification`——本节只定义**触发条件与拦截点**（机械判断），不定义检查点本身
要问哪六个问题、也不定义播报的人格化措辞，那两块分别是收敛检查点契约文本与「对外
话术与人格边界」的既有职责范围，本节只负责把机器算出的信号接进正确的流程节点。

**通知机制按两层拆分（SC-C4 调查带出的要求，2026-08-02；gpt 复核后收窄结论
措辞——见下）**：SC-C4 在 **2026-07-28～08-02 这一观测窗**（31 次运行、12 个
进入阶段二独立审查的 PR、其中 1/12 触发过重审）内**未观察到**中间态重审放大，
当时暂不引入 debounce，理由是"cron ~3h 网格本身就是隐式 debounce"——**该前提已于
2026-08-04 随 cron 改为 1h 全天网格而不再成立**（观测窗数据仍有效，失效的是那条
论证）。1h 网格下作者连推 commit 被中间态反复重审的放大风险上升，但当前仍未实测到，
故本轮不动机制、只作废前提：debounce 保留作观测项，重审放大风险**待观测**，样本积累
到能反驳"无需 debounce"这个结论时应重新评估（这从来不是"review-pr 结构上不可能出现
重审放大"这种全称判断）。这次调查顺带查出一个真缺口——非 required
的第三方 bot（如 Greptile）长期缺席时，PR 会无限期挂在
`skip-gate`/`threads-unresolved`，没有"等待方缺席"的升级机制（本轮不做，另开
处理）。为了不让那次改动需要重构本节的通知投递管线，通知在设计上就拆成两层，
本节只落地第一层的一种触发源：

- **触发判定**（可插拔，本节只实现"round/new-family"一种）：`recordConvergenceRound`
  算出连续未收敛轮数达到 `CONVERGENCE_NOTIFY_THRESHOLD` 时产出
  `notification = {reason: 'round-nonconvergence', prNumber, head, thresholdKey,
  detail}`；未来的"等待方缺席 N 轮"触发源会是完全独立的判断逻辑（很可能不来自
  审查轮次），不复用这段判断，但复用下面的投递+去重层。
- **通知投递 + 去重**（`hasNotified`/`markNotified`，与触发源无关）：去重键是
  `reason`+`thresholdKey`+`headRefOid` 三元组，`reason` 进键是为了让将来的
  "缺席"触发不会被"round"触发已经发过的去重记录误吞，也不会反过来污染 round
  触发自己的去重状态。

**`checkpointRequired=true`（连续 `CONVERGENCE_CHECKPOINT_THRESHOLD` = 5 轮仍有
新 P0/P1 家族，或本轮检测到收敛状态文件损坏被强制触发，见 4.2；此项**故意**无
去重/无通知投递层，纯粹是每轮重新算的活门，收敛后自然消失——**这不是漏做，是
刻意的**，但理由不是"任何去重都必然让门 fail-open"这种全称（gpt 2026-08-02
复核后收窄措辞：理论上一份绑定 head+本轮输入内容 hash 的 completion receipt，
可以既避免重复提示又保持 fail-closed——下次输入没变就不用再提示，输入变了立刻
重新提示，这样的去重不会 fail-open）。真正的理由是：`checkpointRequired` 这个
requirement 信号**不按通知投递去重**；本模块当前**没有**实现这样的 completion
receipt，"这一轮是否已经产出过收敛检查点六件套"没有任何机器可核验的凭证——在
这个前提下，唯一安全的做法就是每轮重新算、条件仍成立就仍然提示，重复提示是
**当前**依赖 T1 过程约定（agent 自己记得"这轮已经写过六件套了"）而非机器强制的
安全网，不是"永远不能加去重"的教条。本轮**不新增** completion receipt 机制
（确认门：删掉这个机制，`checkpointRequired` 的目标——"下一个修复 commit 前
必须先产出六件套"——照样成立，只是没有去重，新增属于范围外的死复杂度）。
`notification` 是对外投递，同一 head 重复发是真的刷屏，去重是对的——两者去重
与否的差异由各自语义/是否有可核验凭证决定，不是随意的，改动前务必想清楚这一
点，不要因为看到"通知去重了、检查点没去重"就顺手给检查点也补一层）**：

- **`selfFixAuthors` 的 PR**：5.4 已停用，**不得**再为复发开跟进会话或投递下一轮
  修复任务；卡点只进汇总 / 打回。收敛检查点请求按下面常规 PR 口径写进打回正文
  （ownPr 发 COMMENT 时同样带上），不要当成「可以开会话」的信号；
- **非 self-fix 的常规 PR（5.2 打回路径）**：本轮打回评论正文里必须显式带一段完整
  的检查点请求（列出连续未收敛的家族清单，逐条附 `invariant` 与最近一次
  `priorHead`/`priorDescription`；具体措辞按「对外话术与人格边界」现有基调写，
  不新造模板），提醒作者/维护者在继续修之前先确认根因，而不是本 skill 自己代替
  人工完成检查点。

**`notification` 非 null（当前唯一触发源：连续达到 `CONVERGENCE_NOTIFY_THRESHOLD`
= 10 轮仍有新 P0/P1 家族，且当前 head 尚未对 `notification.reason` +
`notification.thresholdKey` 这一组合通知过）**：

1. 读 `pr-rules.json` 的 `summaryBroadcast.command`（4.2 起同一份配置，不新增
   配置项、不硬编码群/收件人；未配置则该门关闭，只在内部汇总标注一句
   "本 PR 已连续 ≥10 轮未收敛，但目标仓库未配置 summaryBroadcast，无法主动播报"）；
2. 已配置时，把一段事实性正文（`notification.detail` 里的连续轮数、
   `recurringFamilies` 摘要、PR 链接；语气仍遵循「对外话术与人格边界」现有基调，
   不额外新造模板编号）经
   `<正文> | node "<SKILL_ROOT>/scripts/notify-summary.mjs" --title "<标题>"`
   发出——复用 6.1 owner 每轮汇总已在用的同一条播报出口，不新建通道；
3. **无论** `notify-summary.mjs` 返回 `posted` 是否为真，只要走到"决定要发"这
   一步，都先调用
   `node "<SKILL_ROOT>/scripts/record-convergence-round.mjs" <N> --record-attempt --reason <notification.reason> --threshold <notification.thresholdKey> --head <headRefOid>`
   记一次尝试（运维可观测性用，不参与任何去重判定，失败也要记，这样才能查到
   "已经试过 N 次、每次都失败"而不是"从没到过阈值"）；
4. **只有 `posted === true`（确认投递成功）时**才调用
   `node "<SKILL_ROOT>/scripts/record-convergence-round.mjs" <N> --mark-notified --reason <notification.reason> --threshold <notification.thresholdKey> --head <headRefOid>`
   回写去重（D4 阻断修正：此前"只要走到决定要发这一步就 mark"，配置缺失/子
   进程失败也会被 mark，导致这个 head 从此永久静音——**失败绝不能 mark**）——
   按 `reason`+`threshold`+`head` 三元组去重（同一 head 不重复刷屏；新推的 head
   若仍未收敛会重新触发，不是"发过一次就永久静音"）。失败路径不需要额外重试
   机制：下一轮换到新 head 时 `consecutiveRoundsWithNewFamilies` 仍 `>=` 阈值，
   会在新 head 上重新判定，自然触发下一次尝试。

**边界**：本节的检查点/通报都是"提醒人介入"，不是自动阻断合并的新 gate——是否
合并仍完全由 4.1/5.1/5.2 现有判定决定；`checkpointRequired`/`notification` 非
null 本身不构成新的 P0/P1，也不写入 `p0p1Count`。

### 5.8 合并出口与审计（SC-C,2026-08-04 #469 复盘）

- **所有合并一律经 `scripts/merge-pr.mjs`**（5.1 的四条路径——approved / admin-trust /
  authorized-fast-merge / self-merge——命令块均已改为该出口）,不得直接执行 `gh pr merge`。
  它强制 `--match-head`（判定与执行之间的原子护栏）,并做两相审计:执行前 append
  `intent` 到状态目录 `merges.jsonl`（写失败即拒绝合并——审计不可用时宁可不合）,
  执行后 append `result`（共用 opId;身份查不到时拒绝执行——审计"谁在合"不允许为空,
  #469 教训）;merge 成功后崩溃留下的孤儿 intent 由
  `merge-pr.mjs --reconcile` 只读核对 PR 实际状态补齐（只认 `OPEN|MERGED|CLOSED`
  三种已知 state,未知形状保持孤儿留待下轮,不封口;auto 模式每轮扫描后跑一次,命令
  落点见 §6 阶段 1,幂等、失败不阻塞）。`--dry-run` 打印 would 并零执行、零审计写,
  供演练。`--basis` 只收 5.1 四条路径（approved/admin-trust/authorized-fast-merge/
  self-merge,后三条 admin 路径必须显式带 `--admin`,保证审计 basis 与真实命令一致）。
  5.5 冲突代合并/5.6 先合后修是本节审计边界外的**显式例外**:它们从不 push PR 分支,
  而是在隔离 worktree 把 PR 分支 merge 进默认分支并 push **默认分支**,GitHub 随即
  自动把 PR 标记为 merged——全程不执行 `gh pr merge`,因此不经本出口、也没有对应
  basis;其留痕走 5.5/5.6 自己的评论与汇总要求(run-log 的 outcome 词表里的
  `conflict-merged`/`merge-then-fix` 是轮次结果口径,与本出口的 basis 枚举是两个
  不同口径,不可混用)。
- **诚实边界**:以上只约束"经脚本出口"的合并;agent 在 shell 里绕开出口直接敲 raw
  `gh pr merge` 不在机器承诺内——tests 的静态 inventory（static-merge-inventory.test.mjs）
  保证 skill 自己的脚本里除该出口外零合并形态,但约束任意 agent 行为靠过程纪律,
  不冒称机器强制。
- **stale-approval 的职责分工**（与 5.1 的 approved 条件式配套）:GitHub 分支保护的
  `dismiss_stale_reviews`（服务端,覆盖所有人,新 commit 即作废旧 approve）是第一道;
  `evaluateApprovalBasis` 的 head 绑定判定（skill 层,该设置被关/其他接入仓未开启时
  仍然拒 stale approve）是兜底。两者有意重叠（纵深防御）,代码只产出一条归一化
  reason,不双报。事故背景一行:2026-08-04 mivo-canvas #469,同账号 approve 后
  force-push,旧 approve 经 reviewDecision=APPROVED 被自动化当无条件绿灯合入。

### 5.9 open-findings 核销门与逃逸学习闭环（SC-R5/R7，2026-08-05）

- **台账**：任何席位（auto / 交互 / preflight 命中）提出的 finding 都由
  `consume-review-output.mjs`（**单一写者**）落 per-PR 台账。`findingId` 机器派生
  （`invariantKey|path|line`），跨轮身份只认 `invariantKey`，不用单轮 `family_id`。
- **核销门**：下一轮的任务里会注入全部 `effective-open` 的 findingId，审查必须逐条给
  `resolved`（带**新 snapshot** 的证据锚点——同 snapshot 自称已修一律拒：代码没变，
  问题不会自己消失）或 `invalidated`（带判误报依据）。未逐条处置 → `invalid`。
  这堵的是 #469 的洞:**本地席位拒过的问题，换个席位开审就等于清零重来**。
- **effective-open 谓词**：`open` ∪ 未经交互确认的 `invalidated`（模型单方"误报"主张
  不关门）∪ snapshot 已漂移的 `accepted-risk`。`preflight` 命中只能由**同 ruleId+
  ruleVersion 在新 snapshot 重跑不命中**自动核销——规则实现变了不冒充"代码已修"。
- **pre-merge 独立复核**：合并阶段重建当前 complete snapshot + 重读台账，要求
  `effective-open=0 ∧ accepted-risk=0` 且回执绑定的 `snapshotHash`/`ledgerHash` 全匹配。
  这挡住"先拿到 clean、之后又新增 open"和两步之间的崩溃窗口。台账损坏 fail-closed。
- **逃逸学习闭环（机器触发，非过程约定）**：合并后被后续 PR 证伪的 false negative
  （#469→#483 就是原型）走这条链，每一段都有机器动作：
  1. `build-review-task.mjs` 从 PR body **与关联 issue**（默认自己现场 `gh pr view
     --json body,closingIssuesReferences` 取；离线用 `--pr-body-file` /
     `--related-issues-file` seam）确定性抽出**逃逸候选**（引用了哪些 PR + 修复语义信号；
     有意偏向多收，宁可多问一句），逐条写进任务正文。**数据源必需且绑定**：取不到即
     `escapeSourceIncomplete` → 本轮 `invalid`，不得据"无候选"放行；
  2. 审查输出的 `escapeAssessment[]` 必须**逐条覆盖**候选集（缺/多/未知/重复 → `invalid`）；
  3. `consume-review-output.mjs` 对 `verdict:"yes"` 的候选**确定性写 pending inbox**
     （`pending-fix-merge`），`originHead` 现场取完整 40 位 SHA（拿不到即登记失败）；
     登记发生在 provisional verdict **非 invalid 之后**——本轮若因覆盖/必答/task 不合法
     而 invalid，不留任何 durable state；登记失败 → `invalid`，不放行；
  4. **生产触发点 = 合并出口**：`merge-pr.mjs` 合并成功后自动调
     `record-escaped-finding.mjs --activate`（输出带在 `hazardActivation` 字段里），
     不依赖任何手工命令。激活时现场核验 fix PR 已 MERGED **且 merged head === 登记的
     fixHead**、origin PR 也确实已合并且 head 与登记的 `originHead` 一致、且 hazard 绑定的
     repo === 当前仓；
  5. canonical upsert → 回读校验 → **commit&push 成功**，三者全过才 ack（从 inbox 移除；dist 分发版无回推：回读校验通过即 ack）；
     任一失败保留 inbox 下轮重放（幂等 upsert，重复不增条、不降级）。若 push 报
     `nothing-to-push`（上一轮已推成功但进程崩在 ack 之前），必须读**远端** canonical
     确认该 hazard 已 active 才安全 ack；
  6. 之后命中同 `repo` + 同 paths 的 PR，任务正文里就会带上这条 hazard。

  `promotionStatus` 必须明确选择：`landed`（已晋升为确定性规则/profile 必答，且目标**在
  注册表里真实存在**、版本可解析）/ `recorded-only`（必填理由）/ `pending`。canonical 条目
  按完整 schema 校验（缺 repo/fingerprint/paths/fixHead/originHead/evidence 一律判不完整
  → `invalid`）。`grandfathered` 白名单**当前为空**——不存在免 head 核验的通道；要加必须
  往代码里那个显式 id 集合写死。`hazardId` 只绑**稳定事件身份**（repo + origin/fix PR 号 +
  两侧 head OID），自由文本 pattern 只作 evidence，换个措辞不会生成新条目。
  **诚实边界**："这次算不算逃逸"仍是语义判断（T1）；机器保证的是候选集确定性产出、必答
  对账、yes 项必登记、双状态机不可跳步、激活现场核验、ack 晚于 push、prompt 真实注入。
