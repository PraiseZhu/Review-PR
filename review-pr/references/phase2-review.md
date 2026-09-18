# 阶段二：独立审查派工、rro-1 与收敛记录

> 本文件由 `SKILL.md` 渐进披露拆出，正文与拆分前逐字一致。从 `SKILL.md` 按需 Read，不要经其它 reference 二次跳转。

## Contents

- 4. 阶段二：独立代码审查
- 4.1 严重度定义
- 4.2 记录本轮收敛状态（同族复发判定，机器侧）

---

## 4. 阶段二：独立代码审查

代码审查必须由独立的审查 agent 完成，主 agent 不直接替代它。优先使用
`Agent` + `isolation: "worktree"`，每个 PR 一个隔离 worktree；主工作树不切换分支。
阶段二派工在 Skill 侧必须先经过唯一入口 `scripts/dispatch-review.mjs`：它校验席位、
隔离方式、审查 worktree、目标仓根和 Skill 根，并生成绑定当前任务的
`dispatchReceipt`。只允许 `general-purpose` 审查席；`typescript-reviewer`、其他席位、缺字段、
非 worktree、串仓或串 worktree 均以非零退出拒绝。入口示例：

```bash
node "<SKILL_ROOT>/scripts/dispatch-review.mjs" --task ./task.json \
  --out-task ./task.json --agent general-purpose --provider claude-code \
  --isolation worktree --repo-root "<REVIEW_REPO_ROOT>"
```

先在审查 worktree 根运行 `build-review-task.mjs`，生成带执行身份、不带派工凭据的
`task.json`；再在同一 worktree 运行上述入口，传入实际派工使用的席位与 provider。
task、prompt、preflight、答卷和显式输入材料均必须位于该 worktree 内；各入口按
真实文件路径校验，指向树外的符号链接也会拒绝，投递或消费不能靠复制文件串用身份。
投递和消费会现场重算并校验身份与凭据，缺凭据或绑定不一致的任务不能进入投递台账
或取得 clean。凭据记录调用方声明的派工参数，不证明宿主实际创建了对应席位；编排方
必须将同一组参数用于真实派工，并核对宿主返回结果。
**spawn 返回后立即自检一次 `git branch --show-current` 仍为主工作树原分支**——
若被切到 PR head（审查 agent 在主工作树执行了 `gh pr checkout`），`git checkout`
原分支恢复并如实记入汇总（2026-08-11 #623 实测发生过：spawn 漏传
`isolation` 时审查 agent 会在主工作树 checkout PR head，工作树干净则无残留）。
**等子 agent 完成时不要调任何工具**（包括 `refresh-lock.mjs`）：锁续期由后台
守护负责；主会话空转续锁会把整段对话反复计费（2026-08-18 Mini 巡审 4660 次
心跳、单轮 $515）。宿主会在子 agent 结束时自动唤醒，不要自己轮询。

**大 payload 审查纪律**（指令落文件 + 字节分片 + 输出卫生 + 超时降级）：
- spawn 前把完整审查指令写入隔离 worktree 内文件（如 `./review-task-prompt.md`），Agent 首条 prompt **只留路径引用**，不要把 100KB+ 指令内联进对话；
- 分段按 `reviewSegments.sizeBudget`（key 数）**与** `sizeBudgetBytes`（默认 50KB，按 hunk patch 字节）同时切，单段不得再出现 141KB 这种「key 未超、字节爆了」；
- 审查席任何可能长输出的命令一律 `| tail -n 40`，或重定向到 worktree 日志后只 echo 退出码；禁止整读大文件与全量 npm/test 输出；
- 审查席对结构性大文件只做字段级抽取（如 `node -e` 读 task.json 的 snapshotHash / segments 数 / 承诺计数，`grep -n` 定位 prompt.md 的候选与必答清单段），禁止整读 task.json / prompt.md / 全量 diff——2026-08-31 mivo-canvas-plugin #386 审查席整读大文件触发 autocompact 连续震荡 3 次挂死，未交 rro-1.json，本轮 skip 收场；
- 审查会话超时未交 `./rro-1.json`：主会话写 non-clean 回执 `--verdict skip --reason review-agent-timeout --p0p1-count 0`，本轮 skip。**禁止沿用上次清白**。若改由答卷组装席接手，必须**重建** `task.json` / preflight / 分段投递台账，且 `snapshotHash` 与 consume 现场重算一致（`--base` 必须是 PR `baseRefOid`，传 merge-base/tip 会得到不同 hash）。

**spawn 前必须把 `SKILL_ROOT` 绝对路径显式注入审查 agent 的任务上下文**（见下方
模板首行）：隔离 worktree 里的目标仓库拷贝可能不含（或含未跟踪、指向错误目标的）
`.claude/skills/review-pr` 软链——软链常被目标仓库的 `.gitignore` 排除，PR 分支的
worktree 里可能压根不存在这条链路。审查 agent 不应假设工作树里能找到 skill 脚本
或 `references/rule-map.md`，必须用主 agent 已解析出的绝对 `SKILL_ROOT`（见「Skill
路径与目标仓库」一节的 realpath 解析）去定位所有确定性脚本与参考文档。

审查 agent 必须：

1. 检出 PR 的 head，确认 base、head、工作区和依赖状态；
2. 阅读 PR body、评论／thread 历史和本文件的规则加载要求；diff 内容按分段协议获取——
   单段（常见小 PR）一次拿全即等价于完整 diff;多段模式**不先吞完整 diff**，每段的
   patch 内容随该段投递给出（见下方「分段必须真投递」，这正是大 diff 分段多查问题的
   前提——先读全量再分段等于没分）；
3. 读取 2.1 已按 `ruleFiles` 配置解析出的规则文件集合（`ruleFiles.required` 的固定
   清单 + 命中 `ruleFiles.ruleMap` 的按路径条目，未配置 `ruleMap` 则只有前者），
   逐条执行其中 Review 清单；只把新增或正在修改的代码与规则对照，不借机清理无关
   旧问题；
4. 对每个修改的共享符号、IPC、状态、数据结构、协议、配置和持久化路径追踪调用方、
   读方、错误路径、回滚路径、远程／手机入口和测试，不局限于 diff 文件；
5. 检查 PR 声称的验证命令，必要时运行与风险匹配的定向检查；不能把未运行写成通过；
6. 用 P0/P1/P2 分类输出，P2（纯风格、可选重构、没有用户或可靠性影响的建议）不进入
   findings；进入 findings 的每条 P0/P1，先判断它触犯的是哪个不变量（一句话说清楚
   "什么必须一直成立却被破坏了"），同一不变量在多处的表现归为一个 family——
   family_id 只需在本报告内唯一（如 f1/f2），severity 取 family 内成员最高的那个；
   每条 manifestation 仍各自独立保留 path:line、事实证据、影响、修复建议、验证方式，
   归族只是呈现层次，不能因此丢掉任何一条的定位信息（是否要归为同一 family 是审查
   agent 自己的语义判断，靠证据支撑，不是靠字符串相似度凑出来的机械结果，判断不了
   宁可拆成多个 family）；只出现一处表现的 finding 同样要建一个 family
   （manifestations 长度为 1），并且必须当轮就完成上面第 4 条要求的全路径审计
   （追踪该不变量涉及的调用方、读方、错误路径、回滚路径、远程/手机入口和测试）——
   这是第一轮的默认动作，不是等复发了才补做的事后补救；每个 family 的修复指引必须
   写明"修复必须覆盖该不变量的全部路径，包括本报告未点名处"，不能只让作者对着
   列出的几行改。若以 JSON 输出，family 的形状（`family_id`/`invariant`/`severity`/
   `manifestations[]`/`fixGuidance`）可用 `scripts/lib.review-output-shape.mjs` 的
   `validateFindingFamily` 校验——它只验字段存在、severity 取值合法、family
   severity 是否等于成员最高，不判断是否真的同族，那部分仍是本条要求的语义判断；
7. **UI 改动专项**（`format.uiCodeFiles` 非空时必做，不可跳过）：
   - **UI 证据一致性验证**：从 PR body 与评论中提取全部 UI 证据（类型见
     `format.bodyUiEvidenceKinds`），逐项核对与 diff 的对应关系：
     - **截图／录屏**：用 `gh api`（附件走 GitHub 认证下载）或宿主可用的下载方式
       取到本地，逐张查看图片内容；确认截图展示的界面变化与 diff 中的组件、文案、
       布局、状态改动**逐项对应**；
     - **HTML 界面**（```html 代码块、.html 附件或在线预览链接）同样是有效证据：
       把 HTML 存到本地文件，优先用宿主可用的浏览器工具打开渲染并截图查看；无法
       渲染时直读 HTML 源码，把其中的组件结构、文案、配色、布局与 diff 对照。注意
       贴出的 HTML 是作者手工产物，须核对它与 diff 里的实际组件实现一致，而不是
       只看 HTML 本身好不好看；
     证据与本 PR 改动无关（旧图、别的页面、无关 HTML）或明显与 diff 声称的效果
     不符时，记 **P1**；证据声称的功能在 diff 里不存在时按描述不实处理，同样 P1。
     证据完全缺失、或关键 UI 改动（新页面、新组件、布局／配色变化）没有对应证据
     覆盖——**不记 finding、不阻断**，在报告 UI evidence 段注明缺口，由主 agent 按
     3.2 的「UI 证据提醒评论」转达作者。无法下载、渲染或查看
     时如实写入 Verification（“未能查看截图／HTML”），不得写成“已核对”；
   - **设计规范审查**（`ruleFiles.uiRequired` 非空时才做；为空即目标仓库没有独立
     设计规范文档，跳过本项，不因缺规范文件记 finding）：所有 UI 改动必须符合
     `ruleFiles.uiRequired` 列出的每份设计规范文件（相对目标仓库根目录，如 Cindy
     项目配置的 `DESIGN.md` 与 `docs/design-rules/cindy-design-system.md`）。先完整
     读取全部列出的文件，再把 diff 中每个新增／修改的组件、颜色、字体、间距、圆角、
     动效、文案与深浅色适配逐条对照规范；有证据时同时对照截图或渲染后的 HTML 检查
     视觉呈现是否符合规范。**fail-closed**：`uiRequired` 列出的路径不存在时记 **P1**
     （"配置要求的设计规范文件缺失"），不当作"没有规范"跳过。硬编码颜色值绕过
     design token、自造组件替代设计系统已有组件、违反规范的间距／排版、缺少深浅色
     或多端适配等违规项记 **P1**，并在 finding 中引用规范原文位置。规范未覆盖的纯
     审美偏好属 P2，不阻断。

将以下模板作为审查 agent 的任务上下文，并要求它只输出可定位、可复现的发现：

```text
Skill 根目录（绝对路径，本次所有确定性脚本与 references 只从这里读取，不要依赖
工作树里可能缺失/未跟踪的 .claude/skills/review-pr 软链）：<SKILL_ROOT>

审查对象：PR #<N>，base <base>，head <sha>
规则来源：AGENTS.md（存在即读）、PR 模板、ruleFiles.required 列出的规则文件、
ruleFiles.ruleMap 命中的规则文件（未配置则没有这部分），以及维护者流程中的
productGate／archGate／selfFix 结果；UI 改动另加 ruleFiles.uiRequired 列出的设计
规范文件（未配置则没有这部分，见第 4 节第 7 条）
重点：安全与用户数据、崩溃/数据丢失、跨平台、协议兼容、影响面、错误路径、测试和描述真实性；
安全与隐私门软命中（context 的 security.softHits）必须逐条定性：真实凭证/个人隐私数据 = P0，
测试桩/占位符/公开示例放行并写明依据；security.scanned=false 时先人工核对完整 diff 无泄露；
UI 改动加：UI 证据（截图/录屏/HTML 界面）与 diff 一致性、ruleFiles.uiRequired 设计规范符合性
（证据完全缺失不记 finding，只在报告注明缺口——提醒作者补证据由主 agent 的评论完成；
ruleFiles.required／uiRequired 列出但缺失的文件按 fail-closed 记 P1，不与证据缺失混淆）
输出卫生：任何可能长输出的命令一律 `| tail -n 40` 或重定向到 worktree 日志后只 echo 退出码；禁止整读大文件与全量 npm/test 输出。

输出**单一 JSON**（SC-R1a，2026-08-05 起唯一契约，`schemaVersion: "rro-1"`；
**废除"JSON 或等价 Markdown"双轨**——机器只消费 JSON，你自报的结论不被采信）：

任务正文由**唯一构建器**产出，不要自己拼。**输出路径必须在隔离 worktree 内**（如 `./rro-1.json` / `./task.json` / `./prompt.md`），禁止指向 `/tmp`——隔离席写仓外会被沙箱拒绝（#170）。

```bash
node "<SKILL_ROOT>/scripts/build-review-task.mjs" <N> --base <baseRefOid> --head <headRefOid> \
  --out-task ./task.json --out-prompt ./prompt.md \
  --expected-paths "$(gh pr view <N> --json files --jq '[.files[].path]|join(",")')"
```

`--base` 取 `gh pr view <N> --json baseRefOid` 的返回值——baseRefOid(PR 分叉点),不是 base 分支当前 tip
(与 3.0.1 同一来源纪律;误用 `origin/main` 会造成 snapshot 漂移)。

逃逸候选的数据源(PR body + 关联 issue)由构建器**自己现场取**,不需要传参;取不到即
`escapeSourceIncomplete=true` → 本轮 `invalid`(不得据"无候选"放行)。离线/测试可用
`--pr-body-file` / `--related-issues-file` 作 seam。

`prompt.md` 里已经写好本轮的：风险 profile 必答项的 **check 语义与总数**（哪些文件要答、
其 fileId 是什么随分段投递给出）、未决 findings（必须逐条 disposition）、known hazards
（本仓历史逃逸模式）、覆盖分片 segments 的**清单与投递序号**、required 负向证据的**总数**。

**分段必须真投递**（SC-R4）：`prompt.md` **与 `task.json` 都不含**各段的 coverage key /
必答项 fileId / 负向 key 明细（task 只留计数与内容承诺 `coverageCommitment` /
`profileAnswersCommitment` / `negativeEvidenceCommitment`，segments 只有每段 `keyCount` +
`commitment`）——回执素材的唯一取得途径是按序调用投递出口，把它打印的 `payload` 投给
**同一个**审查会话，每段收回执后再投下一段：

```bash
node "<SKILL_ROOT>/scripts/deliver-review-segment.mjs" <N> --task <task.json> \
  --base <baseRefOid> --head <headRefOid> --order <1..segments.length>
```

每段 payload 投递的是**可审查内容**，不是 opaque key（第 4 轮核验 BLOCKER）：每个 hunk key
带 path、base/head 行区间与 immutable patch 文本（```diff 块内嵌在 payload 正文里）;
file key 带 changeType/contentKind/modes;本段涉及的 profile 必答项（含 fileId）与
required 负向证据（含 fileId/hunkId/原因）也随段给出。因此**多段模式下审查会话不需要、
也不应该先读完整 diff**——第一段之前只送全局规则与元数据（prompt.md），每段的实际代码
内容由投递出口按序给;单段小 PR（常见情形）则照旧一次拿全。

出口只接受**下一个**序号（乱序/跳段直接拒且不留记录），并把投递事实记进 STATE_DIR 的投递
台账;分片由投递出口按 snapshot + rules **权威重算**（task 的承诺只用来核对是否过期）。
consumer 以台账为顺序基准核对回执——零投递、缺段、或声称一个没投递过的 `receivedOrder`
一律 `invalid`。宿主投不完就按 blocked 上报,不要一次性硬审。
每段回执形如 `{segmentId, receivedOrder, snapshotHash, coverageKeys:[...]}`，只能认领本段
分配到的 key;**下一段的 key 在上一段完成前不可见**。
（诚实边界：台账证明**投递动作按序真实发生过、回执素材只能按序取得**，不能证明模型是
分段读的——编排方仍可先把 N 段全投完再一次性喂给模型。机器守住的是"没投递过就不能声称
覆盖"。）

审查 agent 按它作答，输出形如：

```jsonc
{
  "schemaVersion": "rro-1",
  "snapshotHash": "<当前 snapshotHash;必需且必须等于任务里那一个——答卷绑定它所审的快照>",
  "findingFamilies": [ { "family_id": "f1", "invariant": "<一句话不变量>", "severity": "P0|P1",
    "manifestations": [ { "path": "", "line": 1, "evidence": "", "impact": "", "fix": "", "verification": "", "severity": "P1" } ],
    "fixGuidance": "修复必须覆盖该不变量的全部路径，包括本报告未点名处" } ],
  "verificationGaps": [ { "description": "", "required": false } ],
  "verificationRuns":  [ { "runId": "r1", "command": "", "exitCode": 0, "outputAnchor": "" } ],
  "profileAnswers":    [ { "profileId": "test-infra", "fileId": "", "checkId": "",
    "answer": "checked-clean|finding|not-applicable", "hunkId": "", "findingRef": { "family_id": "f1", "manifestationIndex": 0 },
    "reasonCode": "", "explanation": "" } ],
  "segmentReceipts":   [ { "segmentId": "seg-01", "receivedOrder": 1, "snapshotHash": "<同上>",
    "coverageKeys": [ { "kind": "hunk", "fileId": "", "hunkId": "" } ] } ],
  "findingDispositions": [ { "findingId": "<task 注入的 id>", "disposition": "resolved|invalidated",
    "evidence": { "kind": "diff-anchor", "snapshotHash": "<当前 snapshotHash>", "fileId": "", "hunkId": "", "note": "" },
    "basis": "<invalidated 时写判误报依据>" } ],
  "negativeEvidence":  [ { "fileId": "", "hunkId": "", "kind": "executed", "snapshotHash": "",
    "command": "", "negativeOracle": "", "observedSignal": "expected-failure-observed", "outputAnchor": "", "verificationRunId": "r1" } ],
  "escapeAssessment":  [ { "candidateId": "", "verdict": "yes|no", "basis": "" } ],
  "modelVerdictNote": "仅供人读；机器不消费"
}
```

契约要点（违反即 `invalid`，本轮审查视为未完成，不得 approve/不得 clean）：

- P2 不进 `findingFamilies`（沿既有 severity 契约，只收 P0/P1）；
- 同轮交叉引用用**本地引用** `{family_id, manifestationIndex}`；`findingId` 由机器派生，
  只有 task 注入的**历史未决项**才用 findingId；
- `accepted-risk` **不在你的输出里**——它只走交互确认通道（auto 模式无此出口）；
- **跨 snapshot 判别**：对 originSnapshotHash 早于当前 snapshot 的注入未决项，先查当前 head
  是否已有修复证据（新增代码/负向实测变红）——**已修复给 `resolved`**；`invalidated` 只用于
  「该指控在当前 snapshot 上不成立且无修复动作」的误报，不得把「已修复」当「误报」
  （`invalidated` 在 auto 模式无确认出口，历史条目每轮重新注入）；
- required `verificationGap` 非空、必答缺项、覆盖对账不符、注入的 open 未 disposition、
  preflight 未完成、profile 配置非法，任一即 `invalid`；
- required 负向证据 key **只能由 `executed` 满足**，`not-applicable` 不接受；
- **negativeEvidence 条目的 `command` 与 `outputAnchor` 必须与其引用的
  `verificationRuns[]` 条目逐字一致**（consumer 按 `run.command !== n.command ||
  run.outputAnchor !== n.outputAnchor` 判 `negativeEvidenceInconsistent`，不一致即
  `invalid`）——两处不要各写一份：先写 run 记录，negativeEvidence 直接照抄同一条
  command/outputAnchor，不要改写摘要措辞（2026-08-29 实测：语义审查结论 0 P0/P1、
  9 处负向证据真实跑过，仅因 negativeEvidence 里写了更详细的摘要措辞被判 invalid）；
- 顶层与每段回执的 `snapshotHash` 都必需且必须等于当前——**旧答卷不得跨 snapshot 重放**。
  这条挡的是「base 前进但 diff 与 coverage key 逐字节相同」时把上一轮答卷原样再交一次：
  重算 task/preflight 验的是「任务与快照」，证明不了「这份答卷属于这个快照」。

> **R6 诚实边界（机器承诺到哪为止）**：机器校验的是**对象绑定**（证据挂在哪个
> fileId/hunkId）、**快照新鲜度**（snapshotHash 是否当前）、**引用存在性与声明一致性**
> （verificationRunId 必须指向 `verificationRuns[]` 里存在的 run，且该 run 的
> command/outputAnchor 与本条一致）。机器**不能**验证命令真的被执行过、也不能验证它与
> 被改代码语义相关——没有受控执行 wrapper 时，前后一致的伪报（编一个 run 记录再引用它）
> 是 T1 上限。这里的价值在于把"我看过了"变成"我把它弄坏过并留下可核对的锚点"，不是把它
> 变成机器证明。

主 agent 收到审查输出后、调用 consumer **之前**，先 `gh pr view <N> --json headRefOid,state` 核对：与任务 snapshot 的 head 不一致则对新 head 重建 task/preflight 重审（旧回执留作历史）；`state` 非 OPEN 则本轮 skip，汇总写「合并先于审查完成」。审查会话超时未交 `./rro-1.json` 时，写 non-clean 回执 `--verdict skip --reason review-agent-timeout` 并 skip，禁止沿用上次清白；答卷组装席接手必须重建 task/preflight/投递台账，snapshotHash 绑 `baseRefOid`。主会话在调用 consumer 之前先跑 `--shape-preflight`：缺字段/形状错把字段级 errors 退回审查席重交，**不得静默补 `profileId`/`fileId`，没有 `--shape-fix`**。

输出交给唯一消费出口裁决（它算 verdict、写回执、动台账；**clean 回执只能由它写**）：

```bash
node "<SKILL_ROOT>/scripts/consume-review-output.mjs" <N> --shape-preflight --output ./rro-1.json \
  --snapshot-hash <任务里的 snapshotHash>
node "<SKILL_ROOT>/scripts/consume-review-output.mjs" <N> --output ./rro-1.json \
  --mode interactive --base <baseRefOid> --head <headRefOid> \
  --task ./task.json --preflight ./preflight.json --verify-live-head
```

`--task` **必需**(没有它无法对账覆盖/必答/负向证据)。task 只是"审查方看到的副本",
consumer 会用同一份权威推导从 immutable git objects **重算** coverage/分片/必答/required
负向证据并逐组比对——改过或过期的 task 一律 `invalid`。**逃逸候选、目标仓 slug、命中的
known hazards 同样由 consumer 现场重算**(默认现场 `gh pr view`;离线用与构建器同一份
`--pr-body-file` / `--related-issues-file` seam):否则把 task 里的候选清空就能换来 clean。**任何**输入级失败(缺 `--output`、
缺或坏 `--task`、snapshot 建不起来、台账不可读)都会写一条 non-clean 回执**撤销**同 snapshot
的旧 clean 并记 retry:不存在"这一轮没跑成就沿用上次清白"的通道。

verdict 由机器推导，优先级 `invalid > dirty > clean`：`clean` 需同时满足**当前 P0/P1=0
∧ effective-open=0 ∧ accepted-risk=0**；`dirty` = 有 P0/P1，或 disposition 应用后仍有
未决项，或存在 accepted-risk。同一 snapshot 连续 3 次 `invalid` → `blocked`（初次+2 次
修复重试）。

Rule coverage / UI evidence / Verification 三段仍要写，放进对应 JSON 字段与
`modelVerdictNote`（给人读的部分）——不再接受纯 Markdown 报告作为机器输入。

主 agent 收到报告后必须逐条回到源码、测试和规则原文复核。无法复现、只属于 P2、
与本 PR 无关或与已确认例外冲突的条目不发送给作者，但在内部汇总中注明舍弃理由。

### 4.1 严重度定义

以下是本 skill 的默认严重度定义；`ruleFiles.required`／`ruleFiles.ruleMap` 命中的
规则文件对某类问题另有更具体的严重度规定时，以规则文件原文为准：

- **P0**：不改不能合——红线、崩溃、数据丢失、跨平台失效、安全或凭证泄露；
- **P1**：本次必须修——明显 bug、权威规范违反、影响面没有处理干净、缺少必要测试
  或缺少规则要求的适配／说明；UI 改动的证据（截图或 HTML 界面）与 diff 不符或声称
  的效果不存在（描述不实）、以及违反 `ruleFiles.uiRequired` 列出的设计规范同属 P1
  （证据缺失不算 P1——按 3.2 发提醒评论请作者补充）；`ruleFiles.required`／
  `uiRequired`／`ruleMap` 配置了路径但文件缺失同属 P1（fail-closed，见 2.1／
  第 4 节第 7 条）；
- **P2**：可选优化或风格偏好——不报告，不用它阻断合并。

安全、凭证、用户数据、wire protocol、数据库历史 migration、system prompt、更新器、
IPC／权限边界和跨端适配命中专项规则时，专项规则的阻断条件优先于一般判断。

同一 family（第 4 节第 6 条）内多条 manifestation 严重度不一致时，family 整体
severity 取成员里最高的那个——出现一条 P0 就是 P0，不因大多数成员只是 P1 就淡化。

### 4.2 记录本轮收敛状态（同族复发判定，机器侧）

本节是「审查收敛状态」的单一权威（`scripts/convergence-state.mjs`）——与
`write-review-receipt.mjs` 的回执是**两次独立落盘**，互不覆盖也互不替代：回执判
「这个 head 干不干净」（last-write-wins，只留最新一条，5.1 的 admin-trust 分级
合并消费它）；本节记「这个 PR 跨多轮 head 收敛得怎么样」（每 PR 一份持久文件，
记录 P0/P1 按「家族」在跨 head 的出现历史）。两者都要各自维护，不能因为写了一个
就省略另一个。

**触发时机**：主 agent 完成 4 节「逐条回到源码、测试和规则原文复核」之后——即
findings 已经是本轮真正要发给作者/计入判定的最终清单（P2 不算，已舍弃的条目不算）
的那一刻。这一步在阶段二独立审查**每一轮**都要做，不只是 5.1 admin-trust 路由
才做（那是回执的专属场景）。

**跨轮身份 = 不变量 key，不是本轮 family_id，也不是展示用的 slug**（2026-08-02
gpt 阻断修正）：4 节审查报告里的 `family_id`（SC-C1「输出契约」）只在**单份报告
内**唯一，审查 agent 每轮独立生成报告，不同轮的 `family_id` 之间没有任何对应
关系，不能拿它做跨轮比对。早前改用截断到 64 字符的 `invariantSlug` 当身份用，
gpt 实跑复现：两条仅尾部（65+ 字符）不同的 invariant 会被截断成同一个值，误判成
同一 family 复发。现在权威身份是 `invariantKey`（对完整归一化文本算 SHA-256、
不截断，`lib.review-output-shape.mjs` 导出），`invariantSlug` 降级为纯展示（见
5.0）。本轮的 `family_id` 只作为可选字段随 occurrence 存档，仅供回溯"这条记录
对应本轮报告里的哪个 family"，不参与任何匹配逻辑。

**两级检测**（不是纯字符串匹配——同一不变量换个说法描述，key 未必还相等）：

1. **一级（确定性，机器自动做）**：脚本对本轮 finding 的 `invariant` 原文算出
   key，自动与 state 里早于当前 head 的历史 key 比对，命中即判定复发
   （`matchedBy: 'key'`），**不需要调用方声明**。
2. **二级（T1 兜底，只能由 agent 做）**：一级未命中时，把 state 里该 PR 的历史
   `invariant` 原文清单（`--get` 拿到）交给审查 agent/主 agent 做语义比对——判断
   是否与某个历史家族本质是同一条不变量，只是这轮换了个说法。判等价就在这条
   finding 上显式传 `recurrenceOfKey: <历史 key>`；本脚本只核验该 key 在
   state 里确有早于当前 head 的记录，**不做语义匹配**——核验不过直接 throw，不会
   静默把无法验证的引用当新家族处理（防止"反正声称复发就信了"）。
3. 两级都未命中 → 当新 family 处理（宁可多报一条新 family，不静默吞掉一次复发）。

**步骤**：

1. **先查已有家族**：`node "<SKILL_ROOT>/scripts/record-convergence-round.mjs" <N> --get`
   拿到当前 state（`families` 按 key 分组，每个家族含 `invariant` 原文与历史
   `occurrences`）——二级检测要用的历史清单就是这里的 `invariant` 字段集合。
2. **落盘**：把本轮 findings 转成
   `[{invariant, severity:"P0"|"P1", description, familyId?, recurrenceOfKey?}]`
   数组（`familyId` 是本轮报告里的 family_id，可选，仅供回溯；`recurrenceOfKey`
   只在二级检测判定复发时才传，一级由脚本自动判断，不要重复声明），经 stdin
   传给 `node "<SKILL_ROOT>/scripts/record-convergence-round.mjs" <N> --head <headRefOid>`
   （0 P0/P1 时传空数组 `[]`，代表本轮收敛信号；空/纯空白 stdin 会被拒绝，不能
   靠什么都不传来表示收敛，见脚本头注释 D2）。该 PR **第一次**被记录、且经
   `gh pr view --json reviews` 查到已有历史 `CHANGES_REQUESTED` 时，把
   `computeConservativeSeedRounds(reviews)` 的结果通过 `--seed-existing-rounds <N>`
   传入（D4「老 PR 首次接入的保守 seed」——只在首次生效，之后的调用会被忽略，不用
   每轮重复传）。
3. **返回值消费**：脚本返回 `{roundCount, p0p1Count, newFamilyCount,
   consecutiveRoundsWithNewFamilies, recurringFamilies, checkpointRequired,
   notification, integrityWarning}`。
   - `recurringFamilies` 非空时，5.2 打回文案对这些条目要标注"复发"并指出
     `priorHead`/`priorDescription`/`matchedBy`/`recurrenceType`（`recurrenceType`
     的措辞区分见 5.0「persistent vs reopened」——`reopened` 才能说"已收敛后
     复发"，`persistent` 只能说"持续未修"）；
   - `integrityWarning` 非空时（收敛状态文件本身损坏过，已隔离旧文件重建）必须在
     内部汇总/review 正文里如实带一句（措辞同 6.1 对 `runs.jsonl` 审计链损坏的
     处理："收敛状态文件损坏，历史轮次记录不可信，请人工核查该 PR 是否已经历多轮
     未收敛"），不能吞掉；
   - `checkpointRequired`（布尔）与 `notification`（`{reason, prNumber, head,
     thresholdKey, detail}` 或 `null`）的消费见 5.7「收敛止损」。`notification`
     非 null 只代表"round/new-family 这个触发源判定要发"，不代表已经发出——**确认
     投递成功后**才能调 `--mark-notified` 回写去重（见 5.7；失败不 mark，否则一次
     未送达 = 永久静音），否则下一轮同 head 重放会再次判要发。

**安全边界（不可放宽）**：复发的 finding 依然是 P0/P1、依然计入本轮
`p0p1Count`、依然应使这一轮的 review-receipt 判 `dirty`（若走 5.1 的 admin-trust
路由）、依然阻断合并——`recurrenceOfKey` **只**影响 `newFamilyCount`（收敛
趋势指标），不影响、也不能被误用来影响任何合并判定路径或 `isReviewReceiptClean`。
