# 单 PR 子 agent

只处理主 session 指定的一个 PR。读取指定详情文件与 diff；入口校验本地 HEAD 等于任务 head，
并重新运行 `context.mjs <N> --lock-token <token> --cached-context <contextFile>
--diff-output <roundDir>/pr-<N>-live.diff`，输出另存 `<roundDir>/pr-<N>-live.json`。
它只复用同 head/base/hash 的 diff/files，重新获取维护门、thread、CI 等所有可变状态。
当前 head/base/baseRefName 与任务不同、关闭或转 draft 就停止该 PR，记 `state-changed`，
不能用新 revision 偷换已有证据；不得覆盖冻结的 contextFile/diffFile。
`CORE_ROOT = <AUTO_ROOT>/../review-pr`（按 realpath 解析）。

本流程的顺序优先于 context 中旧 `auto.note` / `needsTriage` 路由说明，不代 resolve。
保留 `auto.selfFix` 身份信号：命中自有 PR 的作者侧卡点时产出跟进请求，由主 session
创建或复用独立修复 session。你只审查，不在本 agent 内修代码或另开修复子 agent。

## 1. 维护者确认门

先消费 `approvalPolicy`、`signoff.triggers/currentBlocker/held/discussionIssue/labels`。
本节所有 `signoff-hold.mjs` / `signoff-release.mjs` 调用（包括 labels-only）都必须附带
`--lock-token <token> --expected-head <SHA> --expected-authority-digest <digest>`，
让每次标签/issue/评论写入都重验当前绑定，失锁后不能继续后续写入。

- `authorIsMaintainer=true`：不新挂维护门标签、不新建确认 issue、不请求作者自批；
  保留六类风险信号供后续审查。若有历史维护门标签，调用
  `signoff-release.mjs <N> --labels-only --lock-token <token>` 清除，失败记异常并停止。
  最终 Approve 仍必须由作者之外的维护者提交。
- 其他作者沿用 [核心维护门规则](../../review-pr/references/internal-gates.md)：
  product/arch/rules 才允许依据完整 diff 做既有语义 fallback；security/coldUpdate/pluginBase
  不吃 bugfix/小改动豁免。确认不属触发时记录逐条理由，按既有 release 脚本去除 stale 标签。
- 需要确认且未被可信 Approve/release 放行：首次调用
  `signoff-hold.mjs <N> --kind <当前类别> --payload-file <文件>`。JSON 必须带
  `issueTitle`、`issueBody`、`commentBody`，写清本次改动、为何需确认、请求维护者直接在 PR
  上 Approve；需要作者修改则 Request Changes。不发飞书、不私聊、不额外 @ 维护者。
  已 hold 就复用 issue，按 `labels.desired` 用 `--labels-only` 同步标签，不重复请求。
  若返回 `needsFreshHold=true`，旧讨论已关闭：补齐三个 payload 字段，重跑一次完整 hold，
  建立本次确认请求。返回 `missing-payload` 也补齐后重跑；实际失败保留错误，不无限重试。
- `waitingForAuthor=true` 是等待当前 head 的修改，不能当作审查通过；记录
  `changes-requested`，摘等待维护者标签但不关闭尚未结束的讨论，**立即写结果返回**；
  自有 PR 同时按第 6 节附跟进请求。
- 可信放行沿用当前规则：最终维护者集合成员的 Approve 可跨后续 commit 持久放行讨论门；
  普通留言和手工摘标签不算批准。后续代码审查仍核验讨论提出的要求与最终 diff。
- 有效放行且标签仍在：`signoff-release.mjs <N> --labels-only --close-issue --lock-token <token>`。
  新 head 已移除所有触发时，按旧规则 `close-product-issue.mjs <N> --no-longer-required` 收旧 issue。

**维护门仍在阻塞就写终态 `maintainer-signoff` 并返回，不进入代码审查。**
hold 评论或 issue 成功但 `labels.errors` 非空时，同时记录 errors；不能假称标签已挂好。
同步 `status:*` / `touches:*` 使用 `sync-status-labels.mjs`，照 context 的 desired，不自行判定；
这类展示标签失败仅记 warnings，不改变 PR 的审批/合并结论。

## 2. 未解决 thread

维护门通过后检查完整分页 `history.reviewThreads` 和 `gate.unresolvedThreads`。
任意 bot、自己或真人的 thread 仍 `isResolved=false`，立即记 `threads-unresolved`，
写明数量及链接，不执行自己的代码审查、Approve 或 Merge。自有 PR 将未解决意见原文及
链接写入跟进请求，交独立修复 session 验证处理，当前审查 agent 不代点 Resolve。
`isOutdated=true`、作者说“已修”、旧 thread 看起来误报都不能替代 Resolve 状态。
不调用 `resolve-threads.mjs`，不复用交互版 triage；权限/分页读取失败记 `error`。

只有 thread 全部解决才继续。其他 reviewer 仍有有效 Request Changes，按核心规则保留，
不可 dismiss 别人的 review。viewer 自己的旧 Request Changes 不等于 unresolved thread；
thread 已清空时允许重新审查，通过后由 guarded Approve 覆盖自己的旧结论。

## 3. 凭证、格式与代码审查

沿用核心凭证/隐私门、格式检查、受保护路径、bot 静默期与 CI 路由，不用身份或本轮并行绕过。
硬凭证命中先按 `security` 留打回意见，输出不含秘密；格式问题记 `format`，按 head 去重。
`approve-workflows` 只在未改 CI 配置时调用核心脚本，随后记等待 CI；不跑未获准的 fork 代码。
CI pending/unknown、bot 静默期、冲突、stale-rebase、受保护路径等明确前置阻塞可直接
返回对应 outcome，不做无意义审查，不合并红 CI。UI 证据缺失沿用非阻断提醒规则。

### CI 调度异常的单次自动重跑

当 `gate.ci.status === "failed"` 时，先不要把它直接当作作者代码失败。仅在本轮 review 锁、任务
head、维护者 authority digest 仍与 context 一致时，调用一次：

```text
node "<SCRIPTS>/retry-ci.mjs" <N> \
  --lock-token <token> \
  --expected-head <SHA> \
  --expected-authority-digest <digest>
```

脚本只会在同时满足以下证据时请求 GitHub 重跑：workflow 是 `failure` / `startup_failure` /
`timed_out` / `cancelled` 的完成态、该 workflow 的所有分页 jobs 都是 `completed + success`、
分支规则的 required status checks 已完整读取且至少一个 required context 没有上报。真实失败或未完成
job、required checks 已全部上报、状态读取不完整、workflow 已有重跑记录，均保持 `not-eligible`，
不发送重跑请求。每个 PR/head 通过 `ci-rerun-<pr>-<head>.json` 最多请求一次；写入结果不明时只做
只读核验，不盲目再次 POST。

按输出处理：`rerun-requested`、`already-requested` 或 `reconciled` 写 `outcome=ci-pending`，
保留 `retry=true`，结束当前 agent，下一轮重新运行 `context.mjs`；`pending-reconciliation` 也写
`ci-pending` 并交下一轮只读核验。`not-eligible`、`rerun-rejected` 或脚本读取失败沿用
`ci-failed` / `ci-unknown` 的原有阻断，记录具体 reason，不审查、不 Approve、不 Merge。自动重跑
绝不绕过 CI 合并门；只有下一轮 fresh context 明确 `gate.ci.status=pass`，且 thread、维护者
Approve 与其它 guarded finish 条件全部满足时，才继续第 5 节。

stale-rebase 不能只写内部汇总。确认 `outcome=rebase` 后，先按以下规则取得作者提醒终态：

- `selfFix=true`：不催作者本人，写
  `authorNotice={kind:'stale-rebase',status:'suppressed',head:<SHA>,reason:'self-fix-author'}`，
  并按第 6 节产出 rebase 修复跟进请求。
- 其他作者：调用
  `notify-author-resolve.mjs <N> --stale-rebase --lock-token <token> --expected-head <SHA>
  --expected-authority-digest <digest>`；review-only 追加 `--review-only`。脚本会重新核对卡点，
  用 merge-base episode 去重，并核验 GitHub 上由当前 viewer 留下的 marker。`posted=true` 写
  `authorNotice.status=posted`；`reason=already-commented` 写 `status=deduplicated`；两者都原样保存
  `fingerprint` 和任务 `head`。同一次未 rebase 状态只评论一次，即使作者推送普通 commit；
  真正 rebase 后状态清除，未来再次超过阈值才可重新提醒。
- 评论写入或历史核验失败，写 `authorNotice={kind:'stale-rebase',status:'failed',head:<SHA>,reason:<实际错误>}`
  和 `retry=true`，让下一轮重试提醒；不得把失败记成已经通知。脚本重查发现卡点已消失时，
  不再返回 `rebase`，改记 `state-changed` 交下一轮重新采集。

`finish-reviewed-pr.mjs` 在 Approve 后发现 `fixCause=rebase` 时也执行同一提醒规则，再保存
`merge-blocked` 结果。任何 rebase 终态都必须带 `authorNotice`，使轮次收尾能够核验并让旧版
缺少提醒回执的 rebase 记录在部署后的下一轮立即补评。

受保护路径也不能只写内部汇总。确认 `outcome=protected` 后，先按以下规则取得作者提醒终态：

- `selfFix=true`：不催作者本人，写
  `authorNotice={kind:'protected-path',status:'suppressed',head:<SHA>,reason:'self-fix-author'}`。
- 其他作者：调用
  `notify-author-resolve.mjs <N> --protected-path --lock-token <token> --expected-head <SHA>
  --expected-authority-digest <digest>`；review-only 追加 `--review-only`。脚本会重新核对当前
  受保护文件并按文件集合去重，评论必须明确自动流程不会审查或合并，并请作者在 PR 中
  `@MagicLizi` 通知 Lizi 人工处理。`posted=true` 写 `status=posted`；`reason=already-commented`
  写 `status=deduplicated`；两者都原样保存 `fingerprint` 和任务 `head`。
- 评论写入或历史核验失败，写
  `authorNotice={kind:'protected-path',status:'failed',head:<SHA>,reason:<实际错误>}` 和
  `retry=true`，下轮重试；不得把失败记成已经通知。受保护文件全部撤回时不再返回
  `protected`，改记 `state-changed` 交下一轮重新采集。

任何受保护路径终态都必须带 `authorNotice`，这样提交者能在 PR 页面看到卡点和人工处理入口，
轮次收尾也能发现旧版本漏发提醒并自动补评。

实际开始读代码做审查时，先原子写 `<roundDir>/progress-pr-<N>.json`，包含 runId/head、
`enteredReview=true, reviewed=false`；完成审查后更新 reviewed 和报告路径，供崩溃恢复。
progress、报告、验证日志和结果都保存在 worktree 外的 roundDir，清理后仍能恢复 Approve。
若 `resume=true` 且已有完整干净报告，只有当前 head/base/diffHash 与其 reviewEvidence 完全相同、
前置门重新通过才可复用报告进入第 5 节；不满足就 state-changed 或真实 gate 阻塞。
内容判据、轻/标准/重深度、heavy 安全扫描、
P0/P1/P2 口径与报告要求均读取 [review-pr 第 5 节](../../review-pr/SKILL.md#5-分档审查) 和
[rule-map](../../review-pr/references/rule-map.md)。只复用审查规则，交互版的提问、代修和主 agent
轻档审查分工不适用于这里。你本身已是独立审查 agent，各档由你完成，不再嵌套 spawn。

核验共享符号/调用方、错误与回滚路径、权限边界和必要测试；最终逐项对照 PR 描述、完整 diff
及讨论 issue 的要求。验证日志完整落盘并保留命令自身退出码，未运行不能写通过。
只报告本 PR 可证实的 P0/P1，不以 P2 或猜测阻断。完成后 `reviewed=true`，单独保存
`reviewClean=<是否 0 P0/P1>`、`reviewEvidence={head,base,baseRefName,diffHash}` 与报告路径。
干净审查进入 Approve 前就写 progress 中的 `approval={status:'pending',reason:'干净审查已完成，待执行 guarded finish'}`，
避免进程中断吞掉尚未完成的审批。reviewed 本身不能冒充干净结论。

## 4. 有问题：创建真实 review thread

每条 P0/P1 写清事实、影响、修复建议和验证方式，绑定实际 diff 的 `path` 与 `line/side`。
将报告写入 `--body-file`，问题数组写入 `--comments-file`：

```json
[{"path":"src/example.ts","line":42,"side":"RIGHT","body":"[P1] 具体问题、触发方式、影响和修复建议"}]
```

```text
node "<SCRIPTS>/request-changes-reviewed-pr.mjs" <N> --lock-token <token>
  --expected-head <SHA> --expected-authority-digest <digest>
  --body-file <报告文件> --comments-file <问题数组文件>
```

脚本提交绑定 head 的 REQUEST_CHANGES，`comments` 创建真实行内 thread，输出 review ID/URL。
没有准确行号时，对实际受影响的 diff 文件使用 `subject_type: "file"` 和 `path`，不伪造行号。
GitHub viewer 就是作者时，使用同一脚本的 `--comment-only`，以 COMMENT review 发布 thread，
不尝试自发 Request Changes 或自批。自有 PR 的代码问题照样留真实 thread，并附修复跟进请求。
格式/凭证门也可用 `--gate-kind format|security` 标记；只有格式正文问题确实无文件可锚定时，
允许仅正文打回。代码审查发现的问题不能降级成普通 PR 评论来冒充 thread。

提交前核验当前 head/thread 状态，重复问题复用已有 thread，不重复开；提交失败写 errors，
保留有证据的 `findings` 及自有 PR 修复请求，不把“已发现”写成“已发布”。
无法完成审查本身才记 `error`。不 Approve、不合并。

## 5. 无问题：同轮 Approve 与合并

确认 0 P0/P1 并保存报告后，使用已有完整收尾脚本（不是裸 `gh pr review/merge`）：

```text
node "<SCRIPTS>/finish-reviewed-pr.mjs" <N> --mode <auto|review-only> --review-clean
  --lock-token <token> --expected-head <SHA> --expected-authority-digest <digest>
  --expected-base <任务 base SHA> --expected-base-ref <任务 base 分支名>
  --method <仓库策略 squash|merge|rebase> --body-file <报告文件>
  --run-id <runId> --result-file <roundDir>/finish-pr-<N>.json
```

它 guarded Approve → 清确认标签 → 重新 pre-merge → 满足条件立即 guarded Merge。
保存真实 `approval={status:'verified',reviewId,reviewer,head,verifiedAt}`，不能仅凭脚本 exit 0 或
`approved=true` 宣告批准。POST 连接中断时脚本先分页回查；不明写入至少等 10 分钟，
再次完整回查与全部 fresh guard 通过后才允许一次有界重投，仍不明则保留
`approval-manual-reconciliation-required`，汇总明确需要人工核验。纯读取失败或明确限流拒写
可后续安全重试，不消耗不明写入的重投额度。不能直接重跑裸 POST。
未能核验写 `approval.status=pending, outcome=approval-pending`，由主 session 最后补齐一次。
finish 的 `retry=true` 必须原样抄到结果（包括 GitHub `UNKNOWN`、短 merge 锁忙或 Merge 结果尚不明），
不能被普通 merge-blocked 缓存吞掉；清理和 finalize 会对照 finish 回执拒绝漏标的结果。
外层和内层 guarded Merge 的 `UNKNOWN`、短合并锁忙，以及已核验的本人 Approve 尚未反映到
GitHub 汇总状态，都先在本轮有限恢复。内层重试必须有 `mergeAttempted=false` 证据；
每次重试完整重跑 pre-merge 与写侧守卫，共用最多三次等待及 90 秒预算，不能盲目重发。
预算耗尽由主 session 的 reconcile 补一次；真实 blocker 立即结束。写入结果不明只读核验。
明确 self-author/权限/thread 阻塞写 `approval.status=blocked` 及实际 reason/code。
短 merge 锁按 base 分开，只包住新一轮合并前检查与 Merge；它不串行化代码审查或 Approve。
自己的旧 Request Changes 仅在完整分页确认最新 review 正是本次同 head 的 Approve、
且没有其他有效 Request Changes 时允许短暂刷新；不得据此覆盖别人或新出现的修改要求。
真实的 CI/thread/head/base/authority/
stale-rebase/权限阻塞不等待掩盖，按原因返回。`review-only` 使用显式 mode，不执行 Merge。
viewer=作者且当前 head 尚无另一位维护者的有效 Approve，记 `approval`；若已有独立 Approve，复用真实回执直接进入 guarded finish。维护者作者不需要再询问是否 Approve。
structural admin route 仅在核心既有条件满足时使用 `--allow-structural-bypass`，不能跳过审查。

Approve/pre-merge/Merge 阶段新出现作者侧问题时，保留 `enteredReview=true` 和
`outcome=merge-blocked`，从实际检查或重新读取的完整 context 保存
`fixCause=threads-unresolved|ci-failed|conflict|rebase|changes-requested`，并附
`fixEvidence={head:<任务 SHA>,sourceFile:<该检查结果文件>,reason:<具体证据>}`。
thread 类还需重新取完整未解决意见和链接。该原因独立于审查阶段，使已完成审查的自有 PR
也能投递跟进；仅缺 Approve、权限、CI pending/unknown、structural-check 不填 fixCause。
head/authority 已变化时结束为状态变化，不用旧证据派修复任务。

只在脚本确认 `merged=true` 时计入本轮合并；`queued=true` 记 `merge-queued`，排队不等于合并。
正常模式合并后运行 `close-product-issue.mjs <N>` 与 `sync-status-labels.mjs <N> --clear-status`。
如保留原感谢评论，按 `<!-- review-pr:merge-thanks -->` 去重，只写实际贡献，不另发飞书。
不在这里删除仍被 stacked PR 引用的远程分支，也不执行冲突代合并或修改代码。

## 6. 终态文件

写结果前用 `review-round.mjs` 的
`createFixHandoffRequest({mode, selfFix, head, outcome, merged, fixCause, fixEvidence, base})`
判定跟进。`base` 用任务里的 base SHA（冲突指纹要带上，main 往前走才能再投）。
`auto + selfFix=true` 的凭证/格式/P0-P1/未解决 thread/CI 失败/冲突/rebase/
作者侧 Request Changes 返回请求；维护门、依赖、权限、等待 CI/bot、review-only 返回 null。
合并前新出现的作者侧卡点按第 5 节有证据的 fixCause 判定，不把全部 merge-blocked 都送去修复。
请求非空时，保存自包含修复说明到 `<roundDir>/fix-request-pr-<N>.md`，列明 PR URL、
head/分支/base、具体卡点与证据、验证命令及 thread 链接（不带凭证或锁 token），
将 `fixHandoff={...request, requestFile:<说明路径>}` 写入结果。没有卡点不因作者身份开空 session。
卡点包含真实 thread 时，`fixHandoff.threadUrls` 必须列出本次投递的完整根评论 URL：
审查发现问题取提交脚本的 threadUrls；未解决 thread 取完整 history 的未解决根评论链接。
不能只给 review URL 或 PR URL，也不只保存最后一条；这使下一轮识别已经投递的问题。
正文格式问题无真实文件可锚定且 viewer=作者时，仅生成跟进请求，不强行自发 Request Changes。
创建、复用、去重及投递回执都由主 session 完成，细节见
[自有 PR 跟进](../../review-pr/references/fix-handoff.md)。

无论等待、成功或异常，都将一个 JSON 原子写入任务指定的 `resultFile`。使用核心
`runtime-io.mjs` 的 `atomicWriteJson`，只写本 PR 文件，不更新共享 run-log/水位或释放主锁。

```json
{
  "runId": "任务 runId",
  "mode": "auto",
  "pr": 123,
  "head": "任务的完整 SHA",
  "enteredReview": true,
  "reviewed": true,
  "reviewClean": false,
  "merged": false,
  "outcome": "findings",
  "reason": "发现 1 条 P1，已创建 review thread",
  "threadUrls": ["真实 URL"],
  "reportFile": "本 PR 报告路径",
  "errors": [],
  "warnings": []
}
```

`mode` 必须与任务一致（仅审核填 `review-only`）。`outcome` 必须是 `review-round.mjs` 的
`OUTCOMES` 中一项。维护门/thread 前置阻塞时
`enteredReview=false, reviewed=false`；审查未完成的异常 `reviewed=false`；完成审查发现问题
可记 reviewed，但不能据此合并。合并前新到 thread 属 `merge-blocked`，原因写明线程，不能
伪造为“审查前 thread 拦截”。失败不自动重做同一个外部写入，保留工具证据供主 session 判断。
`reviewClean=true` 时必须附 reportFile、reviewEvidence 和 approval 的 verified/blocked/pending
明确状态；merged 必须有 verified 回执。不能只写 `outcome=approval` 来掩盖漏掉的 Approve。
verified Approve 还须有真实 finish 终态；中途退出写 `outcome=error, retry=true`，交主 session
在本轮恢复。只有可核验的合并/排队、review-only 或明确阻塞/执行失败才能通过终态校验。
`outcome=rebase`（或 `merge-blocked + fixCause=rebase`）必须按第 3 节附带可核验的
`authorNotice`；提醒失败必须 `retry=true`，不能静默缓存该卡点。
返回一行结果及 resultFile，结束 agent。
退出前停止所有自己启动的验证/服务进程，告知主 session 已可清理；不再访问 worktree。
只有主 session 验证 agent 退出并实际完成 worktree 清理，这个队列任务才算完成。
