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
### 5.2 不通过：请求修改
### 5.3 维护者专用分流

- `format.hitsServer=true` 且没有作者已通知 Lizi 的证据：无论代码审查是否通过，都走
  Server gate 的 3B，不得 auto 放行。
- `selfFixAuthors` 的作者侧问题（preview 版：5.4 fix-handoff 与 5.1 合并已剥离，这类卡点在内部审查输出中标注「需维护者跟进」，不投递、不打回）；
- fork workflow 批准（preview 版：`approve-workflows.mjs` 已剥离，workflow approval 放行交由维护者在主仓执行）；PR 改过 CI 文件时 auto 跳过并在
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
### 5.5 冲突代合并（主干侧解决，不推作者分支）
### 5.6 代修合并（merge-then-fix，仅交互模式）
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
2. **preview 版：对外播报出口已剥离**（`notify-summary.mjs` 不在产物中）：本触发不主动发消息——把 `notification`（连续轮数、`recurringFamilies` 摘要、PR 链接）写进 6.1 汇总的「收敛警告」组，由 owner 本机查阅；`--record-attempt`/`--mark-notified` 去重回写随播报一并剥离，不再调用。

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
  5. canonical upsert → 回读校验 → **commit&push 成功**，三者全过才 ack（从 inbox 移除）；
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
