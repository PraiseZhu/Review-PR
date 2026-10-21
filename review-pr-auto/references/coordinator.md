# 滚动队列与恢复

主 session 在目标仓库执行这些命令；`Q = <SCRIPTS>/review-queue.mjs`。
queue 只准备任务、保存状态和清理 worktree，不会调用宿主的 spawn/wait，也不会替你审查代码。
命令必须串行调用，共享状态由脚本原子落盘。PR 报告、结果、finish/progress 都在 roundDir，
不能放进待删除的 worktree。不得把 token 写进报告或传给修复 session。

## 开始与领取

```text
node "<Q>" init --plan <plan.json> --lock-token <token> --concurrency <实际可用子 agent 数，1..10>
node "<Q>" watch --plan <plan.json> --lock-token <token>
node "<Q>" claim --plan <plan.json> --lock-token <token>
```

watch 用宿主可管理的后台命令运行；Windows 不弹出可见窗口。保留进程/session ID，
至少每 60 秒 `status` 一次并读取 `heartbeat.json`；正常结束时 `stop` 后等待 watch 退出。
watch 只在主 session 最近 10 分钟仍有队列操作时自动续锁。任何 `lost=true`、续锁失败或
异常退出都先停止子 agent 的外部写入，不能靠补造锁继续。

claim 返回 `claimed=true` 时才用其 task 启动一个独立 reviewer；shell cwd 和
`REVIEW_PR_REPO_ROOT` 都设为 `task.worktree.path`。然后立即：

```text
node "<Q>" bind --plan <plan.json> --lock-token <token> --pr <N> --agent-id <真实宿主 agent ID>
```

持续领取直到返回 `reason=capacity|empty`。capacity 时等待任意一个正在运行的 agent，
不是等待整个 group；每条完成后立即领取下一条，跨 group 也按原年龄顺序。
宿主另有占用时只领取当前可启动数量，不预建所有 PR 的 worktree。

## 退出、清理、释放名额

1. 从宿主查询 agent 的实际终态，等它和它启动的验证命令全部退出。不能把“已经写结果”当作退出。
2. 核验它的 result/progress/finish 与 runId/head 一致。崩溃时保留已确认的 GitHub 事实；
   若停在 merging 但只读回查确认同 head 的 PR 已 MERGED 且 mergedAt 有效，将该实际查询
   回执补入 finish.merge（merged=true、reconciled=true），同步 finish 的 merged 终态后再记结果；
   不能只把 result 改成 merged，也不能为补回执重新发送合并请求。
   若已经干净审查但没有确认 Approve 且不是维护者作者 exempt，写 `reviewClean=true, approval.status=pending,
    outcome=approval-pending`，说明中断原因并保留报告，不改成普通 approval 等待。
   若 Approve 已确认或维护者作者 exempt 但 finish 停在 `approved/approval-exempt/checking/merging/merge-retry-pending`，
   记 `outcome=error, retry=true` 并保留 checkpoint；清理后仍需本轮 continuation 收尾。
3. 若存在 fixHandoff 请求，按共享 handoff 流程串行投递、去重或交回
   `needs-human`，写入真实终态。
4. 执行：

```text
node "<Q>" complete --plan <plan.json> --lock-token <token> --pr <N> --agent-id <同一 ID> --agent-exited
```

complete 会删除这个任务持有的 worktree，核验目录和 Git 注册都已消失并记录 generation，
才把 phase 改为 complete、释放名额。未跟踪/忽略的构建产物随托管 worktree 回收；tracked 改动、
附着分支、locked worktree、其他 common-dir、路径越界均拒绝清理。
清理失败保留 cleanup-pending，确认残留进程退出或安全处理原因后重复 complete。
不能在删除失败后手写 complete、删除 ownership 或用广域 prune 掩盖问题。

若 create/spawn 本身失败，先保存该 PR 的真实 error 结果。确认宿主从未启动 agent 时才可
用 `--no-agent-started --agent-exited` 代替 `--agent-id` 完成清理；绑定存在时不接受此声明。
spawn 成功但 bind 前中断：先查宿主已有 agent 并补 bind，不能凭空再 spawn 一个。

## 审批与合并补齐

首遍所有任务退出且清理完成后：

```text
node "<Q>" reconcile --plan <plan.json> --lock-token <token>
```

它把 `reviewClean=true` 且 Approve 未确认、已 Approve 后遇到尚未写入的临时合并失败、
或 finish 中断的 PR 各重新入队一次。照常 claim/bind，
启动单 PR continuation reviewer；`resume=true` 时先读之前外部保存的报告和 finish checkpoint。
刷新 context，确认 head/base/diffHash 与报告绑定相同、当前维护门/thread/CI 通过，才复用已完成
审查继续 guarded finish；任何绑定变化都记 state-changed 并等待下轮重审，不能用旧报告补批新内容。
若旧 checkpoint 停在 merging，先只读核验 GitHub 与合并锁；结果不明时不得重发。
即使只补 Approve 或 Merge，也要独立 worktree 和退出后的清理。

补齐任务结束后再次 reconcile；返回 `reconciled=true, allComplete=true` 才可以 finalize。
每条最多补一次，剩余 pending 如实进入未合并原因，round-state 强制下轮重试；
不明 POST 的恢复由 Approve 脚本控制：至少等待 10 分钟、完整回查与 fresh guards 后最多一次
重投，仍不明就明确需要人工核验；模型不能自行循环提交。
viewer=作者等真实 blocked 不反复补批。已经 verified 或合法 exempt 且符合合并门的 PR 应在 reviewer 内同轮合并。
finalize 会验证 finish 的实际合并终态或阻塞证据，不能把非终态 checkpoint 当作完成；
恢复仍失败时保留具体异常，不编造 blocker、不将可合并 PR 静默缓存为状态未变。

## 中断恢复

pre-check 会返回最早尚未 close 的 `resumePlan`，包括仅剩清理或卡片发送的轮次。先 prepare
（`--skip-skill-pull`，本轮已在 pre-check 更新）获得
当前锁/authority，读取旧 plan/queue/宿主 agent 状态，不重新分组。新锁不能让仍活着的旧 reviewer
继续写；先通知其停写并退出。旧报告仍须核验权限及代码证据，不能直接信任旧 authority。
完成记录不重复 spawn；running/ready/preparing/cleanup-pending 不自动回收名额。
每项先核查 agent 和独立验证命令，补结果、补绑定或补清理，再继续 queued。
plan 尚无 queue 时用 init 初始化；冻结计划在 init 后不得修改。

finalizer 会再次调用真实 worktree 验证，旧 generation 的清理回执不能用于后来重建的目录。
worker 不更新 skill 代码。
恢复轮次也读取外部状态目录的 `skill-sync.json`，将本次更新失败纳入尚未生成的摘要；
已经 finalized 的摘要保持原样，新增同步异常在最终消息中如实说明。
已 finalized 的轮次复用原汇总并补未发送卡片；全部页有发送回执或明确失败记录后 `queue close`
才写 completed.json。它不会真的代你发送消息，不能把本地卡片生成当作发送成功。
清理确实无法完成时，明确报告本轮未完成及具体残留原因，让下次继续恢复。
独立修复 session 的 worktree 不属于 queue，也不在这里回收。
