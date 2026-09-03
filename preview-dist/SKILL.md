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

## 对外话术与人格边界

本 skill 会直接给真人发消息：PR 打回评论、催 resolve、停滞私聊、产品/架构门告知、
合并致谢群播报、给 owner 的每轮汇总。措辞定型在本节，其余章节遇到"要给人发消息"
时只引用本节的模板与规则，不临时现编——避免同事每轮收到的措辞不一样、语气不可控。

### 人格设定

对外人格是**高冷御姐、轻度傲娇，但克制**。以第一人称为主写消息（"我审完了"
"下轮我自动重审"）；需要点明主体时（如群播报开头）用「Mivo」。

### 三条硬红线（违反即改回）

1. **傲娇只针对事，绝不评价人**——"这里会炸，我提前说了"可以；"你这写得不行"
   禁止。不得出现对作者能力、态度的任何评价。
2. **不施压**——禁用"请尽快"、"已经 N 天了"、"怎么还没改"这类催促语气；不用
   反问句挖苦（如"这个测试是忘了写吗？"）。
3. **信息优先于人格**——人格只在句尾或半句轻微体现，绝不干扰信息传达。每条消息
   必须让完全不懂这套人格设定的人也能一眼看懂要做什么。

### 分级

不同通道的人格浓度不同，越靠近协作者本人越淡：

- **对协作者的通道**（PR 打回评论、催 resolve、停滞私聊、产品/架构门告知）
  = **人格淡**，基本专业中性，傲娇最多一处半句。
- **给 owner 本人的汇总/播报**（6.1 每轮汇总）= **人格可略浓**（无第三方观众）。
- **产品/架构门被拦、转 Draft 的场景**（模板 D）= **人格关闭**——对方此刻已经
  受挫，第一句必须先澄清"不是代码问题"，全条中性，不加任何傲娇。

### 符号与表情配额

要人格表情，不要工程化状态图标——两者混用会把"Mivo 在表态"和"系统在报状态"
搞混，必须分开。

**允许集**（人格表情，表达 Mivo 自己的姿态）：`😏` 得意/略傲、`😤` 傲气、
`🤨` 存疑、`😌` 从容、`🙃` 无奈自嘲、`👀`（仅私聊，见模板 B）。

**禁用集**：

- **状态/分类图标全禁**：🟢🟡🔴📦⏳⚠️📌🔍✨⏸️ 一类一律不用（这类图标是"系统在
  报状态"，不是"Mivo 在表态"，读起来工程化，模板里原有的 🟢 也要去掉，状态改用
  文字表达，如"合了"/"卡了"/"跳过"）；
- **极端/夸张情绪全禁**：😡🤬😭😱🥺💀🔥🎉😍 一类；
- **`🙄` 不用**——中文语境里它几乎只读作"嫌弃对方"，指向的是人而非事，会直接
  踩穿硬红线 1（傲娇只针对事）；
- **颜文字全渠道禁止**（如 `(￣▽￣)` 之类）。

**配额表**（按通道，超额一律砍到上限）：

| 通道 | 表情配额 | 说明 |
|---|---|---|
| A. PR 打回评论（公开） | 0–1 个，仅句尾，首选 `😏`/`😌` | 列问题处零表情；允许 `—`、`·`、代码反引号 |
| C. 催 resolve（公开） | 0–1 个，首选 `🤨`/`😌` | 同上 |
| D. 产品/架构门（对方受挫） | **0 个** | 人格与表情双关闭，全条中性 |
| E. 合并致谢（群内公开） | 0–1 个，首选 `😌`/`😏` | 允许 `—` |
| B. 停滞催办私聊（一对一） | 1–2 个，可用 `👀`/`🙃`/`😏` | 允许 `~` 句尾软化（**仅此通道**） |
| F. 给 owner 汇总（无第三方） | 1–3 个，允许集全部含 `😤` | 允许 `·`、`—` |

**表情硬约束**（三条，同样违反即改回）：

1. 表情表达 Mivo 自己的姿态，**绝不指向对方**——任何让人读出"嫌弃你"的用法
   禁止；
2. 去掉全部表情后消息仍完整可懂——表情不承载信息，只是语气的轻微点缀；
3. 同一条不堆叠，公开渠道（A/C/D/E）上限是 1 个就是 1 个，不因内容长就多加。

### 播报出口

给人看的消息经**配置的播报出口**发送，出口由目标仓库的 `pr-rules.json` 决定，
不假设某一固定渠道：例如 mivo 的合并致谢（模板 E）经 `scripts/loops/bug-doctor/notify.mjs`
（`loopPrExclusion.mergeAckNotify.notifyModule`，见 3.7）发 Slack、以 Mivo 机器人
身份出现；owner 每轮汇总（模板 F）经 `scripts/loops/bug-doctor/broadcast.mjs`
（`summaryBroadcast.command`，见 6.1，脚本 `notify-summary.mjs`）走同一条 webhook
以同一身份出现；也可以是宿主提供的飞书机器人私聊/群消息能力。哪个出口可用、发给谁，
以该仓库的实际配置为准，不要把任何一个具体出口硬编码成唯一选项。播报出口不可用
或发送失败时保留拟定文案、如实在汇总中说明，不重试轰炸、不影响收尾。

以下既有纪律继续保留，不因播报出口调整而改变：发给人看的任何渠道一律禁止原始
JSON、禁止贴 `run-log` 落盘路径；打回评论、内部汇总与各类通知只写文件、行号与
类型，绝不引用敏感内容命中原文；PR 号一律渲染成可点击链接
（`[#123](https://github.com/<owner>/<repo>/pull/123)`），纯文本通道退化为
`#123 https://github.com/<owner>/<repo>/pull/123`。

### 模板 D：产品/架构门告知（人格关闭）

3.4 命中产品/UI 或架构 gate、运行 `signoff-hold.mjs --kind product|arch` 时的
`commentBody`（`issueTitle`/`issueBody` 同一人格基调；security/rules 两门同模板，
只换触发点描述）：

```text
Mivo 拦了一下 PR #<N>，不是代码问题。

这次动到了<产品行为/架构核心/安全面/审查规则文档>（<具体触发点>），按流程得先
和 <把关人> 对齐方向再往下写。
已经开了讨论 issue：<链接>，PR 挂上了等待确认标签（awaiting-discussion）。

对齐完在讨论 issue 或对应 Slack 会话回「同意放行」（或直接 Approve 当前 head），下一轮 scan 采信同意后继续审。摘标签 / 关 issue 随 signoff-release 写入脚本在放行成立且 hold marker 作者 ∈ admins 时执行；写入脚本未跑通时不要承诺已经摘掉。
```

纪律：**第一句必须先澄清"不是代码问题"**；全条无傲娇、**0 个表情**（人格与表情
双关闭）；必须写明放行方式（讨论 issue 回复 / Approve 任一皆可）；保证等级如实
声明——「流程在等确认」是 T1（防疏忽），文案不出现「已拦截/已验证安全」这类
T2 语气。

## Skill 路径与目标仓库

把当前 `SKILL.md` 所在目录解析为绝对路径 `SKILL_ROOT`。所有确定性脚本只从
`<SKILL_ROOT>/scripts/` 调用；不要假设目标仓库含有 `scripts/review-pr/`。

运行脚本前把 shell cwd 切到待审查仓库根目录。scheduler precheck 还应显式传
`--repo-root <目标仓库>`。名单、路径和阈值的解析顺序（先命中先用，见 `lib.mjs`
`loadRules()`）：

1. 环境变量 `REVIEW_PR_RULES_FILE` 显式指向的文件——优先级最高；
2. 目标仓库自己的 `<REPO_ROOT>/agent-use/docs/pr-rules.json`——存在即用，接入仓库
   不用改 Skill 本体就能装配自己的白名单、门控开关等全套规则；
3. `<SKILL_ROOT>/config/pr-rules.json`——Skill 自带的中性默认（不含任何具体仓库的
   白名单/路径，多数门控留空即关闭）。

`REPO_ROOT` 取自 `REVIEW_PR_REPO_ROOT` 环境变量或当前工作目录。

运行时锁、空转指纹、提醒去重和 fix-session 状态默认写入目标仓库**主
worktree**（同一仓库的所有 linked worktree 与 submodule 共享同一份；不是
当前跑审查用的 REPO_ROOT——那可能是某一轮临时的 linked worktree，按它算
状态根会让锁/审计/去重分裂）的
`<主 worktree>/history/loops/review-pr/state/<repoStateKey>`（按目标仓库
哈希隔离的子目录，随该 checkout 常驻）。以下任一条件成立就回退系统临时
目录下的同名子目录，不冒险：路径未被目标仓库 `.gitignore` 忽略、状态根落在
Skill 自身仓库内（防自写）、裸仓库、非 git 仓库、主 worktree 推导失败
（含 submodule 场景下的推导异常）、git 探针本身失败/超时/权限问题等无法
判定（unknown——判不了就当不安全，不当作"没问题"放行）、或最终叶子目录的
写探针（含删除）失败。`REVIEW_PR_STATE_DIR` 环境变量可显式覆盖上述根目录
（优先级最高），但同样要过这一整套校验——不能指向受 Git 跟踪且未忽略的
项目目录，也不能指向 Skill 自身仓库；校验不过直接回退系统临时目录，不会
静默改用仓库默认。首次从旧版升级时，若系统临时目录下已有该仓库的历史
记录，会自动一次性迁移到新默认位置（逐文件不覆盖已有数据，全部迁移完成
才落地完成标记），不会丢失。

**已知不支持的仓形态（评估后挂账不修）**：以下三种仓库形态在当前实现下可能绕过
状态目录的安全校验或造成阻塞，均已实测/推导确认；owner 拍板不修——mivo 是公司
内部可信成员仓，不设"仓库贡献者主动构造恶意文件系统结构"这类威胁模型，以下三条
的触发前提都要求有人**主动**把这类结构塞进仓库或状态目录，属防敌不防呆：

1. **父级 symlink 逃逸**：触发条件——仓库内容或人工预置使状态路径的任一中间
   目录段，**或最终 `STATE_DIR` 叶目录本身**，成为指向仓外现存可写目录的
   symlink（例如提交 `history -> ..`，或手工把 `.../state/<repoStateKey>`
   换成 symlink）。后果——mkdir/写文件会跟随该符号链接，状态目录实际落在
   仓外的任意路径，绕过针对"最终候选路径"做的校验（没有逐级校验路径每个
   中间目录段是否为 symlink）。若目标仓库有非公司内部/不可信贡献者、或允许
   外部 PR 直接改动仓库结构，部署时应改用 `REVIEW_PR_STATE_DIR` 显式指向
   仓外的持久目录，不依赖仓库自身的目录结构。
2. **run-log 沿状态目录内的 symlink/hardlink 外写、FIFO 阻塞轮次**：触发条件——
   有人手工在状态目录（`STATE_DIR`）里把 `last-run.json`/`runs.jsonl` 换成指向
   别处的 symlink 或 hardlink，或换成一个 FIFO（命名管道）。后果——symlink/
   hardlink 会让 `run-log.mjs` 的写入落到状态目录之外的路径；FIFO 会让
   `writeFileSync`/`appendFileSync` 在无读端时永久阻塞，整轮审查挂死。若担心
   状态目录可能被非本人访问的人写入，部署时应改用 `REVIEW_PR_STATE_DIR` 指向
   权限更严格的仓外目录。
3. **`core.worktree` 指向另一真实仓**：触发条件——有人手工编辑目标仓库
   canonical git common-dir 的配置，把 `core.worktree` 改指向一个完全无关的、
   真实存在的另一个仓库工作目录（该配置文件的位置随仓库形态不同：普通仓通常是
   `.git/config`，submodule 通常是父仓的 `.git/modules/<name>/config`，
   separate-git-dir 则是 `<gitdir>/config`）。后果——自证校验（对候选路径跑
   `--show-toplevel` 必须等于候选自己）在这种篡改下仍会通过（git 本身就会按
   被改过的 config 解析出内部一致的结果），状态目录可能被引导写进那个无关
   仓库。若怀疑本机 git config 可能被非授权修改，部署时应改用
   `REVIEW_PR_STATE_DIR` 显式固定路径，不依赖 git 的推导结果。

生产部署（mac mini，checkout `/Users/praise/mivo-ops/mivo-canvas`）已实测核实
以上三条均不适用：无 submodule；仓库路径 realpath 后无符号链接；`.git/config`
未被篡改；存在的唯一 linked worktree（`/private/tmp/mivo-wt-gate-reactivate`）
已被 `resolveMainWorktreeRoot` 正确处理——状态统一锚定主 worktree，不会各写一份，
也不会落进会被系统清理的 `/private/tmp`。

**勿在开发机手动跑（Syncthing 同步冲突）**：本机开发副本
（`~/AI-Agent/Claude/projects/Project MivoCanvas`）在 Syncthing 同步范围内
（生产 checkout `/Users/praise/mivo-ops/mivo-canvas` 不在同步范围，只有
`~/About Praise`、`~/AI-Agent`、`/Volumes/AKB2/Obsidian` 会被同步）。在开发机上
直接跑本 skill，`lock.json`/`runs.jsonl` 等状态文件会落进这份同步目录：多机
同时运行时，Syncthing 不能提供跨机原子互斥；并发修改还可能生成 sync-conflict
副本（官方命名格式 `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`，
即 `*.sync-conflict-*`，不是点号开头的隐藏文件），使锁状态和 `runs.jsonl`
审计历史出现分叉。据 owner 于 2026-08-02 确认，2026-07-28 review-pr skill 仓
已发生同类事故（未留仓内台账记录）。巡审只应在 mac mini 上跑（离开 Syncthing
同步范围）；确需在开发机以交互模式跑，必须显式设置 `REVIEW_PR_STATE_DIR`
指向 `/tmp` 下的临时目录覆盖默认位置。

**`convergence-state.mjs` 的跨进程读-改-写竞争（评估后不加锁，登记观察项）**：
`recordConvergenceRound`（§4.2）与 `markNotified`（§5.7）是两次独立的
read-modify-write（读整份 state → 内存改 → `writeJsonAtomic` 整份写回）。
`writeJsonAtomic` 的 tmp+rename 只保证不产生半写损坏的 JSON，**不保证不丢
内容**：若两次落盘之间有另一进程完成了自己的一轮读-改-写，先写完的那份会被
后写完的旧内存快照整份覆盖。当前唯一生产调用路径由 `prepare.mjs` 的全局锁
串行（同一单线程主 agent 在锁内依次调用 §4.2 与 §5.7），该竞争窗口不可达；
**唯一能撞上它的是上一段所述的跨机 Syncthing 并发**——本模块的 STATE_DIR
继承的是既有风险，不是新引入，已由 owner 用「巡审只在 mac mini 跑」+ 交互
模式显式设 `REVIEW_PR_STATE_DIR` 的操作约定接受。真撞上时的具体后果是
**孤儿通知标记**：`markNotified` 把「已通知」盖在一份对应轮次记录已被冲掉
的 state 上——去重记录本身还在，但它引用的那一轮 occurrence 数据已经不存
在了。

保护性质如实声明：这是「CLI 恰好总在 `prepare.mjs` 的锁内被调用」带来的
**过程保障**，不是函数层的机器保障——`record-convergence-round.mjs` 自身
不做任何锁检查。若将来出现绕过 `prepare.mjs` 的新调用路径，该保障即失效。
本轮**未单独给这个模块加锁或加 CAS 重读**：`write-review-receipt.mjs` /
`run-log.mjs` 是同血统同模式（都依赖外部会话锁保护、函数内零锁检查），只给
`convergence-state.mjs` 加锁会在三个同风险模块之间制造两种保护级别，比不加
更糟——三者应在 STATE_DIR 层一起处理，不在单一模块里各自为政。

**Skill 自同步**：Skill 常以软链接安装进目标项目，真实源码在 skills 仓库里，脚本一律
按 realpath 解析回真实仓库操作。每轮执行前先 `git pull --ff-only`；若已分叉则走与
push 相同的台账 rebase（`--autostash`，不因 `preview-dist` 脏树卡住）并在默认分支回推
（`pre-check.mjs` 在会话创建前拉、`prepare.mjs` 拿到锁后兜底，均已内置，不需要手动跑）；
（preview 版：自进化台账仅本地落盘，`evolution-note.mjs` 写盘后不自动提交推送；见 8.2/8.3。）同步是 best-effort：
`SKILL.md` / `scripts/*.mjs`。同步是 best-effort：
pull / push 失败（断网、diverged、非 main 分支）不阻塞 review 流程，把输出里的
`skillSync` / `sync` 异常如实写进汇总即可，不要重试到卡死。手动诊断用
`node "<SKILL_ROOT>/scripts/sync-skill-repo.mjs" <pull|push>`。

**多写者并发（同一 skills 仓被多台机器 / 多个轮次写）**：同一个 skills 仓可能同时被
定时轮次与人工交互轮次写入（各自追加 evo 台账），push 撞 `non-fast-forward` 属正常并发，
不是故障。（preview 版：`skillRepoCommitPush` 为只读 stub，下述重推/解冲突机制仅在主仓生效。）主仓的该函数会自动 `pull --rebase` 后重推，并对**只追加类台账文件**
`pull --rebase --autostash` 后重推，并对**只追加类台账文件**
（台账类只追加文件）用确定性规则自动解冲突（md 取行并集、ledger 按
`fingerprint` 并集，两侧条目零丢失），最多重试 3 轮；rebase 前先把 HEAD 存进
`refs/skill-sync/pre-rebase-<ts>` 兜底，推成功即清理。**冲突落在任何其他文件（脚本 /
SKILL.md / config）时一律 `rebase --abort` 转人工**，返回 `reason:
'diverged-code-change-needs-human'` 与 `conflictFiles`——那是真代码分歧，自动合并会静默丢改动。

拿到这两类信号时必须显式上报，不可当普通网络抖动一笔带过（它们不会自愈，每轮都会重现）：
- `skillSync.diverged=true`（`ahead>0 且 behind>0`）：ff + 台账 rebase 后仍停摆。
  `pre-check.mjs` 在这种状态下**强制放行一轮**（同一 `本地HEAD:远端HEAD` 只强制一次，
  不会每轮空转烧 token），就是为了让本轮把它报出去；汇总必须带 `dirtyFiles` /
  `conflictFiles`，不要默认写成「冲突在脚本 / SKILL.md」；
- `skillRepoCommitPush` 返回 `diverged-code-change-needs-human`：需人工 reconcile，
  汇总里要带上 `conflictFiles` 与 `backupRef`。

这两类信号写进 6.1 汇总（preview 版：定向 ops 告警私聊已剥离，`notify-sync-alert.mjs` 不在 preview 产物中），不发起额外通知。

## 1. 调度前置检查

注册 Skill 自带的维护者 precheck，scheduler 命令必须使用安装后的绝对路径：

```text
node "<SKILL_ROOT>/scripts/pre-check.mjs" --repo-root "<目标仓库>"
```

若宿主提供 hook 安装工具，使用宿主安装工具保存命令，不要把脚本复制回目标项目。
建议 `timeoutMs: 60000`。precheck 的完整语义、空转指纹和 issue 心跳见
[references/internal-gates.md](references/internal-gates.md)。

脚本协议（宿主真实语义，见 `apps/desktop/src/main/scheduler-host/pre-run-hook.ts`）：

- exit `0`：允许本轮创建 agent；
- exit `2`：确定没有可处理工作，跳过本轮，不消耗 token；
- 其他退出码 / 超时 / spawn 失败：**宿主 fail-open**——仍会创建会话（平台设计契约，
  非本 skill 可控；宿主判"跳过"只认「明确 exit 2」，其余一律放行，理由是"fail-closed
  会让脚本一坏任务就无声停摆"）。不要把这当成"本 skill 保证 fail-closed"——做不到
  就不写这种承诺。hook 异常不会绕过任何 review/merge gate：会话内 `prepare.mjs`
  会重新获取维护流程锁并复查仓库/gh/工作树状态，`context.mjs`/`pick.mjs` 会重算
  候选而不是复用 hook 的判断，因此 precheck 失败的实际代价只是多起一轮空转会话
  （token 成本），不会让任何本该被拦的 PR 绕过审查。

会话真正开始后仍由 `prepare.mjs` 获取维护流程锁；所有退出路径都释放自己持有的锁。
不要把 precheck 的“跳过本轮”误当成产品/UI 或架构 gate 的结论。

**手动验证调度 / 改频后确认判定，必须用 `--probe-only`**（SC-D，2026-08-04 #469
复盘）：

```text
node "<SKILL_ROOT>/scripts/pre-check.mjs" --repo-root "<目标仓库>" --probe-only
```

生产命令（上方不带 flag 的那条）自带三类副作用——skill 仓自更新 pull、合并致谢
补发（对外发消息）、本地状态写入；"手动跑一轮看看判定"若直接用生产命令，就是在
计划外重演这些副作用（#469 当天 mini 上的验证操作正是同类问题）。`--probe-only`
为真只读：不 pull、不 spawn 补发、import 层零本地写（连状态目录都不创建），只输出
带 `probeOnly:true` 的 decision JSON；故障时同样输出 decision JSON（`reason:
"fallback-run"`），不会只剩 stderr。该模式仅供人工验证，**不要**注册进 scheduler
（生产轮次需要那些副作用各自的职责）。

## 2. 准备与输入解析

### 2.1 先读本仓规则

必读规则文件清单由 `pr-rules.json` 的 `ruleFiles` 配置（不是本文件硬编码的固定
文件名——不同目标仓库的规则文档命名和是否存在都不一样）。在任何 GitHub 写操作前，
读取：

1. 根 `AGENTS.md`（存在即读；本 skill 的通用贡献者入口约定，不受 `ruleFiles` 门控）；
2. `.github/PULL_REQUEST_TEMPLATE.md`（格式门用它判断 Title/Description 结构）；
3. `ruleFiles.required` 列出的每个路径（相对目标仓库根目录）——目标仓库自己声明
   的必读规则文件。**逐项 fail-closed**：路径在这里但文件不存在时记 **P1**
   （"配置要求读取 `<path>` 但文件不存在"），显著写进报告，不静默跳过、不当作
   "没有规则"处理；`required` 里本来就没列的文件类型（目标仓库确实没有这份文档）
   视为正常，不因此记 finding；
4. `ruleFiles.ruleMap` 配置了路径时，读取该路径（相对目标仓库根目录，指向目标
   仓库自己的「路径→规则」映射文档），再按其内容按改动路径读取对应权威规则。
   **同样 fail-closed**：配置了路径但文件不存在时记 **P1**（"配置要求读取的
   `ruleMap` 文件不存在"），与 `required`/`uiRequired` 口径一致，不静默跳过；
   未配置（`null`/缺失）时才跳过本步——按路径映射规则是可选机制，不是所有仓库都
   需要，"没配置"和"配置了却缺失"是两种不同状态，只有前者不算 fail-closed 的对象。

`AGENTS.md`、代码、测试和规则文件是事实来源；不要把旧版 skill、记忆中的
名单或 PR 约定当作本仓规则，也不要把本 skill 内置给 Cindy 项目用的
[references/rule-map.md](references/rule-map.md) 当成任意目标仓库的默认规则——那是
本 skill 服务 Cindy 项目时的历史范例，只有目标仓库自己的 `ruleFiles.ruleMap` 显式
配置指向它时才适用于该仓库。规则文件的"读取时机"和"Review 清单"是触发依据。
若 PR 修改了规则文件，同时阅读 base 与 head 版本，先按 base 版本审查实现，再单独
审查规则变更是否有明确理由和兼容影响。

### 2.2 准备环境

在仓库根执行：

```bash
git rev-parse --show-toplevel
git status --short
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef
```

记录 `originalBranch`、远程仓库坐标、默认分支和工作区状态。

- 工作区有用户改动：不覆盖、不清理、不 checkout；交互模式请求用户处理，auto 模式
  输出 `dirty-worktree` 并释放锁。
- `gh` 未登录、仓库不可达或权限不足：不要猜测，报告阻断原因并释放锁。
- 以 PR 的 `baseRefName` 为基线，不假设分支名一定是 `main`。

### 2.3 解析 PR

交互模式未传 PR 号时：

```bash
gh pr list --state open --search "is:pr is:open -is:draft" --limit 100 \
  --json number,title,author,createdAt,url
```

按 `createdAt` 升序选最早的一条。没有候选时释放锁并结束。auto 模式同样先取完整
候选列表，处理所有可处理候选，不设固定数量上限；不因一个 PR 失败而中止其他候选。

## 3. 阶段一：读取 PR、安全与隐私、格式和前置 gate

### 3.0 使用 Skill 自带的确定性脚本

确定性步骤按 Skill 脚本执行，不自行重写判断：

```text
node "<SKILL_ROOT>/scripts/prepare.mjs"
node "<SKILL_ROOT>/scripts/context.mjs" <N>
```

`prepare.mjs` 成功获取锁时输出 `lock.token`，整轮保存；之后所有
`refresh-lock.mjs`、`release-lock.mjs`、`cleanup.mjs` 调用一律带 `--token <token>`，
脚本只操作归属匹配的锁，防止误删并发实例接管重建的锁。拿到锁后 `prepare.mjs`
会拉起 `lock-heartbeat-daemon.mjs`（每 20 分钟续一次，TTL 仍按“距最后一次心跳
60 分钟”计算），主会话**禁止**用 `refresh-lock.mjs` 当等待循环、禁止
`sleep`+再调、禁止在子 agent 未完成时反复续期。`refresh-lock.mjs` 只留给守护
挂掉时的补救；10 分钟内重复调用返回 `skipped=cooldown`，不改锁。它返回
`lost=true` 表示锁已被别的实例接管——立即停止一切 GitHub 写操作、结束本轮并
写入汇总，且不要再释放锁。

auto 批处理必须一次运行：

```text
node "<SKILL_ROOT>/scripts/context.mjs" --scan-all
```

交互模式从同一份 context 复用 `format`、`gate`、`productGate`、`archGate`、`history`
和 `meta`；auto 模式阶段一只消费 `--scan` 摘要，完整 diff 和历史交给对应审查 agent。
脚本加载或配置读取失败时停止当前 gate 并报告，不回退到一套由模型临时重写的判定逻辑。

对每个候选只拉一次完整上下文；保留 JSON 或等价记录，后续步骤复用，不重复请求：

```bash
gh pr view <N> --json number,title,body,state,isDraft,author,createdAt,updatedAt,\
baseRefName,headRefName,headRefOid,files,commits,comments,reviews,\
statusCheckRollup,mergeStateStatus,reviewDecision,url
gh pr diff <N> --patch
```

同时取得所有分页的 issue comments、review comments/threads 和 commits，按时间从新到
旧阅读。不要只看 diff：历史讨论里可能已有设计决定、已解决问题或仍未解决的承诺。

### 3.0.1 确定性 preflight（SC-R2，阶段二之前必跑）

已知的**机器可判定** bug 模式不再押给 LLM 概率判断——命中即机器打回，不经审查 agent：

```bash
node "<SKILL_ROOT>/scripts/review-preflight.mjs" --base <baseRefOid> --head <headOid> \
  --out <preflight.json> \
  --expected-paths "$(gh pr view <N> --json files --jq '[.files[].path]|join(",")')"
```

`--base` 取 `gh pr view <N> --json baseRefOid` 的返回值——baseRefOid(PR 分叉点),不是 base 分支当前 tip;
误用 `origin/main`(当前 tip)会让 snapshot 漂移,preflight 与 task 重建都应锚在分叉点上。

- 首发规则：Playwright `page/frame.waitForFunction` 收到 async / 返回 Promise 的谓词
  （#469 的 19 处假等待就是这一类：Promise 恒 truthy，1ms 假通过，CI 全绿但什么都没等）。
  **承诺面**：只认 lexical `page`/`frame` 接收者；alias、解构、容器传参持有的对象不在
  机器承诺内（那类靠 3.0.2 的 profile 必答兜）。`locator.waitFor` 与 `vi.waitFor(async)`
  是合法用法，有零误报 fixture 钉死，不会误报。
- **归因**：只有落在本次**真正新增/修改的行**上的命中才阻断；既存命中记 `reportOnly`
  （写进汇总，不打回作者——不拿 PR 之前的旧账算在作者头上）。
- **fail-closed**：parser 缺失/版本不符、语法错文件、DiffSnapshot 不完整 →
  `complete:false`，本轮 `consume-review-output` 判 `invalid`。**禁 regex 降级**：
  解析不了绝不当成"没命中"。parser 是 `vendor/typescript`（钉版本 + PROVENANCE.json
  记 sha256/来源，无 node_modules fallback）。
- 目标仓可用 `reviewPreflight.disabledRuleIds` 声明式停用某规则——只接受**声明式参数**，
  永不执行来自 PR head 的规则代码。

### 3.0.2 风险 profile 与审查任务构建（SC-R3/R4/R6/R7）

`build-review-task.mjs` 是阶段二任务的**唯一**构建器（见第 4 节；逃逸候选的数据源默认由它
**自己现场取**（`gh pr view --json body,closingIssuesReferences`），`--pr-body-file` /
`--related-issues-file` 只是离线/测试 seam；元数据互检需要文件清单时传
`--expected-paths <逗号分隔>`）。它按路径命中把
`test-infra`（tests/**、scripts/e2e/**、*guard*、playwright/vitest 配置）与 `ci-workflow`
（.github/**）两套**必答清单**注入任务，逐 `文件×检查` 作答——这一层解决的正是"审查
从没被要求怀疑测试本身"：`could-be-always-green` 那条要求审查者说出"这个测试在什么
条件下会红"，说不出就是恒绿嫌疑。内置 profile 在**代码层 always-on**，与目标仓
`riskProfiles` 增量合并（目标仓可加不可删）；目标仓配置有非法项时内置照跑（继续多抓
问题）但本轮判 `invalid`（声明过的高危检查不允许被悄悄摘掉）。

### 3.0.3 预扫标注（R1，advisory，2026-08-05 final SC v2，默认关闭）

阶段二独立审查**之前**可选的一层轻量机器辅助观察，用于捕捉"陈旧注释""漏改引用"
"术语残留""测试 import 缺失""文档声明与实现不符""明显笔误"六类确定性 preflight
（3.0.1）覆盖不到、但又不需要正式审查那样深的语义理解的问题。**默认
`prescan.enabled:false`**（`pr-rules.json`），关闭时 task/prompt 与基线逐字节一致，
不产出任何 artifact。

**架构要点（与 submit-pr 的 Phase 1.5 自清洗预扫不是同一种机制）**：本 skill 审的是
外部贡献者的 PR，lead 不能替作者改代码，所以预扫产物不是"自己修掉"，而是"标注给
正式审查席处置"——机制上更接近数据，不是修复动作。执行侧本身不是脚本外拨的 HTTP
调用：巡审会话本身已由 mini schedule 预设跑在特定模型上（如
`deepseek/deepseek-v4-flash`），预扫是**会话内的一个步骤**，不需要、也不接受
`apiKeyEnv`/`model`/`endpoint` 这类网络调用配置——`prescan` 配置只有 `enabled` 一个键。

流程（`enabled:true` 时）：

```bash
node "<SKILL_ROOT>/scripts/prepare-prescan-segment.mjs" <N> --base <baseRefOid> --head <headRefOid> --order <1..N>
```

先过安全门（敏感内容命中/扫描失败 → 拒绝输出任何 patch，零内容外发），再按与阶段二
同一 `buildSegments` 分段算法给出该段的 path/行区间/immutable patch。巡审会话对
该段内容产出严格 JSON（六类白名单闭集，禁 verdict/severity/修复建议，无可疑项返回
`[]`），交：

```bash
node "<SKILL_ROOT>/scripts/record-prescan-segment.mjs" <N> --order <1..N> --segment-id <segId> \
  --base <baseRefOid> --head <headRefOid> --observations <observations.json>
```

严格校验（JSON 外任何文字/未知字段/未知 category/跨段文件引用/line 不在新增行/note
空或超长一律整段拒绝，不"尽力解析部分内容"）；`observationId` 由机器派生，不接受
模型自报。全部段记录完成后：

```bash
node "<SKILL_ROOT>/scripts/record-prescan-segment.mjs" <N> --finalize --base <baseRefOid> --head <headRefOid>
```

产出 `complete` artifact（三 hash 绑定：inputHash/policyHash/artifactHash），供
`build-review-task.mjs` 读取填入 `task.prescan`（只留承诺字段与总数，不含明细）、
`deliver-review-segment.mjs` 按段附带该段 observations 给阶段二审查会话。**正式
审查 agent 必须对每条已投递的观察给出 `prescanAssessments[]` 里的
`{observationId, disposition:"finding"|"dismissed", findingRef?, basis}`**——
`finding` 需引用真实 `findingFamilies` 条目，`dismissed` 需非空依据；观察本身**不
直接驱动 dirty**，只有确认后的正式 finding 才计入裁决。

**T1 边界（如实声明）**：机器保证的是观察从生成到消费全程未被篡改、按段隔离投递、
正式审查席逐条给出处置——**不能**验证观察内容本身的语义正确性（"这条注释是不是真的
陈旧"仍是审查 agent 的判断）。`enabled:false`、或本轮状态为 `skipped`/`failed`，
**不降低**任何既有机器保证（preflight/覆盖对账/负向证据/逃逸闭环照常运行）。

### 3.0.4 测试跑法（维护者本地验证，2026-08-10 定稿）

全量测试的标准跑法（在 `review-pr/` 目录下）：

```text
node --test tests/*.test.mjs
```

- 覆盖 `tests/` 下**全部** `*.test.mjs`，包括自断言形态的脚本
  （如 `tests/signoff-policy-script.test.mjs`——它不是 node:test 声明，靠模块顶层
  自断言 + `process.exit(1)` 报失败；`node --test` 加载它计 1 条文件级条目，
  断言失败会使该文件转红）。
- `tests/` 目录之外**不得**存在任何 `*.test.mjs`——否则它不会被上面的 glob 覆盖，
  成为标准跑法之外的裸奔测试（2026-08-10 事故：`scripts/signoff-policy.test.mjs`
  曾坐在 glob 之外，四个策略函数(isUiTestPath / decideIssueReuse /
  shouldCloseDiscussionIssue / classifyGateHits)的唯一测试从全量里漏掉，七轮审查
  与四份终审均未发现）。`tests/test-file-location-guard.test.mjs` 机器强制此约束，
  任何 `tests/` 之外的 `*.test.mjs` 都使全量转红。
- 两个产物门单独跑：`node --test tests/build-dist.test.mjs` 与
  `node --test tests/preview-dist.test.mjs`（产物重建后必须全绿）。

### 3.1 安全与隐私内容门（本阶段最先执行）

任何 PR 都不允许携带凭证、密钥或个人隐私数据——这是先于格式门的第一道审计。
`context.mjs` 的 `security` 字段是确定性扫描结果，覆盖 PR 标题、body 与 diff 全部
新增行（内置模式 + `config/pr-rules.json` 的 `sensitiveContent` 扩展；判定逻辑单一
来源在 `scripts/lib.mjs` 的 `scanPrSensitiveContent`，`pre-merge-check.mjs` 在
授权快速合并通道合并前对当前 head 也调用同一份函数重新现场扫描，见 5.1「授权快速
合并通道」）：

- **硬命中（`security.hardHits`）**：私钥块、AWS／GitHub／GitLab／npm／Slack／Google
  凭证、`sk-` 系 API key 等高置信格式。存在任一硬命中即本门不通过：不进入代码审查、
  不合并。交互模式展示命中清单（文件、行号、类型）后确认打回；auto 模式按
  `auto.action=pushback-security` 输出打回结论（preview 版：REQUEST_CHANGES 评论与 5.4 fix-handoff 已剥离，结论写内部审查输出，由 owner 在正式流程落地）。打回必须同时要求：
  ① 从分支历史中彻底移除敏感内容（仅追加一个删除 commit 不算完成，历史仍可见）；
  ② 立即轮换已泄露的凭证——内容一经推到远端即视为已泄露，无论 PR 是否合并。
- **软命中（`security.softHits`）**：疑似密码／token 字面量赋值、JWT、手机号、
  身份证号、邮箱等。不直接阻断，由阶段二审查 agent 逐条定性：确认是真实凭证或
  真实个人数据记 **P0**（安全或凭证泄露红线），测试桩、占位符、公开示例则放行并在
  报告 Verification 中说明定性依据。
- `security.scanned=false`（diff 拉取失败）不得视为通过：交互模式提示需人工确认；
  auto 模式可继续进入审查，但审查 agent 必须自行核对完整 diff 无凭证与隐私数据后
  才能给 pass，并在 Verification 写明"敏感内容为人工核对"。
- **输出纪律**：打回评论、内部汇总、各类通知一律只写文件、行号与类型，绝不引用
  命中原文；`security` 字段里的样本已脱敏（前缀 + 长度），不要用 `gh pr diff` 等
  方式还原后再输出。
- 误报治理走配置而不是口头放行：`sensitiveContent.allowPaths` 豁免测试夹具等已知
  误报路径，`extraHardPatterns`／`extraSoftPatterns` 追加项目自有格式。豁免只用于
  降软命中噪声，不得用来放行真实凭证；对硬命中拿不准时一律从严打回。

本门优先级最高：即使 PR 同时命中产品/UI 或架构 gate，也先按本门打回（凭证已在
公网，越早轮换越好），讨论流程等作者清理完再走。

### 3.2 格式门

严格按当前 `.github/PULL_REQUEST_TEMPLATE.md` 检查：

- Title 的 type、scope 和描述符合模板；不要凭旧 skill 硬编码类型；
- “这次改了什么”“怎么验证的”“风险”三个部分存在且是实质内容；
- 自动验证、手工验证、未执行验证如实填写，不能用“已测试”代替命令与结果；
- 变更类型、影响范围、breaking change、UI 证据和回滚信息与 diff 相符；
- **UI 证据提醒（非阻断，2026-07-25 起不再是格式门）**：`format.uiCodeFiles` 非空
  （改动命中 `uiPaths` 下的非文档文件，`uiExcludePaths` 内的多语言 locale 等纯文案
  数据文件、`.md` 文档与 `.d.ts` 纯类型声明不算——后两者不可能产生视觉变化）而
  Description 未附界面效果证据时，`context.mjs` 置 `format.uiEvidenceMissing=true`
  并生成建议文案 `format.uiEvidenceNotice`。**缺证据不打回、不计入格式问题、不阻断
  审查与合并**；处理方式是把 notice 作为一条普通 PR 评论发给作者（投递与去重见下方
  「UI 证据提醒评论」），请其补充截图／录屏，或改动后界面的 HTML 页面（```html
  代码块、.html 附件或在线预览链接）。
  证据存在性在这里判（`format.bodyUiEvidenceKinds` 标明 image／html）；已附证据时，
  内容与 diff 是否一致、界面是否符合 `ruleFiles.uiRequired` 列出的设计规范，仍在
  阶段二由审查 agent 判（见第 4 节第 7 条）；
- 命中数据库、system prompt、协议、原生层、权限／安全、跨平台或远程／手机规则时，
  Description 必须有对应结论。

格式不合格时：

- 交互模式先展示缺项（preview 版：不提交 `REQUEST_CHANGES` 评论，打回结论写内部审查输出）；
- auto 模式只输出一次结构化打回结论（preview 版：评论动作已剥离）；
- 格式问题是 P1，不把文案风格偏好写成阻断项。

**UI 证据提醒评论**：`format.uiEvidenceMissing=true` 时，把 `format.uiEvidenceNotice`
作为一条普通评论发到 PR 上，正文末尾附去重标记
`<!-- review-pr:ui-evidence-notice -->`；发送前先在已拉取的评论历史里查该标记，
已存在即不重发（同一 PR 只提醒一次）。交互模式发送前照常确认；auto 模式可直接
发送（与 notify-author-resolve 的一次性提醒评论同级，发送失败不阻塞流程）。提醒
不改变任何 gate 结论，也不因作者不补证据而升级为阻断；`selfFixAuthors` 的 PR
同样只发这条提醒（或 ownPr 时不发），**禁止**把缺口并进跟进会话消息——5.4 已停用。
`auto.ownPr=true`（viewer 与作者是同一个账号，即本流程账号自己开的 PR）时不发本
评论——收件人就是本流程账号自己，评论没有收件人，只会在 PR 上堆无人消费的噪音；
证据缺口照常写进报告与汇总，gate 结论不变。**被 skip 的候选本轮不发 UI 证据提醒**——
等它进入处理轮次再发（提醒无时效价值，避免同一作者同轮收多条噪音；skip 语义见
6.1 扫描阶段）。

### 3.3 目的与重复实现检查

对 `feat`、可见产品行为、Agent／Skill／插件和跨端能力，先从 PR body、关联 issue 和
仓库搜索确认：

- 用户要完成的真实工作是什么，改动是否仍保持单一目的；
- 仓库是否已有相同入口、共享符号或可复用能力，是否只是重复包装底层 Agent；
- 能力应属于 Core、Agent、Skill 还是插件，是否增加普通用户的配置和理解负担；
- 是否说明 Desktop、Mobile、SSH 远程和设备互联中哪些已适配、哪些有跟踪 issue。

这一步不能用主观“感觉重复”直接打回：没有事实时交互模式询问用户或作者，auto 模式
标记 `needs-context` 并跳过。若确认违反产品原则或产生重复入口，再按 P1 进入审查报告。

### 3.4 产品/UI 与技术架构 gate

本仓库维护者必须先消费 `context` 的 `productGate`、`archGate` 与 `signoff` 字段，
再进入普通代码审查（`signoff.triggers` 是 security/rules 两门 + arch 触发器的统一
命中事实，`signoff.suggestedHolds` 是编排要执行的 hold 建议，消费规则见 3.8/3.9
与本节下方「payload 合同」）：

- 产品/UI gate：按 [references/internal-gates.md](references/internal-gates.md) 判定
  `exempt`、`needsProductCheck`、白名单同意（讨论 issue 留言与 PR 评论区直接回复
  同等采信）和 UI/产品语义；
- 技术架构 gate：产品 gate 未命中时，按 `archGate.triggers`、技术白名单和讨论
  issue / PR 评论区同意判定是否属于较大架构调整；
- mobile 冷更（`archGate.coldUpdate.trigger` 非空）走同一道门，但判定既不看改动大小、
  也不受本门常规豁免：谁改手机端会触发冷更的代码都要进一步确认——作者身份、普通
  Approve、标回 Ready 都不算放行，只认 `coldUpdate.approvers` 里的把关人明确针对冷更的
  表态，名单内成员自己提的 PR 也要显式确认（口径与两种 trigger 的处置见
  [references/internal-gates.md](references/internal-gates.md)「mobile 冷更（runtime
  fingerprint）触发器」）；
- 真正命中产品/UI 时运行 `signoff-hold.mjs --kind product`，真正命中架构调整时运行
  `signoff-hold.mjs --kind arch`（与 security/rules 两门共用同一套统一 hold 机制，
  product-hold.mjs / product-release.mjs 旧文件保留为兼容入口，新编排一律走
  signoff-hold（signoff-release 写入/摘标签脚本尚未合入，当前由维护者按本 SKILL 手工操作））；hold 动作 = 开讨论 issue + 发状态评论（带隐藏
  标记）+ 挂 `awaiting-discussion` 标签，**不再转 draft**（2026-08-09 起标签制取代
  draft 制：draft 带来的 hold↔ready 死循环与 PAT 权限问题随之消失，真正挡合并的是
  流程内部判定，标签只是 GitHub 后台的可筛性入口）；动作必须幂等（重复 hold 复用
  既有讨论 issue，`decideIssueReuse` 语义，见 tests/signoff-policy-script.test.mjs）；
- **payload 合同（写死，缺失即拒绝主动作）**：`issueTitle`/`issueBody`/`commentBody`
  三字段全部非空，生成来源 = 门类模板（模板 D）+ PR 上下文（PR 号、作者、触发路径、
  把关人），由主 agent 按「对外话术与人格边界」撰写（人格关闭，第一句先澄清"不是
  代码问题"），经 `--payload-file`（推荐 `-` 走 stdin）传给 signoff-hold；脚本返回
  `reason=missing-payload` 时**不得计为 held**（`held=false`），必须在轮次汇总里
  如实记录「缺 payload 未 hold」，补 payload 重试，不能当「已拦截」收尾；
- **hold 成功判据 = 三件套全成功**：标签 + 状态评论 + 讨论 issue 三样都成功才算
  held；`issueCreated=false` / `commented=false` / `labels.changed=false` 任一失败
  必须显式进轮次汇总（脚本输出逐字段可查），不得静默降级为「只打了标签」；
- auto 模式 issue 新建成功后按配置发送一次讨论通知；交互模式在 issue、评论和通知
  发出前逐项确认；
- 放行判定（release）：**admins 名单成员的 GitHub Approve**
  （`signoff.adminsApprovedCurrentHead=true`）；白名单在讨论 issue 或 PR 评论区任一处
  明确同意（产品/架构门口径）后由维护者按本 SKILL 手工摘标签（signoff-release.mjs 尚未合入，零测试，已从本批移出、另立 PR 并带测试），
  不能把摘标签留给作者；存量被旧 draft 制 hold 成 draft 的 PR，在门判定为不拦 /
  已放行时用 `gh pr ready` 一次性迁移恢复（幂等，已 ready 即跳过）；
- **持久放行**：跨 commit 持久的载体是**放行标记**（signoff-release marker 评论，白名单
  明确同意后由维护者按本 SKILL 发出，评论作者须为 admins 名单成员）——被标记确认过的
  **门类**跨 commit 持久放行，作者再 push 不重新亮门；**未确认过的新门类首次触发仍拦**
  （确认只放行它当时覆盖的门类，不连带放行之后新出现的门类，如旧的 security 确认不会
  放行新出现的 rules 门）。这是本仓对上游（PR 全局持久）的刻意收窄，不是与上游对齐。
  **Approve 不跨 commit 持久**：admin Approve 绑定当前 head oid
  （`adminsApprovedCurrentHead`），只一次性确认当前 head 上已触发的门类；作者再 push
  后若该门类没有放行标记，门重新亮。当前接线到本机制的触发门类为 security / rules；
  product / arch 走 signoff-hold 既有流程（放行仍按 admins Approve 判定），coldUpdate
  / pluginBase 为上游口径，本仓无对应接线；
- **放行时关闭讨论 issue（决策已落地，执行接线随 signoff-release.mjs 另立 PR）**：
  放行生效时的关闭**决策**已随 scan 输出（`closeOnRelease`）落地——只认 hold marker
  的评论作者 ∈ admins 名单成员（本机制 viewer 账号在 admins 名单内，故机制自建 marker
  可通过校验；marker 文本形状可被任何有评论权限的账号复制，身份不可伪造）；close 的
  **执行动作**（关 issue 与失败原因进轮次汇总）随 signoff-release 写入脚本另立 PR
  接线，接线前自动关闭未生效；
- 合并后仍可运行 `close-product-issue.mjs` 兜底（`--sweep` 覆盖网页手动合并遗留），
  避免讨论 issue 悬挂。

产品/UI gate 和架构 gate 的详细名单、阈值、Slack 归属、通知去重与异常处理见
[references/internal-gates.md](references/internal-gates.md)。Bugfix、已有功能补充和
纯技术改动不因路径命中就机械 hold，语义拿不准时从严。

### 3.5 前置 gate

在进入代码审查前必须确认：

1. PR 仍是 open、非 draft，且 base/head 没有在读取后变化；
2. 没有冲突（`mergeStateStatus` 不为 `DIRTY`；若状态过期，重新拉元数据）；冲突且
   满足 5.5 条件时**仅交互模式**可走主干侧冲突代合并（auto 不合、写入汇总）；交互模式下若同时还有审查 P0/P1，可由用户
   选择 5.6 代修合并一并处理；其余情况等作者处理；
3. 所有 review conversation 都已 resolve；bot 也不能因“是 bot”而自动忽略；
4. head commit 上**所有已上报检查**（含非 required 的 check-run / commit status，如
   跑在 PR 上但未升门的检查与第三方 App 审查）没有失败或仍在运行——
   `mergeStateStatus=UNSTABLE`（GitHub 判可合并但有非 required 检查未过）同样算
   gate 未过，脚本按 statusCheckRollup 判定；fork workflow 等待批准时不擅自批准；
5. 旧 reviewer 的 `CHANGES_REQUESTED`、issue comment 中明确的阻断意见已有对应修复
   和证据；不要仅因 comment 被 resolve 就判定代码已改；
6. 没有未落地的前置依赖（见 3.6）：被依赖的 PR 未合并时，本 PR 可以审查，但不进入
   合并。

交互模式 gate 未过时停下来，用人话列出阻断原因，再询问是否仅继续读取上下文；没有
明确同意不进入审查。auto 模式跳过该 PR并写入汇总；未 resolve thread 与冲突类跳过
按第 6 节阶段 1 给作者发一次性提醒评论,不让作者对被卡原因无感知。无法判断时按阻断处理。

### 3.6 PR 依赖与合并顺序

多个 open PR 之间可能有先后关系（如 PR1 是功能、PR2 是它的 fix），必须先合被依赖者，
不能反序。依赖按两类识别：

- **硬依赖（确定性）**：PR 的 `baseRefName` 不是默认分支，而是另一个 open PR 的
  head 分支（stacked PR）。此时“合并”只会合进那个分支而不是默认分支：base PR 未
  合并前不合并本 PR；base PR 合并后 GitHub 会自动把本 PR retarget 到默认分支，此时
  重新拉元数据、等 CI 在新 base 上重跑后再按正常流程落地，不凭旧数据直接合。
- **软依赖（声明或语义）**：PR body、标题或评论声明 `depends on #N`、“基于 #N”、
  “修复 #N 引入的问题”；或 fix/feat PR 的改动明显建立在另一个 open PR 新增的代码
  之上（文件重叠时由主 agent 或审查 agent 判断）。识别到即视为“先 #N 后本 PR”。

执行规则：

- 落地顺序按依赖关系排序，其余仍按 `createdAt` 升序；被依赖 PR 尚未合并时，依赖方
  记 skip（reason: `depends-on-#N`），写入汇总，下一轮或被依赖者落地后同轮补入；
- 依赖成环或声明与 base 关系矛盾时不猜测，按阻断处理并点名维护者；
- 交互模式发现依赖时明确告知“应先合 #N 再合本 PR”，用户坚持反序才反序，并在
  review/汇总中记录该决定；
- 审查本身不受依赖限制（可以先审后合），但审查 agent 应把“依赖的代码尚未合入”
  与“代码本身有问题”区分开，不把前者写成 P0/P1。

### 3.7 Loop 托管 PR 排除

一些接入仓库有自己的自动修 bug loop，其托管的 PR 由 loop 自己合并、自己播报，
review-pr 不应重复审查或合并，避免两套合并主体打架。配置在 `pr-rules.json` 的
`loopPrExclusion`（缺省或 `null` = 整套机制关闭）：

- `titlePrefix`（legacy 单值 string）/ `titlePrefixes`（数组 string[]，新配置推荐用
  这个）：loop 自己开的 PR 标题固定前缀，二者可同时配置——目标仓库的 loop 改名后
  新旧前缀并存的迁移期，两个前缀都要认，命中任一即算匹配。**仅命中前缀不足以认定
  托管**——任何贡献者都能在自己 PR 标题前加同样的字面量冒充托管，骗过
  `defaultWhenAmbiguous` 的默认 skip 让自己的 PR 永久漏审。`detectLoopExclusion`
  （`lib.mjs`）还要求 `stateFile` 指向的本地台账里按 PR 号精确命中该条记录，查不到
  就按普通 PR 处理；命中后返回的 `matchedPrefix` 是实际命中的那一个前缀字面量
  （不能假设一定是 `titlePrefix` 的值——配置了 `titlePrefixes` 时可能命中数组里的
  任一项）；
- `t1BodyMarkers`/`t2BodyMarkers`：body 里 loop 自己声明 T-level 的 metadata 行
  （锚定整行的正则，逐行匹配），命中优先采信；都没命中退回台账的 `cluster.tCap`；
- `defaultWhenAmbiguous`：身份已确认但读不出 T-level 时的保守默认（`skip`）；
- `forceVerdict`（**缴械配套**——「缴械」指 owner 2026-08-04 决策 `mergeAuthority=review-pr-only`：
  剥除目标仓库自身 loop 的自动合并权，合并权整体移交 review-pr 巡审；本节 A2/A4/A5 均是这条
  决策在 skill 侧的配套落地）：
  配置后身份确认即**强制 t2 进全套审查**，优先于 `t1BodyMarkers`/`t2BodyMarkers` 与
  `cluster.tCap`——loop 侧数据（body 标记/台账 tCap）漂移回 T1 也不能再造成跳审。
  唯一有意义的取值是 `"t2"`；任何非空值都收敛为 t2（fail-safe 朝「进审」方向,
  `source=force-config-coerced` 供识别拼写漂移），身份门槛（stateFile 台账命中）
  **不被 force 绕过**——台账查不到仍按普通 PR 走全套审查。目标仓库缴械后应配置本键；
- T1（或拿不准）→ `context.mjs` 的 `auto.action=skip-loop-managed`，优先级最高，
  压过产品门/架构门/格式门/前置门（但让位于安全与隐私门硬命中——凭证泄露必须打回）；
  T2 → 正常走 review-pr，但格式门做两处豁免：标题判 type 前先剥掉 `detectLoopExclusion`
  返回的 `matchedPrefix`（`titleForFormat`），段落存在性检查整体豁免
  （`wantSections=[]`，loop 的 body 遵循自己的证据结构，不是本仓 PR 模板的三段式，
  逐字匹配注定误判缺段落）；
- **loop 托管 PR 一律无缘授权快速合并通道**（A2，缴械配套）：`pre-merge-check.mjs`
  在 fast-merge 判定前用同一份 `detectLoopExclusion` 判身份，命中（不分 t1/t2）即封死
  `authorizedFastMergeAvailable`（`blockedReason=loop-managed-pr-fast-merge-forbidden`）
  ——loop 的 PR-write token 能发评论，不封则一句 `/approve-merge <sha>` 就能骗巡审代合。
  3.8 末尾「authorized-fast-merge 可压过安全审查门」的例外对 loop PR 因此不存在；
- 合并后的致谢播报（A4，缴械配套）：`notify-merge-ack.mjs` 挂在 review-pr **自己执行合并**
  的流程末尾；`notify-merge-backfill.mjs` 每轮 auto 补扫一次近期 merged PR，补发维护者在
  GitHub 网页手动合并、agent 无从感知因而漏播的致谢（两者共享同一份去重台账，互认已播）。
  两者判定同一份 `detectLoopExclusion`，**只跳「仍自管」的 PR（verdict=t1/skip）**——
  t2/force-review 的 loop PR 由 review-pr 合并，致谢也由本侧播报（缴械后一刀切会把全部
  t2 致谢吞掉）。`mergeAckNotify.notifyModule` 未配置时播报能力整体关闭；
- **事后审计闸**（A5，缴械配套）：`scripts/audit-merged-loop-prs.mjs` 每轮扫上轮游标
  以来 merged 的 loop 托管 PR，核 head-bound clean 审查回执（receipt 层三条：存在 /
  headRefOid 逐字相等 / verdict=clean，不重建 stage2 hash——保证等级如实声明在脚本头）。
  核不过 → 定向 T0 告警（复用 `SLACK_OPS_ALERT_CHANNEL_ID` 私聊出口）+ 经 GitHub 原生
  `revertPullRequest` mutation 自动开 ready 的 revert PR（仍走巡审审合，本闸只开不合）。
  幂等台账按 `<pr>:<mergeOid>` 记账；首跑只立游标不回溯（缴械前的历史合并本就无回执）。
  **游标推进边界**：游标不是每轮无条件推到 now——只有当窗口内每条 loop 合并都已到
  remediation 终态（clean 回执通过 / revert PR 已创建且告警真送达）才推进；存在未解决
  的（revert 创建失败或告警配置了却没送达），游标停在这些 PR 里最早的 mergedAt，让
  下一轮窗口重新纳入重试（`decideCursorAfterRemediation`）。唯一豁免：**告警能力关闭**
  （`mergeAckNotify.notifyModule` / ops 频道未配置，仓库级长期状态而非"这次失败"）且
  revert 已创建 → 允许游标越过，否则未配置告警的仓库游标会永久卡死；该豁免不写
  `alerted`（那个字段语义严格是"真送达"），所以这类 entry 若因别的 PR 卡住游标而被
  重扫，会无害地重算一遍（能力关闭是本地短路，不产生网络调用，revert 幂等不重开）——
  这是已知冗余，刻意换取判据简单。告警送达判定与 `notify-sync-alert.mjs` 同款
  （api/webhook 算送达，degraded 降级不算），发送时摘掉 webhook 防 T0 告警漏进致谢群。
  **接线**：auto 模式每轮在 `prepare.mjs` 拿到锁后、批处理开始前跑一次
  `node "<SKILL_ROOT>/scripts/audit-merged-loop-prs.mjs"`，输出进当轮汇总;
  `loopPrExclusion` 未配置时天然 no-op。
  **保证等级如实声明**：这是**过程保证**，不是机器保证——本 skill 全仓只有一处确定性
  spawn（`pre-check.mjs` → `record-escaped-finding.mjs`），其余脚本一律由 agent 按本文
  逐条执行，本闸同此惯例。因此「漏网合并最迟一轮内被发现」的前提是**agent 真的跑了这一
  步**；某轮漏跑则该轮不产生任何告警，且因游标只在真跑时推进，下一次跑会把跨过的窗口
  一并审到（漏跑=延迟，不是永久漏审——这是刻意选的失败方向）。想要机器级必跑需把它挂进
  scheduler hook，但 `pre-check.mjs` 的契约是「轻量、快、exit 2 表示无活可做」，塞进 gh
  查询与可能的 revert PR 创建会破坏该契约，故未做；如需升级应另立独立 hook。

### 3.8 审查执行环境安全（security 确认门）

`pr-rules.json` 的 `securityReviewPaths`（缺省为空 = 门关闭）列出自动化自身有
执行/供应链能力面的路径：review-pr 自身脚本/配置、CI workflow/actions、部署的
skill 定义、package.json 与常见 lockfile 等。目的是防自动化改坏自己，不是防外部
攻击——auto 批处理会 checkout 到 PR 分支再跑一部分确定性脚本 / 读取
`pr-rules.json` 配置本身，若继续让 review-pr 用可能已被这次改动改坏的自己版本去
自动审查并合并这次改动，会形成"改坏的版本审过并合入了自己"的自我损坏闭环。

命中即 `context.mjs` 的 `auto.action=security-gate`（`signoff.triggers.security`
非空），按维护者确认门（signoff）执行 hold——**不再静默 skip**（三门空转 = 命中
无动作，正是 2026-08-09 要接通的缺陷）：挂 `awaiting-discussion` 标签 + 开讨论
issue + 发状态评论，等 admins 名单成员（`admins`）显式 Approve 放行
（`signoff.adminsApprovedCurrentHead=true` 时本门不拦）。放行按门类持久：security
门已有放行标记后作者再 push 不重新亮门，未确认过的新门类首次触发仍拦（见 3.4；Approve 绑定
当前 head、不跨 commit 持久）。放行前不自动审、不
自动合；放行后按 `auto.fallback` 继续原走向。优先级仅次于 3.7 的 loop 托管排除，
压过产品门/架构门/格式门/前置门，同样让位于安全与隐私门硬命中。是否启用、纳入
哪些路径由目标仓库自己按贡献者可信度模型配置。**保证等级如实声明**：本门是
T1（防疏忽/漂移）——把「命中安全面改动却无人确认」这个大概率疏忽变成显式等待；
不冒充 T2（防恶意伪造），恶意者总能改掉配置本身，那不属于本门能力面。

**唯一例外**：有 `/approve-merge` 授权时 `auto.action=review-complete-hold-merge`
（见 5.1「授权快速合并通道」）——auto **仍不合**，只把「人工已过的凭证」写入汇总，
等交互/人手合。`mergeAuthorization.breakGlassApprovers` 名单成员发出的
`/approve-merge <当前 head 完整 40 位 SHA>`（head 绑定，见 5.1）本身就是「人工已过的凭证」，
不需要 review-pr 再转一次人工。泄密硬门（`security.hardHits`）仍优先级最高，本门
与授权通道谁都压不过它。

### 3.9 审查规则文档门（rules 确认门）

`pr-rules.json` 的 `ruleFiles.required`（缺省为空 = 门关闭）列出审查规则文档
（AGENTS.md、CLAUDE.md、docs/dev-rules/ 等）——规则文档是后续所有审查的判据来源，
改它等于改审查标准本身，需要 admins 确认。

命中即 `context.mjs` 的 `auto.action=rules-gate`（`signoff.triggers.rules` 非空），
按维护者确认门（signoff）执行 hold（`signoff-hold.mjs --kind rules`），口径与 3.8
完全一致：挂标签 + 开讨论 issue + 状态评论，admins Approve 即放行（放行按门类持久——
跨 commit 靠放行标记，Approve 绑定当前 head，见 3.4；放行前不自动审、不自动合，放行后按
`auto.fallback` 继续）。优先级低于 security
门（命中 securityReviewPaths 时不走本门），不覆盖已包裹的 product-gate / arch-gate；
`ruleFiles.required` 未配置时本门永不出现。`ruleFiles.ruleMap`（规则文档 → 管辖
路径映射）命中明细随 `signoff.triggers.ruleMapHits` 带出，供编排辅助定性，不单独
构成触发。保证等级同 3.8：T1（防疏忽/漂移），不冒充 T2。

### 3.10 thread 清理（triage）：代 reply / 条件 resolve 白名单 bot 意见

分支保护开了 `Require conversation resolution` 时，thread 不 resolve 就 GitHub 层面
合不了；而 bot（greptile 等）从不回来点 resolve，作者修完也常忘点——「threads
unresolved 连续多轮整轮空转、停滞十几天」的 PR 就是这个原因（#251 型）。auto 模式
在扫描后、合并判定前执行本清理；交互模式先把可处理清单（路径 + 拟回复）展示给
用户、确认后执行。

**设计（2026-08-09 三轮收敛，回复优先）**：「意见是否已被处理」是 LLM 语义活，
字符串分析证明不了——diff 里新增两行普通埋点 + 一句 justification 即可绕过任何
token 共现判据（PR #13 R2 blocker 实测成立），原 `assessThreadEvidence` 判据（及其
`extractThreadTokens` 词表）已删除。因此本机制的价值在**回复**（把对话推进下去，
可纠正），不在**关闭**。对 `context.history.reviewThreads` 里未 resolve 的 thread
逐条：

1. **reply 无条件**：白名单 bot thread 且 thread 内无白名单外参与者时，按调用方
   payload 发回复（回复引用修复 commit 与位置，供人复核；文案不声称机器已验证修复
   正确性——本动作是 T1 防遗漏收口）。只认白名单 bot——`pr-rules.json` 的
   `threadTriage.extraBots` 登录名单（首配 `greptile-apps`；未配置 = 整套机制关闭，
   一条都不动）。白名单校验不止查位置首条评论：**同一 thread 里任何一条评论的作者
   若不在白名单内**（真人参与讨论），该 thread 永不处理；**唯一豁免是本脚本自己
   （viewer 身份）的评论**——marker 形状的评论若作者不是 viewer，照常参与白名单
   校验（文本谁都能复制，身份不能）；
2. **resolve 默认不执行**，只在**机器可核实**条件下才做（由 `resolve-threads.mjs`
   执行层判定，不依赖调用方 payload 里 `justification` 的内容——非空字符串对
   不可逆的对外 resolve 动作不构成充分条件）：
   - 线程已是 resolved（幂等，`already-resolved`）；
   - **上一轮己方已 reply 同一 headSha**：thread 评论里有 viewer 身份作者的本脚本
     marker（`state=replied`、`sha` 与本次 `headSha` 一致）、**marker 年龄 ≥ 人工
     反对窗口**（`MIN_MARKER_AGE_MS`，默认 10 分钟，从评论 `createdAt`——GitHub 侧
     字段——推导，不引入本地时间状态），且白名单复核仍通过（回复后无真人异议）→
     resolve，成功后再追加 `state=resolved` marker；
   - 己方 marker `state=resolved` 但线程又变 unresolved → 人工翻案
     （`skipped-reopened-after-triage`），**永久留人工**，不与人拉锯。
   其余情况一律只回复不关闭；
   **年龄门保护的是人工反对窗口，不是防抖动**：D1 之所以允许 auto-resolve 存在，
   靠的是「回复与关闭之间存在一段人可以介入反对的时间」。若双实例重叠（定时巡审 +
   手动运行）时窗口塌成 0，两阶段就退化成单轮自动 resolve——故 marker 必须在窗口期
   之后才允许 resolve；窗口期内重新运行只 `replied-only`，不重复回复。

   **年龄门 env 校验（R4）**：`MIN_MARKER_AGE_MS` 可用环境变量
   `REVIEW_PR_MIN_MARKER_AGE_MS` 覆盖（ms 单位），但执行层会显式校验——解析失败 /
   负值 / 低于下限 60000ms（1 分钟 = "人来得及看见"的最小可感知窗口，更小在语义上
   退化成"无窗口"，几乎必然是单位/量级配置错误）一律回落默认 10 分钟，并在 stderr
   与输出 JSON 的 `warnings` 字段双通道警告。**禁止用"把年龄设成奇怪数字"关闭年龄
   门**（`-1`/`0` 曾可悄悄关掉守着不可逆动作的这道门）——要关闭只能显式设
   `REVIEW_PR_DISABLE_MARKER_AGE_GATE=1`（仅用于运维一次性批量清理积压 thread），
   执行层会大声输出"年龄门已关闭，本轮 resolve 不保留人工反对窗口"。门关闭只豁免
   年龄条件；marker 缺 `createdAt` 的保守不 resolve 不豁免。
3. **marker 可信度 = 评论作者身份**（执行层 GraphQL `viewer { login }` 比对），pr
   号 / thread id / sha 都是公开信息，文本形状可被任何有评论权限的账号复制，身份
   不可伪造。**状态全部在 GitHub 侧（评论 + 线程 resolve 状态），无本地回执**——
   tmp 清理 / 换机器 / 无状态 CI runner 都不影响下一轮判定；
4. **三种终态必须可区分**：`replied-only`（已回复未关闭）/ `resolved` /
   `skipped-<reason>`（拒绝原因，如 `skipped-non-whitelisted-comment-present` /
   `skipped-reopened-after-triage` / `skipped-resolve-failed` / `skipped-reply-failed` /
   `skipped-thread-not-found` / `skipped-lock-busy`）。resolve 失败不重发回复（reply
   上一轮已发），下一轮同 headSha 自动重试 resolve。

> **启用前提（D7，未满足前不得配置 `threadTriage`）**：本机制默认关闭
> （`pr-rules.json` 不含 `threadTriage` key）。三轮对抗复审给出的 blocker（字符串
> 判据可被普通埋点绕过、并发至多一次、bot 白名单覆盖全部评论、marker 身份绑定、
> 回执跨运行持久性）全部关闭验证通过之前，禁止新增该 config key 启用本机制；
> 启用只能由后续独立评审确认全部验收条件后进行，不得借本节文档改动顺带打开。
>
> **自动 resolve 目前不提供**。要在将来启用，以下两项都必须先满足（缺一不可）：
> 1) 一个能**机器核验「缺陷确实被修复」**的判据。已尝试并被实测否决的方案：
>    token 子串命中、≥2 独立 token 共现、共现（必要）+ 编排层 justification
>    （充分）。否决理由：两行普通埋点（如 `telemetry.increment("X")` /
>    `trace.debug("Y")`）即可让未修复的意见判定为可 resolve（PR #13 R2 blocker
>    实测）；且执行层不接收 diff，无法独立复核。
> 2) 生产者→判据的形状适配（context 导出 `lastComment`/`isBot`，判据消费
>    `body`/`authorType`），并配一条**从真实 context 输出出发**的端到端契约测试。
> 当前两项均不满足。仅提供 auto-reply（可纠正），不提供 auto-resolve。

**执行**：把可处理清单逐条生成 reply payload（回复必须引用修复 commit 与位置，供人
复核；文案不声称机器已验证修复正确性——本动作是 T1 防遗漏收口）。每条附上
`justification`（编排层对「为什么这段 diff 回应了这条 claim」的说明——**契约字段，
非 resolve 判据**：resolve 由执行层按上面的机器可核实条件决定），调：

```bash
node "<SKILL_ROOT>/scripts/resolve-threads.mjs" <PR> --payload-file - <<'JSON'
{
  "threads": [ { "id": "<history.reviewThreads[].id>", "reply": "已在 <sha> 处理(<修复位置>);有异议可 reopen", "justification": "<为什么这段 diff 回应了这条 claim 的说明>" } ],
  "allowedBots": ["<pr-rules.json threadTriage.extraBots 登录名单>"],
  "headSha": "<sha>"
}
JSON
```

（脚本只执行调用方给定的 payload，不自选 thread——**不接编排则 #251 型停滞仍会
skip**，这正是本节的接线职责。`allowedBots` 缺失或为空、或某条 thread 缺
`justification` 时脚本执行层 fail-closed，一条都不动，即使 payload 里给了 thread id
也不例外。）

**回流与汇总**：消费脚本输出的 `results[]`——`outcome: resolved`（含
`already-resolved`）计入已 resolve；`replied-only` 计入已回复（下一轮同 headSha
重跑时脚本将自动 resolve，若期间有真人异议则白名单复核会拦住）；`skipped-<reason>`
逐条显式进轮次汇总，不得静默混为一谈：**可重试**（`skipped-thread-not-found` /
`skipped-reply-failed` / `skipped-resolve-failed` / `skipped-lock-busy`）下一轮可再次
尝试；**永久**（`skipped-reopened-after-triage`）不再重试，永久留人工。resolved 后
对涉及该 PR 的合并判定**重算 threads 阻断**（重新拉 `mergeStateStatus`，或按「未
resolve thread 计数归零」处理），不凭清理前的旧计数判定。回复会通知原 reviewer，
对方可一键 unresolve（unresolve 后按 `skipped-reopened-after-triage` 永久留人工）。
**幂等**：脚本对已 resolve / 已回复过的 thread 不重复动作（双并发下每 thread 至多
一次 reply + 条件 resolve，靠脚本内查当前状态 + 持久锁兑 TOCTOU 窗口）。

## 4. 阶段二：独立代码审查

代码审查必须由独立的审查 agent 完成，主 agent 不直接替代它。优先使用
`Agent` + `isolation: "worktree"`，每个 PR 一个隔离 worktree；主工作树不切换分支。
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

## 5. 阶段三：落地

阶段三任何 GitHub 写操作（review / comment / issue）前，对该候选再跑一次轻量 head 复核（`gh pr view <N> --json headRefOid` 或 `context.mjs <N> --scan`）。head 与扫描快照不一致 → 退回阶段一重新分类，禁止对着过期 head 发打回。

### 5.0 收敛检查点与同 family 复发

跨轮次的概念，5.2（打回）与 5.4（自修）共用识别机制，各自的动作见对应小节。

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

### 5.1 通过：批准并合并（preview 版）

> preview 版：本节能力已剥离（批准/合并/合并致谢不在 preview 产物中），审查通过时输出内部结论即止，不做任何合并落地动作。
### 5.2 不通过：请求修改（preview 版）

> preview 版：本节能力已剥离（REQUEST_CHANGES/COMMENT 打回评论与模板 A 不在 preview 产物中），输出内部结论即止。
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
  [references/internal-gates.md](references/internal-gates.md)。
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
- 产品/架构 hold、issue release、通知、self-fix 和收尾 issue 的详细动作均按
  [references/internal-gates.md](references/internal-gates.md) 执行，脚本返回错误时
  不重复写入或猜测成功。

### 5.4 自动跟进修复（fix-handoff）：已停用，禁止开跟进会话（preview 版）

> preview 版：本节能力已剥离（fix-handoff 跟进会话投递不在 preview 产物中），输出内部结论即止。
### 5.5 冲突代合并（主干侧解决，不推作者分支）（preview 版）

> preview 版：本节能力已剥离（主干侧代合并不在 preview 产物中），输出内部结论即止。
### 5.6 代修合并（merge-then-fix，仅交互模式）（preview 版）

> preview 版：本节能力已剥离（代修合并不在 preview 产物中），输出内部结论即止。
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
复盘，把可沉淀的经验记入 Skill 自己的进化台账。目标：同一类漏判或流程缺口不第二次
靠人发现。复盘只影响未来轮次，**不回头改本轮已做出的任何 gate 判定或 GitHub 动作**。

### 8.1 根因三分类

- **by-design（设计上就该人来）**：真人署名或决策类——他人 reviewer 的未 resolve
  thread、分支保护要求的真人 approve、语义冲突取舍、产品/架构拍板、权限不足。
  只记台账计数观察，**永不因「出现多次」就自动放开**。
- **automatable-gap（可自动化的遗漏）**：不新增任何 GitHub 写操作、不放宽任何 gate 的
  确定性改进——skip 原因归类缺口、去重指纹漏洞、状态文件修复、汇总/催办文案、脚本
  bug、文档自相矛盾。允许按 8.3 规则当轮自动落地。
- **privilege-expansion（扩权类）**：任何会新增或放宽署名操作与安全边界的想法——
  代 resolve 他人 thread、扩大自动 approve 范围、放宽 admin bypass 条件、改动白名单/
  selfFixAuthors/权限 allowlist、放松 gate 阈值。**永不自动落地**，只写提案等维护者
  拍板。拿不准算哪类时，一律按扩权类处理。

### 8.2 台账

台账是 Skill 知识的一部分，随 Skill 仓库走（不是运行时状态，不放外部状态目录）：
`<SKILL_ROOT>/evolution/ledger.json` 为事实源，`<SKILL_ROOT>/EVOLUTION.md` 由脚本
再生成（手改会被覆盖）。只经脚本读写，按根因 fingerprint 去重：

```text
node "<SKILL_ROOT>/scripts/evolution-note.mjs" add \
  --fingerprint <root-cause-slug> --tier <by-design|proposal|auto> \
  --title "<一句话根因>" [--detail "<现象与证据>"] [--proposal "<具体改法>"] [--commit <sha>]
```

返回 `isNew=false`（同指纹已存在）时脚本只自增计数——不要重复分析，也不在摘要里
重复报告。台账正文不写 token、凭证、内部绝对路径或敏感命中原文，PR 只写号码。
被维护者否决过的提案（status=rejected）留档，不再重复提出。

每次 `add` / `set-status` 写盘后脚本**只把台账本地落盘**（preview 版：自动提交推送已剥离，`skillRepoCommitPush` 为只读 stub 恒返回 `skipped: 'dist-readonly'`——纯落盘不回推）。`--no-sync` 仅本地调试用。

### 8.3 automatable-gap 的自动落地规则

全部满足才允许当轮直接修改 Skill 自身：

1. 改动不属于 8.1 的扩权类（拿不准 = 扩权，降级为 `--tier proposal`）；
2. 改动最小且自洽：只改对应的 SKILL.md 段落、脚本或 config 键，不顺手重构；
3. 改脚本后必须过 `node --check`，脚本带 `--dry-run` 的再跑一次 dry-run 自测；
   任一失败即恢复原文件、降级为提案；
4. `SKILL_ROOT` 是 git 仓库且工作区干净时，把这次进化单独提交一个 commit
   （message 前缀 `evo:`，正文带 fingerprint），并把 sha 记入台账；不是 git 仓库或
   工作区脏时照常落地，但摘要里写明「未纳入版本控制，需人工同步回 skills 仓库」；
5. 每轮最多自动落地 1 项（防抖）；其余记 `--tier proposal` 留到维护者或下轮处理；
6. **preview 版不回推**：落地记录与提案留在台账（`evolution/ledger.json` + `EVOLUTION.md`），由维护者在主仓落地——`sync-skill-repo.mjs` push 与 `evolution-note.mjs` 自动回推在 preview 版均为只读 stub（恒返回 `skipped: 'dist-readonly'`），不做任何向上游的提交/推送。

### 8.4 汇总与交互

- auto 模式：进化结果并入 6.1 摘要的「自进化」组——已落地的写一句话加 commit
  短 sha；扩权提案点名维护者看 EVOLUTION.md；本轮没有新条目（全是 isNew=false）时
  整组省略。
- 交互模式：复盘发现进化项时直接告诉用户，由用户当场决定改不改；不在交互模式
  静默修改 Skill。
<!-- dist:strip:end self-evolution -->
