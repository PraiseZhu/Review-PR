#!/usr/bin/env node
// signoff-hold.mjs — 维护者确认门的拦截动作:自动创建讨论 issue → 在 PR 上发评论告知作者
// (带 issue 链接)→ 打上维护者确认标签。**不再转 draft**(旧 draft 制已废除:draft 带来的
// hold↔ready 死循环、PAT 无 convertToDraft 权限、归属判定一整族复杂度随之消失;
// 真正挡合并的是流程内部的判定,标签只是 GitHub 后台的可筛性入口——
// 通过动作是维护者在 PR 上 Approve,摘标签不构成通过)。
//
// 移植自 lizi 上游 signoff-hold.mjs(makecindy/cindy-lizi-skills,2026-08-09),
// 适配点:全部依赖函数已在 mivo 侧 lib.mjs(signoff 统一段)补齐;--kind 只影响措辞,
// 触发判定由 context.mjs 按 mivo 扁平配置(securityReviewPaths / archGate / ruleFiles)
// 输出,本脚本只做动作 + 幂等。文案(issue 标题 / issue 正文 / PR 评论)由调用方
// (主 agent 按 SKILL 要求与语气规范拟)经 --payload-file 传 JSON 进来,脚本不生成
// 任何一句对外文字;缺文案时拒绝执行主动作(reason=missing-payload,标签照打)。
//
// 状态回帖(renotice):首次 hold 的评论只发一次,但门会**反复**亮起来 —— 维护者
// Request Changes → 标签摘掉、球给作者;作者改完推上来 → 门重新亮、标签挂回去。
// 这个「挂回去」以前是完全静默的;所以本脚本在「已经 hold 过 + 本轮发现标签不在」
// 时自动补一条回帖,按 head sha 去重。判据用的是**看到时标签不在**(不是「加标签成功」)。
// 这条文案是固定模板、由脚本自己出:它不含任何语义判断,而可靠性要求它不能依赖上层
// 每轮都记得传文案。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段,让 auto 轮转能继续下一候选。
//
// 跑:node <skill-root>/scripts/signoff-hold.mjs <PR> [--payload-file <path|->]
//     [--kind <product|arch|security|coldUpdate|rules|pluginBase>] [--labels-only] [--dry-run]
//     [--no-renotice]
//   --payload-file:JSON 文案来源,`-` = stdin(推荐,避开中文/引号问题)。结构:
//     { "issueTitle": "...", "issueBody": "...", "commentBody": "...{{ISSUE_URL}}..." }
//     commentBody 里的 {{ISSUE_URL}} 会被替换成新建 issue 的链接;没写占位符则自动在
//     末尾追加一行「讨论 issue:<url>」。已存在标记评论时 payload 可省(只补打标签)。
//   --kind:当前在拦的触发类别(context 的 signoff.triggers 命中),只影响措辞。
//   --labels-only:只确保维护者确认标签挂上(并摘掉旧门类子标签),不开 issue、不发首次
//     hold 评论。用于标签状态重同步。**状态回帖照发**(见上)。
//   --no-renotice:关掉状态回帖(只给测试/特殊场景用)。
//   --dry-run:只探测(是否已拦截过 / 将做什么),不写任何外部状态——**也不获取排他锁**
//     (round2 修复:此前 dry-run 会真的写锁文件,和本行文档自称的"不写外部状态"矛盾,
//     还会跟真实执行抢锁造成饥饿)。
//
// 正确调用(`-` 走 stdin):
//   node .../signoff-hold.mjs 123 --kind security --payload-file - <<'JSON'
//   { "issueTitle": "…", "issueBody": "…", "commentBody": "…{{ISSUE_URL}}…" }
//   JSON
//
// 排他锁相关环境变量(见下方"幂等原子 claim"段):
//   SIGNOFF_HOLD_LOCK_DIR:锁文件目录,默认 stateFile('signoff-hold-locks')(按本地
//     git-common-dir 哈希隔离,见 lib.mjs repoStateKey)。
//   SIGNOFF_HOLD_LOCK_TIMEOUT_MS:抢锁轮询的超时上限,默认 15000。
// 锁超时(拿不到锁)时的输出:reason='lock-timeout' + needsIntervention:true +
//   holderPid/holderStartedAt(能读到时)——round2 前是完全静默的 {held:false},现在
//   显式标注"需要人工介入",不再悄悄交给下一轮空转。
// 其它 round2 新增输出字段:heldBlockedBy(held=false 时点名 issue/comment/labels 里
//   具体是哪项没成)、legacyLabelWarning(旧门类标签清理失败,与本轮 signoff 标签是否
//   挂上——labelWarning——是两件独立的事,不互相连坐)。

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepo, parsePR, gh, print, fail, renderIssueUrl, PRODUCT_GATE_MARKER_PREFIX, SIGNOFF_RENOTICE_MARKER_PREFIX, parseSignoffRenotices, loadRules, syncSignoffLabel, SIGNOFF_LABEL_DEFAULT, removeLegacyGateLabels, issueNumberFromUrl, decideIssueReuse, stateFile } from './lib.mjs';
// R8 拆节:锁原语本体已迁 lib.mjs,本模块只保留真依赖的显式 import(acquireHoldLock /
// releaseHoldLock 供 main/finally 使用;LOCK_STALE_MS 供预算计算)——不为测试
// re-export 生产导出面(D4 守卫测试 fixture 改 import 本模块自有符号,见测试)。
import { acquireHoldLock, releaseHoldLock, LOCK_STALE_MS } from './lib.mjs';

// 隐藏去重标记:HTML 注释,GitHub 渲染不可见,但 API 返回的 body 里查得到。
// 前缀沿用 review-pr:product-gate(lib.mjs 常量,parseLastHoldMarker 共用)——存量被 hold
// 的 PR 用的就是它。kind=arch 兼容位:非 product 触发统一带 kind=arch(历史消费方只区分这两种)。
const MARKER_PREFIX = PRODUCT_GATE_MARKER_PREFIX;
const marker = (issueUrl, kind) =>
  kind === 'product' ? `${MARKER_PREFIX} issue=${issueUrl} -->` : `${MARKER_PREFIX} kind=arch issue=${issueUrl} -->`;

const KIND_TOPICS = {
  product: '产品 / UI 变更',
  arch: '技术架构调整',
  security: '安全敏感改动',
  coldUpdate: 'mobile 冷更(runtime fingerprint 变化)',
  rules: '审查规则文档变更',
  pluginBase: '插件基座改动(影响全部已装插件)',
};

// round6 R6-1(blocker)+R6-2(major):租约不等式由构造成立,不再靠人去核算术声称。
// R4 声称「11 次 × 15s < 300s」、R5 声称「固定部分 8 次(实际 15)」都被复审实测否掉;
// 本轮的修法不是再加一个范围校验,而是把三个量耦合起来,让「预算 × 单次超时 < 租约」
// 在任意 env 取值下都恒成立:
//   ① 先定不可延后调用数 ESSENTIAL_CALLS = 6:pr view / issue view / issue create /
//      status comment / label create / label POST 各最多 1 次(调用点注释见 main)。
//      这些少了任何一次,本轮 hold 就名不副实(门声称挂了、实际没挂)——所以它们的
//      额度与可延后工作物理隔离(独立预算池 ghE),任何循环都吃不到;
//   ② 钳住单次超时:T = min(env 值, floor(0.9 × LOCK_STALE_MS / ESSENTIAL_CALLS))
//      —— 必要路径本身(ESSENTIAL_CALLS × T)一定装得进租约,env 再大也推不翻;
//   ③ 派生预算:CRITICAL_SECTION_MAX_CALLS = floor(0.9 × LOCK_STALE_MS / T) 由 T 派生,
//      floor 只会往下取整,所以 预算 × T ≤ 0.9 × 租约 < 租约 在任意 T 下恒成立;
//      0.9 留 10% 余量给进程调度 / 时钟偏差。
//   ④ T 被钳住或回落默认时输出显式警告(stderr + JSON warnings 双通道),让运行者
//      看得见生效值。
// R7-1(修正 R6 遗留):T ≤ 0 / 非数值(如 SIGNOFF_HOLD_GH_TIMEOUT_MS=abc)不再钳到
//   1ms——`Number(env)` 解析出 NaN 后 Math.max/Math.min 会把 NaN 一路带进派生预算,
//   spawnSync timeout 收到 NaN 直接崩溃(exit=1)。现在非有限数(NaN/±Infinity)/ ≤0
//   一律回落默认 15000(口径抄 resolve-threads.mjs 的 resolveMinMarkerAgeMs,见下)。
// R6-2:可延后工作(reconcile 循环 / legacy 标签清理 / renotice 回帖)共享
//   DEFERRABLE_BUDGET = 总预算 - ESSENTIAL_CALLS 的池(ghD),与必要调用互不挤占;
//   池耗尽时 budgetExhausted fail-visible(报 reconciliation.unprocessed /
//   legacyErrors),下一轮补做,合法工作不再被例行丢弃。
//   ⚠ 执行顺序上 reconcile 循环排在 issue create 之前——若共享同一池,循环吃光预算
//   会让真正的 hold(issue create)发不出去,比什么都不做更糟(门声称挂了、实际没挂);
//   双池在结构上杜绝此路径,不依赖「恰好排在后面」。
// R6-5(运行时局限,显式声明):ghT 的超时走 spawnSync 的 timeout 参数,它是 SIGTERM 式
//   超时——需要子进程真的退出才返回,所以严格实时上界还依赖 gh 不忽略 TERM(gh 正常
//   不忽略,但这不是硬实时保证,不能声称「严格 ≤ T」)。
export const ESSENTIAL_CALLS = 6;
// R7-1 env 校验:安全不变量不能悬在一个未校验的 env 旋钮上。口径抄 resolve-threads.mjs
// 的 resolveMinMarkerAgeMs——显式校验(解析失败 / 非有限 / ≤0 一律回落默认)+ 双通道
// 警告(stderr 文本 + JSON 输出顶层 warnings 数组)。三态由 GH_CALL_TIMEOUT_STATE 表达
// (none / clamped / fallback),GH_CALL_TIMEOUT_CLAMPED 布尔只认钳位、不再在 NaN 时报
// false 说谎。T 恒为 ≥1 的整数(spawnSync timeout 只收 unsigned integer,小数/NaN 会
// 越界崩溃),派生预算随 T 有限,不等式仍由 ③ 构造成立。
const GH_CALL_TIMEOUT_DEFAULT_MS = 15000;
const CLAMP_CAP_MS = Math.floor(0.9 * LOCK_STALE_MS / ESSENTIAL_CALLS);
export const GH_TIMEOUT_WARNINGS = [];
function resolveGhCallTimeoutMs() {
  const raw = process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS;
  // 空串等同未设(静默):CI 模板展开 FOO=${UNDEFINED_VAR} / 容器编排 / .env 产出的
  // 空串是「事实上没设」,不是配置错误——对它出警告是给没做错事的运维制造噪音,
  // 噪音会把真警告淹没。纯空格 ' ' 仍是 fallback+警告(那是打错,有信息量)。
  if (raw === undefined || raw === '') return { ms: GH_CALL_TIMEOUT_DEFAULT_MS, state: 'none' };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    const w = `[signoff-hold] 警告:SIGNOFF_HOLD_GH_TIMEOUT_MS=${JSON.stringify(raw)} 非法(须为正数字;非数值/0/负值会让派生预算失真),已回落默认 ${GH_CALL_TIMEOUT_DEFAULT_MS}ms`;
    GH_TIMEOUT_WARNINGS.push(w);
    process.stderr.write(`${w}\n`);
    return { ms: GH_CALL_TIMEOUT_DEFAULT_MS, state: 'fallback' };
  }
  const ms = Math.max(1, Math.floor(n));
  if (ms > CLAMP_CAP_MS) {
    const w = `[signoff-hold] SIGNOFF_HOLD_GH_TIMEOUT_MS=${n} 超过钳位上限 ${CLAMP_CAP_MS}ms,已钳为 ${CLAMP_CAP_MS}ms(保证必要路径装得进 ${LOCK_STALE_MS}ms 租约;可延后工作预算相应收窄,超出的下轮补做)。`;
    GH_TIMEOUT_WARNINGS.push(w);
    process.stderr.write(`${w}\n`);
    return { ms: CLAMP_CAP_MS, state: 'clamped' };
  }
  return { ms, state: 'none' };
}
const resolvedGhCallTimeoutMs = resolveGhCallTimeoutMs();
export const GH_CALL_TIMEOUT_MS = resolvedGhCallTimeoutMs.ms;
export const GH_CALL_TIMEOUT_STATE = resolvedGhCallTimeoutMs.state;
export const GH_CALL_TIMEOUT_CLAMPED = resolvedGhCallTimeoutMs.state === 'clamped';
export const CRITICAL_SECTION_MAX_CALLS = Math.floor(0.9 * LOCK_STALE_MS / GH_CALL_TIMEOUT_MS);
export const DEFERRABLE_BUDGET = Math.max(0, CRITICAL_SECTION_MAX_CALLS - ESSENTIAL_CALLS);
export const MAX_RECONCILE_DUPS = 3;
// 临界区 gh 调用的统一超时包装:所有临界区网络调用必须走 ghT,否则可能超出租约。
// R6-5:超时是 SIGTERM 式(见上),不是硬实时保证。
const ghT = (args, opts = {}) => gh(args, { timeoutMs: GH_CALL_TIMEOUT_MS, ...opts });
// round6 R6-1/R6-2:双预算池。ghE = 不可延后(essential,池 = ESSENTIAL_CALLS),
// ghD = 可延后(deferrable,池 = DEFERRABLE_BUDGET)。两池互不挤占:可延后循环无论
// 吃掉多少 ghD 额度,ghE 的额度纹丝不动 → 真正的 hold 永远发得出去。
// budgetExhausted:调用数超过池上限后不再发出,立即返回失败(调用方按「未完成,下一轮
// 重试」处理,报进输出,fail-visible,不静默)。
function makeBudgetedGh(inner, pool) {
  let calls = 0;
  return (args, opts = {}) => {
    if (calls >= pool) {
      return {
        ok: false, budgetExhausted: true, stdout: '', status: 1,
        stderr: 'critical-section-budget-exhausted:本轮临界区 gh 调用预算已用完,剩余动作未执行,下一轮重试',
      };
    }
    calls += 1;
    return inner(args, opts);
  };
}
const ghE = makeBudgetedGh(ghT, ESSENTIAL_CALLS);
const ghD = makeBudgetedGh(ghT, DEFERRABLE_BUDGET);


// ── issue 标题契约(2026-08-28 事故修复)──
// 下游插件仓 merge-thanks 的 issue-announce 只通报标题以「维护者确认 · PR #」开头的
// issue(维护者确认 · PR #<n> <原标题> 公式,云端侧 parseSignoffIssue 同一口径)。
// 2026-08-27 #330(PR #328)与 #353(PR #352)两轮 agent 生成的标题偏离公式,云端
// 播报脚本按合同把非前缀 issue 良性跳过(not-maintainer-confirm-issue)——hold 照常
// 落地、维护者 Slack 通报却从未发出,两层绿灯链路静默断裂。修复:开 issue 前校验
// 标题契约,违约 fail-visible 拒绝主动作(held=false + titleContractViolation,并带
// requiredPrefix 供调用方改写标题重试),不再把违约标题写进 GitHub。
export const MAINTAINER_CONFIRM_TITLE_PREFIX = '维护者确认 · PR #'

/**
 * 是否满足确认 issue 标题契约:必须是云端唯一认的规范前缀
 * 「维护者确认 · PR #<n>」且 <n> 精确等于当前 PR 号(2026-08-28 gpt 单审 P1:下游
 * isMaintainerConfirmIssue 是 startsWith 精确匹配,空格变体落地后 Slack 仍不发;
 * 错号标题会向维护者播报错误 PR)。空/非字符串 → false。供本脚本与测试共用。
 */
export function issueTitleSatisfiesContract(title, pr) {
  if (typeof title !== 'string') return false
  const m = title.match(/^维护者确认 · PR #(\d+)(?:\s|$)/)
  return m != null && Number(m[1]) === Number(pr)
}

/**
 * 负向证据探针:标题是否「疑似确认门但违约」——含对具体 PR 号的引用(#<数字>)
 * 但不满足标题契约(2026-08-28 收窄后契约需 pr 参数,探针同步接受)。用于事件后
 * 复盘审计(把 #330/#353 的实际违约形态钉成探针,回退守门时测试转红),不参与
 * 任何运行时判定。pr 未传时对合规前缀形态按粗匹配排除(仅审计用途)。
 */
export function detectLikelyConfirmTitle(title, pr) {
  const violating = pr !== undefined
    ? !issueTitleSatisfiesContract(title, pr)
    : !(typeof title === 'string' && /^维护者确认 · PR #\d+/.test(title))
  if (violating) {
    return typeof title === 'string' && /#\d+/.test(title)
  }
  return false
}

// ── 三个生产动作抽成可单测的导出函数(SC-3):均接受可注入的 ghFn(默认真实 gh),
// 测试用 fake ghFn 记调用次数/参数,不需要真的打 GitHub API。──
export function performIssueCreate({ pr, slug, kind, author, issueTitle, issueBody, ghFn = gh }) {
  const topic = KIND_TOPICS[kind];
  const footer = `\n\n---\n关联 PR:#${pr}(作者 @${author});本 issue 由 review-pr 流程自动创建,用于先讨论该 PR 涉及的${topic},维护者确认后 PR 会恢复推进。`;
  const r = ghFn(['issue', 'create', '--repo', slug, '--title', issueTitle, '--body-file', '-'], {
    input: issueBody + footer,
    allowFail: true,
  });
  const created = (r.stdout || '').trim().split('\n').pop()?.trim() ?? '';
  if (r.ok && /^https:\/\//.test(created)) {
    return { issueUrl: created, issueCreated: true, issueError: null };
  }
  return { issueUrl: null, issueCreated: false, issueError: (r.stderr || r.stdout || '').trim().slice(0, 300) };
}

export function performStatusComment({ pr, slug, kind, issueUrl, commentBody, ghFn = gh }) {
  const rendered = commentBody.includes('{{ISSUE_URL}}')
    ? renderIssueUrl(commentBody, issueUrl)
    : `${commentBody}\n\n讨论 issue:<${issueUrl}>`;
  const r = ghFn(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
    input: `${rendered}\n\n${marker(issueUrl, kind)}`,
    allowFail: true,
  });
  if (r.ok) return { commented: true, commentError: null };
  return { commented: false, commentError: (r.stderr || '').trim().slice(0, 300) };
}

export function performLabelSync({ owner, repo, pr, label, current = [], dryRun = false, ghFn = gh, legacyGhFn = null }) {
  // round6 R6-2:signoff 标签本身(label create + label POST)是不可延后调用,走 ghFn
  // (main 传 ghE);legacy 标签清理是循环、可延后,走 legacyGhFn(main 传 ghD)——两个
  // 预算池互不挤占,标签挂不上不会被 legacy 循环饿死。默认 legacyGhFn=ghFn 保持既有
  // 调用形态(测试直接传 fake)。
  const result = syncSignoffLabel({ owner, repo, pr, want: true, label, current, ghFn, dryRun });
  const legacy = removeLegacyGateLabels({ owner, repo, pr, current, ghFn: legacyGhFn ?? ghFn, dryRun });
  if (legacy.legacyRemoved.length) result.legacyRemoved = legacy.legacyRemoved;
  // round2 D5:legacy 清理失败与「本轮 signoff 标签是否挂上」是两件事,不 merge 进
  // result.errors/warning——否则 labelsOk(= !labels.warning)会被旧标签 403 之类的清理
  // 失败拖累,误判为"本轮标签没挂上"从而 held 被判 false,即便 signoff 标签其实已经
  // 成功挂上。清理失败单独走 legacyErrors/legacyWarning,不参与 held 判定。
  if (legacy.errors.length) {
    result.legacyErrors = legacy.errors;
    result.legacyWarning = `旧门类标签清理没完成:${legacy.errors[0]}`;
  }
  return result;
}

// ── held 判据(SC-2):issue/评论/标签三件套全成功才算真正拦住 ──
// issueOk / commentOk 要分「本轮需要新开一轮讨论(needIssue)」与「复用既有 open issue」
// 两种情况:复用时旧 issue+旧评论已经把作者引到当前有效讨论,不需要本轮重新创建/重新发
// 评论才算数;需要新开时(从未 hold 过,或旧 issue 已 CLOSED)必须本轮真正成功,不能拿
// "曾经 hold 过"这个陈旧事实顶替——否则旧 issue 被关闭后 gate 重新触发,held 会被误判
// 为 true,把作者晒在一个已关闭的讨论里却显示"已经拦住"。
// round4 D2:GitHub 侧对账 —— 万一仍发生双写(锁被绕过/抢占窗口),PR 上会留下多份
// hold issue,每份都会在重入时把作者引到不同的讨论里。对账规则:保留 number 最小
// (= 最早创建)的 issue,关闭其余 OPEN 的并留一条说明,把它引到保留的讨论。
// 不可逆动作的正确性不该只依赖本地文件锁 —— 锁是优化,这里才是保证;
// 每轮开始时执行,双写后下一轮自愈,而不是永久留两个 issue @ 作者两次。
// 只对可解析为本仓 issue 的 URL 动作;state 查询失败 / close 失败 → 记 errors
// (下一轮重试),不误关。dry-run 不调用(调用方保证)。
// round5 R5-1(blocker):对账是 O(重复数) 不是常数——每重复最坏 3 次 gh 调用
// (view + close + comment)。每轮最多处理 maxDups 个重复(上界由代码结构性强制),
// 超出部分进 unprocessed(数量 + URL)报出,下一轮继续,而不是把整个临界区跑穿
// LOCK_STALE_MS 租约(双实例重复不可逆写入)。
// ghFn 返回 budgetExhausted(临界区调用预算耗尽,见 main() 的 ghE/ghD)时同样进
// unprocessed——那是「预算内没做完」,不是「GitHub 查询失败」,不得混进 errors。
// round6 R6-3(major):「下一轮自愈」原来每轮取 entries.slice(1, 1+maxDups) 同一段——
// 已关闭的重复每轮重复消耗额度、后面的永远轮不到(复审实测连续四轮 open 集合不变,
// 且每轮把额度花在已关闭的重复上做零价值工作)。现在只对「当前仍 OPEN」的重复做
// 关闭动作:一次 `issue list --state open` 拿 open 集合(1 次调用),CLOSED 的重复不再
// 消耗任何 close/comment 额度(连 view 都不消耗)、也不进 unprocessed(它们不需要任何
// 后续动作);多轮收敛靠 open 集合本身推进,不引入本地持久状态(#13 同理由:tmp 易失
// + 换机器就失效)。
export function reconcileDuplicateHoldIssues({ slug, urls = [], ghFn = gh, maxDups = MAX_RECONCILE_DUPS }) {
  const entries = [...new Set((urls ?? []).filter(Boolean))]
    .map((url) => ({ url, number: issueNumberFromUrl(slug, url) }))
    .filter((e) => e.number != null);
  if (entries.length <= 1) return { keptUrl: entries[0]?.url ?? null, closed: [], errors: [], unprocessed: [] };
  entries.sort((a, b) => a.number - b.number);
  const kept = entries[0];
  const closed = [];
  const errors = [];
  const unprocessed = [];
  const ls = ghFn(['issue', 'list', '--repo', slug, '--state', 'open', '--json', 'number'], { allowFail: true });
  if (ls.budgetExhausted) {
    // 预算内没做完:一个都没关,全部交下轮(可延后工作,不影响必要路径)
    for (const dup of entries.slice(1)) unprocessed.push({ number: dup.number, url: dup.url });
    return { keptUrl: kept.url, closed, errors, unprocessed };
  }
  if (!ls.ok) {
    errors.push(`duplicate-open-state-query-failed: ${(ls.stderr || ls.stdout || '').trim().slice(0, 200)}`);
    return { keptUrl: kept.url, closed, errors, unprocessed };
  }
  let openNumbers = null;
  try {
    openNumbers = new Set((JSON.parse(ls.stdout || '[]') ?? []).map((i) => Number(i?.number)).filter((n) => Number.isFinite(n)));
  } catch { /* 非 JSON → openNumbers 保持 null,走查询失败分支 */ }
  if (openNumbers == null) {
    errors.push('duplicate-open-state-query-failed: issue list 输出无法解析,本轮未关闭任何重复(下轮重试)');
    return { keptUrl: kept.url, closed, errors, unprocessed };
  }
  const openDups = entries.slice(1).filter((d) => openNumbers.has(d.number));
  const toClose = openDups.slice(0, maxDups);
  for (const dup of openDups.slice(maxDups)) {
    unprocessed.push({ number: dup.number, url: dup.url });
  }
  for (const dup of toClose) {
    const c = ghFn(['issue', 'close', String(dup.number), '--repo', slug], { allowFail: true });
    if (c.budgetExhausted) {
      unprocessed.push({ number: dup.number, url: dup.url });
      continue;
    }
    if (!c.ok) {
      errors.push(`close-failed-${dup.number}: ${(c.stderr || c.stdout || '').trim().slice(0, 200)}`);
      continue;
    }
    const cm = ghFn(['issue', 'comment', String(dup.number), '--repo', slug, '--body',
      `此 issue 是重复创建的讨论(本 PR 已有更早的讨论 issue #${kept.number}),已自动关闭。讨论请移步 #${kept.number}。`],
    { allowFail: true });
    if (cm.budgetExhausted) {
      unprocessed.push({ number: dup.number, url: dup.url });
      continue;
    }
    if (!cm.ok) errors.push(`comment-failed-${dup.number}`);
    closed.push({ number: dup.number, url: dup.url });
  }
  return { keptUrl: kept.url, closed, errors, unprocessed };
}

export function computeHeld({ issueCreated, priorIssueUrl, needIssue, commented, alreadyHeld, labelsOk }) {
  const issueOk = issueCreated || (!needIssue && priorIssueUrl != null);
  const commentOk = commented || (!needIssue && alreadyHeld);
  const held = issueOk && commentOk && labelsOk;
  const heldBlockedBy = held ? [] : [
    ...(!issueOk ? ['issue'] : []),
    ...(!commentOk ? ['comment'] : []),
    ...(!labelsOk ? ['labels'] : []),
  ];
  return { held, heldBlockedBy };
}

// 只在直接被跑为 CLI 时执行主流程;被 import(如 signoff-policy.test.mjs 覆盖上面
// 导出的纯函数/生产动作)时不触发任何真实 gh/git 调用,否则测试进程会在 import 阶段
// 就被 parsePR/parseRepo 的失败路径(fail() → process.exit(1))直接杀掉。
// round2 D1:判定用 realpathSync 归一化后比较 argv[1] 与本模块自身路径,而不是裸字符串
// `===`——原写法在三种情况下会误判为"不是主模块"从而整个脚本什么都不做(fail-open,
// 门形同虚设):① 经 symlink 调用(本 skill 的调用惯例本就是 `node "<SKILL_ROOT>/..."`,
// 而 ~/.claude/skills 与 ~/.claude/skills/review-pr 都是 symlink);② 路径含空格;
// ③ 路径含中文字符——import.meta.url 会对空格/非 ASCII 字符做百分号编码,而
// process.argv[1] 是调用方传入的原始字面路径,两侧编码口径不一致,裸字符串比较必错。
// 模式抄自 context.mjs 的 IS_MAIN_MODULE(该文件同样的判定,已验证过三类场景)。
// realpath 只作用在 argv[1] 一侧:Node 在构造 import.meta.url 时本就会解析 symlink,
// 字面值已经是解析后的真实路径;fileURLToPath 把百分号编码解回原始字符,消除
// 空格/中文的编码不对称。
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (!isMainModule && process.argv[1]) {
  // round4 D4(blocker 修复):守卫误判必须 stdout 输出 JSON 错误 + 非零退出码,不能只写
  // stderr——round3 实测 `node --preserve-symlinks-main` 下 exit=0、零 gh 调用、stdout
  // 空,自动化消费方(按本脚本自声明的「stdout 输出 JSON」契约)会把空 stdout 当成
  // 「成功但无结果」,hold 动作从未执行却没人知道。区分两种情形:
  //   - 合法 import(argv[1] 是别的文件,如测试运行器):两侧 realpath 不一致,保持
  //     完全静默,这是正常形态;
  //   - 守卫误判(argv[1] 存在且与本模块解析到同一真实文件、字面比较却失配,链接/
  //     编码形态差异):stdout 输出 {ok:false, error} + process.exit(1),让失败可见。
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
      print({ ok: false, error: 'entry-guard-misclassified', message: `入口守卫判定失败但 argv[1] 与本模块指向同一文件(argv[1]=${process.argv[1]})——脚本将不执行任何动作,请改用直接路径调用(避免 --preserve-symlinks-main / symlink 形态)。` });
      process.exit(1);
    }
  } catch { /* 任一侧 realpath 失败则无从判断,不报警 */ }
}
if (isMainModule) {
try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const kindIdx = process.argv.indexOf('--kind');
  const kind = kindIdx >= 0 && KIND_TOPICS[process.argv[kindIdx + 1]] ? process.argv[kindIdx + 1] : 'product';
  const labelsOnly = process.argv.includes('--labels-only');
  const kindGiven = kindIdx >= 0 && KIND_TOPICS[process.argv[kindIdx + 1]] != null;
  const noRenotice = process.argv.includes('--no-renotice');
  const SIGNOFF_LABEL = (loadRules().signoffGate?.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT;
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  let payload = null;
  if (payloadSrc) {
    payload = JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'));
  }
  const issueTitle = (payload?.issueTitle ?? '').trim();
  const issueBody = (payload?.issueBody ?? '').trim();
  const commentBody = (payload?.commentBody ?? '').trim();
  const payloadComplete = issueTitle !== '' && issueBody !== '' && commentBody !== '';

  // 原子 claim(SC-1):check-then-act 全程持有本 PR 的专属文件锁,消除双实例各建
  // 一份 issue/各发一条评论的 TOCTOU 竞态。锁拿不到(另一实例持锁超时)本轮直接放弃,
  // 不做任何写操作,交下一轮重试——总比两边各写一份强。
  // round2 bug#8:dry-run 不获取锁——本行文档自称"不写任何外部状态",而获取锁本身就是
  // 写锁文件,且会跟真实执行抢锁造成饥饿;dry-run 只读,天然不需要互斥。
  const lock = dryRun ? null : acquireHoldLock(owner, repo, pr);
  if (lock && !lock.acquired) {
    // round2 D2:锁超时不再是完全静默的 {held:false, reason:'lock-timeout'} ——显式标注
    // needsIntervention,把持锁方 pid/起始时间带出去(能读到时),这是"需要人工介入排查"
    // 的信号,不是"下一轮再试就好"的常规状态。
    process.stderr.write(`[signoff-hold] 锁超时未拿到,疑似有持有者卡死或长时间占用(pid=${lock.holderPid ?? '未知'})——需要人工介入排查,而不是静默交给下一轮重试。\n`);
    print({
      ok: true, pr, held: false, reason: 'lock-timeout', needsIntervention: true,
      ...(lock.holderPid != null ? { holderPid: lock.holderPid } : {}),
      ...(lock.holderStartedAt != null ? { holderStartedAt: lock.holderStartedAt } : {}),
      ...(GH_TIMEOUT_WARNINGS.length ? { warnings: GH_TIMEOUT_WARNINGS } : {}),
    });
  } else
  try {
  // round6 R6-1/R6-2:临界区调用分两个预算池(见模块顶部 ghE/ghD):
  //   - 不可延后(ghE):pr view / issue view / issue create / status comment /
  //     label create / label POST —— 池 = ESSENTIAL_CALLS,任何可延后循环都吃不到;
  //   - 可延后(ghD):reconcile 循环 / legacy 标签清理 / renotice 回帖 —— 共享
  //     DEFERRABLE_BUDGET,池耗尽 budgetExhausted fail-visible,下一轮补做。
  // 带 GH_CALL_TIMEOUT_MS 超时;总耗时 = 总调用数 × 单次超时 ≤ 预算 × T < 租约,
  // 由构造保证,不再是写死的常数声称。ghJson 不支持超时选项,这里显式解析。
  const meta = JSON.parse(ghE([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,state,mergedAt,author,url,comments,labels,headRefOid',
  ]).stdout || 'null');
  const author = meta.author?.login ?? '';
  const currentLabels = (meta.labels ?? []).map((l) => l.name);
  const headSha = String(meta.headRefOid ?? '').toLowerCase();
  // 挂维护者确认标签;顺手摘掉旧主标签与旧门类子标签(迁移遗留)——委托给 performLabelSync
  // (与 computeHeld 共用同一份判定事实,SC-3 测试直接覆盖该导出函数)
  const syncLabels = () => performLabelSync({ owner, repo, pr, label: SIGNOFF_LABEL, current: currentLabels, dryRun, ghFn: ghE, legacyGhFn: ghD });
  // 标签失败不静默:顶到输出最外层(labelWarning),SKILL 要求最终报告里照抄。
  // 少了标签 → GitHub 后台与待确认面板都筛不到该 PR,门的判定不受影响。
  // round2 D5:legacyWarning(旧门类标签清理失败)单独顶成 legacyLabelWarning,不与
  // labelWarning 混在一起——两者是否成功是独立的事,legacy 清理失败不该连坐 held 判定。
  const withLabelWarning = (out) => {
    const withMain = out.labels?.warning ? { ...out, labelWarning: out.labels.warning } : out;
    return out.labels?.legacyWarning ? { ...withMain, legacyLabelWarning: out.labels.legacyWarning } : withMain;
  };
  const printOut = (out) => {
    // round5 R5-1:unprocessed(预算/上限内没做完的重复)与 closed/errors 同等重要,
    // 必须顶到输出——「主动放弃剩余工作」的可见性,调用方据此知道对账没做完。
    const withRecon = reconcile && (reconcile.closed.length || reconcile.errors.length || reconcile.unprocessed.length)
      ? { ...out, reconciliation: reconcile } : out;
    // round7 R7-1:env 校验警告(回落默认 / 钳位)进 JSON 顶层 warnings——stderr 是
    // 给人看的,JSON 是给自动化消费方看的,双通道缺一不可(口径同 resolve-threads)。
    const withWarnings = GH_TIMEOUT_WARNINGS.length ? { ...withLabelWarning(withRecon), warnings: GH_TIMEOUT_WARNINGS } : withLabelWarning(withRecon);
    return print(withWarnings);
  };

  // 找既有标记评论,读出当时开的 issue 链接。取「最后一条带 issue= 的标记」为准。
  const markerComments = (meta.comments ?? []).filter((c) => (c.body ?? '').includes(MARKER_PREFIX));
  const alreadyHeld = markerComments.length > 0;
  const markerUrls = markerComments
    .map((c) => c.body.match(/issue=(\S+?)\s*-->/)?.[1] ?? null)
    .filter(Boolean);
  // round4 D2:GitHub 侧对账(双写自愈)——标记评论里出现多个不同 hold issue 时,保留
  // 最早(number 最小)的,关闭其余并留说明;万一锁被绕过仍发生双写,下一轮开始即自愈,
  // 不会永久留两个 issue @ 作者两次。dry-run 不写外部状态,跳过对账。
  // round5 R5-1:对账每轮最多处理 MAX_RECONCILE_DUPS 个重复(超出进 unprocessed 报出,
  // 下一轮继续);round6 R6-3:只对仍 OPEN 的重复动作(issue list 拿 open 集合),已关闭的
  // 不再消耗额度,多轮真收敛。round6 R6-2:ghFn 走 ghD(可延后池)——循环排在 issue
  // create 之前也吃不到 ghE 的额度,真正的 hold 永远发得出去。
  const reconcile = dryRun ? null : reconcileDuplicateHoldIssues({ slug, urls: markerUrls, ghFn: ghD });
  const priorIssueUrl = reconcile ? reconcile.keptUrl : (markerUrls.pop() ?? null);
  // ── 旧讨论 issue 复用/新开判定(decideIssueReuse,见 lib.mjs;signoff-policy.test.mjs 覆盖)──
  // 旧 issue 可能已被 close-product-issue.mjs --no-longer-required 收尾关闭,之后 gate
  // 再亮起来时不能把作者引到一个已关闭的讨论里 —— 视同没开过,凭 payload 新开当前讨论
  // issue(新标记评论盖过旧标记)。state 查询失败 fail-safe 复用旧链接:网络抖动不该制造
  // 重复 issue,下一轮查到 CLOSED 再开也不迟。
  let priorIssueState = null;
  let priorIssueStateError = null;
  if (priorIssueUrl != null) {
    const priorNum = issueNumberFromUrl(slug, priorIssueUrl);
    if (priorNum == null) {
      priorIssueStateError = 'issue-url-unparsable';
    } else {
      const r = ghE(['issue', 'view', String(priorNum), '--repo', slug, '--json', 'state'], { allowFail: true });
      if (r.ok) {
        try {
          const s = String(JSON.parse(r.stdout || '{}').state ?? '').toUpperCase();
          priorIssueState = s === 'OPEN' || s === 'CLOSED' ? s : null;
        } catch { priorIssueStateError = 'state-parse-failed'; }
      } else {
        priorIssueStateError = (r.stderr || r.stdout || '').trim().split('\n')[0]?.slice(0, 200) || 'unknown';
      }
    }
  }
  const reuse = decideIssueReuse({ priorIssueUrl, issueState: priorIssueState });
  const needIssue = reuse.needNewIssue;
  // 输出透出旧 issue 状态;labels-only 模式不建 issue,旧 issue 已关闭时以 needsFreshHold
  // 提示调用方带 payload 重跑完整模式。
  const priorIssueInfo = priorIssueUrl == null ? {} : {
    priorIssueState,
    issueReuse: reuse.reason,
    ...(priorIssueStateError ? { priorIssueStateError } : {}),
    ...(reuse.needNewIssue ? { priorIssueClosed: true } : {}),
  };

  // ── 状态回帖 ──
  // 触发条件(全部满足):已经 hold 过(作者收过带 issue 链接的完整说明)+ 本轮看到时标签
  // **不在**(= 门刚从放行/等作者翻回等维护者,或标签被人摘了)+ 这版 head 还没回帖过。
  // 用「看到时标签不在」而不是「加标签成功」:标签写失败(权限类)时门照旧在拦,作者更该知道。
  // headSha 拿不到时**宁可不发**:去重键为空 → 标记写成 head= 解析不回来 → 每轮都重复回帖,
  // 那比漏一条更糟。这种情况在输出里如实写 no-head-sha。
  const labelWasAbsent = !currentLabels.includes(SIGNOFF_LABEL);
  const noticedHeads = parseSignoffRenotices(meta.comments ?? []);
  const renoticeDone = noticedHeads.has(headSha);
  // 回帖里的讨论链接用 reuse.reuseUrl:旧 issue 已关闭时不回帖 —— 不能把作者引进一个
  // 已关闭的讨论;完整模式新开 issue 时那条带标记的评论本身就是完整通知,不需要回帖叠加。
  const renoticeIssueUrl = reuse.reuseUrl;
  const renoticeWanted = !noRenotice && renoticeIssueUrl != null && labelWasAbsent && !renoticeDone && headSha !== '';
  // 文案固定模板。三条纪律:
  //   ① kind 没传就不硬说是哪一类 —— 默认值 product 在 --labels-only 时是猜的,猜错比不说更糟;
  //   ② 不写「你刚推了新代码」这类断言 —— 本分支也会在「首次 hold 时标签写失败、下一轮补挂」
  //      时走到,那时作者并没有推东西,说了就是错话;
  //   ③ 不写「不用你再管了」—— 门在拦的同时可能还有 review 意见 / CI 要作者修。
  const renoticeBody = () => {
    const scope = kindGiven ? `维护者确认门(${KIND_TOPICS[kind]})` : '维护者确认门';
    const hail = author ? `@${author} 👋 ` : '';
    return [
      `${hail}**这个 PR 现在在等维护者确认**,确认之前流程不会合并它 —— 不是卡住了,也不是在等你再改一版(你推的改动流程都读到了,判的就是最新一版代码)。`,
      '',
      `- 在拦的是:${scope}。`,
      `- 讨论 issue:<${renoticeIssueUrl}>`,
      '- 通过方式只有一个:维护者在本 PR 上 **Approve**。维护者觉得要改会直接 **Request Changes**,那时候球才回到你手里。',
      '- 这期间如果还有 review 意见没处理完、CI 没过,照常修就行,不影响这条等待。',
      '',
      '这条是流程自动发的状态提醒(同一版代码只发一次),不用回复。',
    ].join('\n');
  };
  const doRenotice = () => {
    if (!renoticeWanted) {
      return {
        renoticed: false,
        renoticeSkipped: noRenotice ? 'disabled'
          : priorIssueUrl == null ? 'never-held'
            : renoticeIssueUrl == null ? 'prior-issue-closed'
              : !labelWasAbsent ? 'label-already-on'
                : renoticeDone ? 'already-noticed-for-head'
                  : headSha === '' ? 'no-head-sha' : 'unknown',
      };
    }
    if (dryRun) return { renoticed: false, wouldRenotice: true };
    // round6 R6-2:renotice 回帖是可延后动作(下一轮凭「无 head 标记」自动补发,
    // 语义无损),走 ghD 可延后池——回帖失败不连坐标签、也不改变门的判定。
    const r = ghD(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
      input: `${renoticeBody()}\n\n${SIGNOFF_RENOTICE_MARKER_PREFIX} head=${headSha} -->`,
      allowFail: true,
    });
    // 回帖失败不连坐标签、也不改变门的判定:头一行报错顶到输出里,下一轮凭「无 head 标记」自动重试。
    return r.ok
      ? { renoticed: true, renoticeHead: headSha }
      : { renoticed: false, renoticeError: (r.stderr || r.stdout || '').trim().split('\n')[0]?.slice(0, 200) ?? 'unknown' };
  };

  // 已合并 / 已关闭的 PR 不碰
  if (meta.state !== 'OPEN' || meta.mergedAt) {
    print({
      ok: true, pr, author, held: false, reason: 'pr-not-open', state: meta.state,
      ...(GH_TIMEOUT_WARNINGS.length ? { warnings: GH_TIMEOUT_WARNINGS } : {}),
    });
  } else if (labelsOnly) {
    // 标签先挂回去,再回帖:回帖里说的「在等维护者确认」要和 GitHub 上的标签状态一致。
    // 旧 issue 已关闭 → needsFreshHold=true:labels-only 建不了 issue,调用方带 payload
    // 重跑完整模式新开当前讨论 issue。
    printOut({
      ok: true, pr, author, labelsOnly: true, alreadyHeld, ...priorIssueInfo,
      ...(priorIssueUrl != null && reuse.needNewIssue ? { needsFreshHold: true } : {}),
      labels: syncLabels(), ...doRenotice(),
    });
  } else {
    if (dryRun) {
      printOut({
        ok: true, pr, author, dryRun: true,
        alreadyHeld, priorIssueUrl, ...priorIssueInfo,
        // 探测口径同步(gpt 单审 P2):违约时把「将建 issue / 将发评论」报为 false,
        // 与真实执行行为一致;并点名 titleContractViolation,调用方(主 agent)在
        // dry-run 阶段就能看到,不必等真实执行才撞红线。
        wouldCreateIssue: needIssue && payloadComplete && issueTitleSatisfiesContract(issueTitle, pr),
        wouldComment: needIssue && payloadComplete && issueTitleSatisfiesContract(issueTitle, pr),
        missingPayload: needIssue && !payloadComplete,
        titleContractViolation: needIssue && payloadComplete && !issueTitleSatisfiesContract(issueTitle, pr),
        labels: syncLabels(),
        ...doRenotice(),
      });
    } else if (needIssue && !payloadComplete) {
      // 开 issue / 发评论必须有完整文案——光打标签会让作者一头雾水。标签照打:判定已经是
      // 「维护者确认门在拦」,GitHub 后台就该能筛到它。遇到本 reason 补 payload 重试,别排查脚本。
      printOut({
        ok: true, pr, author, held: false, reason: 'missing-payload', alreadyHeld, ...priorIssueInfo,
        labels: syncLabels(),
      });
    } else if (needIssue && !issueTitleSatisfiesContract(issueTitle, pr)) {
      // 标题契约守门(2026-08-28 事故修复):标题必须匹配「维护者确认 · PR #<n>」公式,
      // 否则下游 merge-thanks 的 issue-announce 按合同良性跳过,Slack 通报静默丢失
      // (#330 / #353 实测)。违约时 fail-visible:拒绝开 issue / 发评论(开了也通报不出
      // 去,等于给链路埋第二颗静默雷),held=false + titleContractViolation,调用方改写
      // 标题补 payload 重试即可。标签照打——门判定不受文案违约影响,GitHub 后台可筛性保住。
      printOut({
        ok: true, pr, author, held: false, reason: 'title-contract-violation',
        titleContractViolation: true, requiredPrefix: MAINTAINER_CONFIRM_TITLE_PREFIX,
        givenTitle: issueTitle, alreadyHeld, ...priorIssueInfo,
        labels: syncLabels(),
      });
    } else {
      // 1) 开讨论 issue(没有可复用 issue 时;失败则本轮不发评论,下轮自动重试)——委托给
      // performIssueCreate(SC-3 测试直接覆盖该导出函数)
      let issueUrl = reuse.reuseUrl;
      let issueCreated = false;
      let issueError = null;
      if (needIssue) {
        const r = performIssueCreate({ pr, slug, kind, author, issueTitle, issueBody, ghFn: ghE });
        if (r.issueCreated) {
          issueUrl = r.issueUrl;
          issueCreated = true;
        } else {
          issueError = r.issueError;
        }
      }

      // 2) 发评论(带隐藏标记;仅在本轮新开了 issue 时——评论的核心就是给 issue 链接)——
      // 委托给 performStatusComment(SC-3 测试直接覆盖该导出函数)
      let commented = false;
      let commentError = null;
      if (issueCreated && issueUrl) {
        const r = performStatusComment({ pr, slug, kind, issueUrl, commentBody, ghFn: ghE });
        commented = r.commented;
        commentError = r.commentError;
      }

      // 3) 维护者确认标签(与 issue/评论共同构成 held 判据,见下——三件套全成功才算 held,
      // 不再是「失败不连坐」:标签 POST 失败时 held 必须为 false,并在 heldBlockedBy 里点名)
      const labels = syncLabels();

      // 4) 状态回帖(只在「早就 hold 过、这轮门重新亮起来」时;本轮首次 hold 已经有 2) 的评论)
      const renotice = doRenotice();

      // held 判据(SC-2):issue 建成(或有效复用)&& 评论发出 && 标签同步成功,三件套全成功
      // 才算 held——委托给 computeHeld(纯函数,SC-3 测试直接覆盖)。任一项失败时
      // heldBlockedBy 点名具体失败项,不再只挂 labelWarning 一个侧信道。
      const { held, heldBlockedBy } = computeHeld({
        issueCreated, priorIssueUrl, needIssue, commented, alreadyHeld,
        labelsOk: !labels.warning,
      });
      printOut({
        ok: true, pr, author, kind, held, ...(held ? {} : { heldBlockedBy }), ...priorIssueInfo,
        issueUrl, issueCreated, issueError,
        commented, alreadyHeld, commentError,
        labels,
        ...renotice,
        url: meta.url,
      });
    }
  }
  } finally {
    if (lock) {
      const rel = releaseHoldLock(lock);
      if (rel.notOwner) {
        // round2 D3:token 不匹配 = 本实例的锁已被判定陈旧后由另一实例抢占重建,当前实例
        // 不再是持有者——跳过 unlink,避免误删新持有者的锁(误删的后果是双实例同跑)。
        process.stderr.write('[signoff-hold] 释放锁时发现 token 不匹配(锁已被判定陈旧后被其他实例抢占重建)——本实例不是当前持有者,已跳过 unlink,避免误删新持有者的锁。\n');
      }
    }
  }
} catch (e) {
  fail(e);
}
}
