# Auto 批处理、汇总与对外通知

> 本文件由 `SKILL.md` 渐进披露拆出，正文与拆分前逐字一致。从 `SKILL.md` 按需 Read，不要经其它 reference 二次跳转。

## Contents

- 6. Auto 批处理
- 6.1 汇总输出格式

---

## 6. Auto 批处理

进入 auto 模式的第一步（扫描前），打印一行本轮 provenance——纯可观测性，不改变
任何判定，只为事后排查"这轮到底读的是哪份配置、读了哪些权威规则、通知发去了哪"。
**来源路径必须调用 `lib.mjs` 的 `loadRulesWithSource()` 取真实值**（返回
`{ rules, rulesFile }`，`rulesFile` 就是三层优先级解析后实际采用的那份配置文件的
绝对路径），不要让 agent 自己重演 `REVIEW_PR_RULES_FILE` 环境变量 / 目标仓库
`agent-use/docs/pr-rules.json` / Skill 自带 `config/pr-rules.json` 这三层优先级去猜——
猜错会导致 provenance 报告的来源和实际读取的配置不一致：

```text
本轮 provenance：rules=<loadRulesWithSource() 返回的 rulesFile 绝对路径>，
repo=<owner>/<repo>，ruleFiles.required=<该配置 rules.ruleFiles?.required 的清单，
为空写"未配置额外规则文件">，summaryBroadcast=<summaryBroadcast.command 已配置则写
解析后的绝对路径，未配置写"未配置">，mergeAck=<loopPrExclusion.mergeAckNotify.
notifyModule 已配置则写路径，未配置写"未配置">，人格品牌=<对外话术模板里第一人称
之外用于自称的品牌名，如"Mivo"；本 skill 默认无品牌名则写"无">
```

样例（在 mivo 仓跑）：

```text
本轮 provenance：rules=/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/agent-use/docs/pr-rules.json，
repo=xindong/mivo-canvas，ruleFiles.required=[AGENTS.md, CLAUDE.md]，
summaryBroadcast=/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/scripts/loops/bug-doctor/broadcast.mjs，
mergeAck=/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/scripts/loops/bug-doctor/notify.mjs，
人格品牌=Mivo
```

auto 模式分三阶段，目标是确定性、可重试和不互相污染：

1. **扫描**：一次运行 `context.mjs --scan-all`，消费 `results` 和
   `heldDraftResults`，按创建时间排序；格式失败、普通 gate 未过或权限不足的候选记为
   skip，不 checkout；`security.hardHits` 非空的候选按 `pushback-security` 优先打回
   （不 checkout、不进审查）。记录每个候选的 base、head SHA、文件路径和原因，并用候选间的
   `baseRefName`／head 分支交叉比对标出 stacked 依赖（见 3.6）。（preview 版：5.4 fix-handoff 与 worktree 回收已剥离，相关脚本不在产物中，本段跳过。）
   （漏播的合并致谢由 `pre-check.mjs` 负责补发，**不在本阶段跑**：本轮次在「没有 open PR」
   时压根不会创建，而一批 PR 刚全部合完、open 清零正是最该发致谢的时刻，因此该动作必须与
   「有没有审查活」解耦，（preview 版：合并致谢播报已剥离——`notify-merge-backfill.mjs` 不在产物中，本节不适用。）
   `skip-loop-managed` 的候选原样跳过、不 checkout、不提醒（详见 3.7，未配置对应键
   时永不出现）；`security-gate`／`rules-gate` 的候选**不跳过**——进处理清单，按下方
   「三门 hold 接线」调 `signoff-hold.mjs`（详见 3.8／3.9，未配置对应键时这两类永不
   出现；命中但该门类已被维护者确认（持久放行，见 3.4）时不 hold，直接按 `auto.fallback`
   继续）；`auto.action=signoff-hold-unavailable`（F3，2026-08-09）的候选**不按原
   路由继续**——记人工介入、报 owner 排查 signoff-hold.mjs 调用点（见下方探测字段
   段），排查后重跑本轮。`product-gate`／`arch-gate` 语义定性后同样走 signoff-hold
   （见 3.4）。
   （preview 版：合并出口与审计已剥离——`merge-pr.mjs` 不在产物中，合并审计对账跳过。）

   **thread 清理（triage）**：对 `context` 输出中 `gate.unresolvedThreads` 非空的
   候选，按 3.10 逐条生成 reply payload（白名单 bot `threadTriage.extraBots` +
   编排层逐 thread 非空 `justification`，见 3.10 第 1/4 条；resolve 由执行层按机器
   可核实条件决定——己方 marker + 同 headSha + 白名单复核，编排层不代判），调
   `node "<SKILL_ROOT>/scripts/resolve-threads.mjs" <PR> --payload-file -`；
   `done=false` 的条目逐条进汇总；resolved 后重算该 PR 的 threads 阻断再进后续分流
   （未做清理、不重算就按未 resolve 处理）。未配置 `threadTriage.extraBots` 时本步
   整体跳过（机制关闭，一条都不动）。
   **跳过对被剥离的通知能力保持静默**（preview 版：作者催办/停滞私聊通道已剥离——`notify-author-resolve.mjs`/`remind-stale-author.mjs`/`resolve-author-feishu.mjs` 均不在产物中）：被 skip 的候选只在 6.1 汇总的 skip 行注明原因，不主动向作者发任何消息。
2. **计划**：选入全部可处理候选，不设固定数量上限（宿主的并行 agent 上限自然限流，
   超出的排队等待即可）；落地顺序先按 3.6 的依赖关系、再按 `createdAt` 升序；对会改变
   base 的候选做文件重叠守卫，同一文件同一时刻只允许一个 PR 在审，重叠项排队等前一个
   落地后再补入。审查 agent 在独立 worktree 并行运行；**三门 hold 接线（串行执行，
   每个候选最多一次）**：对 `auto.action` 为 product-gate / arch-gate / security-gate /
   rules-gate 的候选（或 `signoff.suggestedHolds` 非空时），按
   `signoff.suggestedHolds` 的优先级（security > rules > arch > product 之外的实际
   action 顺序）取命中门，主 agent 按 3.4 的 payload 合同生成三字段文案，调：

   ```bash
   node "<SKILL_ROOT>/scripts/signoff-hold.mjs" <PR> --kind <product|arch|security|rules> --payload-file - <<'JSON'
   { "issueTitle": "...", "issueBody": "...", "commentBody": "...{{ISSUE_URL}}..." }
   JSON
   ```

   **三件套判据**：`held=true` 且 `issueCreated=true` 且 `commented=true` 且
   `labels.changed=true`（或 `alreadyHeld=true` 复用）才算 hold 成功；`reason=
   missing-payload` 不得计为 held，如实进轮次汇总并补 payload 重试；任一字段失败
   （issueError / commentError / labelWarning）必须逐项进轮次汇总，不得静默降级为
   「只打了标签」。格式打回、workflow approval 和 release 等轻操作按候选串行落地。

   **`signoff.holdInvocation`（探测字段，不是正式 hold，也不是"可执行"的证明）**：
   `context.mjs` 在算出 `auto.action` 落 security-gate / rules-gate / arch-gate
   之一时，会自动对 `signoff-hold.mjs --kind <门> --dry-run` 发起一次真实子进程
   调用尝试（无 payload、`--dry-run` 不落地任何 issue / 标签 / 评论），把结果原样
   写进 `signoff.holdInvocation`（`kind` / `invoked` / `dryRun` / `ok` / `pr` /
   `author` 等字段）。**`invoked=true` 只代表这次探测尝试本身返回了
   `{ok:true,...}`**——它不能证明"调用点确实可执行"：探测有三种已知失败形态
   （模块不存在 / 输出非 JSON / 子进程 `fail()` 非零退出），三种都会让
   `invoked=false`。**`auto.action=signoff-hold-unavailable` 是给编排层 agent 的
   信号，不是脚本级强制（F3，2026-08-09；round4 措辞更正）**：失败会重试一次
   （瞬时网络 / 限流噪声），重试耗尽仍失败 → `context.mjs` 把 `auto.action`
   **升级为 `signoff-hold-unavailable`**（人工介入类值——取值与 security-gate /
   rules-gate / arch-gate 不同，按契约路由不会把它们混为一谈），同时失败原因写进
   顶层 `configWarnings`——"连 hold 机制能不能调用都验证不了却继续放行"正是本批
   要消灭的 fail-open。**如实声明：仓内没有任何机器机制能在编排 agent 疏漏时阻止
   流程继续**——`context.mjs` 输出的唯一消费者就是编排层 agent（它读
   `auto.action` 决定路由），仓内不存在、也未设计一个读该输出并强制执行的脚本级
   dispatcher；要求"生产 .mjs 消费方"等于要求一次架构变更（机器级强制已记为后续
   独立 PR，不在本 PR 范围）。因此以下是对编排层 agent 的**明确要求，不是对既有
   机器保障的描述**：**编排遇到 `auto.action=signoff-hold-unavailable` 的候选，
   必须升级为人工介入**——不得按原 hold 流程继续，记人工介入、报 owner 排查调用
   点（signoff-hold.mjs 是否存在 / 依赖是否完整 / gh 鉴权是否可用），排查后重跑
   本轮；跳过这条 = 在 hold 机制不可证明可执行时继续放行，正是本段要消灭的
   fail-open。**成本与配对（R5，2026-08-10 修正，推导链可核）**：探测经
   `lib.mjs` 的 `spawnScriptJson` 发起，两处调用（首次探测与失败后的重试，
   `context.mjs`）**显式传 `timeoutMs: HOLD_PROBE_TIMEOUT_MS`**（默认 `20s`，
   env `REVIEW_PR_HOLD_PROBE_TIMEOUT_MS` 可调）——**修前**这两处未显式传、
   各自取默认 `180000ms`（`lib.mjs:2876`），单候选最坏 `2×180s=360s`，且
   `--scan-all` 外层（默认 `180s`）会先于子进程输出升级 kill 它——**F3 的升级
   在批量路径对病理场景不可达，且整个候选的扫描输出一并丢失**（复审席对照实验
   实证：假 hold 进探测后 sleep，父层只收到自己的超时错误）。**修后**探测
   `2×20s=40s ≪ 外层 180s`，升级重新可达、子进程 40s 内完成并输出。**外层
   `SCAN_CHILD_TIMEOUT_MS`（默认 `180s`，env `REVIEW_PR_SCAN_CHILD_TIMEOUT_MS`
   可调）与探测是显式配对的**：`外层 ≥ 2×探测 + 30s` 由测试锁定（默认值不变量），
   那 30s 余量专门留给子进程探测之外的工作（graphql 60s 显式超时、diff 拉取等）；
   「外层 ≥ 内层」不再是两个静默默认值的巧合。**整轮成本（不要只计 H）**：
   `--scan-all` 为**每个** open 候选（共 N）拉一个子进程做基础扫描，另有 heldDraft
   独立批次，命中三门的候选（H 个）再叠加探测——整轮最坏 ≈ N × 单 PR 扫描 +
   heldDraft 批次 + ⌈H/4⌉ × 40s（4 并发，`mapPool`）。**边界（如实声明）**：外层
   超时不升级为 `signoff-hold-unavailable`——子进程还有 graphql（60s 显式超时）、
   diff 拉取等，叠加也能超外层，**本不变量不保证子进程永不超时，只保证探测不是
   外层超时的原因**；「可区分是超时」≠「可区分为什么超时」，父进程
   无法知道 kill 时卡在探测还是别处（D 否决，理由见 `context.mjs` 外层 spawn
   上方注释）；探测不可用会走 F3 自身升级。编排排期计入这些延迟。它
   **不替代**上面这一步主 agent 按 3.4 payload 合同发起的正式 hold（那次带真实
   `issueTitle` / `issueBody` / `commentBody`，才会真正创建 issue、打标签、发评
   论）。主 agent 判断是否需要发起正式 hold，仍按 `auto.action` /
   `signoff.suggestedHolds`（`signoff-hold-unavailable` 除外，见上），不读
   `holdInvocation`。

   **`history.reviewThreads[].participants` 的数据边界（F2，2026-08-09；round4
   措辞更正）**：`context.mjs` 经 GraphQL `comments(first:50)` 取线程评论，
   **没有分页**——第 51 条起的评论不进 `claim` / `participants` / `lastComment`。
   导出对象带显式截断标志：`commentsFetched`（实际取到条数）/ `commentsTotal`
   （GraphQL `totalCount`，读不到为 `null`）/ `participantsTruncated`
   （`totalCount` 不可读——无法证明完备，保守按截断处理——或 `fetched < total` 时
   为 `true`）。**如实声明："flag=true 时不得据 `participants` 判无非白名单参与
   者"是对编排层 agent 的约定，不是机器约束**——本输出与标志的唯一消费方是编排
   层 agent，仓内没有脚本级机制强制执行该约定。**权威判定方是执行层（#13 的执行
   端）**：它自己的 live 分页查询取全量评论、独立判定白名单参与者，`participants`
   截断与否不影响它的判定（执行端独立分页是 defense-in-depth 设计，不是缺陷）。
   本标志只用于让编排层在截断时**不做完备性断言**：不据 `participants` 下
   "无非白名单参与者"的结论，也不把该 thread 静默跳过。`claim` 取线程**位置首条**评
   论（`cs[0]`）原文——不是"bot 首条评论"：选择器自身不识别 bot，安全性由
   human-thread 闸与 participants 闸共同保证，不依赖 claim 选择器自身识别 bot。
3. **落地与补位**：先消费 held 的放行信号并自动 release——`signoff.
   adminsApprovedCurrentHead=true`（admins Approve 当前 head；跨 commit 持久靠放行标记，
   见 3.4）或产品/架构门
   白名单在讨论 issue / PR 评论区明确同意时，由维护者按本 SKILL 手工摘标签
   （signoff-release.mjs 尚未合入，零测试，已从本批移出、另立 PR 并带测试；幂等，
   标签已摘即无操作；存量被旧 draft 制 hold 成 draft 的 PR 用 `gh pr ready`
   一次性迁移恢复）；`auto.action=
   review-complete-hold-merge` 的候选（含有 `/approve-merge` 授权）**不合**，写入汇总等交互/人手按 5.1 合；`auto.structuralBypassPending=true` 的候选照常进阶段二独立
   审查，通过后只落回执、不合，等交互/人手按 5.1「admins 名单的结构性 BLOCKED 分级合并」走 admin bypass，不
   通过则按 5.2 正常打回；其余通过审查的 PR 只落 clean 回执并汇总，**禁止** `merge-pr.mjs` / `gh pr merge` / 5.5 主干 push，失败的 PR 请求修改，
   CI pending、未 resolve thread、权限问题只跳过不绕过——未 resolve thread 的
   阻断判定用 **thread 清理（3.10）回流后**的计数：扫描阶段已代 resolve 的不再阻断，
   清理后仍 unresolved 的照旧阻断（不合入，只决定本轮是否打回/跳过，不凭清理前
   的旧计数）；冲突的 PR 若满足 5.5 门槛
   （其余全过、仅剩冲突）**auto 不按 5.5 合**，写入汇总等交互处理，否则跳过；
   依赖方在被依赖 PR 合并前记 skip（`depends-on-#N`），被依赖者本轮落地
   后重新拉元数据、CI 通过再补入；`selfFix=true` 的作者侧卡点（安全硬命中、格式、审查
   P0/P1、语义冲突、CI 失败、未 resolve thread、停滞）（preview 版：5.4 fix-handoff 已剥离——这类卡点不打回不投递，在汇总标注「需维护者跟进」）；重叠排队的
   候选在冲突项落地后补入处理。任何单 PR 异常都写入汇总并继续其他候选。锁续期由
   `prepare.mjs` 拉起的后台守护负责，不要在候选之间、等待子 agent 时、或
   同一分钟内反复跑 `refresh-lock.mjs`。`lost=true`（守护或补救调用返回）时
   立即终止本轮剩余候选的所有写操作。

auto 模式可以按维护者配置创建产品/架构/安全/规则门的讨论 issue、挂
`awaiting-discussion` 标签（不再转 draft）、admins Approve 后自动 release（摘标签）
和发送一次定向通知；3B 的作者催办仍按旧流程的去重和停滞规则执行。auto 自己不修改
PR 代码。5.4 已停用，auto **不得**再把修复丢给跟进会话。

### 6.1 汇总输出格式

每轮结束时先把机器可读 JSON **落盘**（供日志与下游脚本消费），不放进会话文本：

```text
node "<SKILL_ROOT>/scripts/run-log.mjs"   # 汇总 JSON 走 stdin,脚本写入外部状态目录
```

外部状态目录默认位置见 `lib.mjs` 的 `resolvePersistentStateRoot()`（默认落进目标仓库
主 worktree 的 `history/loops/review-pr/state/`，随该 checkout 常驻；`REVIEW_PR_STATE_DIR`
仍可显式覆盖，见「Skill 路径与目标仓库」一节的完整校验与回退条件）。`run-log.mjs`
落盘时会自动注入 `sinceLastRunHours` 与 `sinceLastRunReason`：**从 `runs.jsonl` 尾部
向前扫描**，找最近一条能解出合法 `loggedAt`（非空字符串且可被 `Date` 解析；`null`/
数字等非字符串一律不算合法，不会被误判成 epoch 1970）的行，与本轮相减得到小时数——
不是只看最后一行，防止恰好最后一行被截断/手工改坏时把整段真实历史误判成"首轮"。
`sinceLastRunReason` 三态：`ok`（正常算出，可能已跳过若干条坏行，跳过数计入本轮
warning）/ `first-run`（`runs.jsonl` 不存在或为空，真的是第一次）/
`history-corrupted`（文件有内容但一行都解不出合法 `loggedAt`——审计链本身已损坏，
这与"首轮"是完全不同的运维含义，不能都归为 `null` 让人猜）。`sinceLastRunHours`
回答的是"距上一轮多久"，不是"调度层有没有失败轮"（调度失败在 agent 启动前就
发生，本 skill 拿不到那层信号），但轮次间隔异常拉长本身就是缺口的可观测代理信号。
`sinceLastRunReason` 与 `sinceLastRunHours` 按代码实现是**三态互斥**（不要照
模板编造一个两者同时出现的 `<N>`）：`history-corrupted` 时 `sinceLastRunHours`
恒为 `null`（坏到一行都解不出,天然算不出"距上一轮 N 小时"这个数），
`first-run` 时同样恒为 `null`；只有 `reason=ok` 时 `sinceLastRunHours` 才是
真实数字。据此，“其他”行最多补一句、按以下顺序判断，二者不会同时出现：
- `sinceLastRunReason === 'history-corrupted'` → 补**「runs.jsonl 审计链损坏，
  历史轮次记录不可信，请人工核查」**；
- 否则，`reason === 'ok'` 且 `sinceLastRunHours` 超过 2（cron 已是 1h 全天网格，
  稳态轮次的正常最大间隔 1 小时，留一轮容差 ⇒ 漏 1 轮即报）→ 补**「检测到上游
  调度缺口约 `<N>` 小时，可能有失败轮未入账，请查 scheduler」**（`<N>` 取实际
  数值，不得在 `reason` 不是 `ok` 时编造）；
- 其余情况（`first-run`，或 `ok` 且未超过阈值）→ 都不写，不要为了凑格式硬补
  一句。

JSON 结构：

```json
{
  "mode": "auto",
  "processed": [{"pr": 123, "action": "merged", "event": "APPROVE", "findings": 0, "url": "https://github.com/<owner>/<repo>/pull/123"}],
  "skipped": [{"pr": 124, "reason": "ci-pending", "url": "https://github.com/<owner>/<repo>/pull/124"}],
  "draftSkipped": [{"pr": 140, "reason": "author-draft", "url": "https://github.com/<owner>/<repo>/pull/140"}],
  "failed": [],
  "lockReleased": true
}
```

`processed[].action` 与 `processed[].event` **口径不同、不可混用**：

- `action`：本 skill 自己的业务分类（`merged` / `changes-requested` / `held` /
  `conflict-merged`（5.5 主干代合并）/ `merge-then-fix`（5.6 代修合并）等），供
  汇总模板“已合并/已打回/…”分组使用；
- `event`：**实际提交给 GitHub 的 review 事件**，`processed[]` 每条**必填**，
  取值仅 `APPROVE` / `REQUEST_CHANGES` / `COMMENT` / `none` 之一：
  - 5.1 正常批准合并 → `APPROVE`；
  - 5.1 `selfMergeAvailable` 的 self-merge（GitHub 禁止同账号自我 approve，
    直接 `--admin` 合并，未提交任何 review）→ `none`；
  - 5.2 打回：`ownPr=false` → `REQUEST_CHANGES`；`ownPr=true`（GitHub 禁止对
    自己 PR 提交 REQUEST_CHANGES/APPROVE）→ `COMMENT`——**即使 `action` 仍写
    `changes-requested`，`event` 必须如实写 `COMMENT`；二者不同是预期行为，
    不是需要对齐的不一致**（2026-08-01 前的历史记录曾把两者混同，导致审计时
    误读为“打回都是 REQUEST_CHANGES”，此处明确禁止复发）；
  - 5.5 主干代合并、5.6 代修合并：全程不提交 `gh pr review` → `none`；
  - 产品/架构/安全/规则门 hold（signoff-hold，未提交 review）→ `none`。

`threadTriage`（可选，见 3.10）：本轮的 thread 代处理结果，**每条必须显式**——
`[{pr, threadId, path, outcome}]`，`outcome` ∈ `replied-only` / `resolved`（含
`already-resolved`）/ `skipped-<reason>`（如 `skipped-non-whitelisted-comment-present` /
`skipped-reopened-after-triage` / `skipped-reply-failed` / `skipped-resolve-failed` /
`skipped-thread-not-found` / `skipped-lock-busy`）；`skipped-*`（= resolver 拒绝或
失败）不得静默，落盘时逐条展开；未配置 `threadTriage.extraBots` 时整字段可省略。

`draftSkipped` **必须是 `[{pr, reason, url}]` 数组，禁止写成裸数字**（历史上
只落过一个汇总数字如 `21`，事后既定位不到具体是哪些 PR、也说不清原因，
2026-08-01 起禁止复发）；`context.mjs --scan-all` 输出的同名字段只是扫描期的
诊断计数（普通作者自转 draft，非产品/架构门 hold），落盘前必须展开成逐 PR
记录，缺具体原因时至少写 `"author-draft"`/`"unknown"`，不能整条省略。**逐 PR
明细的确定性来源**：用 `gh pr list --repo <owner>/<repo> --state open --json
number,isDraft,url` 这条只读命令自己查一遍当前 open 的 draft PR，逐条填进
`draftSkipped`，禁止凭 `context.mjs` 那个计数字段反推/瞎猜 PR 号——计数只能
证明"有多少条"，证明不了"是哪几条"（`context.mjs` 本身保持 0 改动，这是
agent 组装汇总 JSON 时自己另外查一次）。
`run-log.mjs` 对以上两点只做形态校验、不做语义校验：字段缺失或形态不对时记
stderr warning 并**照常落盘**，不会因为形态问题拒绝写入或丢数据。

**preview 版：完整摘要落盘供 owner 本机查阅**：run-log 落盘、自进化复盘完成后，把 6.1 摘要原文（渲染成人类可读 markdown 后的文本，不是 run-log 的原始 JSON）写入 run-log 目录的 `summary.md`——对外推送通道已剥离（`notify-summary.mjs` 不在产物中），不再经播报出口外发；scheduler 转发的短通知只当作「本轮已结束」的提示。
播报不可用、未配置或发送失败（脚本返回 `posted:false`）时不重试轰炸、不影响收尾：
保留拟定文案，并在会话末尾摘要里注明"推送未送达"（未配置则注明"本轮汇总未主动
推送，目标仓库未配置 `summaryBroadcast`"）。交互模式不主动推送——用户就在会话里，
推送等于让人收两份。

**会话的最后一条消息必须是且只能是人类可读摘要**（同一份 6.1 摘要，也是推送未送达时
的兜底）——scheduler 的桌面/群消息通知会
直接转发会话末尾内容，末尾若是 JSON，用户就会在通知里收到一坨 JSON（这正是历史上
的事故根因，禁止复发）。发给人看的任何渠道（群消息、私聊、交互模式的最终回复）
一律禁止原始 JSON，也不贴 run-log 落盘路径。摘要模板（空分组整组省略，
每行一个 PR，标题超长截断到 40 字；`<PR_URL>` 用该 PR 的真实 GitHub 链接）：

```text
PR Review 汇总（auto · <日期 时间> · 共 <N> 个候选）

**已合并** <n>
- [#123](<PR_URL>) fix(desktop): 修复窗口关闭崩溃 — 0 问题
- [#131](<PR_URL>) chore: 升级依赖 — 主干代合并，解决 lockfile 冲突

**已打回** <n>
- [#124](<PR_URL>) feat(mobile): 新增扫码 — P1×2：缺测试、未处理错误路径
- [#132](<PR_URL>) feat(core): 接入三方 API — 凭证泄露×1（github-token），须清历史并轮换

**需人处理（不开跟进会话）** <n>
- [#125](<PR_URL>) fix(core): 会话恢复 — 审查 P1×1，5.4 已停用，未投递

**被 hold** <n>
- [#126](<PR_URL>) feat(ui): 新设置页 — 产品讨论 issue #88 等白名单意见

**跳过** <n>
- [#127](<PR_URL>) — CI 还在跑
- [#128](<PR_URL>) — 有冲突，等作者 rebase
- [#130](<PR_URL>) — 依赖 #123，等它先合并

**异常** <n>
- [#129](<PR_URL>) — 名录读不到，未能私聊作者

**自进化** <n>
- 已落地：skip 原因归类漏了 merge queue 状态 — commit abc1234
- 已落地（2026-08-09，见 3.10）：白名单 bot thread 代 reply / 条件 resolve——reply
  无条件（反停滞），resolve 只在机器可核实条件下执行（己方 marker + 同 headSha +
  白名单复核），marker 按 viewer 作者身份绑定、状态在 GitHub 侧无本地回执；原
  `assessThreadEvidence` 字符串共现判据已删除（可被两行普通埋点绕过，实测成立）。

其他：锁已释放；本轮外部写操作：<approve/merge/comment/issue 各几次>；检测到上游
调度缺口约 <N> 小时，可能有失败轮未入账，请查 scheduler 😤
```

（若本轮 `sinceLastRunReason === 'history-corrupted'`，上面示例的调度缺口那句
整体替换成「runs.jsonl 审计链损坏，历史轮次记录不可信，请人工核查」。）

这两句按 `sinceLastRunReason`/`sinceLastRunHours` 三态互斥,**最多出现一句，
不会同时出现**（见上文 6.1 开头的三态说明；`history-corrupted` 时
`sinceLastRunHours` 恒为 `null`，构不成"距上一轮 N 小时"这个数，不要编造）：
`reason=history-corrupted` → 只写审计链损坏那句；`reason=ok` 且
`sinceLastRunHours` 超过 2 → 只写调度缺口那句；其余情况（`first-run`，或
`ok` 且未超过阈值）→ 都不写，"其他"行只保留锁与写操作两项，不要为了凑格式
硬写"无缺口"/"审计链完好"这类否定句。

组名用加粗文字而非状态图标（原版 ✅🔴🛠⏸️⏭️⚠️🧬 已去掉，符合「符号与表情配额」的
状态图标全禁规则）；整条消息按模板 F 配额最多用 1–3 个人格表情，不必每组都加，
点到为止。

**PR 号必须是可点击链接**：经播报出口发送时优先用该出口支持的 markdown/富文本
消息形态（如飞书的 post `a` 元素或互动卡片 lark_md、Slack 的 mrkdwn 链接语法，
出口支持哪种用哪种），PR 号渲染成
`[#123](https://github.com/<owner>/<repo>/pull/123)`；出口只支持纯文本时不要发
`[..](..)` 原文——退化为 `#123 https://github.com/<owner>/<repo>/pull/123`
（多数纯文本通道会自动把裸 URL 变成可点击链接）。行内引用的讨论 issue（如“issue #88”）
同样带链接。链接一律用 `gh pr view` 返回的 `url`，不要手工拼错仓库名。

行内容要求：结论在前、原因用短语不用术语堆砌；问题数写 P0/P1 计数而不是罗列全文；
没有发生的组（如异常为 0）整组不出现。交互模式的单 PR 结论同样用这种
"结论 + 原因"的短列表，不贴 JSON。
