# 上游转人工提交对照与对齐结论(upstream-alignment)

> 对齐对象:makecindy/cindy-lizi-skills(下称「上游」)
> 上游快照:HEAD = `7820392`(2026-08-10,本地只读副本 `/tmp/lizi-upstream`)
> 本仓基线:base = `d7ab111`
> 日期:2026-08-10
> 结论为两席审查(对抗双审 + 上游预演)核定后落笔;每条给出「移植 | 不移植 | 合并」三选一结论 + 理由。

## 总览

| # | 上游 sha | 提交 | 结论 |
|---|----------|------|------|
| 1 | `5467af8` | 维护者 Approve 后门持久放行,不再因新 commit 重新亮门 | **合并(改良)** — 收窄为门类粒度 |
| 2 | `da33085` | signoff-release 标记同样持久,同 Approve 不限当前 head | **合并(改良)** — 随 1 按门类粒度落地 |
| 3 | `fc622f5` | Approve 放行时自动关闭讨论 issue | **合并(改良)** — 补 marker 作者校验 |
| 4 | `6af6834` | 新增 stale-rebase 检测(分支落后 base 超 N 天需 rebase) | **合并(经终态)** — 判据采 `7820392` 终态 |
| 5 | `16be74a` | stale-rebase 判据改为 behind 里最早 commit 距今多久 | **合并(经终态)** — 过渡态,已被 `69ab127` 取代 |
| 6 | `69ab127` | stale-rebase 改用 merge base 日期——rebase 后自动归零 | **合并(经终态)** — 语义保留,behindBy 前置由 `7820392` 补回 |
| 7 | `7820392` | stale-rebase 补回 behind_by > 0 作为前置条件 | **合并(改良)** — 终态基线 + 补测试 + 修近似措辞 |

四项结论类别含义:

- **移植**:按上游实现原样照抄。
- **不移植**:本仓不承接该提交的内容。
- **合并(改良/经终态)**:吸收上游意图,但落地形态与本仓现状对齐 / 修正上游缺陷;四提交链标注「经终态」= 只按链条最终语义落地,不照抄中间态。

---

## 1. `5467af8` — 维护者 Approve 持久放行

**上游做了什么**:`review-pr/scripts/lib.mjs` 的 `evaluateMaintainerReview` 新增 `historicalApproval` 分支——不再要求 Approve 晚于当前 head,只要维护者 Approve 过一次,后续作者新 push 不再重新亮确认门(`released = currentApproval ?? historicalApproval ?? marker`)。上游 commit 说明自述:「维护者 Approve 即持久有效,不限当前 head」;把关移到最终审查——commit 安全网逐项列明「diff 超出 PR 声称目的 / 夹带私货 / 讨论结果未落实 → P1」,即「对照描述+讨论结果逐项复核,有问题照样拦」。同提交改 `security-patterns.test.mjs`(25 行增量)。

**本仓现状**:放行判定是「admins 名单成员对**当前 head 之后**的 GitHub Approve」(SKILL.md「放行判定(release)」节;context.mjs 的 `adminsApprovedCurrentHead` 判定)——即本仓正是上游 `5467af8` 改**之前**的语义:作者新 push 后旧的 Approve 失效,需重新 Approve。

**两席审查核定事实(本结论的最重要依据)**:上游的持久化是 **PR 全局持久,不是门类粒度**。`evaluateMaintainerReview` 的 `historicalApproval` 返回值不带 kind,而 `evalSignoffKind` 对六个门类(product/arch/security/coldUpdate/rules/pluginBase,见 `fc622f5` 的 `VALID_KINDS`)传同一组全局 reviews → **旧的 security Approve 会连带放行之后新出现的 rules 门**(GPT 审查席已用纯函数实测复现)。上游测试套件(security-patterns.test.mjs 等,逐条 check/eq 断言数百条)中没有「新门类仍拦」的反例用例——5467af8 新增的持久放行用例只断言「全局持久放行成立」方向。

**结论:合并(改良)**。持久放行语义值得移植(本仓现在要求 Approve 晚于当前 head,维护者确认后作者一 push 门就重亮,反复消耗人工);但**必须收窄为门类粒度**:持久判据按 kind 记账,一个 kind 的旧放行不得放行其他 kind。本仓 `parseSignoffReleases`(lib.mjs)已经按 kind 维护 `Map<kind, {by, at, via}>`——门类粒度的落点天然存在,禁止复刻上游「historicalApproval 不带 kind + 六门类共享全局 reviews」的全局持久形态。

---

## 2. `da33085` — signoff-release 标记同样持久

**上游做了什么**:`5467af8` 之后 5 分钟的补丁,同一函数 `evaluateMaintainerReview`:把「marker 只对它之后的当前 head 有效(`markerIsCurrent`)」改为 `historicalMarker`——signoff-release 标记与 Approve 同等持久,作者新 push 不再让标记失效(`released = currentApproval ?? historicalApproval ?? historicalMarker ?? markerRelease`)。上游 commit 说明:「signoff-release 标记也持久有效,同 Approve 不限当前 head……release-marker 同 Approve 一样,一旦写入即持久有效」。同提交只改 lib.mjs 与 security-patterns.test.mjs(2 行)。

**本仓现状**:`parseSignoffReleases` 注释明确「标记只对它之后的当前 head 有效,作者新 push 后要重新确认」——同样处于上游改前语义。本仓 signoff-release **写入**脚本未合入(见「分歧 2」),当前解析契约已按 kind 粒度存在。

**结论:合并(改良)**。与 `5467af8` 同函数、同缺陷(全局持久、不带 kind),随条目 1 一起按门类粒度落地——「该 kind 已被放行过」与「该 kind 有新触发」分开记账,旧标记只放行它声明的 gates,不连带其他门类。

---

## 3. `fc622f5` — Approve 放行时自动关闭讨论 issue

**上游做了什么**:lib.mjs 新增 `issueNumberFromUrl`(从 issue URL 解析编号,只校验属于同仓库)+ `closeDiscussIssue`(先发说明评论、再 close,失败各自上报不连坐);`signoff-release.mjs` 新增 `--close-issue` 开关——**仅 Approve 放行时**关讨论 issue(Request Changes 不关:「讨论暂停不是结束」),关失败不连坐标签/判定。上游注释(usage 头):「--close-issue:摘标同时关闭当初 signoff-hold 开的讨论 issue(仅在 Approve 放行时使用;Request Changes 不关——讨论暂停不是结束)」。上游未加任何测试。

**两席审查核定事实**:上游 `parseLastHoldMarker` 只校验 issue URL 属于同仓,**不校验 marker 评论作者 / issue 创建者** → **任意可评论者贴一个指向同仓其它 issue 的伪 marker,Approve 路径就会关错 issue**(实测伪 marker 被接受)。上游 `fc622f5` 未加任何测试。

**本仓现状**:close-issue 基础已在本仓:`issueNumberFromUrl`(lib.mjs,与上游同名函数同语义)、`decideIssueReuse`(issue 复用判定)、`shouldCloseDiscussionIssue`(收尾判定)、`close-product-issue.mjs`(产品门:PR 合并后自动关讨论 issue,marker 前缀 `<!-- review-pr:product-gate`)。本仓的 close-issue 动作绑定在「PR 合并后」,上游的绑定在「Approve 放行时」——语义不同但动作同源。`parseLastHoldMarker`(lib.mjs)同样只解析 `issue=` URL、不验作者。

**结论:合并(改良)**。close-issue 能力承接上游意图(讨论结束自动收尾,不悬空),但本仓落地**必须补 marker 作者校验**:关 issue 前校验 hold marker 评论作者是否为 admins 名单成员(流程/维护者身份),伪 marker 一律不执行 close(与「放行路径不验作者会关错 issue」的核定事实对应)。接线位置:随分歧 2 的 signoff-release 写入脚本另立 PR 一并落地——决策层已随 lz-port-persist 先行(复用 `issueNumberFromUrl` 做同仓校验;新增 `decideCloseOnRelease` 放行时关闭决策、marker 评论作者须为 admins 名单成员,与 `performIssueClose` 执行函数,刻意瘦身为只 close、不发说明评论),close 执行接线仍待该另立 PR。

---

## 4-7. stale-rebase 四提交链

四提交是同一机制的连续修正,最终语义以 `7820392` 为准。逐项列明,落地只按终态。

### 4. `6af6834` — 新增 stale-rebase 检测

**上游做了什么**:首次引入 `checkStaleRebase({behindBy, headCommittedDate, nowIso, cfg})`——分支落后 base(`behindBy > 0`)且最后一次 push(`headCommittedDate`)距今超过 `maxDaysUnpushed` 天 → blocking 要求 rebase。背景(上游注释):CI 是对 PR head+base 虚拟 merge commit 跑的,base 前移后旧 CI 失效;branch protection 的「Require branches to be up to date」由 GitHub 把关,但 `--admin merge` 会绕过它,这里补一道防线。同时改 context.mjs / pre-merge-check.mjs / notify-author-resolve.mjs / pr-rules.json。

**本仓现状**:stale-rebase 零命中(全仓无 `checkStaleRebase` / `stale-rebase` 符号);pre-merge-check.mjs 只复核 GitHub 自身的 `mergeStateStatus` / `mergeable`,没有本仓侧的「落后 base 超时」防线——`--admin merge` 绕过 up-to-date 的缺口本仓同样存在。

**结论:合并(经终态)**。机制引入点有效(防 admin 绕过),但本提交的「最后一次 push 距今」判据在 `16be74a` 即被推翻,落地时**不采本提交形态**,只作为链条起点记录。

### 5. `16be74a` — 判据改为 behind 里最早 commit 距今

**上游做了什么**:`headCommittedDate` → `earliestBehindCommitDate`(behind 里最早 commit 距今多久),配置键 `maxDaysUnpushed` → `maxDaysBehind`。理由:看「最后一次 push」会被作者小 push 刷新计时,看不透分支到底旧没旧。

**结论:合并(经终态)**。过渡态:方向(看 behind 内容的年龄)比 `6af6834` 准,但同样在 `69ab127` 被取代——「behind 里最早 commit」在 rebase 后不归零、还会重复催,是弃用该形态的直接原因。

### 6. `69ab127` — 改用 merge base 日期,rebase 后自动归零

**上游做了什么**:判据改为 `mergeBaseDate`(merge-base 的 committer date),计算 `daysSinceRebase`——PR 分支从 main 分叉的那个 commit 距今多久,作者 rebase 一次 merge base 就前移一次,计时自动归零、不重复催。**该提交同时删掉了 `behindBy` 前置**(此缺陷由 `7820392` 补回)。

**结论:合并(经终态)**。merge-base 日期是终态核心语义,保留;「去掉 behindBy」的中间态不采,前置由 `7820392` 补回。

### 7. `7820392` — 补回 behind_by > 0 前置(终态)

**上游做了什么**:`checkStaleRebase({behindBy, mergeBaseDate, nowIso, cfg})`——`behindBy <= 0` 直接不拦(「未落后 base,无需 rebase」);context.mjs 用 compare API 一次取 `{behind_by, merge_base_date}`;**compare API 失败 catch 后 fail-open 不拦**(「compare API 不可用——不拦」)。

**两席审查核定事实**:
- stale-rebase 终态判据 = `behind_by > 0` 且 merge-base 的 committer date 距今 ≥ 阈值;
- compare API 失败 **fail-open 不拦**;
- 「距上次 rebase」是**近似措辞**——读的是共同祖先 commit 的时间,不是 rebase 操作发生的时刻;
- 上游四提交**零测试**(全仓 tests 对 `checkStaleRebase` / `staleRebase` 零命中)。

**结论:合并(改良)**。`7820392` 终态判据作为移植基线(behind_by>0 前置 + merge-base committer date + compare fail-open);改良点三条:①**补测试**——上游四提交零测试是明确缺口,落地时必须带 `checkStaleRebase` 纯函数测试(behind_by=0 不拦 / 未超阈值不拦 / 超阈值拦 / 时间读不到跳过 / compare 失败 fail-open);②**修正近似措辞**——文档与配置注释写清「距上次 rebase」实为「merge-base commit 的 committer date 距今」,不是 rebase 动作时刻;③**显式化 fail-open 语义**——compare API 失败不拦是可用性优先(API 抖动不该卡死所有 PR),接受,但必须在 pr-rules.json 说明里写明,不得让后人误读为「必有数据」。

---

## 两个分歧的结论

### 分歧 1:年龄门(本仓 10min 反对窗口)vs 翻案保护(上游 reopened 永久留人工)

**结论:两者并存,不二选一。** 它们防的是不同的洞:

| | 防的洞 | 机制 | 双方现状 |
|---|---|---|---|
| 年龄门 | **事前抢跑**:auto-resolve 太快,人没有机会反对 | 本仓 `MIN_MARKER_AGE_MS` 默认 10 分钟反对窗口(从评论 createdAt 起算),年龄门关闭时执行层大声输出豁免声明 | 本仓已有 |
| 翻案保护 | **事后翻案**:已收敛的线程被 reopen 后反复拉锯 | `skipped-reopened-after-triage` —— 己方 marker 已 resolved 但线程又变 unresolved → 人工翻案,**永久留人工**,不与人拉锯 | 本仓已有(与上游 `3bd19dd` 同款) |

移植 `5467af8` / `da33085` 的持久放行**不削弱**这两者:持久放行放宽的是「Approve 何时生效」(门类粒度),年龄门管的是「自动 resolve 前留足反对时间」,翻案保护管的是「reopen 后不再自动重试」——三条线正交。本仓两者均已落地,维持现状即为正确结论。

### 分歧 2:signoff-release.mjs(上游活跃维护 vs 本仓已移出本批)

**结论:不移植(本批),维持本仓既定「另立 PR 并带测试」安排;fc622f5 的 close-issue 能力以改良形态并入该另立 PR。**

- 上游侧:signoff-release.mjs 约 156 行,仍处活跃演进中(`fc622f5` 还在扩 `--close-issue` 与 issue 生命周期),形态未稳,现在照抄会在下一次上游演进后立刻过时;
- 本仓侧:signoff-hold.mjs 已移植(2026-08-09,含 issue 复用/收尾/renotice/排他锁),signoff-release **写入**脚本零测试、已从本批移出、另立 PR 并带测试(lib.mjs 该段注释白纸黑字);放行语义当前由「admins 对当前 head 之后 Approve」承担,不依赖写入脚本即可运转;
- 落地路径:①本批只保留解析契约(`parseSignoffReleases` 按 kind,已是现状);②`5467af8` / `da33085` 的持久化语义按门类粒度落地(条目 1、2)时,判定层先行,写入脚本随后;③`fc622f5` 的 `--close-issue` 接线在另立 PR 中落地,并补 marker 作者校验(条目 3)。

---

## 落地要点汇总(七项 + 两分歧)

1. 持久放行按 **门类粒度** 落地:放行标记解析 + 作者校验后按 kind 记账(`parseSignoffReleaseMarkers` / `collectConfirmedSignoffKinds`,随 lz-port-persist 落地;`parseSignoffReleases` 的 kind Map 是既有解析契约,记账语义由其演进而来),旧放行只放行它声明的 gates(对应 `5467af8` / `da33085`);
2. close-issue 决策层补 **marker 作者校验**(评论作者 ∈ admins 名单成员,复用 `issueNumberFromUrl`),执行接线随 signoff-release.mjs 另立 PR(对应 `fc622f5`);
3. stale-rebase 按 `7820392` 终态移植:behind_by>0 前置 + merge-base committer date ≥ 阈值 + compare fail-open,必带测试、修正「距上次 rebase」近似措辞(对应 `6af6834`→`7820392` 链);
4. 年龄门与翻案保护并存(本仓均已有);
5. signoff-release.mjs 本体本批不移植,另立 PR 并带测试;close-issue 能力并入该 PR。
