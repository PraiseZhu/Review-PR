# 自有 PR 的独立修复 session

自动批次保留 `selfFixAuthors` 的既有跟进能力；交互版在用户同意代修后也使用本流程。
审查与修复分开：每 PR 审查子 agent 返回卡点，主 session 负责创建或复用一个独立 session。
每个 PR 绑一个跟进会话。跟进会话把**这一波作者侧卡点**修完再结束；审查批次当看门狗，
超时无进展就再发一条，不能假设它还活着。Approve/Merge 仍归审查批次。

## 触发与权限

- 身份来自 `context.auto.selfFix`（作者在 `selfFixAuthors` 中），不把所有维护者都当作自有 PR。
  作者身份本身不需要开空 session；必须有作者侧问题。
- 正常 auto 模式的凭证/格式/P0-P1/未解决 thread/CI 失败/冲突/rebase/作者侧 Request Changes
  触发跟进。调用 `review-round.mjs createFixHandoffRequest` 得到请求和指纹。
  thread 沿用 `head|skip-gate`；CI 失败用 `head|skip-ci-failed`；冲突用 `head|skip-conflict|<base>`。
  自动批次看到未解决 thread 就停止自己的审查，直接把证据交给修复 session，不先 triage。
  审查完成后的 Approve/pre-merge/Merge 发现新 thread、CI 失败、冲突、rebase 或作者侧
  Request Changes，保留 `outcome=merge-blocked`，另用带同 head 检查证据的 fixCause 投递，
  不因卡点发生在审查后而漏跟进，也不把纯权限或等待合并队列的问题投递给修复者。
- 维护门、未合并依赖、权限、受保护路径、structural-check、仅缺另一位维护者 Approve、
  CI pending/unknown、bot 静默期均不投递。`review-only` 完全不创建或唤醒自动修复 session。
- 审查中的 P0/P1 仍按新流程开真实问题 thread；viewer=作者用 COMMENT，不自发
  REQUEST_CHANGES/APPROVE。只有 PR 正文格式错误等确实无文件可锚定时，直接写修复说明。
  已确认问题的 thread 发布失败记录 errors，并继续投递修复，不让发布失败吞掉作者侧问题。
- 修复 session 不使用批次的 review 锁，不运行 Approve/Merge，不自审自批；有争议的要求
  请求明确裁定，不能为了变绿而静默忽略。未解决的 thread 不点 Resolve。

## 主 session 串行投递

每个审查子 agent 退出后逐条串行处理；共享 `fix-sessions.json` 只由主 session 写。
读取 reviewer 保存的完整 `fix-request-pr-<N>.md`，不要只转发一句“请修一下”。

1. 再核验自己的锁及 PR 当前 head/state/draft；head 已变化、关闭或转 draft，写
   `fixHandoff.status=stale` 与具体原因，下轮重取证据，不按旧 head 发修复任务。
2. 卡点包含 thread 时，把 `fixHandoff.threadUrls` 原子写为
   `<roundDir>/fix-threads-pr-<N>.json`（非空 URL 数组），本次 get/set 都加
   `--threads-file <该路径>`。使用 `fix-session-state.mjs get <N> --fingerprint <fp>`。
   `shouldDispatch=false` 且绑定有效则记 `deduplicated` 或 `needs-human`，保留 session ID。
   `get.needsHuman=true` 且指纹未变：记 `status=needs-human`，不投递、不挂 auto-fixing。
   同 head 已成功投递的 thread 不因 `findings → threads-unresolved` 换了路由就重新唤醒；
   同 head 新到的 thread、新的 CI 失败、或冲突带了新的 base，都要继续投递。
3. `get.watchdog=nudge|escalate` 时必须投递。nudge 的消息要问跟进会话卡在哪，并要求
   继续修这一波仍存在的作者侧问题；escalate 不再投递修复任务，改为
   `fixHandoff.status=needs-human`，并 `set ... --needs-human`，把球交回维护者。
4. `shouldDispatch=true` 且不是 escalate 时，session ID 非空就用宿主的 session
   handoff/jump 工具复用；否则用 create 工具新建 PR 专属 session，并要求
   `use_worktree: true` 或等价隔离能力。这是独立 session，不是随本轮结束被销毁的
   review subagent，也不能共用审查 worktree。
5. 投递前写本 PR 的投递日志，包含 runId/head/fingerprint 和稳定任务标记；工具支持
   idempotency key 时使用该标记。成功立即保存真实 session ID/消息回执，再执行
   `fix-session-state.mjs set <N> --session <id> --fingerprint <fp>`；nudge 再加
   `--watchdog nudge`。最后将 PR 结果改为 `fixHandoff.status=dispatched`。
   恢复时先读取本 PR 日志与共享绑定，不重复发送已确认的投递。
6. 只有工具明确返回 NOT_FOUND/ARCHIVED/DELETED，才 `clear <N>` 后新建一次。
   超时等结果不明时先只读查回执或任务标记，不能盲目重发。工具/隔离能力不可用或实际失败
   记 `failed` 及具体原因；没有真实回执不能声称“已创建”。投递失败不能刷新去重指纹。

最终 `fixHandoff` 保留 `fingerprint`、`requestFile`、`status`、`reason`，成功/去重/交回
必须带真实 `sessionId`；有 thread 时一并保留 `threadUrls`。去重可以是相同指纹，也可以是
相同 head 的 thread 全部已经投递；后一种保留 `dispatchedFingerprint= get.lastFingerprint`
供核对，结果里的 `fingerprint` 仍填本次请求指纹，不刷新共享绑定。例：

```json
{"status":"dispatched","fingerprint":"<head>|review-failed","sessionId":"<真实 ID>","requestFile":"<修复说明路径>","reason":"已复用该 PR 的独立修复 session"}
```

一次 PR 的审查和跟进投递均有终态后，本组完成；不等待修复者执行完才进入下一组。
汇总保持 PR 原本的未合并类别，附跟进状态；“已投递”不等于“已修复/已合并”。

`status:auto-fixing` 只在绑定存在、未标 needsHuman、且距上次投递未超过看门狗窗口时挂。
超时或交回给人后改挂真实卡点或 `status:needs-human`。

## 自包含投递消息

```text
你负责跟进修复 <repo> PR #<N>（<title>）。PR：<url>
本次观察 head=<SHA>，作者=<login>，分支=<headRefName>，base=<baseRefName>。
任务标记：<runId + PR + fingerprint>。
<若为本轮看门狗催办：上一轮投递后 head 未变。先说明卡在哪，再继续修仍存在的作者侧问题。>

当前卡点：
<审查意见/完整 thread 与链接/格式清单/CI 失败摘要/冲突或 rebase 证据>
<必要验证命令及已知结果；凭证问题只写文件、行号和类型，不复制秘密>

要求：
1. 在自己的独立 worktree 中操作。开始先核验当前 PR、分支和 head；已经有更新时重新
   对照卡点，只修仍存在的问题，避免覆盖作者的新工作。
2. 遵守仓库 AGENTS.md 与现有开发规范。把这一波作者侧卡点处理完：修代码、解与当前
   base 的冲突、处理自己能处理的 thread 和红 CI，验证后 push 到 PR 分支。
3. push 后立刻再拉一次 PR。若仍有冲突、红 CI 或自己能处理的 thread，继续修，不要结束。
4. 只有下面情况才结束本次修复，且不要 Approve/Merge：
   - 作者侧卡点已清，只等下一轮独立审查 / CI 刷新；
   - 需要维护者裁定（范围外、产品取舍、安全争议）。说明卡点和需要谁拍板，不要静默忽略。
5. 逐条回应实际处理的 review thread，只有已验证解决的才 Resolve；未处理、存疑的保留。
```

修复 push → head/状态变化 → 下轮候选 → 独立重审 → guarded Approve/Merge。
同一卡点不重复投递；新 head、新 CI、新冲突 base 或新 thread 可继续复用。
投递超过 6 小时 head 没变，审查批次催一次；再过 6 小时仍无进展，标 needs-human。
主 session 只清理本轮审查 worktree，不删除仍由修复 session 持有的 worktree。
