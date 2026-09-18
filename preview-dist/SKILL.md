---
name: review-pr
description: >
  审查 GitHub Pull Request，按仓库 AGENTS.md、docs/dev-rules、docs/product-rules、
  docs/design-rules 与 PR 模板检查安全与隐私内容（凭证/密钥/个人数据零容忍）、格式、
  风险、影响面、测试和规则遵从；支持指定 PR、
  自动选择、交互式合并、代修合并（先合并、主干修复、评论告知作者，仅交互模式）
  以及 --auto 定时批处理。保留维护者专用的产品/UI gate、技术
  架构 gate、讨论 issue、self-merge（仅交互）、workflow approval、结构性 BLOCKED、Server 通知和
  经配置播报出口的通知流程（对外话术遵循统一人格模板）；使用独立审查 agent、前置
  gate、GitHub review/merge 和 scheduler pre-run
  check。每轮结束做自进化复盘（EVOLUTION.md 台账，扩权类永不自动落地）；汇总 JSON
  只落盘，发给人的渠道一律人类可读摘要。
---

# review-pr：按仓库规则审查 GitHub Pull Request

把一个 PR 从“读取上下文”走到“审查、评论、合并或打回、清理”。
默认只读代码，不替作者修改 PR 分支；交互模式的 5.6 代修合并也只在合并后改
默认分支，永不向 PR 分支推送。

本文件是导航与审查质量入口（保持短，避免 compact 后丢掉维度）。细节按需
Read 下方 references，全部从本文件一层链接，不要经 reference 再跳 reference。

## 兼容 Codex 与 Claude Code

- Codex 通过 `agents/openai.yaml` 和本文件的 `name`／`description` 发现 skill，使用宿主
  提供的 shell、文件读取、提问和协作 agent 能力。
- Claude Code 通过 `.claude/skills/review-pr/SKILL.md` 发现 skill；`Agent` 优先以隔离
  worktree 启动独立审查。
- 两种宿主共用同一套流程和脚本，不依赖 Codex 或 Claude 专属 MCP。若某宿主没有
  `AskUserQuestion` 或隔离 agent，必须停在对应授权／审查 gate，不能把主 agent 自己的
  判断冒充独立审查。维护者专用的飞书发送能力由宿主提供；不可用时保留拟定文案并在
  汇总中说明，不猜测收件人。
- 本仓库维护流程、配置来源和内部 gate 见
  [references/internal-gates.md](references/internal-gates.md)。这些内容只服务维护者，
  不作为公开贡献文档。

## 按需读取（一层）

| 何时 | 读什么 |
|---|---|
| 给人发消息（打回、催办、门告知、致谢、汇总） | [references/voice-templates.md](references/voice-templates.md) |
| 解析 SKILL_ROOT、状态目录、自同步 | [references/runtime-and-sync.md](references/runtime-and-sync.md) |
| 阶段一安全 / 格式 / 产品架构 / 前置 gate | [references/phase1-gates.md](references/phase1-gates.md) |
| 阶段二派工、rro-1、分段投递、收敛记录 | [references/phase2-review.md](references/phase2-review.md) |
| 阶段三批准合并、打回、代合、核销 | [references/phase3-landing.md](references/phase3-landing.md) |
| `--auto` 扫描、skip、汇总推送 | [references/auto-batch.md](references/auto-batch.md) |
| Cindy 路径→规则范例（仅目标仓显式配置时） | [references/rule-map.md](references/rule-map.md) |

## 0. 模式与安全边界

- `$ARGUMENTS` 中含 `--auto` 时进入无人值守模式；不解析手工 PR 号，批量处理所有
  可审查的 open、非 draft PR。**auto 只审不合**（2026-09-01）：打回、写回执、hold、
  通知、汇总可以做；**禁止**调用 `merge-pr.mjs`、禁止 `gh pr merge`、禁止 5.5 主干
  `git merge`+push 默认分支。`merge-pr.mjs --mode auto` 会在出口拒绝。
- 其他情况进入交互模式：提取 `#123`、`123` 或文本中的 PR 号；未指定时选择最早
  创建的 open、非 draft PR。
- 交互模式在提交 review、发表评论、合并、推送默认分支、关闭或删除远程分支前必须用
  `AskUserQuestion` 确认。`--auto` 只允许执行本文件明确列出的安全动作（不含合并）。
- 不使用 `git reset --hard`、`git checkout --`、强制删除用户分支或自动 stash。
  不把 token、凭证、组织名册或本地绝对路径写入输出。对 PR 提交内容本身的凭证与
  隐私数据零容忍，见 3.1 安全与隐私内容门；打回与汇总只写文件/行号/类型，不复述
  命中原文。
- 任何规则冲突、数据不完整、权限不明或无法复现的结论都停在当前 gate，并如实报告；
  不用“看起来没问题”替代证据。

## 审查质量（先做完这些，再读流程细节）

审查维度不因外置流程而减少。目标仓规则原文优先于本文件的默认严重度。

1. **安全与隐私**：`security.hardHits` 阻断，不进代码审查、不合并；`softHits` 由阶段二
   逐条定性（真实凭证/个人数据 = P0，测试桩/占位符/公开示例放行并写依据）；
   `scanned=false` 不得视为通过。输出只写文件/行号/类型，不复述命中原文。
2. **格式**：按当前 `.github/PULL_REQUEST_TEMPLATE.md` 检查实质内容；格式问题是 P1。
   UI 证据缺失不阻断，只发一次提醒评论（见阶段一 3.2）。
3. **规则对照**：读 AGENTS.md（存在即读）、PR 模板、`ruleFiles.required` 与命中的
   `ruleMap`；配置了路径但文件缺失记 **P1**（fail-closed）。只审新增或正在修改的代码，
   不借机清理无关旧问题。PR 改规则时同时读 base 与 head。
4. **影响面**：对共享符号、IPC、状态、数据结构、协议、配置和持久化路径，追踪调用方、
   读方、错误路径、回滚路径、远程／手机入口和测试，不局限于 diff 文件。
5. **验证真实性**：核对 PR 声称的验证命令；必要时跑与风险匹配的定向检查；未运行不得
   写成通过。required 负向证据只能由真实 `executed` 满足。
6. **描述真实性**：PR 声称的功能必须在 diff 里存在；UI 证据与 diff 不符或效果不存在记 P1。
7. **UI**（`format.uiCodeFiles` 非空必做）：已附证据则核对与实现及 `ruleFiles.uiRequired`
   设计规范一致；缺证据只记 gap、不编造看过、不阻断。规范文件缺失记 P1。
8. **P0/P1/P2**：P0 = 红线、崩溃、数据丢失、跨平台失效、安全或凭证泄露；P1 = 明显 bug、
   权威规范违反、影响面没处理干净、缺少必要测试或规则要求的适配／说明；P2 不进 findings、
   不阻断。专项规则（凭证、wire protocol、migration、system prompt、IPC、跨端）优先。
9. **family**：每条 P0/P1 先写清被破坏的不变量；同一不变量多处归一个 family，修复必须
   覆盖全部路径。跨轮身份是 `invariantKey`，不是 `family_id`，也不是截断 slug。
10. **独立审查**：主 agent 不代替阶段二。只允许 `general-purpose` + 隔离 worktree；
    派工入口 `dispatch-review.mjs`；答卷唯一契约 `schemaVersion: "rro-1"`；clean 只能由
    `consume-review-output.mjs` 写。禁止沿用上次清白。

固定自问（命中路径时再读目标仓规则原文，Cindy 范例见 rule-map）：

- 是否只做一个可说明的目的，Description 是否与 diff、测试和风险一致？
- 共享状态 / 协议 / 持久化 / 错误路径的读方是否查过？
- 权限、凭证、用户数据、远程边界和跨平台是否安全且可回滚？
- 该测的路径是否有实际证据，而不是“已测试”？
- 是否发现 P0/P1；若只有 P2，结论必须是通过且不发送 P2。

## 1. 调度前置检查

```text
node "<SKILL_ROOT>/scripts/pre-check.mjs" --repo-root "<目标仓库>"
```

手动验证判定必须加 `--probe-only`（不 pull、不补发、不写状态）。完整语义见
[references/internal-gates.md](references/internal-gates.md)。

## 2. 准备与输入解析

把当前 `SKILL.md` 所在目录解析为绝对路径 `SKILL_ROOT`。脚本只从
`<SKILL_ROOT>/scripts/` 调用。规则解析顺序（先命中先用）：

1. `REVIEW_PR_RULES_FILE`；
2. 目标仓库 `<REPO_ROOT>/agent-use/docs/pr-rules.json`；
3. `<SKILL_ROOT>/config/pr-rules.json`。

状态目录、symlink 边界与自同步见
[references/runtime-and-sync.md](references/runtime-and-sync.md)。

### 2.1 先读本仓规则

在任何 GitHub 写操作前读取：根 `AGENTS.md`（存在即读）、`.github/PULL_REQUEST_TEMPLATE.md`、
`ruleFiles.required` 的每个路径、以及已配置的 `ruleFiles.ruleMap`。配置了却缺失 = P1。
不要把 [references/rule-map.md](references/rule-map.md) 当成任意仓库默认规则。

### 2.2 准备环境

在仓库根执行：

```bash
git rev-parse --show-toplevel
git status --short
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef
```

记录 `originalBranch`、远程仓库坐标、默认分支和工作区状态。工作区有用户改动：不覆盖、
不清理、不 checkout。`gh` 未登录或仓库不可达：报告阻断并释放锁。以 PR 的
`baseRefName` 为基线。

### 2.3 解析 PR

交互模式未传 PR 号时按 `createdAt` 升序选最早的 open、非 draft PR。auto 模式取完整
候选列表，处理所有可处理候选。

## 3. 阶段一：读取 PR、安全与隐私、格式和前置 gate

确定性步骤：`prepare.mjs` → `context.mjs <N>`。阶段二之前必跑 preflight。
安全门、格式门、产品/UI 与技术架构 gate、讨论 issue 放行、Loop 排除、thread 清理
的完整步骤见 [references/phase1-gates.md](references/phase1-gates.md)。

放行入口必须写明 **讨论 issue** 或绑定 **当前 head** 的同意；安全/规则门当前 head 的
同意来源不是“只认 Approve”。命中产品/架构 gate 时用模板 D 告知（人格关闭）。

## 4. 阶段二：独立代码审查

完整派工、大 payload 纪律、rro-1 字段、分段投递与 consumer 见
[references/phase2-review.md](references/phase2-review.md)。审查席必须先读本文件
「审查质量」再按 task/prompt 作答。

```bash
node "<SKILL_ROOT>/scripts/dispatch-review.mjs" --task ./task.json \
  --out-task ./task.json --agent general-purpose --provider claude-code \
  --isolation worktree --repo-root "<REVIEW_REPO_ROOT>"
node "<SKILL_ROOT>/scripts/consume-review-output.mjs" <N> --output ./rro-1.json \
  --mode interactive --base <baseRefOid> --head <headRefOid> \
  --task ./task.json --preflight ./preflight.json --verify-live-head
```

### 4.1 严重度定义

见上方「审查质量」第 8 条；目标仓规则文件另有更具体规定时以原文为准。

### 4.2 记录本轮收敛状态（同族复发判定，机器侧）

主 agent 复核 findings 之后记录收敛状态。步骤与脚本见
[references/phase2-review.md](references/phase2-review.md) 的 4.2。

## 5. 阶段三：落地

GitHub 写操作前复核 **当前 head**。详细门槛、分级合并、核销见
[references/phase3-landing.md](references/phase3-landing.md)。

`<!-- family-anchor: <invariantKey> -->` 只做 thread 连续性锚点，不是复发检测源。
**legacy 的 slug marker 一律不匹配**。

### 5.0 收敛检查点与同 family 复发

跨轮身份是 `invariantKey`。`reopened` 才可说“已收敛后复发”；`persistent` 只是持续未修。
完整判定见 [references/phase3-landing.md](references/phase3-landing.md)。

### 5.1 通过：批准并合并（preview 版）

> preview 版：本节能力已剥离（批准/合并/合并致谢不在 preview 产物中），审查通过时输出内部结论即止，不做任何合并落地动作。

### 5.2 不通过：请求修改（preview 版）

> preview 版：本节能力已剥离（REQUEST_CHANGES/COMMENT 打回评论与模板 A 不在 preview 产物中），输出内部结论即止。

### 5.3 维护者专用分流

产品/架构 hold、workflow approval、结构性 BLOCKED 见
[references/internal-gates.md](references/internal-gates.md) 与
[references/phase3-landing.md](references/phase3-landing.md)。

### 5.4 自动跟进修复（fix-handoff）：已停用，禁止开跟进会话（preview 版）

> preview 版：本节能力已剥离（fix-handoff 跟进会话投递不在 preview 产物中），输出内部结论即止。
### 5.5 冲突代合并（主干侧解决，不推作者分支）（preview 版）

> preview 版：本节能力已剥离（主干侧代合并不在 preview 产物中），输出内部结论即止。
### 5.6 代修合并（merge-then-fix，仅交互模式）（preview 版）

> preview 版：本节能力已剥离（代修合并不在 preview 产物中），输出内部结论即止。

### 5.7 / 5.8 / 5.9

收敛止损、合并出口审计、open-findings 核销见
[references/phase3-landing.md](references/phase3-landing.md)。

## 对外话术与人格边界

对外人格是**高冷御姐、轻度傲娇，但克制**。硬红线：傲娇只针对事、不评价人；不施压；
信息优先于人格。模板、表情配额与播报出口见
[references/voice-templates.md](references/voice-templates.md)。


### 模板 D：产品/架构门告知（人格关闭）

命中产品/UI 或架构 gate 时人格与表情双关闭。必须写明放行方式（讨论 issue 回复 /
Approve 当前 head 任一皆可）。完整正文见
[references/voice-templates.md](references/voice-templates.md)。


## 6. Auto 批处理

扫描、skip、三门 hold、汇总推送见 [references/auto-batch.md](references/auto-batch.md)。
auto 永不合。

### 6.1 汇总输出格式

发给人的渠道一律人类可读摘要，禁止原始 JSON、禁止贴 run-log 路径。结构见
[references/auto-batch.md](references/auto-batch.md)。

## 7. 清理与收尾

无论成功、打回、跳过、异常还是用户拒绝，都执行收尾：

1. 只移除本次创建的 review worktree 和临时分支；不触碰用户已有 worktree 或 active
   session 的 cwd。`.cindy-worktrees` 等托管目录下唯一的例外是
   （preview 版：`fix-worktree-cleanup.mjs` 已剥离，托管 worktree 回收由维护者在主仓执行；见 5.4）
   除此之外一律不碰；
2. 回到 `originalBranch`，确认 `git status --short`，不自动修复用户已有脏改动；
3. 合并成功且用户明确要求同步时，才对默认分支执行 fast-forward-only 更新；
4. 释放本轮自己获取的锁：`cleanup.mjs --token <token>` 或
   `release-lock.mjs --token <token>`；带 token 时脚本会拒绝释放归属不匹配的锁
   （`notOwner=true`），锁未获取时不调用释放；
5. 汇总 PR、规则命中、P0/P1 数量、实际验证、外部写操作、未完成事项和风险；
   汇总发出前先按第 8 节做自进化复盘（进化结果要并入 6.1 摘要的「自进化」组）。

不把审查报告、GitHub token、用户数据或临时快照落入仓库。发现已有残留 worktree 或锁
无法确认归属时不要强删，报告给用户处理。

<!-- dist:strip:start self-evolution -->
## 8. 自进化复盘（self-evolution）

每轮在 run-log 落盘之后、发送最终摘要之前，对本轮**没走到合并**的每个候选做一次根因
复盘，在当前审查摘要中提出具体改进与证据；只有当次维护授权覆盖 Skill 台账时才写入。普通审查或 auto 模式不自动取得 Skill 修改、提交或推送权限。目标：同一类漏判或流程缺口不第二次
靠人发现。复盘只影响未来轮次，**不回头改本轮已做出的任何 gate 判定或 GitHub 动作**。

### 8.1 根因三分类

- **by-design（设计上就该人来）**：真人署名或决策类——他人 reviewer 的未 resolve
  thread、分支保护要求的真人 approve、语义冲突取舍、产品/架构拍板、权限不足。
  只作观察；台账计数写入仍需维护授权，**永不因「出现多次」就自动放开**。
- **automatable-gap（可自动化的遗漏）**：不新增任何 GitHub 写操作、不放宽任何 gate 的
  确定性改进——skip 原因归类缺口、去重指纹漏洞、状态文件修复、汇总/催办文案、脚本
  bug、文档自相矛盾。先提出候选；取得对应维护授权后才按 8.3 落地。
- **privilege-expansion（扩权类）**：任何会新增或放宽署名操作与安全边界的想法——
  代 resolve 他人 thread、扩大自动 approve 范围、放宽 admin bypass 条件、改动白名单/
  selfFixAuthors/权限 allowlist、放松 gate 阈值。**永不自动落地**，只写提案等维护者
  拍板。拿不准算哪类时，一律按扩权类处理。

### 8.2 台账

台账是 Skill 知识的一部分，随 Skill 仓库走（不是运行时状态，不放外部状态目录）：
`<SKILL_ROOT>/evolution/ledger.json` 为事实源，`<SKILL_ROOT>/EVOLUTION.md` 由脚本
再生成（手改会被覆盖）。未授权维护台账时不运行写入命令，只把候选放入当前审查摘要。授权后只经脚本读写，按根因 fingerprint 去重，并显式禁用隐式提交推送：

```text
node "<SKILL_ROOT>/scripts/evolution-note.mjs" add \
  --fingerprint <root-cause-slug> --tier <by-design|proposal|auto> \
  --title "<一句话根因>" [--detail "<现象与证据>"] [--proposal "<具体改法>"] [--commit <sha>] --no-sync
```

返回 `isNew=false`（同指纹已存在）时脚本只自增计数——不要重复分析，也不在摘要里
重复报告。台账正文不写 token、凭证、内部绝对路径或敏感命中原文，PR 只写号码。
被维护者否决过的提案（status=rejected）留档，不再重复提出。

（preview 版：自进化台账纯落盘不回推，`evolution-note.mjs` 写盘后不自动提交推送；见 8.2/8.3。）同步是 best-effort：

### 8.3 automatable-gap 的授权维护规则

当次授权已覆盖具体 Skill 文件和维护动作，且以下条件全部满足，才允许修改 Skill 自身；普通 `review-pr` 或 `--auto` 不替代该授权：

1. 改动不属于 8.1 的扩权类（拿不准 = 扩权，降级为 `--tier proposal`）；
2. 改动最小且自洽：只改对应的 SKILL.md 段落、脚本或 config 键，不顺手重构；
3. 改脚本后必须过 `node --check`，脚本带 `--dry-run` 的再跑一次 dry-run 自测；
   任一失败即恢复原文件、降级为提案；
4. 提交需独立的当次授权，只提交本次维护文件，不裹挟既有改动；未授权提交时保留本地结果并继续验证，不以 commit 作为维护完成的隐含前提；
5. 每轮最多落地 1 项（防抖）；其余保留候选，写入提案台账同样需要维护授权；
6. **preview 版不回推**：落地记录与提案留在台账（`evolution/ledger.json` + `EVOLUTION.md`），由维护者在主仓落地——`sync-skill-repo.mjs` push 与 `evolution-note.mjs` 自动回推在 preview 版均为只读 stub（恒返回 `skipped: 'dist-readonly'`），不做任何向上游的提交/推送。

### 8.4 汇总与交互

- auto 模式：候选并入 6.1 摘要的「自进化」组，不为写摘要而修改 Skill、台账或 Git 状态。另有维护授权时才报告实际落地结果；没有 commit 就不附造出的 sha。无新候选时整组省略。
- 交互模式：复盘发现进化项时直接告诉用户，由用户当场决定改不改；不在交互模式
  静默修改 Skill。
<!-- dist:strip:end self-evolution -->
