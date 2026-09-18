# Skill 路径、状态目录、自同步与并发

> 本文件由 `SKILL.md` 渐进披露拆出，正文与拆分前逐字一致。从 `SKILL.md` 按需 Read，不要经其它 reference 二次跳转。

## Contents

- Skill 路径与目标仓库

---

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
自进化写台账后由 `evolution-note.mjs` 自动提交推送（见 8.2/8.3）。`evo:` 提交不会裹进
`SKILL.md` / `scripts/*.mjs`。同步是 best-effort：
pull / push 失败（断网、diverged、非 main 分支）不阻塞 review 流程，把输出里的
`skillSync` / `sync` 异常如实写进汇总即可，不要重试到卡死。手动诊断用
`node "<SKILL_ROOT>/scripts/sync-skill-repo.mjs" <pull|push>`。

**多写者并发（同一 skills 仓被多台机器 / 多个轮次写）**：同一个 skills 仓可能同时被
定时轮次与人工交互轮次写入（各自追加 evo 台账），push 撞 `non-fast-forward` 属正常并发，
不是故障。`skillRepoCommitPush` 与分叉后的 `skillRepoPull` 共用同一套 rebase：自动
`pull --rebase --autostash` 后重推，并对**只追加类台账文件**
（`EVOLUTION.md`、`evolution/ledger.json`）用确定性规则自动解冲突（md 取行并集、ledger 按
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

这两类信号除写进 6.1 汇总外，**还要定向私聊 owner 一次**（群内播报出口只承载合并致谢，
不放运维噪音；这条是独立的低频出口，自带按签名去重，同一故障状态只吵一次）：

```text
node "<SKILL_ROOT>/scripts/notify-sync-alert.mjs" --kind <diverged|code-conflict> \
  --signature "<diverged 用 本地HEAD:远端HEAD;code-conflict 用 conflictFiles 拼接>" \
  --detail "<ahead/behind、冲突文件、backupRef 等现场信息>"
```

未配置私聊目标（notify.env 的 `SLACK_OPS_ALERT_CHANNEL_ID`）时该脚本 no-op，
`posted:false, reason:'ops-alert-channel-not-configured'`，不影响本轮任何判定。

