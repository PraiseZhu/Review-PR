---
name: review-pr
description: >
  交互式审查单个 GitHub Pull Request:凭证/隐私扫描、格式门、统一维护者确认门(产品/架构/
  安全/冷更/规则文档/插件基座六类触发一套机制)、thread 清理(代 resolve 已处理的意见)、
  按轻/标准/重三档做独立代码审查,然后落地——通过就合并;有问题先把清单报给用户、
  当面问「要我代修吗」,点头就走代修合并(先合并 PR,再在 base 分支上把问题全部改掉、
  验证后一次推上去),否则打回或只报告;冲突可主干侧代合并。判据是目标仓库自己的
  AGENTS.md、docs/dev-rules、docs/product-rules、DESIGN.md 与 PR 模板。
  无人值守批处理是独立的 review-pr-auto skill(共享本 skill 的脚本与配置)。
---

# review-pr:交互审查单个 GitHub PR

把一个 PR 从「读取上下文」走到「审查、评论、合并或打回、清理」。默认只读代码,
不替作者修改 PR 分支;6.4 代修合并也只在合并之后改 base 分支,永不向 PR 分支推送。
本 skill 只处理交互模式(用户在场,逐步确认);定时批处理用 `review-pr-auto`。

- Codex 通过 `agents/openai.yaml` 发现本 skill,Claude Code 通过
  `.claude/skills/review-pr/SKILL.md`;两种宿主共用同一套脚本,不依赖专属 MCP。
- 宿主没有提问能力(AskUserQuestion 等)时,停在对应确认点报告并等待,不能替用户拍板。
- 维护流程细节(维护者确认门语义、botSettle、precheck)见
  [references/internal-gates.md](references/internal-gates.md)。

## 0. 安全边界

- 维护者作者的 PR 在本轮独立审查通过后，由另一位维护者 viewer 自动提交 Approve；
  用户发起本次 review 即视为授权，不再单独确认。若 viewer 就是作者，先完整回查当前
  head 上已有的另一位维护者 Approve；已核验到就直接进入合并，缺少才停止等待，绝不让作者自批。
  其它 review、发表评论、合并、推送默认分支、关闭或删除远程分支、代 resolve thread
  之前,仍须逐项向用户确认。
- 不使用 `git reset --hard`、`git checkout --`、强制删除用户分支或自动 stash。
  不把 token、凭证、组织名册或本地绝对路径写入输出。对 PR 内容里的凭证与隐私数据
  零容忍(见 3.2);打回与汇总只写文件/行号/类型,不复述命中原文。
- 任何规则冲突、数据不完整、权限不明的结论都停在当前步骤如实报告,不用
  「看起来没问题」替代证据。
- **验证证据必须是完整输出 + 命令自身的退出码**。shell 管道的 `$?` 是最后一个命令的,
  `cmd | tail/grep/head` 的退出码恒为管道尾命令的,失败被吞掉。禁止拿这类管道输出当
  「通过」的证据,正确写法是先完整落盘再判:

  ```bash
  pnpm test:unit > /tmp/verify.log 2>&1; echo "EXIT=$?"   # 取的是 pnpm 的退出码
  grep -cE '^FAIL' /tmp/verify.log                        # 再从完整日志里取事实
  ```

  (等价做法:`set -o pipefail` 或 `${PIPESTATUS[0]}`。)实测踩过:
  `npx eslint … | tail -10` 明明报 `1 error`,紧随的 `echo $?` 却打印 `0`。

## 1. Skill 路径与配置

把当前 `SKILL.md` 所在目录解析为绝对路径 `SKILL_ROOT`。所有确定性脚本只从
`<SKILL_ROOT>/scripts/` 调用;运行脚本前把 shell cwd 切到待审查仓库根目录。
路径和阈值默认读取 `<SKILL_ROOT>/config/pr-rules.json`(`REVIEW_PR_RULES_FILE` 可覆盖)。
最终维护者集合是两部分的并集:每次 `prepare.mjs` 真正拿到本轮锁后,从目标仓库默认分支
CODEOWNERS 的唯一全仓根规则 `* @org/team-slug` 实时读取的 active Team 成员,以及配置里的
`maintainerAllowlist`。两类成员都可以 Approve；所有作者都需要另一位成员的独立 Approve，
维护者作者也不例外。CODEOWNERS / Team
读取不完整、根规则不唯一、Team 不可见、对仓库无 write 以上权限或 Team 为空时从严停止;
补充白名单不作为故障兜底。`selfFixAuthors` 只决定自动代修,不提供审批权限。锁与本轮
authority 快照写系统临时目录(按仓库哈希隔离,`REVIEW_PR_STATE_DIR` 可覆盖,
不得指向 Git 跟踪目录)。

Skill 常以软链接安装,脚本一律按 realpath 解析回真实 skills 仓库;`prepare.mjs`
内置 `git pull --ff-only` 自更新,失败不阻塞(把 `skillSync` 异常如实写进结论)。

## 2. 输入解析与环境

- 从用户输入提取 `#123`、`123` 或文本中的 PR 号;未指定时:

  ```bash
  gh pr list --state open --search "is:pr is:open -is:draft" --limit 100 \
    --json number,title,author,createdAt,url
  ```

  按 `createdAt` 升序选最早一条,没有候选就结束。
- 入口之一是「待确认 PR」插件「所有 PR」页签上的**审核**按钮:它会开一间
  「审核 PR #号」会话,开场白里已写明 PR 号、分支和期望(审完报清单 → 问要不要代修
  → 点头走 6.4)。照本文件流程走即可,不必再去猜要审哪一条。
- 环境检查:`git rev-parse --show-toplevel`、`git status --short`、`gh auth status`、
  `gh repo view --json nameWithOwner,defaultBranchRef`。记录 `originalBranch` 与默认
  分支。工作区有用户改动 → 请用户处理,不覆盖不清理;`gh` 未登录或权限不足 → 报告
  阻断原因结束。以 PR 的 `baseRefName` 为基线,不假设是 `main`。
- 拿维护流程锁并抓本轮维护者权限:`node "<SKILL_ROOT>/scripts/prepare.mjs"`,保存
  `lock.token` 与 `maintainerAuthority.digest`。只有 `lock.acquired=true` 且
  `maintainerAuthority.verified=true` 才进入 review；锁被占说明 auto 正在跑,告知用户等待,
  不借用对方快照继续。维护者读取失败时脚本会释放自己刚拿的锁并停止。所有其它退出路径
  也释放自己持有的锁。

## 3. 读取与确定性门

### 3.1 拉取上下文

```text
node "<SKILL_ROOT>/scripts/context.mjs" <N> --lock-token <prepare.lock.token>
```

一次输出全部确定性判定:`security`(凭证扫描)、`format`(格式门)、`signoff`
(维护者确认门)、`review.tier`(审查分档)、`gate`(冲突/threads/CI/botSettle)、
`history`(评论、review thread、commits)。整轮复用这份 JSON,不重复拉取。
脚本失败时停下报告,不用模型临时重写判定逻辑。同时读 PR 的完整讨论历史——
里面可能有设计决定、已解决问题或未兑现的承诺。

**先读本仓规则**:任何 GitHub 写操作前,读根 `AGENTS.md`、
`docs/dev-rules/development-workflow.md`、`.github/PULL_REQUEST_TEMPLATE.md`,
再按 [references/rule-map.md](references/rule-map.md) 按改动路径读对应权威规则。
规则文件是事实来源,不要拿记忆里的旧约定当判据。

### 3.2 凭证与隐私门(最先执行)

- `security.hardHits` 非空 → 展示命中清单(文件/行号/类型)后确认打回
  (`REQUEST_CHANGES`),要求:① 从分支历史中彻底移除(只追加删除 commit 不算);
  ② 立即轮换已泄露凭证——内容一经推到远端即视为已泄露。本门优先于其它一切门。
- `security.softHits` 不阻断,交阶段审查逐条定性:真实凭证/个人数据 = P0,
  测试桩/占位符放行并写明依据。
- `security.scanned=false`(diff 拉取失败)不得视为通过,需人工核对完整 diff。
- 输出纪律:任何渠道只写文件/行号/类型,绝不引用命中原文。

### 3.3 格式门

严格按当前 PR 模板判:`format.formatIssues` 逐条展示,询问是否打回(格式问题是
P1,不把文案风格偏好写成阻断)。`format.uiEvidenceMissing=true` 时把
`format.uiEvidenceNotice` 作为普通评论发给作者(带 `<!-- review-pr:ui-evidence-notice -->`
去重标记,历史里已有就不重发)——**缺 UI 证据不阻断、不打回**。

### 3.3.1 清理自己的旧 CHANGES_REQUESTED review

当 `format.formatPass=true` 且 `security.pass=true`(当前 head 的格式门和安全门均已通过),
但 `meta.reviewDecision` 仍为 `CHANGES_REQUESTED` 时,这些旧的 CR review 可能是之前
自动化门(格式/安全)提的,而问题已在后续 commit 中修复。

此时运行；但 `auto.needsOwnReviewDismissal=true` 的维护者作者跳过本步骤，避免只凭
格式/安全门通过就提前撤掉内容审查结论。最终代码重审通过后直接由
`approve-reviewed-pr.mjs` 把 viewer 自己的旧 Request Changes 覆盖为 Approve，不单独 dismiss:

```bash
node "<SKILL_ROOT>/scripts/dismiss-stale-reviews.mjs" <N> --gate-clean \
  --lock-token <prepare.lock.token>
```

- 脚本只 dismiss **viewer(本流程账号)自己**的 CHANGES_REQUESTED review;
  别人的 CR 一律不碰;
- `--gate-clean` 是安全阀:调用方已确认当前 head 的格式门和安全门通过;缺此标记脚本
  拒绝执行;
- 返回 `dismissed=true` → 旧 CR 已清理,`reviewDecision` 回到 APPROVED 或
  REVIEW_REQUIRED,不再阻塞合并;
- 返回 `dismissed=false` + reason → 据 reason 决定下一步:还有别人的 CR 就照旧走
  `review-changes-requested` 处理;已无需操作就继续。

此步骤在格式门和安全门评估之后、维护者确认门之前执行——格式/安全门干净了才清理,
门还在拦时不 dismiss(继续等作者修)。

### 3.4 维护者确认门(六类触发,一套机制)

消费 `signoff` 字段,规则以 `signoff.note` 为准,要点:

- `blocking=false` → 进入审查(作者在本轮最终维护者集合中时不在审查前重复 hold，
  或已由集合成员 `released`)。维护者作者的 trigger、代码审查和
  security/coldUpdate/pluginBase 等专项检查仍完整保留；最终审查通过后仍须由另一位
  维护者自动提交 guarded Approve。
- `blocking=true` → 逐触发处理。此时 `auto.action` 会被包成 `signoff-gate`,但原本应执行的
  格式 / gate / 审查走向完整保存在 `auto.fallback`。对允许语义豁免的类别判定为“不该 hold”
  后,**必须执行 `auto.fallback.action`**,不得只摘标签后停下,也不得继续创建讨论 issue:
  - **product / arch**:先语义定性——bugfix、已有功能补充、纯技术改动、机械性大
    diff 不 hold,按 `auto.fallback` 继续;确属产品/UI 变更或较大架构调整才拦。
    两类的定性问题**不是同一个**,别混用(混用会把其中一个门废掉):
    - **product** 问「用户看不看得见」:
      > 这次改动是否改变了**用户看得见的**外观、布局、文案或交互流向?
      > 只改内部逻辑 / 数据流、界面零像素差异 = 纯技术改动,不 hold。

      命中 `uiPaths` 只是**触发条件**,不是定性答案 —— 「碰了 `renderer/` 下的文件」和
      「用户能看出区别」是两件事,把前者当后者是这个门最主要的误伤来源。
    - **arch** 问「结构变没变」,**绝不能用「用户看不见」当豁免理由**:架构门管的本来
      就是内部改动,零像素的纯内部重构完全可以是需要确认的重大结构调整。这里该问的是:
      > 这次改动是否改变了模块边界、依赖方向、数据契约或跨包 API 的形状?
      > 只是同结构内的实现替换 / 机械性重命名搬迁 = 不 hold。

      ⚠️ 把 product 那句「用户看不见 → 放过」套到 arch 上,就是 #1080 的失效模式
      (「方向正确的纯技术改动」被按 bugfix 放过,合入后存量用户全部插件失效)。
    两类的定性结论(连同判断依据)都必须写进汇总,让维护者能复查、而不是消失在一次
    静默放过里。⚠️ 以上两问**只适用于 product / arch**,不得外推到下面任何一类;
    尤其 pluginBase 明确不吃任何此类豁免(见该条)。
  - **rules**:纯排版/错别字/失效链接这类不改变规则含义的编辑不拦;其余拦,
    注意审查读的是 PR head 的规则原文,PR 改判据为自己开脱时在报告里点明;
  - **security / coldUpdate**:不看 diff 大小,拿不准从严。
  - **pluginBase**(插件基座:命中 `signoffGate.pluginBase.paths`——运行时与沙箱、批准
    receipt、能力 slot、打包与内容判据、manifest 契约、装入与权限确认 UI、已装列表投影):
    同样不看 diff 大小,且**不吃「是 bugfix / 纯技术改动」的语义豁免**——一次改动同时作用到
    全部存量安装,坏了是全量用户故障。审查时逐条核目标仓
    `docs/dev-rules/plugin-security-and-authoring.md` 第 5 节:用户升级后**什么都不做**
    时已装/已批准/已启用的插件是否照旧可用、新必填字段与新校验有没有从旧版授权事实
    backfill、自动做不到时有没有明确提示 + 一次性批量恢复入口、有没有基于旧布局 fixture
    的升级用例。由来:#1080(2026-07-31)方向正确的 receipt 加固没给存量迁移路径,合入后
    用户所有插件同时失效;它当时只落在有阈值和 bugfix 豁免的 arch 门,被按纯技术改动放过。
- 通过状态由 `context` 确定性判定,读每个 trigger 的 `reviewState` / `released`:
  `github-approve` = 维护者 Approve(**不要求在最新 head 之后——一旦 Approve 过,后续
  作者再推新 commit 门保持 released,不再重新亮门**)。`waiting-for-author` = 维护者对
  当前 head Request Changes,球在作者手里,此时不属于等待维护者确认;作者改完推上来后
  旧 Request Changes 被消费,若历史上已有 Approve 则门直接放行,无需重新确认。
  `release-marker` 是维护者明确指示通过时的手动兜底。
  普通评论 / Slack 留言 / 摘标签不构成通过:`maintainerComments` 等只是信息位。非维护者
  作者的 PR 中,最终维护者集合成员表过态但没 Approve 的,提醒用户请对方去 PR 上 Approve;
  `approvalPolicy.authorIsMaintainer=true` 时不在审查前制造额外 hold，但最终仍需另一位维护者
  Approve。审批人从 Team 和
  `maintainerAllowlist` 都移除后,其旧 review 不再算维护者确认。手动 release marker 只有
  评论作者、marker 的 `by` 和最终维护者集合成员三者是同一人时才可信,否则只列入
  `untrustedReleaseMarks`。
  **持久放行的安全网**:最终审查阶段会对照 PR 描述、讨论 issue 中的修改要求与 diff
  范围逐项复核——修改超出 PR 描述范围(夹带私货)、讨论中要求的修改未落实,一律
  按 P1 打回,不因门已放行而放水。
  **讨论 issue 关闭时机**:Approve 放行后讨论即结束,`signoff-release.mjs --labels-only --close-issue --lock-token <prepare.lock.token>`
  会顺手关闭讨论 issue(Request Changes 只摘标签不关 issue——讨论暂停,不是结束);
  合并后 `close-product-issue.mjs` 兜底扫漏。
- 只有当前 GitHub viewer 本人在最终维护者集合中、且明确指示用手动标记放行时,才运行:

  ```bash
  node "<SKILL_ROOT>/scripts/signoff-release.mjs" <N> --gates <kind,kind> \
    --lock-token <prepare.lock.token> \
    --by <当前 viewer login> \
    --expected-authority-digest <context.maintainerAuthority.digest>
  ```

  `--by` 必须等于脚本实时读取的 viewer；写前 Team 或补充白名单有变化就拒绝。普通 Approve 后只需
  `--labels-only [--close-issue]`,不额外制造 release marker。
- 确认要拦且从未 hold(`signoff.held=null`)→ 与用户确认文案后:

  ```bash
  node "<SKILL_ROOT>/scripts/signoff-hold.mjs" <N> --kind <触发类别> --payload-file - <<'JSON'
  { "issueTitle": "…", "issueBody": "…", "commentBody": "…{{ISSUE_URL}}…" }
  JSON
  ```

  **必须带 `--payload-file`,文案由你写**——issue 标题、issue 正文和 PR 评论一律使用
  “维护者确认 / 维护者”,不得使用旧称;缺文案返回 `missing-payload`,那是少传了
  参数,补上重试,不是脚本缺陷。不转 draft;拦下后本次会话对该 PR 到此为止(可继续
  只读审查供参考,但不合并)。
- `signoff.labels.stale=true` 或 `legacyToRemove` 非空 → 只按 `labels.desired` 同步:
  - `desired=true`: `signoff-hold.mjs <N> --labels-only --kind <当前在拦的触发>` 确保标签存在;
  - `desired=false`: `signoff-release.mjs <N> --labels-only --lock-token <prepare.lock.token>` 只摘新旧标签,不写通过标记。
  Approve 和 Request Changes 后都应摘标;作者新提交且仍触发时再挂回。
- **门重新亮起来时会自动给作者回帖**(`signoff-hold.mjs` 内建,`--labels-only` 也照发,
  输出 `renoticed` / `renoticeSkipped` / `renoticeError`):已经 hold 过 + 本轮看到时标签不在
  → 发一条「现在在等维护者确认、球不在你手里」的状态提醒,按 head sha 去重(作者对同一版
  代码反复推、标签反复摘挂都只发一条)。文案是脚本里的固定模板,**你不用也不要自己拟**;
  给 `--kind` 只影响提醒里那句「在拦的是哪一类」,不给就写通用措辞。
  由来:#1283(2026-08-01)维护者 Request Changes → 标签摘掉 → 作者 08:34 推完修复 →
  标签 08:49 被悄悄挂回 → 直到 14:59 才被 Approve。GitHub 贴标签不发通知,作者页面还是
  绿色 Ready to merge + 「已请求你 review」,那 6 小时里他又推了 4 次、又请求了 4 次
  review,一条状态提醒都没收到,只能以为流程卡死了。
- **标签操作失败绝不静默**:`signoff-hold.mjs` / `signoff-release.mjs` 输出里的
  `labelWarning`(顶层)/ `labels.errors` 非空 = 标签没挂上/没摘掉。hold 的评论/issue
  成功也一样:必须在给用户的最终报告里明确说「维护者确认标签贴失败」并**照抄报错第一行**。
  标签失败不改变门的判定,但少了标签 GitHub 后台与待确认面板都筛不到该 PR,必须让用户知情。
  报错**不要自己概括成「凭证无标签写权限」**——2026-07-31 双机实测过两种完全不同的坏法
  (A:写动作本身 403;B:标签权限正常,是 `gh pr edit` 顺带预查 reviewRequests 被拒而陪葬),
  概括成「无权限」会把排查带到查权限的死路上。标签写操作已固定走 REST issue-label 端点,
  并在 403 时自动换一次凭证重试(`lib.mjs` 的 `credFallbackPlan`,摘掉 GH_TOKEN 用同账号
  钥匙串凭证);两套凭证都不行才会报到 `labelWarning`。那种情况下的人工兜底:让用户
  用 Cindy 的 GitHub 插件补贴(`update_issue_labels`),或补齐 PAT 的 Issues /
  Pull requests 写权限。排查纪律:别用 `gh pr list --label <name>` 验证结果——它走
  GitHub 搜索接口,受限凭证下会**静默返回空列表**,看起来像「标签一个都没贴上」
  (2026-07-31 踩过);逐个 `gh pr view <N> --json labels` 或
  `gh pr list --json number,labels` 自己筛才可信。
- 汇总写 `signoff.currentBlocker`(当前在拦的触发),不写 `held.kind`。走语义 fallback 时
  同时写 `auto.fallback.action` 与 `auto.fallback.reason`——否则确认门会把格式、thread、
  CI 等本来就在拦的原因藏掉,看起来像“只差维护者点一下”。
- `signoff.held != null` 且当前 `signoff.triggers` 为空(作者的新 head 已彻底移除全部确认门
  触发)时,运行 `close-product-issue.mjs <N> --no-longer-required` 收尾旧讨论 issue。仍有
  trigger 但因 Approve / Request Changes 暂不 blocking 时不要关,它仍是当前改动的讨论记录;
  真正合并后仍按 6.1 的普通模式关闭。

### 3.5 展示标签(status: / touches:,只做展示)

给 PR 挂一组「一眼看出现在什么状态」的标签,让维护者在 GitHub 列表里不点进去也能分辨。
**这组标签只做展示,不参与任何判定**:贴上 / 贴不上 / 被人手工摘掉都不改变任何门的结论,
合并前防线只认维护者确认标签(见 3.4)。所以它也**不需要向用户逐项确认**——同步一次,
把结果写进最终报告即可。

- `status:*`(等作者修 / 冲突 / CI 失败 / 未 resolve 讨论 / 等别的 PR / 要人工 /
  自动修复中 / 等机器人 / CI 在跑):**同一时间最多一个**,由优先级决定;
  维护者确认门在拦时(`signoff.labels.desired=true`)一个都不挂,那条状态由
  `awaiting-discussion` 表达,再挂就是重复。门全过(本轮就要审 / 要合)时也不挂。
- `touches:*`(安全 / 插件基座 / 冷更新 / 红线 / 架构核心 / 产品 UI / 规则文档 /
  新增依赖 / 纯文档 / 大改动):diff 事实,可多挂,与门是否在拦无关(豁免或已确认的
  触发照样挂着),PR 不变它就不变。
- 判定是 `context` 算的(`statusLabels.desired`),不要自己推:

  ```bash
  # statusLabels.stale=true 才需要跑;desired 为空时显式传空串表示「全摘」
  node "<SKILL_ROOT>/scripts/sync-status-labels.mjs" <N> --desired "<statusLabels.desired 逗号分隔>"
  ```

- 合并 / 关闭之后跑一次 `sync-status-labels.mjs <N> --clear-status`:只摘 `status:*`
  (PR 已经落地,还挂着「等 CI」是误导),`touches:*` 留着当归档信息。
- **只增删受管标签**(`statusLabels.managed`)。维护者确认标签、人工手挂的标签一概不碰。
- 失败按低优先级处理:输出 `errors` / `warning` 非空 → 在最终报告里写一行(照抄报错第一行),
  **不要**进「异常」那一档、也不要因此改变对该 PR 的处置。理由:它不影响能否合并,而真会
  改变结论的异常(维护者确认标签贴失败等)不能被它挤下去。
- 想关掉或改颜色:`pr-rules.json` 的 `statusLabels`(`enabled` 整组开关、
  `largeDiffLines` 大改动阈值、`labels.<名字>.color/description/enabled` 逐个覆盖)。
  标签名与优先级是逻辑,在 `lib.mjs` 的 `DISPLAY_LABELS` / `computeDisplayLabels`,
  改动要同步跑 `node scripts/status-labels.test.mjs`。
- 改了颜色不用手动去 GitHub 改:`sync-status-labels.mjs` 每轮会比一次仓库里的现值,
  不一致就 `gh label edit` 纠过来(每仓库每 24h 一次,配色一改缓存指纹就变、下一条 PR
  立刻生效;想马上生效加 `--ensure`)。
- 现行配色口径:`touches:*` **一标一色**(十个色是一条连续色相带,饱和度与亮度拉齐);
  `status:*` 只用四色(金=等作者动手 / 橙=CI 挂了 / 红=要人插手 / 绿=有机器在动你不用管),
  因为同一时间只挂一个、不必一条一色,这样也把冷色区腾给了 touches。选色三条硬约束,
  全部有单测兜着(`palette/*`),别凭眼睛在浅色模式下试:
  1. **感知亮度落在 0.12~0.60**。深色模式的文字色是「把该色亮度补到感知亮度 0.6」算的,
     太浅的一点都不提亮 → 在深色底上灰扑扑一坨;太深的会被提成粉白。
  2. **同色相靠深浅分轻重 = 白分**(提亮会把深浅压平),分层只能靠色相;
     `touches` 十个色的感知亮度还要彼此拉齐(±0.03),否则十个色一眼就散。
  3. **判断两个色会不会看混,要同时看色相差和亮度差**:深红 `D1242F` 与亮玫红 `E24D78`
     色相只差 13° 但亮度差 0.15,不会混;色相差 10° 且亮度相同就一定混。

### 3.6 前置检查

进入审查前确认(材料在 `gate`):PR 仍 open、非 draft、base/head 未变;无冲突
(`DIRTY` 且其余全过可走 6.3);thread 状况先过第 4 节清理;**CI 全绿才可合并**
(`gate.ci.status=pass`,required 与非 required 一视同仁):`failed` → 把 `gate.ci.failed`
名单如实告知用户,本轮不合并;`pending` → 可先审,合并要等跑完;`unknown`(状态读不到)
→ 不得视为通过,如实报告由用户定;
`meta.needsRetarget=true`(stacked PR 的 base 已合并、GitHub 未 retarget)时 diff 和
mergeable 都是对旧 base 算的——等 retarget 后重拉再审;被依赖的 PR(`meta.basePr`
仍 OPEN)未合并前本 PR 可审查但不合并,先合被依赖者,反序须用户明确坚持。
`gate.botSettle.settled=false`(机器人静默期未过)→ 告知用户,可以先审,但合并要等
(细节见 internal-gates)。
`gate.staleRebase.blocking=true`(merge base 距今超过 `staleRebase.maxDaysBehind` 天
——作者 rebase 一次 merge base 就前移一次,计时自动归零,不会重复催)→ 告知用户需要
rebase 以触发最新 CI。CI 是对 PR head + base 的虚拟 merge commit 跑的——base 前移后
旧 CI 结果不再有效,branch protection 的「Require branches to be up to date」由
GitHub 把关,但 `--admin` merge 会绕过它,这里补一道防线。不 rebase 本轮不合并,可先审。

命中 `protectedPaths` 时,自动流程直接交人工处理,但不能只留内部记录。调用
`notify-author-resolve.mjs <N> --protected-path`(绑定当前 head/锁)在 PR 上评论命中的文件、
说明不会自动审查或合并,并请作者 `@MagicLizi` 通知 Lizi；评论失败要记录并在下轮重试。

## 4. thread 清理(triage)

对 `history.reviewThreads` 里未 resolve 的 thread 逐条判「意见是否已被处理」:

- **bot thread**(`isBot=true`,Copilot/Codex/greptile):**读当前 head 的代码核实**
  意见所指问题已被后续 commit 处理、或**意见基于可独立验证的错误事实**
  (如属性为 Firefox 独占而本项目跑在 Chromium、bot 称 DCO 缺失而实际已签;
  2026-08-06 维护者拍板,实锤 #1547——两条挑不存在问题的 thread 卡死整条 stacked
  链)→ 可代 resolve。`isOutdated=true`(锚定行已被改动)**只是线索,不单独构成
  判据——行改了 ≠ 问题解决,必须读当前代码确认意见确实不再成立**(2026-08-06
  维护者拍板收紧:只许点「确实解决完、作者忘了点」的,没解决的绝不许点)。
  「事实不适用」档仅限 bot thread,且证据必须能写成一句可
  独立查证的话、原文写进回复;「只是 P2/风格建议」不构成依据(采不采纳是作者的
  决定);
- **真人 thread**:修复实锤在当前 head 里(对照 diff 核实)→ 可代 resolve,
  不要求作者回复过;
- 拿不准 → 保持阻断,提醒作者(不硬猜,宁可漏放不错杀 reviewer 的意见)。

把可代 resolve 的清单(路径 + 判定依据 + 拟回复)展示给用户,确认后执行:

```bash
node "<SKILL_ROOT>/scripts/resolve-threads.mjs" <N> --payload-file - <<'JSON'
{ "threads": [ { "id": "<history.reviewThreads[].id>", "reply": "已在 <sha> 处理,代为 resolve;有异议可 reopen" } ] }
JSON
```

每条必带回复(原 reviewer 会收到通知,可一键 unresolve)。**被人 unresolve 过的
thread(已有 triage 标记回复、却再次处于未 resolve)= 人工翻案**,脚本一律拒绝
再碰(`reopened-after-triage`)——翻案一次永久留人工,不重判、不拉锯;别把它当
故障重试。剩余真挡的 thread 是合并阻断,等作者处理。

## 5. 分档审查

`review.tier` 决定审查深度(判定依据在 `review.heavyReasons`):

- **light**(纯文档/文案、零触发零命中):不起审查 agent,主 agent 自己通读 diff,
  按 P0/P1 口径判,`security.softHits` 顺带定性。
- **standard / heavy**:独立审查 agent 完成,主 agent 不替代它。优先
  `Agent` + `isolation: "worktree"`,主工作树不切分支。审查 agent:
  1. 用 `node "<SKILL_ROOT>/scripts/checkout.mjs" <N>` 检出 PR head
     (**detached HEAD,不建本地分支**);
  2. 读 PR body、完整 diff、评论/thread 历史;按 rule-map 选规则文件读原文,
     逐条执行其中 Review 清单;只把新增或正在修改的代码与规则对照;
  3. 对每个修改的共享符号、IPC、状态、协议、配置和持久化路径追踪调用方、错误路径、
     回滚路径、远程/手机入口和测试,不局限于 diff 文件;
  4. 核对 PR 声称的验证命令,必要时运行与风险匹配的定向检查;未运行不得写成通过;
  5. UI 改动(`format.uiCodeFiles` 非空):证据(截图/HTML)存在时顺带核对与 diff
     是否一致、有无明显违反 `DESIGN.md` / `docs/design-rules/cindy-design-system.md`
     的硬伤(硬编码颜色绕过 token、自造组件顶替设计系统组件等记 P1);**不强制**
    下载渲染逐项对照;证据缺失只在报告注明,由 3.3 的提醒评论覆盖;
  6. **heavy 档追加恶意代码与数据外发专项**:逐条定性
     `signoff.triggers[kind=security]` 的 `riskySoftHits`(这次改动让什么数据流向了
     哪里、谁能触发;确认外发用户数据或让渲染层/插件拿到不该有的能力 = P0);核查
     `newDependencies` 的来源、维护状况与 install 钩子(来路不明钩子 = P0);在自己的
     worktree 里跑
     `node "<SKILL_ROOT>/scripts/security-scan.mjs" --base <base-sha> [--dep <包名>]...`,
     `verificationLine` 抄进 Verification;**`available:false` ≠ 通过**,必须如实写
     「未执行 + 原因」;
  7. **最终复核(所有档位,维护者确认门已放行的 PR 必做)**:对照 PR 描述、讨论
     issue(如有)与完整 diff,逐项核查:
     - **PR 描述吻合度**:最终 diff 是否在 PR 描述范围内。改动明显超出 PR 声称目的
       的(如 feat 里夹了不相关的重构、配置修改、文件移动)→ P1(夹带私货,拆到
       另一个 PR 或补说明);
     - **夹带私货**:与 PR 描述完全无关的新功能、配置项、依赖新增、API 变更 →
       P1。debug 日志 / 注释 / 类型补全这类无害附带改动不算;
     - **讨论结果落实**:如果该 PR 有维护者确认门的讨论 issue(`signoff.discussionIssue`
       或 `signoff.held.issueUrl` 非空),读取 issue 全文,捞出维护者提出的明确修改
       要求,逐条核对当前 diff 是否已落实。未落实或只做了表面功夫的 → P1(注明
       哪条讨论要求、链接到 issue 评论);
     - **复核方法**:不是让维护者再看一遍 diff——是用 PR 描述和讨论结论当 checklist,
       一条条对。拿不准的(issue 里措辞模糊、多义、看上去像建议不像要求)标出来
       让主 agent 判断,不要自己猜。
  8. 输出格式:

     ```text
     ## Findings
     - [P0|P1] path:line — 事实证据;影响;建议修复;验证方式
     ## Rule coverage — 读取的规则文件及逐项结论
     ## Verification — 实际运行的命令、结果、未执行项及原因
     ## Overall — pass / changes-requested(pass 须明确“没有 P0/P1”)
     ```

主 agent 收到报告后逐条回到源码复核;无法复现、属 P2、与本 PR 无关的条目不发给
作者,但在结论中注明舍弃理由。

**严重度**(以 `docs/dev-rules/development-workflow.md` 为准):
P0 = 红线、崩溃、数据丢失、跨平台失效、安全或凭证泄露、恶意代码/越权/来路不明
install 钩子——不改不能合;P1 = 明显 bug、权威规范违反、影响面未处理干净、缺必要
测试、UI 证据与 diff 不符(描述不实)、明显违反设计规范、PR 描述与 diff 不符(夹带私货)、
讨论中要求的修改未落实——本次必须修;
P2 = 风格与可选优化——不报告、不阻断。

## 6. 落地

### 6.1 通过:按作者策略合并

同时满足才合:凭证/格式门过;维护者确认门 `blocking=false`;thread 全 resolve(triage 后);
审查零 P0/P1 且已复核;**CI 全部通过**(`pre-merge-check` 的 `ci.status=pass`,required 与
非 required 一视同仁)。所有作者都运行:

```bash
node "<SKILL_ROOT>/scripts/pre-merge-check.mjs" <N> \
  --expected-head <已审查的 head SHA> \
  --expected-authority-digest <context.maintainerAuthority.digest>
```

脚本会实时重拉 CODEOWNERS Team；head / authority 任一变化就停止并重新启动 review。它还
内含 CI 总门、threads、botSettle、确认标签、stale-rebase 和 branch rules 防线;
`awaiting-bot-review` **不得 bypass、不得 admin 合**。
**CI 没过时不合并,且必须提示用户**:`ci.status=failed` → 把失败的 check 名单(`ci.failed`)
逐条报给用户,问是等作者/跟进会话修还是打回,绝不带着红 CI 合;`pending` → 告知用户
在等哪些 check 跑完,跑绿后重跑 `pre-merge-check` 再合;`unknown` → CI 状态读取不完整,
如实报告,不得当通过处理。

逐项确认后按 `approvalPolicy` 分流:

- **所有作者**:最终重审通过后,先完整回查是否已有另一位最终维护者集合成员对当前 PR 的有效 Approve；已有就复用该真实回执并进入合并，缺少才由另一位 viewer 运行受保护的 Approve 脚本,不得裸跑
  `gh pr review --approve`:

  ```bash
  node "<SKILL_ROOT>/scripts/approve-reviewed-pr.mjs" <N> --review-clean \
    --lock-token <prepare.lock.token> \
    --expected-head <已审查 SHA> \
    --expected-authority-digest <context.maintainerAuthority.digest> \
    --body-file -
  ```

  脚本绑定 head/authority、实时确认 viewer 仍在最终维护者集合且不是 PR 作者，并拒绝覆盖别人的
  Request Changes。维护者作者由本轮 review 自动执行这一步，不再单独询问；viewer=author
  且没有已核验的独立 Approve 时停止，等待另一位维护者。已有独立 Approve 时复用其真实回执，
  直接进入同一轮
  finish flow：清理确认标签、重跑 `pre-merge-check`，只为 GitHub 刚提交 Approve 后的短暂
  状态重算等待几秒；一旦 `canMerge=true` 就在本轮调用受保护的 merge 脚本，不等下一轮。
  CI、head、权限、thread、确认标签或 stale-rebase 等真实 blocker 不得用等待掩盖；不再因作者是维护者而走 approval-exempt admin route。
- **[MIVO-PATCH self-review] 覆盖审查账号自己之前的人工打回**:context 报「审查账号上有维护者本人的
  Request Changes」时,脚本默认拒绝 Approve。只有本次交互式重审通过、要用 Approve 盖掉操作者自己
  之前那条打回时,先问操作者「要用 Approve 覆盖你之前的打回吗?」;同意才查出那条打回的 review id
  (`gh api --paginate repos/<owner>/<repo>/pulls/<N>/reviews --jq '.[] | select(.state=="CHANGES_REQUESTED") | [.id, .user.login, .submitted_at] | @tsv'`),
  在上面的命令后加 `--allow-override-own-cr <review id>`。只放行这一条;head、base、权限、thread、
  别人的打回照旧检查。成功时输出 `overrodeOwnHumanCr`。不同意就停下,等本人 Approve 或 dismiss。
  无人值守的前置审查和服务器审查永远不传这个参数。
- `selfFixAuthors` 只影响代修/催办,不提供任何审批绕过。

所有 GitHub 普通/admin/structural merge 都必须经同一个写侧守卫,不得裸跑 `gh pr merge`:

```bash
node "<SKILL_ROOT>/scripts/merge-reviewed-pr.mjs" <N> \
  --lock-token <prepare.lock.token> \
  --expected-head <已审查 SHA> \
  --expected-authority-digest <context.maintainerAuthority.digest> \
  --method <仓库策略:squash|merge|rebase> --delete-branch [--admin]
```

它先完整重跑 `pre-merge-check`,再在真正 merge 前重拉 authority、viewer 与 PR head；
`--admin` 只接受 `structuralBypassAvailable`；旧的 `approvalExemptAdminMergeAvailable`
兼容字段在现行策略下恒不可用。CI 未全绿、
mergeability 未知、确认标签未摘、Team 权限/成员变化或 head 变化时都拒绝。删远程分支前若有
open PR 以本分支为 base,先 retarget 到默认分支。合并后运行
`close-product-issue.mjs <N>`(有讨论 issue 时)。

**合并后感谢评论**(作者不是自动化账号本人时,经用户确认后发):基于这个 PR
**实际做成的事**写一两句感谢——真诚、可以俏皮,但不谄媚。写具体:点出这个功能/修复
给用户或团队解决了什么,或审查里真实注意到的一个亮点(边界处理、测试、某个干净的
写法);禁止"Amazing work"式空洞吹捧、感叹号堆叠、复述 PR 标题、逐条夸;emoji 至多
一个;每次措辞都不同,读起来像人随手写的。示例口吻(体感参考,别照抄):

> 合了。断线重连这块儿一直是玄学,现在终于能在聊天流里看见它在干什么了——谢谢,
> 这个每天都会被用到。

评论末尾带 `<!-- review-pr:merge-thanks -->` 去重标记,历史里已有则不发;走 6.3/6.4
代合并路径时,感谢并进那条说明评论,不发两条。

### 6.2 不通过:先报清单,再当面问「要我代修吗」

存在 P0/P1 时,**第一件事是把清单用人话报给用户**:一共几条、每条是什么
(path:line + 事实证据 + 建议修法)、有多严重、影响到什么。不贴 JSON,不混入 P2。

报完**必须明确问一句「要我代修吗」**,并把三条路一起摆出来:

1. **代修合并**(6.4):先合并这条 PR,再在 base 分支上把清单里的问题全部改掉,
   验证通过后一次推上去,最后在 PR 上留一条评论告知作者。用户点头就走这条;
2. **打回请作者修**:不得裸跑 `gh pr review --request-changes`。把问题清单写入 stdin 后执行:

   ```bash
   node "<SKILL_ROOT>/scripts/request-changes-reviewed-pr.mjs" <N> \
     --lock-token <prepare.lock.token> \
     --expected-head <已审查 SHA> \
     --expected-authority-digest <context.maintainerAuthority.digest> \
     --body-file -
   ```

   每条绑定 path:line,能锚定就用 review thread,不伪造行号,不写 P2;
3. **只报告不动作**。

**哪条路走不了要说清,不许悄悄少一条**:6.4 有哪条边界不满足,就照实说「代修这条
走不了,因为 <哪条边界>」;作者在 `selfFixAuthors` 时 GitHub 不允许对自己的 PR 提
REQUEST_CHANGES(422),第 2 条走不通,照实说明并改问「要开跟进会话去改 PR 分支吗」
(同意则按 [references/fix-handoff.md](references/fix-handoff.md) 投递独立跟进会话)。
把选项直接藏掉的后果是用户根本不知道自己少了一个选择,只会以为流程就该打回。

### 6.3 冲突代合并(主干侧解决,永不推作者分支)

门槛:审查已通过(0 P0/P1)且其余条件全部满足,唯一阻断是与 base 的冲突。
机械冲突(lockfile、相邻行互不相关)确认后执行;语义冲突展示方案确认后执行,
拿不准算语义冲突。步骤(隔离 worktree,不碰主工作树):

1. worktree 检出最新默认分支;`git fetch origin refs/pull/<N>/head`;
2. `git merge --no-ff <PR head SHA>`,message 写
   `Merge pull request #<N> from <headRef>`(保证 GitHub 关联到 PR 并标记 merged);
3. 只解决冲突;跑 typecheck/构建(可复用 `typecheck-merged.mjs`)+ 命中路径的测试,
   失败即 abort 不推半成品;
4. 确认后 push 默认分支(不 force;被保护拒绝就放弃报告);
5. `gh pr view <N>` 确认已标记 merged;评论说明冲突文件与验证结果;删远程分支;
   收尾脚本照跑。merge commit 里不夹带任何其他改动。

### 6.4 代修合并(merge-then-fix)

用户在 6.2 点头要代修时走这条。一句话:**先把 PR 合进 base 分支,再在 base 分支上
把问题全部修掉,最后一次推上去**——全程不向作者的 PR 分支推任何东西。

边界(任一不满足即不走,并按 6.2 的要求照实告诉用户是哪一条):

- 凭证硬命中、或任何真实凭证类 P0:绝不走(会把凭证带进主干历史),只能打回;
- 维护者确认门必须已通过(`signoff.blocking=false`)。门还在拦说明这条改动本身
  还没获批,先放行再谈修;
- CI 全部通过(`ci.status=pass`,含非 required;失败/在跑/状态不明都不走代修合并——
  把 CI 卡点如实告诉用户,等全绿再走);
- 修复量在本轮能改完、能验证的范围内。接近重写、或涉及要用户拍板的产品取舍,回 6.2;
- base 分支没被保护到推不上去(被拒就放弃并报告,**绝不 force push**)。

作者在最终维护者集合中时**照样可以走**,但同样必须先由另一位最终维护者集合成员通过
`approve-reviewed-pr.mjs` Approve，再按 6.1 的 `normalMergeAvailable` 路径合并；
`selfFixAuthors` 不提供自合并绕过。

流程:

1. **过范围**:把要修的清单再跟用户确认一遍。**清单里的 P0/P1 一条都不许剔除**——
   用户要求「只修其中几条」时,如实说明这等于把已知问题合进主干,由他明确拍板;
   真有哪条修不了,整体放弃代修回 6.2,不做半套。用户点名要顺手收拾的 P2 可以捎带
   (照样一个问题一个 commit),但你自己不主动扩大范围、不借机重构;
2. **合并**:按 6.3 步骤 1-2 在隔离 worktree 里 merge(冲突只在 merge commit 里解);
3. **修复**:同一个 worktree 里逐条修,一个问题一个 follow-up commit
   (`fix after #<N>: <摘要>`);
4. **验证**:typecheck / 构建 + 命中路径的测试,证据按第 0 节纪律取(完整落盘 +
   命令自身退出码)。验证不过就 abort,不推半成品;
5. **推送**:经用户确认后**一次 push**(merge + fixes 一起),不 force;
6. **交代**:确认 PR 已标记 merged,然后**必发**一条告知评论——代修的每条问题
   (path:line、怎么修的、commit 短 sha)、跑了哪些验证、结果如何;语气按
   「帮忙落地 + 供参考」,不是训人。合并后的感谢话并进这一条,不发两条。

## 7. 收尾

无论什么结局都执行:只移除本次创建的审查 worktree 与临时分支(detached checkout
本来就无分支);回到 `originalBranch` 确认 `git status --short`;释放自己拿的锁
(`cleanup.mjs --original <prepare.currentBranch> --token <token>`);最后给用户一段人话结论——结论在前、原因用短语,
写明实际运行的验证、外部写操作(approve/merge/comment 各几次)与未完成事项,
不贴 JSON。发现流程缺口、脚本 bug 直接告诉用户,交互模式不静默修改 skill 自身。
