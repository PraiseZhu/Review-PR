# Cindy 维护者专用 gate

本文件描述 Cindy 维护流程,不是公开贡献指南;实现依赖共享脚本
(`review-pr/scripts/`)、`config/pr-rules.json` 和宿主提供的通知能力。
review-pr(交互)与 review-pr-auto(批处理)共用本文件。
自动批次的执行顺序以 [单 PR 子 agent 流程](../../review-pr-auto/references/pr-worker.md) 为准；
审查 agent 不代修、不代 resolve；自动批次的自有 PR 保留
[独立修复 session 跟进](fix-handoff.md)。交互版的催办和 thread triage 不自动搬入批次审查。

## 单一配置来源

路径、阈值和账号配置只读 `config/pr-rules.json`:

- `maintainerAuthority`:每个实际启动的 review 轮次由 `prepare.mjs` 从目标仓库默认分支
  CODEOWNERS 的唯一全仓根规则 `* @org/team-slug` 实时读取 active Team 成员,再与配置里的
  `maintainerAllowlist` 取并集。两类成员都有维护者 Approve 权限；所有作者都需要另一位成员
  独立 Approve。维护者作者不在审查前重复 hold，但最终也不豁免。Team 必须可见且对仓库至少有 write 权限；读取失败、根规则不唯一、分页不完整或
  Team 为空都从严停止,补充白名单不兜底。本轮快照绑定 lock token,所有 context 子进程共用；
  Approve、dismiss 和 pre-merge 前再实时复核 digest;
- `signoffGate`:`label`(唯一维护者确认标签)+ 六类触发的检测输入——
  `product.{uiPaths,uiExcludePaths}`、`arch.{corePaths,coreDiffLines,refactorDiffLines,anyTypeDiffLines}`、
  `security.{paths,excludePaths,riskyPatterns,dependencyScan}`、
  `coldUpdate.{paths,guardMarker}`、`rules.{paths,excludePaths}`(excludePaths 只放机器生成产物,如
  docs/legal/notices/)、`pluginBase.{paths,excludePaths}`(插件基座:所有已装插件共同
  踩着的那层,判据见目标仓 `docs/dev-rules/plugin-security-and-authoring.md` 第 5 节);
- `protectedPaths`:受保护路径(`paths`,含 `.github/`、根 `CODEOWNERS`、`docs/CODEOWNERS`)。命中这些路径的 PR **一律不自动合并**,
  交人工处理——不看 diff 大小、不看标题类型。[MIVO-PATCH protected-author-release] 作者是维护者
  (`authorSignoffExempt`)时不等人工放行:开 notice issue 通报后自动放行(`review-pr` 写通过,仍不自动合并);非维护者作者照旧;
- `statusLabels`:展示标签开关与外观(`enabled` 整组、`largeDiffLines` 大改动阈值、
  `labels.<名字>.{color,description,enabled}` 逐个覆盖)。**只影响展示,不影响任何判定**;
  标签名与优先级是逻辑,在 `lib.mjs` 的 `DISPLAY_LABELS` / `computeDisplayLabels`;
- `threadTriage`:交互版 thread 代 resolve(`extraBots` 追加按登录名认定的机器人);
- `postMergeSweep`:合并后迟到 bot 意见清扫窗口;
- `botReviewSettle`:机器人静默期(`reviewers` / `maxWaitMinutes`);
- `ciSensitivePaths`:workflow approval 安全门;`serverPaths`:Server 通知 gate;
- `selfFixAuthors`:自有 PR 遇作者侧卡点时自动创建或复用独立修复 session（review-only 除外）；
  交互版经授权使用同一路由。不提供 Approve、免审批或 self-merge 权限;
- `slackSyncBots` / `slackSenderAliases` / `orgMappingRepos`:讨论 issue
  留言归属(Slack 同步评论的发送者 → GitHub 账号,不涉及任何飞书发送);
- `feishuNotify.summaryChat`:auto 每轮汇总卡片要发到的飞书群(`name` + `chatId`)。
  这是全流程**唯一**的飞书发送出口——hold 群通知、确认 @ 维护者、停滞飞书私聊
  催办均已下线(2026-07-31 拍板:除汇总卡片外不再往飞书发任何内容);
- `securityScan`:重档审查的扫描配置。

不要在 SKILL.md 中写死人名、群名、阈值或路径;配置变化先检查 JSON 再跑 review。

## 确定性脚本

脚本输出 JSON,是判定和副作用的唯一实现;主 agent 只做语义判断和文案:

| 场景 | 脚本 |
|---|---|
| 调度预检 | `pre-check.mjs --repo-root <目标仓库>` |
| 自动批次全量详情与冻结分组 | `plan-review-round.mjs --lock-token <token> --mode <auto\|review-only>` |
| 滚动并发 / 审批补齐 / 退出后清理 | `review-queue.mjs init/claim/bind/complete/reconcile/status/watch/stop --plan <plan.json> --lock-token <token>` |
| 单 PR 审查 worktree 归属与真实清理 | `review-worktree.mjs create/remove/verify --plan <plan.json> --pr <N> --lock-token <token>`；remove 另需 `--agent-exited` |
| 自动批次覆盖校验、单张汇总卡与 Git 历史发布 | `finalize-review-round.mjs --plan <plan.json> --lock-token <token>` |
| 锁与心跳 | `prepare.mjs`、`refresh-lock.mjs`、`release-lock.mjs`、`cleanup.mjs` |
| 单 PR / 批量扫描 | `context.mjs <PR> --lock-token <token>`、追加 `--scan`、或 `--scan-all --lock-token <token>` |
| 复用不可变代码材料，动态门仍重取 | `context.mjs <PR> --cached-context <原详情> --diff-output <新 diff 文件> --lock-token <token>` |
| 审查检出(detached,零分支) | `checkout.mjs <PR>`(建分支场景才加 `--branch`) |
| 维护者确认门 hold / 放行 / 收尾 | `signoff-hold.mjs`、`signoff-release.mjs`、`close-product-issue.mjs` |
| 展示标签同步(只展示,不参与判定) | `sync-status-labels.mjs <PR> --desired "<...>"`、合并后 `--clear-status` |
| 清理自己的旧 CR review | `dismiss-stale-reviews.mjs <PR> --gate-clean --lock-token <token>` |
| thread 代 resolve | `resolve-threads.mjs <PR> --payload-file -` |
| 合并后迟到意见清扫 | `post-merge-sweep.mjs` |
| 重档安全扫描(worktree 内) | `security-scan.mjs --base <sha> [--dep <包名>]...` |
| 确认门策略单测 | `signoff-policy.test.mjs`(改 UI 测试路径过滤、讨论 issue 收尾/复用判定后必跑) |
| 安全/通过判定单测 | `security-patterns.test.mjs`(改 lib.mjs 判定后必跑) |
| 展示标签判定单测 | `status-labels.test.mjs`(改 `DISPLAY_LABELS` / `computeDisplayLabels` 后必跑) |
| CI 总门判定单测 | `ci-status.test.mjs`(改 `evaluateCiStatus` / `classifyRollupContexts` 后必跑) |
| 动态审批与合并路由单测 | `maintainer-authority.test.mjs` + `approval-policy.test.mjs`(改 Team 解析、独立 Approve、自批拒绝或 admin merge 判定后必跑) |
| fork workflow 放行 | `approve-workflows.mjs` |
| 受保护 review / 合并 | `approve-reviewed-pr.mjs`、`request-changes-reviewed-pr.mjs`、`pre-merge-check.mjs`、`merge-reviewed-pr.mjs` |
| 催办(GitHub 评论,不走飞书) | `notify-author-resolve.mjs` |
| 合并后健康检查 | `typecheck-merged.mjs` |
| 汇总落盘 | `run-log.mjs` |
| 跟进会话状态 / worktree 回收 | `fix-session-state.mjs`、`fix-worktree-cleanup.mjs` |

能由脚本确定的字段不要用 grep、手写 gh api 或模型猜测重新实现。

`context.mjs` 通过 `pr-diff.mjs` 获取完整 diff：优先使用 GitHub 接口，仅在明确的
diff 超限错误时，按本轮固定 head/base SHA 从 origin 拉取提交；浅克隆先补全历史，再在
本地比较唯一 merge-base 与 head。不切分支、不改工作区、索引、已有 refs 或 FETCH_HEAD。
本地结果仍执行完整安全扫描、head/base 变化检查与 evidence 校验，不截断或跳过扫描；
兜底失败保留 GitHub 与本地错误并停止，权限或网络等非超限错误不触发本地兜底。

自动批次的干净审查与 Approve 是两个状态：`reviewClean=true` 必须有同 head 的真实
review ID/reviewer 回执，或明确 blocked/pending 原因。pending 在本轮补齐一次并在下轮继续，
不能被相同 head 的缓存吞掉。每个 PR 子 agent 的 worktree 清理属于完成条件；
`fix-worktree-cleanup.mjs` 是独立修复 session 的旧清理流程，不用它广域回收审查队列。

## 维护者确认门(六类触发,一套机制)

判定全在 `context.mjs` 的 `signoff` 字段,语义规则在 `signoff.note`。要点:

- **触发**:product(feat / 生产 UI 路径;`.d.ts` 与测试/mock/snapshot 路径确定性排除)、arch(核心路径 ≥150 行 / refactor ≥400 /
  任意 ≥800)、security(边界路径双条件 + 危险写法硬命中 + 新增依赖)、
  coldUpdate(fingerprint guard 结论优先于路径启发式)、rules(规则文档 =
  审查判据本身)、pluginBase(插件基座路径 = 全部已装插件的地基;无阈值,
  **且不吃 bugfix / 纯技术改动的语义豁免**——#1080 就是这么被 arch 门放过的)。
  任一触发且未通过 → `blocking=true`,不合并。
- **审批权限共用最终维护者集合**:CODEOWNERS 根 Team active 成员与
  `maintainerAllowlist` 成员都可以为他人 Approve。作者本人在集合中
  (`approvalPolicy.authorIsMaintainer=true`)时不在审查前重复 hold；审查通过后仍由另一位
  集合成员 Approve。viewer 与作者相同时，先回查是否已有另一位维护者的有效 Approve；已有就复用
  并继续 guarded merge，缺少才停止等待，绝不自批。trigger 事实与重档恶意代码专项
  不受影响。账号从 Team 和补充白名单都移除后,其旧 review 的维护者效力立即失效。
- **当前 head 的状态(2026-08-09 拍板:Approve 一旦发生即持久放行)**:
  1. 维护者 **Approve** → 确认完成,摘标签。**此 Approve 持久有效:作者后续再推新
     commit 门保持 released,不重新挂标签、不发状态回帖**;
  2. 维护者对当前 head **Request Changes** → 球在作者手里,同样摘标签;这不是通过,
     PR 仍会被 GitHub 的修改要求拦住;
  3. 作者在 Request Changes 之后提交新代码 → 旧 review 不再代表当前 head。
     如果历史上已有维护者 Approve,门保持 released、标签不挂回;
     如果从未 Approve 过且新代码仍命中确认门,重新挂 `awaiting-discussion` 等维护者确认;
  4. `signoff-release.mjs --gates <kinds> --lock-token <token> --by <viewer>
     --expected-authority-digest <digest>` 只用于当前 GitHub viewer 本人在最终维护者集合中且明确
     指示的兜底。marker 的评论作者、`by` 与最终维护者集合成员必须是同一人；伪造/旧成员 marker
     只进 `untrustedReleaseMarks`,不放行。
  普通评论、讨论 issue、Slack 留言、旧 hold 记录和摘标签本身都不构成通过。
  维护者在评论里表过态但没点 Approve 时,只进汇总提醒对方去 PR 上操作。
  **持久放行的安全网**:最终审查阶段会对照 PR 描述、讨论 issue 中的修改要求与 diff
  范围逐项复核——修改超出 PR 描述范围(夹带私货)、讨论中要求的修改未落实,一律
  按 P1 开问题 thread；自有 PR 同时投递 fix-handoff，不因门已放行而放水。
- **hold 动作** = 开讨论 issue + PR 评论 + 打标签(`signoff-hold.mjs`,必带
  `--payload-file`,缺文案返回 `missing-payload` = 调用方少传参数,补上重试)。
  issue 与 PR 评论只能使用”维护者确认 / 维护者”用词。**不转 draft**。hold 失败不等于
  通过:`blocking` 仍 true,照旧不合并。
- **讨论 issue 关闭**:Approve 放行时 `signoff-release.mjs --labels-only --close-issue --lock-token <token>` 关闭 issue
  (讨论结束);合并后 `close-product-issue.mjs` 兜底扫漏已合并但 issue 还开着的。
  Request Changes 只摘标签不关 issue(讨论暂停,球在作者手里)。
- **状态回帖(renotice)** = 门重新亮起来时给**作者**的一条提醒(`signoff-hold.mjs` 内建,
  `--labels-only` 也照发)。触发条件:已 hold 过 + 本轮看到时标签不在 + 这版 head 没回帖过;
  按 head sha 去重(标记 `<!-- review-pr:signoff-renotice head=… -->`),作者对同一版代码
  反复推、标签反复摘挂都只发一条。文案是脚本里的固定模板(没有语义判断,可靠性要求它不能
  依赖上层每轮记得传文案),`--kind` 只影响「在拦的是哪一类」那句。判据用「看到时标签不在」
  而不是「加标签成功」:标签写失败时门照旧在拦,作者更该知道。回帖失败不改变门的判定,
  下一轮凭「无 head 标记」自动重试。
  由来:#1283(2026-08-01)—— Request Changes 摘标 → 作者 08:34 推完修复 → 标签 08:49
  悄悄挂回 → 14:59 才 Approve。GitHub 贴标签不发通知,作者页面还是绿色 Ready to merge +
  「已请求你 review」,那 6 小时里他又推了 4 次、请求了 4 次 review,一条状态提醒都没有,
  只能以为流程卡死了。旧口径「已 hold → 不重复动作」把两个受众混成一个了:不去烦维护者,
  不等于也不告诉作者。
- **标签**:唯一新标签 `awaiting-discussion`,也是“现在是否等维护者确认”的唯一
  外部依据(`is:pr is:open label:awaiting-discussion` 一键筛全部待确认)。每轮先按
  `signoff.labels.desired` 同步:需要维护者确认就挂,Approve / Request Changes 后就摘,
  作者新提交且仍命中触发就再挂。旧主标签和旧门类子标签只做兼容迁移,同步脚本碰到时
  顺手摘除;`pre-merge-check.mjs` 对新旧标签都设防线 blocker(`signoff-pending`)。
- **优先级**(`signoff.currentBlocker`):product → security → pluginBase → rules →
  coldUpdate → arch。汇总一律写 currentBlocker,不写 held.kind(那只是第一次 hold 的门)。
  `auto.action=signoff-gate` 时,原走向在 `auto.fallback`:product/arch/rules 经语义确认无需
  hold 后必须按 fallback 继续,汇总同时带 fallback action/reason,不得把真实格式/gate 卡点藏掉。
- **讨论 issue 收尾**:`signoff.held != null` 且当前 `signoff.triggers` 为空时,调用
  `close-product-issue.mjs <PR> --no-longer-required`;仍有 trigger、只是 Approve / Request
  Changes 令 blocking=false 时保留 issue。旧 issue 已关闭后 gate 再触发,signoff-hold 会新开
  当前讨论 issue;issue state 查询失败时 fail-safe 复用旧链接,避免网络抖动制造重复 issue。
- Slack 同步消息与其它留言同口径(信息位):归属到维护者的(`via=slack-sync`,
  信任锚是 `slackSyncBots` 配置名单)在汇总里点名提示去 Approve;归属不了的照旧点名
  不采信。issue 读取失败(`maintainerComments=null`)如实进汇总。
- **hold 不发飞书通知**(2026-07-30 拍板取消,原「群发 + @ 维护者」机制随
  Approve 统一确认一并下线):维护者靠 GitHub 通知与轮次汇总的「待确认」条目知悉;
  hold 的 PR 评论与讨论 issue 里写清确认方式(直接在 PR 上 Approve;需要修改就
  Request Changes,作者改完后重新 Approve)。

## 展示标签(`statusLabels`:`status:*` / `touches:*`)

**与门无关的一层**,单独列在这里就是为了不被当成门:合并前防线只认
`awaiting-discussion` 与旧门类标签,展示标签贴错、贴不上、被人手工摘掉都不改变任何判定。

- 判定单一真相源:`context.mjs` 的 `statusLabels.desired`(纯函数
  `lib.mjs computeDisplayLabels`,单测 `status-labels.test.mjs`);落地只有
  `sync-status-labels.mjs`。别在别处重算——重算必漂移,而漂移的后果是「按标签筛出来的
  列表说谎」,比没有标签更糟。
- `status:*` 互斥(最多一个),优先级:门在拦(不挂)→ auto-fixing → awaiting-author →
  conflict → ci-failed → threads-open → blocked-by-pr → needs-human →
  awaiting-bot-review → ci-running → 都不命中(不挂)。**顺序的道理**:先说「球在谁手里」
  (要作者动的最该被看见),再说「机器在忙」;门全过时不挂,因为那一秒后 PR 就要被审 /
  被合,挂了立刻要摘,纯噪音。
- `touches:*` 是 diff 事实(六类确认门触发 + 红线路径 + 新增依赖 + 纯文档 + 大改动),
  与门是否在拦无关:豁免或已确认的触发照样挂着。PR 不变它就不变,所以基本不产生 churn。
- `touches:security` / `plugin-base` / `cold-update` / `rules` / `product-ui` / `core`
  覆盖的信息与 2026-07-30 删掉的门类子标签(`need-whitelist:<kind>`)相同,但那批参与
  流程语义、被合并前防线识别,这批**完全不参与判定**,且表达的是「碰到了什么」而不是
  「现在是否在拦」。2026-08-01 维护者拍板加回,用途是让 GitHub 列表自解释。
- 受管范围:只有 `statusLabels.managed`(`lib.mjs DISPLAY_LABELS`,`pr-rules.json`
  `statusLabels.labels.<名字>.enabled=false` 可逐个关)里的名字会被增删。
- 失败处理与维护者确认标签**不同档**:展示标签的 `errors` 只在汇总写一行(照抄报错第一行),
  不进「⚠️ 异常」、不登记台账、不改变处置。维护者确认标签失败仍照旧进异常组——
  别让展示标签的噪音把真会改变结论的报错挤下去。
- 合并 / 关闭后 `--clear-status` 只摘 `status:*`,`touches:*` 留作归档。

## 审查分档(`review.tier`)

- **light**:轻档 type + 纯文档/文案 + 零触发零命中 → 主 agent 直接读 diff。
- **standard**:独立审查 agent 按 rule-map 审,不跑扫描。
- **heavy**(`heavyReasons`:security 触发 / riskySoftHits / 新增依赖 / 红线路径):
  standard + 恶意代码与数据外发专项 + `security-scan.mjs`。
- 分档只决定审查深度,不影响维护者确认门与合并前提。

## thread 代 resolve(triage)

本节 triage 仅用于交互版 `review-pr`。当前 `review-pr-auto` 在维护门之后看到任何未解决
thread 就停止该 PR，不执行代 resolve；自动编排以 `review-pr-auto/references/pr-worker.md` 为准。

分支保护开了 Require conversation resolution,thread 不点 resolve 就合不了,而 bot
从不回来点、作者修完常忘点——这是历史上整轮空转的最大来源。

- 路由(2026-08-06 修):前置门**唯一**阻塞是未 resolve thread 的候选不再 skip-gate,
  `context.mjs` 给 `auto.needsTriage=true` 进处理清单,④ 清完继续审查;thread 混着
  其他 blocker(冲突 / CI 失败 / 别人的 CR / 静默期未过)照旧 skip,不扩大 triage 的
  作用面。修因:旧路由里 skip-gate 短路发生在 ④ 之前,triage 从未真正执行过
  (实锤:全仓 0 条 triage 标记回复,37 个 open PR 的 thread 全靠作者手点)。
- 口径(红线:**只代 resolve 确认已解决完、作者忘了点的,没解决的绝不许点**):
  bot thread 认「读当前 head 核实意见已被后续 commit 处理」或「意见基于可独立验证
  的错误事实(证据原文写进回复)」——`isOutdated` 只是线索、不单独构成判据(行改了
  ≠ 问题解决,2026-08-06 拍板收紧);真人 thread 只认修复实锤在当前 head(对照 diff
  核实),不要求作者回复过;拿不准 → 保持阻断 + 催办(宁可漏放不错杀)。
- 安全阀:每次代 resolve 必带回复(`resolve-threads.mjs` 强制,写明验证依据的
  commit)——原 reviewer 收到通知,一键 unresolve 即恢复阻断;被 unresolve 过的
  thread(`reopened-after-triage`)脚本永久拒绝再碰,留人工。

## CI 总门(CI 全绿才合并,2026-08-04)

**required 与非 required 一视同仁:`ci.status=pass` 是合并硬前提**,交互与 auto 共用。
判定单一真相源在 `lib.mjs evaluateCiStatus`(单测 `ci-status.test.mjs`),双源:
`statusCheckRollup`(覆盖 Actions / 外部 check-run / commit status,PAT 读不到降级 null)
+ `actions/runs`(兜底 + fork workflow awaiting 探测)。`context.mjs`(`gate.ci`)与
`pre-merge-check.mjs`(`ci`)都无条件算,不再只在 BLOCKED 时查。

- `failed` → 不合并；交互模式把 `ci.failed` 名单如实提示用户，auto 记 `ci-failed`
  并在汇总中列出失败项，自有 PR 投递 fix-handoff，其他 PR 等待作者处理;
- `pending` → 等跑完(auto 跳过,CI 完成会改变扫描指纹自动唤起下轮);
- `awaiting` → 走 approve-workflows 流程,批完等 CI 跑绿;
- `unknown`(两源都读不到,或 GitHub 报 UNSTABLE 但已读到的来源全绿)→ **不得视为
  通过**,如实报告;
- 同名 check 去重(2026-08-16,根因台账 `ci-cancelled-rollup-masks-success`):rollup
  里同一 head SHA 会有 re-run / concurrency 顶掉留下的同名多条,只按「同名最新一条」
  评估(与 GitHub 分支保护同口径);被后续 run 覆盖的 CANCELLED 不算失败,同名最新
  一条仍是 CANCELLED 照样拦;
- 堵住的历史洞:① 非 required 的红 CI 只给 UNSTABLE 不给 BLOCKED,旧逻辑完全不设防;
  ② selfMerge(`--admin`)在 awaiting-approval 分支提前定类,CI 分类永远不执行;
  ③ 失败的外部(非 Actions)required check 被误判成 structural-check 进而可能被 bypass。

## stale-rebase(分支落后 base 太久必须 rebase,不允许过期 CI 结果代绿)

背景:CI 是对 PR head + base 的虚拟 merge commit 跑的——base 前移后旧 CI 结果不再
有效。branch protection 的「Require branches to be up to date」由 GitHub 把关,
但 `--admin` merge 会绕过它。这里补一道防线:
**behind_by > 0 且 merge base(base...head 的共同祖先)距今超过阈值** → 阻断合并、
要求 rebase 以触发最新 CI。behind_by = 0(PR 已和 main 同步)不触发——merge base
再老也不需要 rebase。作者 rebase 一次 merge base 前移一次,计时自动归零。

- **判据纯函数**:`lib.mjs` 的 `checkStaleRebase({mergeBaseDate, nowIso, cfg})`,
  单位测试待补;`mergeBaseDate` 来自 Compare API
  (`/repos/:slug/compare/:base...:head`,取 `merge_base_commit.commit.committer.date`),
  15s 超时,失败按 mergeBaseDate 空不拦;
- **双重落地**:`context.mjs` 扫描阶段押 blocker + `pre-merge-check.mjs` 合并前最终复核;
  Compare API 不可用(网络/权限)→ `behindBy` 按 0 处理(不会把网络问题当阻断);
- **auto 分流**:`auto.action=skip-stale-rebase` → 跳过，记 `rebase` 并进汇总；auto worker 必须
  调用 `notify-author-resolve.mjs --stale-rebase` 催作者 rebase 并保存 `authorNotice` 回执。
  去重绑定 merge-base episode：同一次落后期间只提醒一次，普通 push 不重发；真正 rebase
  解除卡点后清状态，未来再次超过阈值才重新提醒。GitHub 评论 marker 仅信任当前 viewer，
  因此本机提醒状态丢失也不会重复发送；交互版可继续使用同一脚本；
- **selfFixAuthors**:正常自动批次投递独立 session 处理 rebase；review-only 只记录，交互版经授权使用;
- **交互模式**:3.6 前置检查时告知用户「需要 rebase」,可先审但合并不放行;
- **配置**:`pr-rules.json` 的 `staleRebase:{enabled:true, maxDaysBehind:3}`。

## 机器人静默期(不许合并跑在外部 review 机器人前面)

实锤 #716:本流程从作者最后一个 commit 到合并完只要 3.2 分钟,Copilot/Codex 要
6~11 分钟,不等就把 5 条真 P1 漏进主干。实测(40 PR / 552 push):Copilot 响应率
74%(中位 5.0 分)、Codex 54%(8.3 分)、greptile 仅 16%——所以必等名单只放
Copilot + Codex,greptile 进名单会让每个 PR 干等到超时。上限 20 分钟
(2026-07-28 定,覆盖 Copilot p99)。

判据在 `lib.mjs` 的 `evaluateBotSettle`(纯函数、有单测),两级条件(维护者
2026-07-30 定的节奏):

1. **必等表态**:`reviewers` 里每个机器人对**当前 head commit 之后**发过言;
2. **静默窗口**(`quietMinutes`,当前 5 分钟):表态齐了之后,还要最近 5 分钟内
   quiet 名单(`reviewers` ∪ `quietExtraBots`,含 greptile)**都没有新动静**才放行
   ——greptile 不必等它发言(16% 响应率),但它真来发言会重置静默计时,
   「三兄弟都说完并安静了 5 分钟」才进审查/合并。

超总上限(距 head push ≥ `maxWaitMinutes`,20 分钟)一律放行(`timedOut=true`,
汇总写明迟到意见可能合并后才到,由 post-merge-sweep 兜底)——静默被反复重置也
不会永久卡死。未满足时本轮不审不合(扫描阶段就 skip,免得审查白跑)。两处执行:
`context.mjs` 扫描押 blocker + `pre-merge-check.mjs` 合并前复核
(`awaiting-bot-review` 不得 bypass、不得 admin 合；所有作者路线都受限)。
bot 意见本身则由 thread 机制保证被处理:未 resolve 的 bot thread 不进审查
(自动批次等待 Resolve；交互版按 triage / 催办流程处理)。

## 作者侧与仓库侧

- 所有作者最终重审通过后,只能由另一位最终维护者集合 viewer 用
  `approve-reviewed-pr.mjs --review-clean --lock-token <token> --expected-head <SHA>
  --expected-authority-digest <digest>` 提交 Approve；脚本写前重拉 Team 与白名单,并拒绝非成员 viewer、
  viewer=作者、head/authority 变化、别人的 CR 与未 resolve thread。维护者作者在审查通过后
  自动执行，不再单独确认；禁止裸跑 `gh pr review --approve`。缺 Approve 不再使用
  approval-exempt admin merge 绕过。
- `selfFixAuthors` 的 PR 在自动批次中沿用统一审查和问题 thread，作者侧卡点另投递独立
  fix-handoff session；review-only 不投递。该配置不提供 Approve、作者豁免或 self-merge。
- fork workflow 待批:未改 `.github/workflows|actions` 才可 auto approve;改过的
  跳过点名维护者。
- `blockClass=structural-check`(必需检查永不上报结果):仅
  `reviewDecision=APPROVED` + **`ci.status=pass`(双源全绿,含外部 CI——单看
  actions/runs 会把失败的外部 required check 误判成结构性门)** + 0 未 resolve
  thread + 有 bypass 权限时可经 `merge-reviewed-pr.mjs ... --admin` 合并,否则跳过；
  不裸跑 `gh pr merge`,也不把结构性门写成 P1 打回作者。
- `format.hitsServer=true` 且无「已通知 Lizi」证据 → 不 auto 放行(当前
  `serverPaths` 为空不触发,规则保留)。
- 实质重构他人历史功能且无对齐证据 → 打回要求补沟通与测试范围。

## 维护者 precheck

scheduler 注册 `node "<SCRIPTS>/pre-check.mjs" --repo-root "<目标仓库>" [--review-only]`。
只读 GitHub 快照，原子产出 `review-candidates.json`；不提前拉 Team。无有效审查锁时先
对真实 skills 仓库 pull --ff-only，更新后重启检查脚本一次；本地有改动/拉取失败时使用原副本，显式返回 `skillSync`。即使无候选也保留此更新步骤，防止一直跳过的安装点永远用旧规则。
每个实际启动的轮次仍经 prepare fresh fetch Team；auto 传 `--skip-skill-pull` 避免重复更新。

仅对精确仓库 `makecindy/cindy`，本机外部 `round-state.json` 优先；Git 历史只在本机文件缺失时作为回退。
回退文件固定为 `review-pr/history/makecindy-cindy/round-state.json`，必须校验版本、仓库、模式、runId
和逐 PR 状态结构；任一不匹配都按无历史状态处理。Git 不会覆盖已有本机状态。

1. 有效锁在 60 分钟 TTL 内 → exit `2`；
2. 无候选（含只剩 draft）→ 写空名单，exit `2`，不创建会话；
3. head、CI、review、thread、base 等快照与 `round-state.json` 的完整处理记录一致且未到
   重查时间 → 跳过该 PR。异常下轮重试；bot 等待 5 分钟复查；其他状态 6 小时心跳；
4. 有候选且名单成功落盘 → exit `0`，session 用 `plan-review-round.mjs` 消费该名单；
5. 查询/落盘失败 → exit `1`，不能假装为空或拿旧名单启动。状态缓存缺失/损坏则全量候选。

`makecindy/cindy` 的 finalize 会将安全化 Summary 写入
`review-pr/history/makecindy-cindy/runs/<runId>/summary.json`，同步更新 `runs.jsonl` 和带仓库信封的
`round-state.json`。历史成功推送是 finalize 完成和 queue close 的前置条件；失败时不写 finalized 回执、
不发送最终飞书卡片，恢复同轮后用原 Summary 幂等重试。Git 中禁止写 diff/context、worktree、锁/token、
报告、agent/fix-session ID 或飞书发送回执；`feishu-cards.json` 与 `notification.json` 只留在外部运行时目录。

名单不按成功代码审查的 head 单独筛选，避免同 head 的 Approve、thread Resolve、CI 完成后
一直不能合并。依赖判断在主 session 收集详细信息后进行；未合并依赖本轮不补入。
无候选不为历史 sweep 单独启动会话。完整编排与终态协议见兄弟 `review-pr-auto/SKILL.md`。
