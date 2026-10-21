#!/usr/bin/env node
// context.mjs — review-pr 的一次性「采集 + 客观判定」核心(只读,在当前分支跑即可)
//
// 把 skill 流程里所有「确定性」的活一次性做完,输出
// 一份结构化 JSON 给 LLM:PR 元数据、文件 / diffstat、格式硬判定、讨论历史、前置门判定。
// LLM 拿到后只需做「语义判断 + 决策」:
//   - 格式:formatPass=false 一定不合规;true 仍需 LLM 判段落是否实质、title 语言(关 3)。
//   - 前置门:gate.gatePass=false → 1.7 必须卡 gate;gate.softFlags 里的 bot 评论 /
//     疑似打回由 LLM 读内容定性。
//
// 本脚本不发评论、不改工作区、不起审查。退出码恒 0(除脚本自身出错=1);
// 判定结论全在 JSON 字段里(formatPass / gate.gatePass),不靠退出码分流。
//
// --scan 精简模式(auto 批处理阶段 1 专用):判定全量照算,但输出**不含** body 全文、
// 评论 / review thread / 提交时间线全文——只留分类决策与汇总所需的最小字段 + filePaths
// (供文件重叠守卫比对)。动机:批处理要对几十个候选各跑一次本脚本,全量 JSON(含全文
// 历史)会把主 agent 的 session 上下文撑爆并造成跨 PR 串扰;全文只应进对应 PR 的审查
// 子 agent 隔离上下文(子 agent 在自己 worktree 里跑不带 --scan 的全量模式自取)。
//
// --scan-all 批量模式(auto 批处理阶段 1 专用):不传 PR 号,脚本自己拉全部 open 非 draft
// 候选,内部并行(8 并发)spawn 自身的单 PR `--scan` 模式,聚合输出 results 数组——把主
// agent「N 个候选 = N 次工具调用」压成 1 次;核心判定逻辑与单 PR 模式**同一份代码**
// (就是 spawn 自己),不存在两套判定漂移。单个候选失败不炸整批(该条 ok:false)。
// 扫描完成后顺手落盘空转指纹(.last-scan.json,供 scheduler pre-check.mjs 比对,见 lib.mjs)。
//
// 跑:node <skill-root>/scripts/context.mjs <PR> --lock-token <prepare.lock.token> [--scan]
//     node <skill-root>/scripts/context.mjs --scan-all --lock-token <prepare.lock.token>
// --diff-output <absolute-file>:原子保存本次实际扫描的 diff，供 roundDir 内材料复用。
// --cached-context <file>:仅复用同 head/base 且 hash 一致的 diff/files；其余资料实时重取。

import { parseRepo, parsePR, gh, ghJson, ghGraphql, classifyHeadChecks, fetchCiRollup, classifyRollupContexts, evaluateCiStatus, probeBranchProtection, loadOrgRosters, parseRosterLine, print, fail, fetchOpenPrSnapshot, computePrSetFingerprint, SCAN_STATE_FILE, spawnScriptJson, mapPool, parseLastHoldMarker, parseSignoffReleaseEvents, selectTrustedSignoffReleases, SIGNOFF_LABEL_DEFAULT, LEGACY_GATE_LABELS, parseFingerprintGuard, matchPathPatterns, loadRules, loadMaintainerAuthoritySnapshot, evaluateMaintainerApprovalPolicy, isApprovalPendingReviewDecision, evaluateSignoffBlocking, botCheckActivity, evaluateBotSettleSinceReady, toHeadPushedAt, evaluateMaintainerReview, latestSubstantiveReviews, RISKY_HARD_BASE_PATTERNS, RISKY_SOFT_BASE_PATTERNS, REMOVED_GUARD_RE, COMMENT_ONLY_RE, scanBoundaryLine, matchNewDependency, loadDisplayLabelConfig, computeDisplayLabels, stateFile, isUiTestPath } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { atomicWriteJson, fetchStaleRebase, fetchAllReviewThreads, fetchGraphqlConnection, fetchRestPages } from './lib.mjs';
// [MIVO-PATCH identity-env]
import { viewerLoginOverride } from './lib.mjs';
// [MIVO-PATCH exempt-authors / slack-release / issue-comment-release / issue-binding / protected-signoff / ci-ignore / ui-evidence / self-review]
import { countDiffLines, isSignoffExemptAuthor, selectDiscussionIssueReleases, latestIssueRelease, evaluateProtectedPathRelease, filterIgnoredCiContexts, ciMergeStateIgnoring, onlyOwnRequiredChecksPending, isProductSignoffEnabled, isUiEvidenceRequired, uiEvidenceNeedsAdminLookup, isAdminPermission, declaresNoUiChange, isAutomatedViewerReview, selectStandingViewerHumanChangesRequest } from './lib.mjs';
import { filePatchHashesFromDiff, loadBotSettleSnapshot, saveBotSettleSnapshot, previousSettleFromLocalMerge } from './lib.mjs'; // [MIVO-PATCH bot-settle-base-only]
import { loadReviewState, reviewSelection } from './review-state.mjs';
import { classifyBasePrLookup } from './review-dependencies.mjs';
import { fileURLToPath } from 'node:url';
import { createContextEvidence, loadCachedCode, sameCodeRevision, writeDiffFile } from './context-cache.mjs';
import { readPrDiff } from './pr-diff.mjs';
import { FIX_WATCHDOG_MS } from './fix-session-state.mjs';

// ── PR 提交规范与维护者 gate 配置：单一真相源在 Skill config/pr-rules.json ──
// featureSections / bugfixSections 需与 .github/PULL_REQUEST_TEMPLATE.md 的必填段落
// 一致；公开仓库可用自己的轻量 CI 校验模板，不读取本私有配置。
// titleTypes 无模板锚点,单一真相源就是那个 json 自己;
// lightTypes / redlinePaths / serverPaths 也只在那个 json(供本脚本判定,PR 模板无对应)。
const prRules = loadRules();
const lockTokenIndex = process.argv.indexOf('--lock-token');
const REVIEW_LOCK_TOKEN = lockTokenIndex >= 0 ? String(process.argv[lockTokenIndex + 1] ?? '').trim() : '';
const TITLE_TYPE_RE = new RegExp(`^(${prRules.titleTypes.join('|')})(\\([^)]+\\))?!?: .+`);
const LIGHT_TYPES = prRules.lightTypes; // 轻档:不强制段落
const FEATURE_SECTIONS = prRules.featureSections;
const BUGFIX_SECTIONS = prRules.bugfixSections;
const REDLINE_PATH_RE = new RegExp(prRules.redlinePaths.join('|'));
// CI 配置敏感路径:PR 改了它们 → approve fork workflow 会执行被改过的 CI(详见 approve-workflows.mjs 安全门)
const CI_SENSITIVE_RE = prRules.ciSensitivePaths?.length ? new RegExp(prRules.ciSensitivePaths.join('|')) : null;
// ── 维护者确认门(signoff gate):六类触发、一套机制。prepare 每轮从目标仓库默认分支
// CODEOWNERS 的唯一 `* @org/team` 根规则实时抓 Team 成员，再与 maintainerAllowlist 取并集；
// context 只消费与当前 review 锁绑定的 fresh snapshot。所有作者最终都要由另一位
// 维护者 Approve；维护者作者不在审查前重复 hold，但不再免最终 Approve。Team 读取失败时白名单不得兜底。──
// 受保护路径(.github/** 等,pr-rules.json protectedPaths.paths):命中即不自动合并,
// 交人工处理——不看 diff 大小、不看作者、不看标题类型。
const PROTECTED_PATHS = (prRules.protectedPaths?.paths) ?? [];
const SG = prRules.signoffGate ?? {};
const SIGNOFF_LABEL = (SG.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT;
// product 触发:feat 类型或命中 UI 面路径(uiExcludePaths 排除 locale 等纯文案数据)
const UI_PATH_PREFIXES = SG.product?.uiPaths ?? [];
const UI_EXCLUDE_PREFIXES = SG.product?.uiExcludePaths ?? [];
// arch 触发:核心路径改动量 / refactor 大 diff / 任意类型超大 diff
const ARCH_RULES = SG.arch ?? {};
const ARCH_CORE_PATHS = ARCH_RULES.corePaths ?? [];
const ARCH_CORE_DIFF_LINES = Number(ARCH_RULES.coreDiffLines) || 150;
const ARCH_REFACTOR_DIFF_LINES = Number(ARCH_RULES.refactorDiffLines) || 400;
const ARCH_ANY_DIFF_LINES = Number(ARCH_RULES.anyTypeDiffLines) || 800;
// coldUpdate 触发:mobile runtime fingerprint 输入路径 + CI fingerprint guard sticky comment
// (guard 真算过 base vs 合并结果,结论优先于路径启发式)。确认人同样使用 maintainers。
const COLD_RULES = SG.coldUpdate ?? {};
const ARCH_COLD_UPDATE_PATHS = COLD_RULES.paths ?? [];
const COLD_UPDATE_GUARD_MARKER = COLD_RULES.guardMarker ?? '';
// rules 触发:规则文档就是本审查流程的判据本身,改到即需确认。excludePaths 只放机器生成、
// 不含任何审查判据的产物(docs/legal/notices 的 THIRD-PARTY-NOTICES / SBOM,实测 #291 #503
// #526 #527 反复误触发)。匹配口径见 matchPathPatterns(`**/名字`/目录前缀/整串精确)。
const RULE_DOC_PATHS = SG.rules?.paths ?? [];
const RULE_DOC_EXCLUDE_PATHS = SG.rules?.excludePaths ?? [];
// pluginBase 触发:插件基座 = 所有已装插件共同踩着的那一层(运行时与沙箱、批准 receipt、
// 能力 slot、打包与内容判据、manifest 契约、装入与权限确认 UI、已装列表投影)。改到即触发,
// 与 rules / security / coldUpdate 一样不设 diff 阈值,也**不吃「是 bugfix / 纯技术改动」的
// 语义豁免**:一次改动同时作用到全部存量安装,坏了就是全量用户故障,而不是某个功能坏了。
// 由来:#1080(2026-07-31)是方向正确的安全加固,但把「无 receipt = 未授权」直接作用到存量
// 安装且没有迁移路径,合入后用户所有插件同时变成停用、必须逐个重新确认。它当时只落在 arch
// 门(有 150 行阈值 + bugfix 语义豁免),按 fix 类纯技术改动被放过。
const PLUGIN_BASE_PATHS = SG.pluginBase?.paths ?? [];
const PLUGIN_BASE_EXCLUDE_PATHS = SG.pluginBase?.excludePaths ?? [];
// security 触发:安全边界路径(双条件:命中路径且确实动了边界内容)+ 危险写法硬命中 +
// 新增第三方依赖。详见 SKILL 维护者确认门一节与 lib.mjs 的模式表。
const SECURITY_PATHS = SG.security?.paths ?? [];
const SECURITY_EXCLUDE_PATHS = SG.security?.excludePaths ?? [];
// 自动跟进修复名单:这些作者的 PR 卡在作者侧问题时不打回 / 不催办,由 skill 开跟进会话自己修
// (owner 本人的 PR 对自动化账号是 own-pr,GitHub 禁止对自己的 PR 提 REQUEST_CHANGES / APPROVE,
// 打回路径本来就走不通),详见 auto SKILL「自动跟进修复(fix-handoff)」。
const SELF_FIX_AUTHORS = (prRules.selfFixAuthors ?? []).map((s) => s.toLowerCase());
// 机器人静默期配置(botReviewSettle: { enabled, reviewers, maxWaitMinutes });判定在 lib.mjs
const BOT_SETTLE_RULES = prRules.botReviewSettle ?? {};
// Slack 同步 bot(信任锚):只有这些账号发的讨论 issue 评论才允许按正文「发送者:」归属真实发言人,
// 防止普通用户伪造「发送者:<维护者>」冒充维护者表态。比对时去掉 GitHub App 的 [bot] 后缀。
const SLACK_SYNC_BOTS = (prRules.slackSyncBots ?? []).map((s) => s.toLowerCase());
const normalizeBotLogin = (login) => (login ?? '').toLowerCase().replace(/\[bot\]$/, '');
// Slack 显示名 → GitHub login 别名(大小写不敏感):兜「Slack 名与名录中文名对不上」的情况(Dash=dashhuang)
const SLACK_SENDER_ALIASES = Object.fromEntries(
  Object.entries(prRules.slackSenderAliases ?? {}).map(([k, v]) => [k.toLowerCase(), (v ?? '').toLowerCase()]),
);

// ── 安全与隐私内容门(阶段一最先执行,见 SKILL 3.1):扫 PR 标题 / body / diff 新增行 ──
// hard = 高置信凭证格式,命中即阻断(auto 走 pushback-security,不进审查不合并);
// soft = 疑似凭证 / 个人隐私数据,交阶段二审查 agent 语义定性(真凭证 / 真个人数据 = P0)。
// pr-rules.json sensitiveContent 可配 allowPaths(整文件跳过扫描,只用于测试夹具类已知误报)
// 与 extraHardPatterns / extraSoftPatterns(项目自有格式,正则字符串)。
const SENSITIVE_RULES = prRules.sensitiveContent ?? {};
const SENSITIVE_ALLOW_RE = (SENSITIVE_RULES.allowPaths ?? []).length ? new RegExp(SENSITIVE_RULES.allowPaths.join('|')) : null;
const HARD_SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['aws-access-key-id', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9][A-Za-z0-9-]{8,}\b/],
  ['sk-api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ...(SENSITIVE_RULES.extraHardPatterns ?? []).map((p, i) => [`custom-hard-${i + 1}`, new RegExp(p)]),
];
// credential-assignment 的占位符豁免(${VAR}/test/example 等)只给软命中降噪,不影响硬命中
const SENSITIVE_PLACEHOLDER_RE = /\$\{|\$\(|process\.env|<[^>]*>|xxx|your[-_]|placeholder|change[-_]?me|example|sample|dummy|test|fake|mock|stub|redacted|\*{3,}/i;
const SAFE_EMAIL_RE = /@example\.(?:com|org|net)\b|@test\.|\.invalid\b|noreply|no-reply|users\.noreply\.github\.com/i;
const SOFT_SENSITIVE_PATTERNS = [
  ['credential-assignment', /\b(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/],
  ['cn-mobile', /(?<!\d)1[3-9]\d{9}(?!\d)/],
  ['cn-id-number', /(?<!\d)\d{17}[\dXx](?!\d)/],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/],
  ...(SENSITIVE_RULES.extraSoftPatterns ?? []).map((p, i) => [`custom-soft-${i + 1}`, new RegExp(p)]),
];
// 命中样本脱敏:只留前 6 字符 + 长度。任何下游输出(打回评论/汇总/飞书)不得还原原文。
const maskSensitive = (s) => `${s.replace(/\s+/g, ' ').slice(0, 6)}…(共 ${s.length} 字符)`;
function scanSensitiveLine(line, location, sink) {
  for (const [kind, re] of HARD_SECRET_PATTERNS) {
    const m = line.match(re);
    if (m) sink.hard.push({ ...location, kind, sample: maskSensitive(m[0]) });
  }
  for (const [kind, re] of SOFT_SENSITIVE_PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    if (kind === 'credential-assignment' && SENSITIVE_PLACEHOLDER_RE.test(m[0])) continue;
    if (kind === 'email' && SAFE_EMAIL_RE.test(m[0])) continue;
    sink.soft.push({ ...location, kind, sample: maskSensitive(m[0]) });
  }
}

// ── 安全敏感改动门:危险写法 + 新增第三方依赖(见 SKILL 3.4「安全敏感改动门」)──
// 与上面的「安全与隐私内容门」是两件不同的事:那个抓「把钥匙和个人信息写进代码」(内容泄露),
// 这个抓「代码本身放松了安全边界 / 引入了攻击面」(能力变化)。两者共用同一次 gh pr diff。
//
// hard = 命中即硬拦(转 draft 等 securityApprovers 确认):这些写法正常开发几乎不会新增,
//        且一旦出现就是实打实的安全边界变化(Electron 隔离被关、动态求值、拼字符串执行 shell、
//        CSP 放宽、导航/权限逃逸、install 钩子)。宁可让作者多等一次确认,不可放过一个 0day 入口。
// soft = 不拦,只作为材料交阶段二审查 agent 逐条定性(新增外发请求、写文件、读敏感 env、
//        子进程能力、innerHTML、弱哈希):这些在正常代码里也大量存在,硬拦会天天误伤。
//
// ⚠️ 删除行也要扫:删掉一行 CSP、把 contextIsolation 那行整行改掉,diff 里都是 `-` 行 ——
// 只扫新增行会漏掉「安全保护被移除」这一整类降级(REMOVED_GUARD_RE,记 hard)。
// 判定用的正则与纯函数都在 lib.mjs(可单测,见 scripts/security-patterns.test.mjs);
// 这里只做两件配置相关的事:把项目自有的追加模式拼上去、按 allowPaths 豁免整文件。
const RISKY_RULES = SG.security?.riskyPatterns ?? {};
const RISKY_ALLOW_RE = (RISKY_RULES.allowPaths ?? []).length ? new RegExp(RISKY_RULES.allowPaths.join('|')) : null;
const RISKY_HARD_PATTERNS = [
  ...RISKY_HARD_BASE_PATTERNS,
  ...(RISKY_RULES.hard ?? []).map((p, i) => [`custom-risky-hard-${i + 1}`, new RegExp(p)]),
];
const RISKY_SOFT_PATTERNS = [
  ...RISKY_SOFT_BASE_PATTERNS,
  ...(RISKY_RULES.soft ?? []).map((p, i) => [`custom-risky-soft-${i + 1}`, new RegExp(p)]),
];
const DEPENDENCY_SCAN = SG.security?.dependencyScan ?? {};
const DEPENDENCY_SCAN_ENABLED = DEPENDENCY_SCAN.enabled !== false;
const DEPENDENCY_EXCLUDE_RE = (DEPENDENCY_SCAN.excludePaths ?? []).length
  ? new RegExp(DEPENDENCY_SCAN.excludePaths.join('|'))
  : null;
// 危险写法样本要保留代码原文(脱敏成前 6 字符就没法判断了),但同一行可能夹带凭证 ——
// 先把高置信凭证格式替换掉再截断,做到「代码看得懂、钥匙带不出去」。
const clipRisky = (s) => {
  let out = (s ?? '').replace(/\r/g, '').trim();
  for (const [, re] of HARD_SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '‹凭证已脱敏›');
  }
  return out.slice(0, 200);
};
/** 扫一行新增代码:hard 进 sink.hard(硬拦),soft 进 sink.soft(交审查 agent 定性)。 */
function scanRiskyLine(line, location, sink) {
  for (const [kind, re] of RISKY_HARD_PATTERNS) {
    if (re.test(line)) sink.hard.push({ ...location, kind, sample: clipRisky(line) });
  }
  for (const [kind, re] of RISKY_SOFT_PATTERNS) {
    if (re.test(line)) sink.soft.push({ ...location, kind, sample: clipRisky(line) });
  }
}
/**
 * 扫一行被删除的代码:只判「安全保护是否被移除」(记 hard,side=removed)。判据在 lib.mjs。
 * 先滤掉纯注释行 —— 删掉一句「// thread/start 的 sandbox: SandboxMode ...」不是移除保护
 * (实测 PR #670 被这样误拦);删的是代码才算。
 */
function scanRemovedGuardLine(line, location, sink) {
  if (COMMENT_ONLY_RE.test(line)) return;
  if (REMOVED_GUARD_RE.test(line)) {
    sink.hard.push({ ...location, kind: 'security-guard-removed', side: 'removed', sample: clipRisky(line) });
  }
}

// ── 以下是 review-pr skill 自身的执行细则(非 agent 约束文档内容,留在脚本里)──
const TITLE_VAGUE_RE = /:\s*(bug|update|improve|fix issue|优化|调整|更新|misc|若干|一些)\s*$/i;

// ── 前置门判定常量(复刻 SKILL.md 1.6.5)──
// 注:CI 读双源(2026-08-04 起无条件读,不再只在 BLOCKED 时查):statusCheckRollup(gh pr view,
// 覆盖全部 CI 来源,fine-grained PAT 可能 403 → 降级 null)+ actions/runs(classifyHeadChecks,
// PAT 一定读得到,只覆盖 Actions,兜底 + awaiting 探测);REST 的 check-runs / commit-status /
// 分支保护(branches/*/protection)端点在本项目 PAT 下常 403,不依赖。总判定 evaluateCiStatus:
// **CI 全绿(pass)才可合并**。BLOCKED 时再用 reviewDecision(权威聚合)区分 review 维度,
// CI 双源全绿且 review 满足却仍 BLOCKED → 结构性门(永不上报结果的 code_scanning/code_quality 等),
// 靠 admin bypass 合或修门,而不是作者要改(见下方 blockClass='structural-check')。
const PUSHBACK_STRONG_RE = /\[阻断\]|\[必改\]/;
const PUSHBACK_WEAK_RE = /不能合|这次先没合|先没合|需要改后再合|先别合|这次先不合|changes?\s*requested|request\s*changes/i;

// 一次拉全 PR 的讨论 / 时间线(reviewThreads + comments + commits)
const GQL = `
  query($owner:String!,$repo:String!,$num:Int!){
    viewer{ login }
    repository(owner:$owner,name:$repo){
      defaultBranchRef{ name }
      pullRequest(number:$num){
        id
      }
    }
  }`;

// [MIVO-PATCH identity-env] 设了 REVIEW_PR_VIEWER_LOGIN 时查询里去掉 viewer:integration 令牌的 viewer 是 bot 或读不到,
// 不能让它决定审查账号,也不能让它的字段错误拖垮整个查询。没设时仍发原来的 GQL,一字不改。
const GQL_WITHOUT_VIEWER = GQL.replace(/^[ \t]*viewer\{ login \}\n/m, '');

const isBot = (a) => a?.__typename === 'Bot' || /\[bot\]$/i.test(a?.login ?? '');
const clip = (s, n) => (s ?? '').replace(/\r/g, '').slice(0, n);

// ── --scan-all 批量驱动(见文件头说明;判定本体在下方单 PR 流程,这里只做编排)──
if (process.argv.includes('--scan-all')) {
  const SELF_PATH = fileURLToPath(import.meta.url);
  try {
    const { owner, repo } = parseRepo();
    const slug = `${owner}/${repo}`;
    // 先验证本轮维护者快照，再启动任何子扫描；查不了权限不能被折叠成 allSkip。
    const maintainerAuthority = loadMaintainerAuthoritySnapshot({ owner, repo, lockToken: REVIEW_LOCK_TOKEN });
    const rawList = fetchOpenPrSnapshot({ owner, repo, timeoutMs: 60_000 });
    const reviewSelectionState = loadReviewState(stateFile('review-state.json'));
    const selected = reviewSelection(rawList, reviewSelectionState);
    const startedAt = Date.now();
    // 只把自上次成功完成代码 review 后 head 已变化(或从未成功 review)的 PR 送入分类。
    // 未变化 PR 仍保留在快照指纹里，但不重复拉完整上下文、不重复启动审查 agent。
    const candidates = selected.reviewCandidates
      .map((p) => ({ number: p.number, title: p.title, author: p.author, createdAt: p.createdAt, url: p.url }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // draft 不进候选:维护者确认门不再转 draft(hold 只做 issue+评论+标签),draft 就是作者
    // 自己的「还没写完」。被维护者确认门拦着的 PR 是 open 非 draft 的普通候选,signoff.blocking
    // 会让它 skip;放行动作是 PR 上的 Approve,会改 reviewDecision 与 PR updatedAt,
    // 两者都在 open PR 集合指纹里,pre-check 比对失配即放行复核。

    // 只读扫描,8 并发安全;单条失败折叠成 ok:false 条目,不炸整批
    const concurrency = Math.max(1, Math.min(8, Number(prRules.batch?.scanConcurrency) || 8));
    const results = await mapPool(candidates, concurrency, async (c) => {
      const r = await spawnScriptJson(SELF_PATH, [
        String(c.number), '--scan', '--compact', '--lock-token', REVIEW_LOCK_TOKEN,
      ]);
      return r && r.ok ? r : { ok: false, pr: c.number, error: r?.error ?? '未知失败' };
    });

    // 空转指纹落盘(供 scheduler pre-check.mjs 比对)。allSkip 必须「全部扫描成功且全为
    // 跳过类」才为 true(「查不了」≠「没活」,下轮照常起会话)。被维护者确认门拦住的候选按
    // 跳过类参与 allSkip:放行动作是 PR 上的 Approve,会改 reviewDecision 与 PR
    // updatedAt(都在 PR 集合指纹里)→ pre-check 比对失配放行;讨论 issue 有新留言时
    // heldIssues(issue updatedAt)指纹也失配,汇总能及时提示。
    // 快照拉取失败只影响省钱(pre-check 拿不到新指纹 → 放行),绝不影响扫描结果本身。
    const complete = results.length === candidates.length && results.every((r) => r.ok);
    let scanState = null;
    let scanStateError = null;
    try {
      const snapshot = fetchOpenPrSnapshot({ owner, repo, timeoutMs: 60_000, settleUnknown: true });
      // 被维护者确认门拦住的候选 → 讨论 issue 的 number + updatedAt(pre-check 逐条比对;
      // 读不到的记 null,pre-check 视 null 为「不可证不变」→ 放行)
      const heldIssues = results
        .filter((r) => r.ok && r.signoff?.blocking && (r.signoff?.discussionIssue || r.signoff?.held))
        .map((r) => ({
          pr: r.pr,
          number: r.signoff?.discussionIssue?.number ?? r.signoff?.held?.issueNumber ?? null,
          updatedAt: r.signoff?.discussionIssue?.updatedAt ?? null,
        }));
      const nextState = {
        version: 2,
        complete,
        savedAt: new Date().toISOString(),
        allSkip: complete && results.every((r) => r.auto?.isSkip === true) &&
          computePrSetFingerprint(rawList) === computePrSetFingerprint(snapshot),
        fingerprint: computePrSetFingerprint(snapshot),
        maintainerAuthorityDigest: maintainerAuthority.digest,
        candidateCount: candidates.length,
        heldIssues,
        prNumbers: snapshot.map((s) => s.number),
      };
      atomicWriteJson(SCAN_STATE_FILE, nextState);
      scanState = nextState;
    } catch (e) {
      scanStateError = String(e?.message ?? e).slice(0, 200);
    }

    const scanResult = {
      ok: complete,
      complete,
      scanAll: true,
      repo: { owner, repo },
      maintainerAuthority: {
        verified: true,
        teamHandle: maintainerAuthority.codeowners.teamHandle,
        memberCount: maintainerAuthority.memberCount,
        digest: maintainerAuthority.digest,
        fetchedAt: maintainerAuthority.fetchedAt,
      },
      candidateCount: candidates.length,
      unchangedReviewCount: selected.reviewedUnchanged.length,
      unchangedReviewPrs: selected.reviewedUnchanged,
      openPrNumbers: rawList.filter((p) => !p.isDraft).map((p) => p.number),
      metrics: { durationMs: Date.now() - startedAt, scanConcurrency: concurrency,
        requests: results.reduce((sum, r) => sum + (r.metrics?.requests ?? 0), 0),
        retries: results.reduce((sum, r) => sum + (r.metrics?.retries ?? 0), 0) },
      totalOpen: rawList.length,
      draftSkipped: rawList.filter((p) => p.isDraft).length,
      candidates,
      scanFailures: results.filter((r) => !r.ok).map((r) => ({ pr: r.pr ?? null, error: r.error })),
      results,
      scanState: scanState
        ? { allSkip: scanState.allSkip, savedAt: scanState.savedAt }
        : { saved: false, warning: scanStateError },
      note: 'results 每条与逐候选跑 `context.mjs <PR> --scan` 的输出逐字段一致(内部就是 spawn 单 PR 模式);ok:false 的条目请单独重跑一次 `context.mjs <PR> --scan` 兜底,仍失败按跳过类记入汇总。维护者确认门状态全在每条的 signoff 字段(消费规则见 signoff.note):blocking=true 的候选写汇总用 signoff.currentBlocker(当前真正在拦的触发),别用 signoff.held.kind(那只是历史上第一次 hold 的门)。draft 一律不扫:维护者确认门不再转 draft,draft 就是作者自己的「还没写完」。空转指纹已落盘 .last-scan.json 供 scheduler 预检,skill 流程无需消费该文件',
    };
    atomicWriteJson(stateFile('last-scan-results.json'), scanResult);
    print(scanResult);
    process.exit(complete ? 0 : 1);
  } catch (e) {
    fail(e);
  }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  // [MIVO-PATCH identity-env] 格式不对在发出任何请求之前报错(fail 输出 JSON,退出码 1)。
  const viewerOverride = viewerLoginOverride();
  const argument = (name) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return '';
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
    return process.argv[i + 1];
  };
  const diffOutput = argument('--diff-output');
  const cachedContext = argument('--cached-context');
  const maintainerAuthority = loadMaintainerAuthoritySnapshot({ owner, repo, lockToken: REVIEW_LOCK_TOKEN });
  const MAINTAINERS_RAW = maintainerAuthority.members;
  const MAINTAINERS = maintainerAuthority.members;

  // ── 1.1 + 1.3 元数据 / 文件 ──
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,title,body,state,headRefName,headRefOid,isCrossRepository,baseRefName,baseRefOid,author,url,mergeable,mergeStateStatus,reviewDecision,isDraft,mergedAt,labels,createdAt',
  ]);
  const title = meta.title ?? '';
  const body = meta.body ?? '';
  const cachedCode = loadCachedCode(cachedContext, { repo: slug, pr, meta });
  const files = cachedCode.reused ? cachedCode.files : fetchRestPages(`repos/${slug}/pulls/${pr}/files`).map((f) => ({
    path: f.filename,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
  // [MIVO-PATCH handoff-lines] 本 PR 自己的交接文件(docs/pr/<PR号>/)不计入行数,见 lib.mjs countDiffLines。
  const totalDiffLines = countDiffLines(files, pr);

  // ── 获取 PR reviews，用于区分 BLOCKED 原因 ──
  // mergeStateStatus=BLOCKED 可能是"需要 approval"，也可能是 CI/冲突。
  // 如果没有 APPROVED 且没有 CHANGES_REQUESTED review → 大概率是"等待 approval"
  const prReviews = fetchRestPages(`repos/${slug}/pulls/${pr}/reviews`).map((r) => ({
    ...r, author: { login: r.user?.login, __typename: r.user?.type },
    submittedAt: r.submitted_at, commit: { oid: r.commit_id },
  }));
  const changesRequestedReviews = latestSubstantiveReviews(prReviews)
    .filter((review) => review.state === 'CHANGES_REQUESTED');
  const hasChangesRequested = changesRequestedReviews.length > 0;
  // reviewDecision 是 GitHub 聚合结论；changesRequestedReviews 也按 reviewer 只保留最后一条
  // 实质 review，避免同一人后来 APPROVED 后，历史 CR 仍冒充当前 blocker。
  const reviewDecision = meta.reviewDecision ?? null;
  const type = (title.match(/^(\w+)/)?.[1] ?? '').toLowerCase();
  const titleTypeOk = TITLE_TYPE_RE.test(title);
  const titleVague = TITLE_VAGUE_RE.test(title);
  const isLight = LIGHT_TYPES.includes(type);
  const template = type === 'fix' ? 'bugfix' : isLight ? 'light' : 'feature';
  const wantSections = template === 'bugfix' ? BUGFIX_SECTIONS : template === 'feature' ? FEATURE_SECTIONS : [];
  const sections = {};
  // 段落存在性用标题锚定(^#+ 行内含关键词),不做全文 substring:本仓段落名短
  // (如「风险」),全文 includes 会被正文里"无风险/低风险"之类误命中,硬判层失去拦截力。
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const h of wantSections) sections[h] = new RegExp('^#{1,6}\\s+.*' + escRe(h), 'im').test(body);
  const missingSections = wantSections.filter((h) => !sections[h]);

  // checklist 统计只限 self-review 标题到下一个标题之间的段内复选框——
  // description 别处的普通 TODO 清单(如「后续拆 issue」)不计入分母,防止勾选率被稀释误报。
  const checklistHeading = body.match(/^#+\s*self-review.*$/im);
  let checklistBody = '';
  if (checklistHeading) {
    const rest = body.slice(checklistHeading.index + checklistHeading[0].length);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    checklistBody = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  }
  const checklistHasSection = checklistHeading != null;
  const checklistTotal = (checklistBody.match(/^\s*- \[[ xX]\]/gm) ?? []).length;
  const checklistDone = (checklistBody.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  const checklistRatio = checklistTotal > 0 ? checklistDone / checklistTotal : 0;

  const redlinePaths = files.map((f) => f.path).filter((p) => REDLINE_PATH_RE.test(p));
  const hitsUpdater = redlinePaths.some((p) => /updater/.test(p));
  // server 改动判定(对应 SKILL「Server 改动确认 gate」:命中则合并必须经 Lizi 确认,auto 不自动合)
  const serverFiles = files.map((f) => f.path).filter((p) => (prRules.serverPaths ?? []).some((prefix) => p.startsWith(prefix)));
  const hitsServer = serverFiles.length > 0;
  const bodyHasOwnerOk = /已和\s*owner\s*确认|owner\s*确认|已确认/i.test(body);
  // CI 配置改动:决定待批 workflow 能否「自动批」(改了 CI 配置的不自动批,详见 approve-workflows.mjs)
  const ciFiles = CI_SENSITIVE_RE ? files.map((f) => f.path).filter((p) => CI_SENSITIVE_RE.test(p)) : [];
  const prTouchesCiFiles = ciFiles.length > 0;

  // UI 面路径命中(产品门与 UI 证据提醒共用;证据检查只看代码改动,排除纯 .md 文档)。
  // uiExcludePaths(多语言 locale 等纯文案数据)整体不算 UI:证据与产品门都不触发。
  const uiPathFiles = files
    .map((f) => f.path)
    .filter(
      (p) =>
        UI_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)) &&
        !UI_EXCLUDE_PREFIXES.some((prefix) => p.startsWith(prefix)),
    );
  // `.d.ts` 纯类型声明(如 vite-env.d.ts)不可能产生任何视觉变化,所以 UI 证据提醒**和产品门**
  // 都不该因它触发(2026-07-28 维护者拍板)。此前只有证据侧排除、产品门没排除,于是「主进程加
  // 一条 IPC + 只在 vite-env.d.ts 补类型声明」这类零像素 PR 会被判 touchesUi=true,进而可能被
  // 转 draft 开产品讨论 issue 等维护者确认 —— 把一个确定事实交给了每轮的语义判断。
  // 注意只排 `.d.ts`,**不排 `.md`**:uiPaths 里刻意列了 docs/design-rules/cindy-design-system.md,
  // 改设计系统文档本身就是产品/设计变更,必须继续触发产品门。
  // 测试 / mock / snapshot 路径同理确定性排除(isUiTestPath,判定与用例见 lib.mjs +
  // signoff-policy.test.mjs):测试-only 的 renderer/mobile 改动同样零像素,不该走到语义定性
  // 那一步。被排除的清单保留在输出里(uiTypeDeclFiles / uiTestFiles),汇总能说明「碰了
  // UI 路径但都是测试,所以没拦」,而不是让产品门看起来根本没触发过。
  const uiTypeDeclFiles = uiPathFiles.filter((p) => p.toLowerCase().endsWith('.d.ts'));
  const uiTestFiles = uiPathFiles.filter((p) => !p.toLowerCase().endsWith('.d.ts') && isUiTestPath(p));
  const uiFiles = uiPathFiles.filter((p) => !p.toLowerCase().endsWith('.d.ts') && !isUiTestPath(p));
  const touchesUi = uiFiles.length > 0;
  // 证据提醒再多排一层 `.md`:文档改动不产生界面,不必附截图。
  const uiCodeFiles = uiFiles.filter((p) => !p.toLowerCase().endsWith('.md'));
  // UI 证据(图片类):markdown 图片 / <img|video> 标签 / GitHub 附件与 user-images 直链(截图或录屏都算)。
  const UI_IMAGE_EVIDENCE_RE = /!\[[^\]]*\]\([^)\s]+\)|<(?:img|video)\b[^>]*src\s*=|https?:\/\/(?:user-images\.githubusercontent\.com|github\.com\/user-attachments\/assets)\/\S+|https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^)\s]+\.(?:webp|png|jpe?g|gif|svg|avif)\b/i;
  // UI 证据(HTML 类):作者贴的改动后界面 HTML 页面同样算有效证据,不因「没有图片」提醒。
  // 认四种形态:```html 代码块 / 完整 HTML 文档(<!DOCTYPE html> 或 <html>)/ .html 附件与在线预览直链 /
  // workers.xd.team 内部部署预览站直链(裸域名或带路径都算)。
  const UI_HTML_EVIDENCE_RE = /```\s*x?html?\b|<!DOCTYPE\s+html|<html[\s>]|https?:\/\/github\.com\/user-attachments\/files\/\S+\.html?\b|https?:\/\/(?:htmlpreview\.github\.io|raw\.githack\.com|codepen\.io|jsfiddle\.net|codesandbox\.io|stackblitz\.com)\/\S+|https?:\/\/(?:[a-z0-9-]+\.)*workers\.xd\.team(?![a-z0-9.-])(?:[/?#]\S*)?/i;
  // 只判「存在性」并标注证据类型;「证据内容是否与 diff 一致、界面是否符合 DESIGN.md」是语义活,由审查 agent 判。
  const bodyUiEvidenceKinds = [
    ...(UI_IMAGE_EVIDENCE_RE.test(body) ? ['image'] : []),
    ...(UI_HTML_EVIDENCE_RE.test(body) ? ['html'] : []),
  ];
  const bodyHasUiEvidence = bodyUiEvidenceKinds.length > 0;

  // ── 3.1 安全与隐私内容门(确定性扫描;打回文案与软命中定性由 LLM 做,见 SKILL 3.1)──
  // 扫描范围:PR 标题 + body(先扫,不依赖 diff 拉取成败)+ diff 新增行(逐 hunk track 新文件行号)。
  const secHits = { hard: [], soft: [] };
  const scanSensitiveText = (text, file) => {
    const lines = (text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) scanSensitiveLine(lines[i], { file, line: i + 1 }, secHits);
  };
  scanSensitiveText(title, 'PR title');
  scanSensitiveText(body, 'PR body');
  // 安全敏感改动门(SKILL 3.4)的原料与本门共用同一次 diff:危险写法 / 保护被移除 / 新增依赖。
  const riskyHits = { hard: [], soft: [] };
  const newDependencies = [];
  const dependencyFiles = new Set();
  const lockfileChanges = new Set();
  // 安全边界文件里「确实动了边界内容」的那些(见 BOUNDARY_FEATURES):路径触发的第二个条件。
  const boundaryTouchedFiles = new Set();
  let securityScanError = null;
  let scannedDiff = null;
  try {
    const diffText = cachedCode.reused ? cachedCode.diff : readPrDiff({ repo: slug, pr, meta });
    scannedDiff = diffText;
    let curFile = null;
    let curAllowed = false;
    let curRiskyAllowed = false;
    let curIsPackageJson = false;
    let curIsBoundaryFile = false;
    let newLine = 0;
    for (const raw of diffText.split('\n')) {
      if (raw.startsWith('+++ ')) {
        curFile = raw.replace(/^\+\+\+ /, '').replace(/^b\//, '').trim();
        curAllowed = curFile === '/dev/null' || (SENSITIVE_ALLOW_RE?.test(curFile) ?? false);
        curRiskyAllowed = curFile === '/dev/null' || (RISKY_ALLOW_RE?.test(curFile) ?? false);
        curIsPackageJson = DEPENDENCY_SCAN_ENABLED
          && /(?:^|\/)package\.json$/.test(curFile)
          && !(DEPENDENCY_EXCLUDE_RE?.test(curFile) ?? false);
        curIsBoundaryFile = matchPathPatterns([curFile], SECURITY_PATHS).length > 0
          && matchPathPatterns([curFile], SECURITY_EXCLUDE_PATHS).length === 0;
        if (/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(curFile)) lockfileChanges.add(curFile);
        continue;
      }
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { newLine = Number(hunk[1]); continue; }
      if (raw.startsWith('+')) {
        const added = raw.slice(1);
        if (!curAllowed && curFile) scanSensitiveLine(added, { file: curFile, line: newLine }, secHits);
        if (!curRiskyAllowed && curFile) scanRiskyLine(added, { file: curFile, line: newLine }, riskyHits);
        if (curIsBoundaryFile) scanBoundaryLine(added, curFile, boundaryTouchedFiles);
        if (curIsPackageJson) {
          const dep = matchNewDependency(added);
          if (dep) {
            newDependencies.push({ name: dep, file: curFile, line: newLine, sample: clipRisky(added) });
            dependencyFiles.add(curFile);
          }
        }
        newLine += 1;
      } else if (raw.startsWith('-')) {
        // 删除行不参与新文件行号计数;`--- a/xxx` 是 diff 头,不是内容。
        // 只判「安全保护是否被移除」——删掉 CSP / 关掉隔离那行,diff 里只有 `-` 侧看得到。
        if (!raw.startsWith('---') && !curRiskyAllowed && curFile) {
          scanRemovedGuardLine(raw.slice(1), { file: curFile, line: newLine }, riskyHits);
          // 删掉边界代码同样算「动了安全边界」(移除 exposeInMainWorld、删掉 permissions: 等)
          if (curIsBoundaryFile) scanBoundaryLine(raw.slice(1), curFile, boundaryTouchedFiles);
        }
      } else if (!raw.startsWith('\\')) {
        newLine += 1;
      }
    }
  } catch (e) {
    // diff 拉不到 ≠ 干净:scanned=false 交下游「未证明无泄露」处理,不在这里硬拦(网络抖动不该打回作者)
    securityScanError = String(e?.message ?? e);
  }
  const SECURITY_HIT_CAP = 20;
  const securityHardKinds = [...new Set(secHits.hard.map((h) => h.kind))];
  const security = {
    scanned: securityScanError == null,
    ...(securityScanError ? { error: securityScanError } : {}),
    pass: securityScanError == null && secHits.hard.length === 0,
    hardHitCount: secHits.hard.length,
    softHitCount: secHits.soft.length,
    hardHits: secHits.hard.slice(0, SECURITY_HIT_CAP),
    softHits: secHits.soft.slice(0, SECURITY_HIT_CAP),
    note: '阶段一安全与隐私内容门(SKILL 3.1):hardHits 非空 → 不进审查不合并,打回要求移除内容、清理分支历史并轮换已泄露凭证;softHits 由阶段二审查 agent 逐条定性(真实凭证/个人隐私数据=P0,测试桩/占位符放行并说明);scanned=false = diff 拉取失败、未证明干净,审查 agent 必须人工确认后才能给 pass。sample 已脱敏(前 6 字符+长度),打回评论/汇总/飞书只写文件+行号+类型,严禁引用命中原文',
  };

  // formatPass:仅硬判定层(段落实质性 / title 语言 关 3 由 LLM 判,不进此布尔)
  const formatIssues = [];
  if (!titleTypeOk) formatIssues.push('Title 缺少合规 type 前缀(feat/fix/refactor/perf/chore/docs/test/revert/build/ci,格式 `<type>(<scope>): <描述>`)');
  if (titleVague) formatIssues.push('Title 命中含糊词黑名单');
  if (template !== 'light') {
    if (missingSections.length) formatIssues.push(`Description 缺段落: ${missingSections.join(' / ')}`);
    // 本仓 PR 模板(三节制)不含 Self-review Checklist 段——不强制;
    // 作者自发写了 checklist 时才校验勾选率(勾不满说明自检没做完)。
    if (checklistHasSection && checklistTotal > 0 && checklistRatio < 0.8) {
      formatIssues.push(`Self-review 勾选率 ${checklistDone}/${checklistTotal}(<80%)`);
    }
  }
  if (hitsUpdater && !bodyHasOwnerOk) formatIssues.push('命中 cindy-updater 路径但 description 无「已和 owner 确认」(cindy-updater 是高风险模块,改动须经 Lizi 确认,见 AGENTS.md 规则 21)[阻断]');
  // UI 证据缺失不进格式门(2026-07-25 维护者拍板):不打回、不阻断合并,改为非阻断提醒——
  // 主 agent 把 uiEvidenceNotice 作为普通 PR 评论发给作者,去重靠评论里的 marker(见 SKILL 3.2)。
  const uiEvidenceMissing = uiCodeFiles.length > 0 && !bodyHasUiEvidence;
  const uiEvidenceNotice = uiEvidenceMissing
    ? `命中 UI 路径(${uiCodeFiles.slice(0, 3).join(' / ')}${uiCodeFiles.length > 3 ? ' 等' : ''})但 description 未附界面效果证据——建议补充改动后效果:截图/录屏,或改动后界面的 HTML 页面(\`\`\`html 代码块、.html 附件或在线预览链接),便于确认界面符合 DESIGN.md 设计规范`
    : null;

  // ── 1.5 + 1.6.5:GraphQL 拉历史 ──
  // ghGraphql 容忍 GraphQL 部分成功(某字段被 token 拒时其余字段仍能拿到),作通用兜底。
  const gqlResult = ghGraphql(viewerOverride ? GQL_WITHOUT_VIEWER : GQL, { owner, repo, num: pr });
  if (gqlResult?.errors?.length || !gqlResult?.data?.repository?.pullRequest || (!viewerOverride && !gqlResult?.data?.viewer?.login)) {
    throw new Error('PR 或 viewer 元数据未完整读取');
  }
  const gqlData = gqlResult.data;
  const threadResult = fetchAllReviewThreads(owner, repo, pr, { includeComments: true });
  if (!threadResult.verified) throw new Error(`review thread 未完整读取:${threadResult.errors.join('; ')}`);
  const g = {
    reviewThreads: { nodes: threadResult.threads },
    comments: { nodes: fetchRestPages(`repos/${slug}/issues/${pr}/comments`).map((c) => ({
      author: { login: c.user?.login, __typename: c.user?.type }, body: c.body,
      createdAt: c.created_at, updatedAt: c.updated_at, url: c.html_url,
    })) },
    timeline: { nodes: fetchRestPages(`repos/${slug}/pulls/${pr}/commits`).map((c) => ({
      commit: { oid: c.sha, committedDate: c.commit?.committer?.date, messageHeadline: c.commit?.message?.split('\n')[0] },
    })) },
  };
  // [MIVO-PATCH identity-env] 审查账号唯一来源:hold 标记认人、审查机 review 排除、viewerIsAuthor、评论过滤、
  // 自解死锁,以及服务器 review.mjs 用 approvalPolicy.viewer 认裁定/申辩 thread,全部从这里取。
  const viewerLogin = viewerOverride || (gqlData.viewer?.login ?? '');
  // ── 堆叠 PR(stacked)的 retarget 信号 ──
  // 非默认 base 可能是 stacked PR,也可能是正常的 release 等长期分支。
  // 只有同仓库、同 head ref 的 PR 才构成分支依赖;fork 同名分支不是这个 base。
  // base PR 一旦合并,GitHub 会把本 PR 自动 retarget 到默认分支,但**在 GitHub 完成 retarget
  // 之前**元数据里的 base 还是旧分支,diff / mergeable 也还是对旧 base 算的 —— 直接进审查会
  // 拿错基线,retarget 后才暴露冲突(实锤 #526:审完才发现)。这里给主 agent 一个显式信号:
  // 先等 retarget、重新拉元数据与 CI,再决定审还是 skip。
  // 只在 base != 默认分支时才多花一次查询(绝大多数 PR 直接跳过,scan-all 不会因此变慢)。
  const defaultBranch = gqlData.repository?.defaultBranchRef?.name ?? null;
  let basePr = null;
  let needsRetarget = false;
  let basePrLookup;
  try {
    // REST head=user:ref filters the source owner; classify also checks its full
    // repository name. Full pagination distinguishes "no PR" from a failed read.
    const pulls = defaultBranch && meta.baseRefName && meta.baseRefName !== defaultBranch
      ? fetchRestPages(`repos/${slug}/pulls?state=all&head=${encodeURIComponent(`${owner}:${meta.baseRefName}`)}`)
      : [];
    const lookup = classifyBasePrLookup({ repo: slug, pr, baseRefName: meta.baseRefName, defaultBranch, pulls });
    ({ basePr, needsRetarget } = lookup);
    basePrLookup = { verified: lookup.verified, reason: lookup.reason };
  } catch (error) {
    // A verified empty list is a normal long-lived base. A failed query remains
    // explicitly unknown so an unattended planner cannot silently treat it as empty.
    basePrLookup = { verified: false, reason: 'lookup-failed', error: String(error?.message ?? error).slice(0, 300) };
  }
  const authorLogin = meta.author?.login ?? '';
  const approvalPolicy = evaluateMaintainerApprovalPolicy({
    authorLogin,
    viewerLogin,
    authority: maintainerAuthority,
  });
  const isSelfFixAuthor = SELF_FIX_AUTHORS.includes(authorLogin.toLowerCase());
  // [MIVO-PATCH exempt-authors] 豁免名单只免审查前的维护者确认门;代码审查、最终 Approve 照常。
  const authorSignoffExempt = approvalPolicy.authorIsMaintainer || isSignoffExemptAuthor(authorLogin, prRules);
  // [MIVO-PATCH ui-evidence] 改界面不等维护者确认,改为要求附界面证据:按 requireUiEvidence 缺证据进格式门(打回补证据)。
  const uiEvidenceDeclaredNotApplicable = declaresNoUiChange(body);
  // requireUiEvidence=non-admin:只在真缺证据时读一次作者的仓库权限;读不到按不是 admin(要证据),原因写进 uiEvidenceAuthorAdmin。
  let uiEvidenceAuthorAdmin = null;
  if (uiEvidenceMissing && !uiEvidenceDeclaredNotApplicable && authorLogin && uiEvidenceNeedsAdminLookup(prRules)) {
    const r = gh(['api', '--method', 'GET', `repos/${slug}/collaborators/${encodeURIComponent(authorLogin)}/permission`], { allowFail: true, timeoutMs: 20_000 });
    try {
      uiEvidenceAuthorAdmin = r.ok !== false ? { verified: true, admin: isAdminPermission(JSON.parse(r.stdout)) } : { verified: false, admin: false, error: String(r.stderr ?? '').slice(0, 200) };
    } catch (error) {
      uiEvidenceAuthorAdmin = { verified: false, admin: false, error: String(error?.message ?? error).slice(0, 200) };
    }
  }
  const uiEvidenceRequired = isUiEvidenceRequired({ uiEvidenceMissing, authorExempt: authorSignoffExempt,
    authorIsAdmin: uiEvidenceAuthorAdmin?.admin === true, declaredNotApplicable: uiEvidenceDeclaredNotApplicable }, prRules);
  if (uiEvidenceRequired) {
    formatIssues.push(`缺界面证据:改了界面(${uiCodeFiles.slice(0, 3).join(' / ')}${uiCodeFiles.length > 3 ? ' 等' : ''}),但描述里没有改动后的截图/录屏或 HTML 界面。请在「效果展示」里补上(图片、\`\`\`html 代码块、.html 附件或在线预览链接都可以);这次改动看不出界面变化的,在「效果展示」第一行写「不涉及」`);
  }
  const formatPass = formatIssues.length === 0;

  // 1.5.2 review threads
  const rawThreads = g.reviewThreads?.nodes ?? [];
  const reviewThreads = rawThreads.map((t) => {
    const cs = t.comments?.nodes ?? [];
    return {
      // id 是 GraphQL thread node id,resolve-threads.mjs 代 resolve 时要用
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line ?? null,
      author: cs[0]?.author?.login ?? '(unknown)',
      isBot: isBot(cs[0]?.author),
      createdAt: cs[0]?.createdAt ?? null,
      count: cs.length,
      comments: cs,
      lastComment: clip(cs[cs.length - 1]?.body, 300),
    };
  });

  // 1.5.1 issue comments
  const rawComments = g.comments?.nodes ?? [];
  const comments = rawComments.map((c) => ({
    author: c.author?.login ?? '(unknown)',
    isBot: isBot(c.author),
    createdAt: c.createdAt,
    url: c.url,
    body: c.body,
  }));

  // 1.5.3 commits 时间线
  const commits = (g.timeline?.nodes ?? []).map((n) => ({
    oid: (n.commit?.oid ?? '').slice(0, 8),
    date: n.commit?.committedDate,
    headline: n.commit?.messageHeadline,
  }));
  const latestCommitDate = commits.reduce((mx, c) => (c.date > mx ? c.date : mx), '');

  // ── 维护者确认门(signoff gate):六类触发,一套确认机制(详见 SKILL「维护者确认门」)──
  // hold 标记(signoff-hold.mjs 写入):非空 = 该 PR 被维护者确认门 hold 过,记录当初开的讨论 issue。
  // 通过有两条路径,统一在 evalSignoffKind 里判(2026-07-30 维护者拍板统一到 GitHub review):
  //   ① GitHub Approve(主路径,六类同一口径):当前 head 的 Request Changes 先交作者修改;
  //      作者新提交将它消费后,任一维护者历史 Approve 持久放行,不重新亮确认门。
  //      evaluator 必须拿完整 review 历史,不能先按 reviewer 截成最新一条,否则同一维护者
  //      后来的 Request Changes 会把他更早的 Approve 从历史中抹掉;
  //   ② 通过标记(signoff-release.mjs 写入)——维护者明确指示通过时的手动兜底,
  //      只对标记之后的当前 head 有效,也让历史状态继续可读取。
  // 摘维护者确认标签、讨论 issue / PR 评论 / Slack 同步留言均不构成通过(评论只做信息位进汇总)。
  // 当前 head 的 Approve / Request Changes 由流程自己按时间判断,不依赖仓库是否开启
  // dismiss stale approvals:Approve 只通过当时的 head;Request Changes 后先摘标签交给作者,
  // 作者新 push 且仍命中触发时重新挂标签等待维护者。
  const holdMarker = parseLastHoldMarker(rawComments.map((c) => ({ body: c.body, createdAt: c.createdAt, author: c.author })), { viewerLogin });
  const inMaintainers = (login) => MAINTAINERS.includes((login ?? '').toLowerCase());
  const releaseEvents = parseSignoffReleaseEvents(
    rawComments.map((c) => ({ body: c.body, createdAt: c.createdAt, author: c.author })),
  );
  const {
    trusted: releaseMarks,
    untrusted: untrustedReleaseMarks,
  } = selectTrustedSignoffReleases(releaseEvents, MAINTAINERS);
  const viewerLower = viewerLogin.toLowerCase();
  // [MIVO-PATCH self-review] 确认门只看维护者本人的表态:审查账号自动提交的 review(带本流程标记)不计入。
  const signoffReviews = prReviews.filter((r) => !isAutomatedViewerReview(r, viewerLower));
  // maintainers 成员的 GitHub review(信息位;通过判定在 evalSignoffKind 里按「每人最新实质
  // review」另算):非 viewer 的成员任意 state 都列;viewer(本流程自动化账号)只列
  // APPROVED——自动化自己会以 viewer 身份发 REQUEST_CHANGES(打回),不能当维护者确认信号;
  // approve-reviewed-pr 只发生在门已过、重审通过之后,时序上不可能反向豁免一个被拦着的 PR。
  const maintainerReviews = prReviews
    .filter((r) => {
      const login = (r.author?.login ?? '').toLowerCase();
      if (!inMaintainers(login)) return false;
      return login !== viewerLower || r.state === 'APPROVED';
    })
    .map((r) => ({ author: r.author?.login ?? '', state: r.state, submittedAt: r.submittedAt }));
  const maintainerApprovals = maintainerReviews.filter((r) => r.state === 'APPROVED');
  // product 触发:feat 类型或命中 UI 面路径(是否真属产品/UI 变更由主 agent 语义定性,
  // bugfix / 已有功能补充 / 纯技术改动不 hold)。
  // [MIVO-PATCH ui-evidence] signoffGate.product.enabled=false 时产品/UI 门不触发;uiPaths 仍用于界面证据判定。
  const productTriggered = isProductSignoffEnabled(prRules) && (type === 'feat' || touchesUi);
  // 讨论 issue 的维护者留言(信息位:2026-07-30 起评论不再构成通过——只认 GitHub
  // Approve 与 signoff-release 标记;留言仍收集,供汇总展示「维护者表过态但还没 Approve」
  // 并提醒对方去 PR 上 Approve。仅命中门的 PR 才查,省 API):
  // 从 PR 评论里 signoff-hold.mjs 的隐藏标记读出当初开的讨论 issue(取最后一条带 issue= 的标记,与
  // signoff-hold 口径一致),拉 issue 全部评论、过滤出维护者的留言原文。viewer 账号在讨论期间
  // 不会往 issue 发言(只在 PR 合并后 close 时发),所以 open issue 上 viewer 的留言可视为本人人肉发言。
  /**
   * 读取该 PR 被 hold 时开的讨论 issue + 其中维护者留言(产品门 / 架构门共用——
   * hold 机制是同一套 signoff-hold.mjs,marker 同前缀(兼容旧 kind=arch 形态);
   * 维护者判定由 maintainerFn 注入)。未被 hold 过返回 null。
   */
  function readDiscussionIssue(maintainerFn) {
    const heldIssueUrl = holdMarker?.issueUrl ?? null;
    const issueNum = holdMarker?.issueNumber ?? null;
    if (issueNum) {
      try {
        const issueMeta = ghJson(['issue', 'view', String(issueNum), '--repo', slug, '--json', 'state,comments,updatedAt,title,body']);
        // 维护者留言两个来源:① 维护者成员本人直接评论;② Slack 同步 bot 代发的评论——
        // GitHub 作者是 bot,真实发言人在正文「发送者:<名字>」里,拿名字去 org 名录反查
        // GitHub 账号(要求唯一命中)再对维护者。名录只在真的碰到 bot 评论时才加载(省 IO)。
        const maintainerComments = [];
        const unattributedSlackComments = [];
        let maintainerErrors = null;
        let orgRosterCache = null;
        for (const c of issueMeta.comments ?? []) {
          const login = c.author?.login ?? '';
          if (maintainerFn(login)) {
            maintainerComments.push({ author: login, createdAt: c.createdAt, body: clip(c.body, 600) });
            continue;
          }
          if (!SLACK_SYNC_BOTS.includes(normalizeBotLogin(login))) continue;
          // 新版同步署名:「来自 Slack #<频道> · @<GitHub login>(<显示名>)」——直接带 GitHub
          // 账号,零反查即可归属(信任锚仍是 bot 作者本身,普通用户的评论进不了本分支)。
          const inlineLogin = (c.body ?? '').match(/来自\s*Slack[^\n]*?·\s*@([A-Za-z0-9][A-Za-z0-9-]*)/)?.[1] ?? null;
          if (inlineLogin) {
            if (maintainerFn(inlineLogin)) {
              maintainerComments.push({ author: login, via: 'slack-sync', sender: inlineLogin, resolvedLogin: inlineLogin.toLowerCase(), resolvedBy: 'inline-login', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            continue; // 归属已确定:非维护者 = 普通参与讨论者,静默忽略
          }
          // 旧版署名:「发送者:」后是真人名字;冒号全角(：)半角都兼容。两种署名都没有的
          // 同步评论是 AI 机器人自己的回复(如「本评论由 Cindy ... 回复后自动同步而来」),
          // 非人类发言,静默跳过——既不计维护者,也不进 unattributed 刷屏。
          const sender = (c.body ?? '').match(/发送者\s*[:：]\s*([^\n\r]+)/)?.[1]?.trim() ?? null;
          if (!sender) continue;
          // 别名优先(不依赖名录,零 IO):命中即定论,维护者进留言、非维护者静默忽略
          const aliasLogin = SLACK_SENDER_ALIASES[sender.toLowerCase()] ?? null;
          if (aliasLogin) {
            if (maintainerFn(aliasLogin)) {
              maintainerComments.push({ author: login, via: 'slack-sync', sender, resolvedLogin: aliasLogin, resolvedBy: 'alias', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            continue;
          }
          if (!orgRosterCache) {
            const loaded = loadOrgRosters(prRules.orgMappingRepos ?? []);
            orgRosterCache = loaded.rosters;
            maintainerErrors = loaded.fetchErrors.length ? loaded.fetchErrors : null;
          }
          // 名字 → 名录行 → GitHub login:行里必须真解析出 name 且与发送者一致(相等或包含,
          // 兼容「陈祝宇 (Zhuyu)」这类带备注的名录写法),防止名字子串误中别的单元格。
          const logins = new Set();
          for (const { text } of orgRosterCache) {
            for (const line of text.split('\n')) {
              if (!line.includes('|') || !line.includes(sender)) continue;
              const parsed = parseRosterLine(line);
              if (!parsed?.githubLogin || !parsed.name) continue;
              if (parsed.name === sender || parsed.name.includes(sender)) logins.add(parsed.githubLogin.toLowerCase());
            }
          }
          if (logins.size === 1) {
            const resolvedLogin = [...logins][0];
            if (maintainerFn(resolvedLogin)) {
              maintainerComments.push({ author: login, via: 'slack-sync', sender, resolvedLogin, resolvedBy: 'org-roster', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            // 唯一命中但不在维护者 → 普通参与讨论者,静默忽略
          } else {
            // 名录没这人 / 同名多人 → 归属不了,不计维护者也不丢弃信息,交主 agent 酌情上报
            unattributedSlackComments.push({ sender, createdAt: c.createdAt, reason: logins.size === 0 ? 'name-not-in-roster' : 'ambiguous-name', body: clip(c.body, 200) });
          }
        }
        // 归属不了的按发送者去重(同一人刷屏几十条没必要全带),留最新一条 + 总条数
        const unattributedBySender = [...new Map(
          unattributedSlackComments.map((u) => [u.sender, u]),
        ).values()].map((u) => ({
          ...u,
          count: unattributedSlackComments.filter((x) => x.sender === u.sender).length,
          createdAt: unattributedSlackComments.filter((x) => x.sender === u.sender).map((x) => x.createdAt).sort().pop(),
        }));
        // [MIVO-PATCH slack-release / issue-comment-release / issue-binding] 讨论串里维护者的明确「同意放行」
        // (Slack 同步评论,或维护者直接在 issue 下评论)构成放行(判据见 lib.mjs)。issue 必须属于本 PR 且不是通知 issue。
        const releases = selectDiscussionIssueReleases({
          issue: issueMeta,
          pr,
          syncBots: prRules.slackSyncBots ?? [],
          maintainers: MAINTAINERS,
          authorLogin,
          consentLine: SG.slackRelease?.consentLine ?? '同意放行',
          slackEnabled: SG.slackRelease?.enabled === true,
          commentEnabled: SG.issueCommentRelease?.enabled === true,
          prCreatedAt: meta.createdAt ?? null,
        });
        return {
          url: heldIssueUrl,
          number: Number(issueNum),
          state: issueMeta.state ?? null,
          updatedAt: issueMeta.updatedAt ?? null,
          mode: releases.mode,
          ...(releases.releaseUntrusted ? { releaseUntrusted: releases.releaseUntrusted } : {}),
          slackRelease: releases.slackRelease,
          ...(releases.slackReleaseRejected.length ? { slackReleaseRejected: releases.slackReleaseRejected } : {}),
          issueCommentRelease: releases.issueCommentRelease,
          ...(releases.issueCommentReleaseRejected.length ? { issueCommentReleaseRejected: releases.issueCommentReleaseRejected } : {}),
          maintainerComments,
          ...(unattributedBySender.length ? { unattributedSlackComments: unattributedBySender } : {}),
          ...(maintainerErrors ? { maintainerErrors } : {}),
        };
      } catch (e) {
        // issue 读不到(被删 / 权限 / 网络)→ 保留 URL 供人工查看,maintainerComments=null 表示「未知」,
        // 主 agent 不得把「未知」当「无同意」直接再 hold 骚扰,应如实进汇总让 owner 看一眼。
        return { url: heldIssueUrl, number: Number(issueNum), state: null, updatedAt: null, maintainerComments: null, error: String(e?.message ?? e).slice(0, 200) };
      }
    }
    return null;
  }

  // PR 内维护者留言(信息位,与讨论 issue 留言同口径:不构成通过,只供汇总展示与提醒
  // 成员去 Approve)。两类评论必须剔除:① viewer(本流程自动化账号)的评论——自动化会以
  // viewer 身份发 hold 告知、resolve 催办等 PR 评论(催办评论不带隐藏标记,无法可靠区分
  // 人肉/机器),一律不列;② 带 `<!-- review-pr:` 隐藏标记的评论——自动化产物
  // (hold / release 告知),即使发帖账号后来换过也不能当人肉表态。
  // Slack 同步 bot 只写讨论 issue 不写 PR,这里不做 bot 归属。
  function collectPrMaintainerComments(maintainerFn) {
    return rawComments
      .filter((c) => {
        const login = (c.author?.login ?? '').toLowerCase();
        if (!maintainerFn(login) || login === viewerLower) return false;
        return !(c.body ?? '').includes('<!-- review-pr:');
      })
      .map((c) => ({ author: c.author?.login ?? '', createdAt: c.createdAt, url: c.url, body: clip(c.body, 600) }));
  }

  // [MIVO-PATCH slack-release] 讨论 issue 在评各类确认门之前读:Slack 放行要参与放行判定。
  // 只有被 hold 过(有讨论 issue)才读,和上游「触发在场才读」的 API 开销一致。
  const anySignoffMaintainer = (login) => inMaintainers(login);
  const earlyDiscussionIssue = holdMarker?.issueNumber ? readDiscussionIssue(anySignoffMaintainer) : null;
  const slackRelease = earlyDiscussionIssue?.slackRelease ?? null;
  const issueCommentRelease = earlyDiscussionIssue?.issueCommentRelease ?? null;
  const issueRelease = latestIssueRelease(slackRelease, issueCommentRelease);

  // 冷更触发器:CI fingerprint guard 的 sticky comment 是权威结论(它在同一 runner 上真算过
  // base(main) 与合并结果两份指纹),压过路径启发式两个方向:
  //   - guard 说变 → 一定触发冷更,即便没碰 coldUpdatePaths(原生依赖版本可能只体现在 lockfile 上);
  //   - guard 说没变 → 路径命中也不触发(只改 eas.json 的 beta-* profile、或被 app.config.js
  //     剥离/覆写而进不到 resolved config 的字段,都是指纹中性的)。
  // 结论行由 apps/mobile/scripts/ci-fingerprint.mjs 的 guardChangedMarker 写入(机器可读);
  // 老版 guard 评论没有该行时退回标题文案判定,两者都读不出 → changed=null(当作未知,不通过,
  // 由路径启发式接管)。guard 评论是 sticky(原地更新),取最后一条并带 updatedAt 供主 agent
  // 判断结论是否已覆盖最新 head。
  const coldUpdateGuard = parseFingerprintGuard(rawComments, COLD_UPDATE_GUARD_MARKER, latestCommitDate);
  const coldUpdateFiles = matchPathPatterns(files.map((f) => f.path), ARCH_COLD_UPDATE_PATHS);
  const coldUpdateTrigger = coldUpdateGuard?.changed === true
    ? `cold-update-confirmed(fingerprint guard 判定合并后指纹变化 → 必须冷更出包${coldUpdateFiles.length ? `;命中指纹输入 ${coldUpdateFiles.slice(0, 5).join(' / ')}` : ''})`
    : coldUpdateGuard?.changed === false
      ? null
      : coldUpdateFiles.length > 0
        ? `cold-update-suspect(改到指纹输入 ${coldUpdateFiles.slice(0, 5).join(' / ')}${coldUpdateFiles.length > 5 ? ' 等' : ''}${coldUpdateGuard ? ';guard 结论读不出' : ';无 guard 结论'} → 需确认是否触发冷更)`
        : null;
  // 规则文档触发器:命中 rulesPaths 即触发,不设阈值、无 guard 之类的权威二级信号可压
  // (理由见文件头 RULE_DOC_PATHS 注释)。语义活只有「把关人是否已针对本次规则改动确认」,
  // 不判「是否较大架构调整」——一行删掉一条硬性要求同样要拦。
  const ruleDocCandidates = matchPathPatterns(files.map((f) => f.path), RULE_DOC_PATHS);
  const ruleDocFiles = ruleDocCandidates
    .filter((p) => matchPathPatterns([p], RULE_DOC_EXCLUDE_PATHS).length === 0);
  // 被排除掉的候选留在输出里:汇总要能说明「碰了 docs/legal/ 但那是机器生成产物,所以没拦」,
  // 而不是让本门看起来根本没触发过。
  const ruleDocExcludedFiles = ruleDocCandidates.filter((p) => !ruleDocFiles.includes(p));
  const ruleDocTrigger = ruleDocFiles.length > 0
    ? `rules-change(改到规则文档 ${ruleDocFiles.slice(0, 5).join(' / ')}${ruleDocFiles.length > 5 ? ' 等' : ''} → 审查判据自身变更,需维护者明确确认)`
    : null;
  // 插件基座触发器:命中 pluginBasePaths 即触发,同样不设阈值(理由见文件头 PLUGIN_BASE_PATHS
  // 注释)。语义活只有「维护者是否已针对存量插件影响确认」,不判「是否较大架构调整」——
  // 一个必填字段就能让全部存量安装失效。
  const pluginBaseCandidates = matchPathPatterns(files.map((f) => f.path), PLUGIN_BASE_PATHS);
  const pluginBaseFiles = pluginBaseCandidates
    .filter((p) => matchPathPatterns([p], PLUGIN_BASE_EXCLUDE_PATHS).length === 0);
  const pluginBaseExcludedFiles = pluginBaseCandidates.filter((p) => !pluginBaseFiles.includes(p));
  const pluginBaseTrigger = pluginBaseFiles.length > 0
    ? `plugin-base(改到插件基座 ${pluginBaseFiles.slice(0, 5).join(' / ')}${pluginBaseFiles.length > 5 ? ' 等' : ''} → 影响全部已装插件,需维护者对存量插件兼容明确确认)`
    : null;
  // 受保护路径(.github/** 等):命中即不自动合并,交人工处理。
  const protectedFiles = matchPathPatterns(files.map((f) => f.path), PROTECTED_PATHS);
  // [MIVO-PATCH protected-signoff] 受保护路径的人工放行(不绑 head,持久有效):未撤销的维护者 Approve,
  // 或确认 issue 上的 Slack / GitHub 评论「同意放行」。Mini 判门与服务器复核各自重跑本 context 读它。
  // [MIVO-PATCH protected-author-release] 作者是维护者(authorSignoffExempt:维护者集合或 exemptAuthors)时放行直接成立;
  // 「作者是不是维护者」只在这里判一次,Mini 判门与服务器 prepareProtectedApprove 都只读 protectedPath.released。
  const protectedPath = evaluateProtectedPathRelease({
    protectedFiles, reviews: signoffReviews, maintainers: MAINTAINERS_RAW, latestCommitDate, issueRelease, authorLogin,
    authorExempt: authorSignoffExempt,
  });
  // 安全敏感改动触发器:三路取并集,任一命中即触发(口径见 SECURITY_PATHS 注释)。
  // 与规则文档门一样不设 diff 阈值 —— 一行 `contextIsolation: false` 与重写整个 preload 同级。
  // 危险写法样本已由 clipRisky 把凭证脱敏,但仍是代码原文:打回评论只写文件/行号/类型,
  // 需要引用时引用改动本身,不要把整行代码抄进飞书汇总。
  // 命中 securityPaths 的文件(路径层),与其中「确实动了边界内容」的文件(内容层)。
  // 触发只看后者 —— 前者保留在输出里供汇总说明「碰了但没动边界,所以没拦」。
  const securityPathCandidates = matchPathPatterns(files.map((f) => f.path), SECURITY_PATHS)
    .filter((p) => matchPathPatterns([p], SECURITY_EXCLUDE_PATHS).length === 0);
  const securityPathFiles = securityPathCandidates.filter((p) => boundaryTouchedFiles.has(p));
  const riskyHardKinds = [...new Set(riskyHits.hard.map((h) => h.kind))];
  const newDependencyNames = [...new Set(newDependencies.map((d) => d.name))];
  const securityReasons = [
    securityPathFiles.length > 0
      ? `安全边界内容变更(${securityPathFiles.slice(0, 5).join(' / ')}${securityPathFiles.length > 5 ? ' 等' : ''})`
      : null,
    riskyHits.hard.length > 0
      ? `危险写法 ${riskyHits.hard.length} 处(${riskyHardKinds.slice(0, 5).join(' / ')})`
      : null,
    newDependencyNames.length > 0
      ? `新增第三方依赖 ${newDependencyNames.slice(0, 5).join(' / ')}${newDependencyNames.length > 5 ? ' 等' : ''}`
      : null,
  ].filter(Boolean);
  // diff 拉取失败时不凭空触发本门(没有扫描原料),但路径触发仍然有效——它只依赖文件列表。
  const securityTrigger = securityReasons.length > 0
    ? `security-sensitive(${securityReasons.join(';')} → 影响用户隐私/系统安全,需维护者明确确认)`
    : null;
  // arch 触发器(核心路径改动量 / refactor 大 diff / 超大 diff;阈值配置在 signoffGate.arch)
  const archCoreFiles = files.filter((f) => ARCH_CORE_PATHS.some((prefix) => f.path.startsWith(prefix)));
  const archCoreDiffLines = archCoreFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  const archDetails = [
    archCoreFiles.length > 0 && archCoreDiffLines >= ARCH_CORE_DIFF_LINES ? `core-paths(核心路径改动 ${archCoreDiffLines} 行 ≥ ${ARCH_CORE_DIFF_LINES})` : null,
    type === 'refactor' && totalDiffLines >= ARCH_REFACTOR_DIFF_LINES ? `refactor-large(refactor 类型且 ${totalDiffLines} 行 ≥ ${ARCH_REFACTOR_DIFF_LINES})` : null,
    totalDiffLines >= ARCH_ANY_DIFF_LINES ? `huge-diff(${totalDiffLines} 行 ≥ ${ARCH_ANY_DIFF_LINES})` : null,
  ].filter(Boolean);
  const archTrigger = archDetails.length > 0 ? archDetails.join(' + ') : null;

  // ── 统一维护者确认判定:六类触发各评一次,名单、通过路径、豁免口径全部一致 ──
  const KIND_MAINTAINERS = {
    product: { raw: MAINTAINERS_RAW },
    arch: { raw: MAINTAINERS_RAW },
    security: { raw: MAINTAINERS_RAW },
    coldUpdate: { raw: MAINTAINERS_RAW },
    rules: { raw: MAINTAINERS_RAW },
    pluginBase: { raw: MAINTAINERS_RAW },
  };
  const evalSignoffKind = (kind, detail, extra = {}) => {
    const a = KIND_MAINTAINERS[kind];
    const authorIsMaintainer = approvalPolicy.authorIsMaintainer;
    // [MIVO-PATCH slack-release / issue-comment-release] 手动标记优先,其次讨论 issue 里的明确同意(Slack 或 issue 评论);都按标记口径持久有效。
    const markerRelease = releaseMarks.get(kind) ?? issueRelease ?? null;
    // GitHub Approve 通过(六类统一):完整历史交给 evaluator。当前 head 的 CR 优先交作者;
    // 作者新提交消费 CR 后,历史 Approve 持久放行,包括同一维护者先 Approve 后 CR 的序列。
    const reviewState = evaluateMaintainerReview({
      reviews: signoffReviews,
      maintainers: a.raw,
      latestCommitDate,
      markerRelease,
      authorLogin,
    });
    return {
      kind,
      detail,
      maintainers: a.raw,
      enabled: true,
      authorIsMaintainer,
      authorExempt: authorSignoffExempt,
      released: reviewState.released,
      reviewState: reviewState.reviewState,
      waitingForAuthor: reviewState.waitingForAuthor,
      needsRecheck: reviewState.needsRecheck,
      blocking: evaluateSignoffBlocking({
        enabled: true,
        authorIsMaintainer: authorSignoffExempt,
        waitingForAuthor: reviewState.waitingForAuthor,
        released: reviewState.released,
      }),
      ...extra,
    };
  };
  // 只装配「已触发」的类别;kind 专属明细挂在各自条目上(--scan 模式截短命中明细)
  const isScanOutput = process.argv.includes('--scan');
  const RISKY_HIT_CAP = isScanOutput ? 5 : 30;
  const signoffTriggers = [];
  if (productTriggered) {
    signoffTriggers.push(evalSignoffKind(
      'product',
      [type === 'feat' ? 'feat 类型' : '', touchesUi ? `命中 UI 路径(${uiFiles.slice(0, 3).join(' / ')}${uiFiles.length > 3 ? ' 等' : ''})` : ''].filter(Boolean).join(' + '),
      { uiFiles: uiFiles.slice(0, 30), uiTypeDeclFiles, uiTestFiles: uiTestFiles.slice(0, 30), touchesUi, maintainerReviews, maintainerApprovals },
    ));
  }
  if (securityTrigger) {
    signoffTriggers.push(evalSignoffKind('security', securityTrigger, {
      reasons: securityReasons,
      pathFiles: securityPathFiles.slice(0, 30),
      pathCandidates: securityPathCandidates.slice(0, 30),
      riskyHardHitCount: riskyHits.hard.length,
      riskyHardKinds,
      riskyHardHits: riskyHits.hard.slice(0, RISKY_HIT_CAP),
      newDependencies: newDependencies.slice(0, RISKY_HIT_CAP),
      newDependencyNames,
      dependencyFiles: [...dependencyFiles],
      lockfileChanges: [...lockfileChanges],
      diffScanned: securityScanError == null,
    }));
  }
  if (ruleDocTrigger) {
    signoffTriggers.push(evalSignoffKind('rules', ruleDocTrigger, {
      files: ruleDocFiles.slice(0, 30),
      excludedFiles: ruleDocExcludedFiles.slice(0, 30),
    }));
  }
  if (pluginBaseTrigger) {
    signoffTriggers.push(evalSignoffKind('pluginBase', pluginBaseTrigger, {
      files: pluginBaseFiles.slice(0, 30),
      excludedFiles: pluginBaseExcludedFiles.slice(0, 30),
    }));
  }
  if (coldUpdateTrigger) {
    signoffTriggers.push(evalSignoffKind('coldUpdate', coldUpdateTrigger, {
      guard: coldUpdateGuard,
      files: coldUpdateFiles.slice(0, 30),
    }));
  }
  if (archTrigger) {
    signoffTriggers.push(evalSignoffKind('arch', archTrigger, {
      coreFilePaths: archCoreFiles.map((f) => f.path).slice(0, 30),
      coreDiffLines: archCoreDiffLines,
      totalDiffLines,
    }));
  }
  const blockingTriggers = signoffTriggers.filter((t) => t.blocking);
  const signoffBlocking = blockingTriggers.length > 0;
  // currentBlocker 按处置优先级:product(方向没对齐时别的讨论为时过早)→ security
  // (损失不可回滚)→ pluginBase(全量存量用户同时受影响,且判据与安全常常互为条件)→
  // rules → coldUpdate → arch
  const KIND_PRIORITY = ['product', 'security', 'pluginBase', 'rules', 'coldUpdate', 'arch'];
  const currentBlocker = KIND_PRIORITY
    .map((k) => blockingTriggers.find((t) => t.kind === k))
    .find(Boolean) ?? null;

  // 讨论 issue 与 PR 内维护者留言:任一触发在场就读(信息位,不构成通过)。
  // softHit 定性等语义活照旧交主 agent / 审查 agent。
  const discussionIssue = signoffTriggers.length > 0 ? earlyDiscussionIssue : null;
  const prMaintainerComments = signoffTriggers.length > 0 ? collectPrMaintainerComments(anySignoffMaintainer) : null;
  // 各在拦触发的维护者表态材料(信息位:维护者在评论里表过态但没 Approve 时,汇总提示
  // 对方去 PR 上 Approve;不作为通过依据)
  const collectMaintainerComments = (maintainersLower) => {
    const isMaintainer = (login) => maintainersLower.includes((login ?? '').toLowerCase());
    return [
      ...(discussionIssue?.maintainerComments ?? [])
        .filter((c) => isMaintainer(c.resolvedLogin ?? c.author))
        .map((c) => ({ from: 'discussion-issue', ...c })),
      ...rawComments
        .filter((c) => isMaintainer(c.author?.login) && !(c.body ?? '').includes('<!-- review-pr:'))
        .map((c) => ({
          from: 'pr-comment',
          author: c.author?.login ?? '',
          viaViewerAccount: (c.author?.login ?? '').toLowerCase() === viewerLower,
          createdAt: c.createdAt,
          url: c.url,
          body: clip(c.body, 600),
        })),
    ];
  };
  for (const t of blockingTriggers) {
    t.maintainerComments = collectMaintainerComments(t.maintainers.map((s) => s.toLowerCase()));
  }

  // 维护者确认标签状态(新标签 + 旧标签迁移)
  const currentLabelNames = (meta.labels ?? []).map((l) => l.name);
  const hasSignoffLabel = currentLabelNames.includes(SIGNOFF_LABEL);
  const legacyGateLabels = currentLabelNames.filter((n) => LEGACY_GATE_LABELS.includes(n));
  const hasAnySignoffLabel = hasSignoffLabel || legacyGateLabels.length > 0;
  const signoff = {
    label: SIGNOFF_LABEL,
    maintainers: MAINTAINERS_RAW,
    authority: {
      verified: true,
      teamHandle: maintainerAuthority.codeowners.teamHandle,
      teamMemberCount: maintainerAuthority.teamMemberCount,
      allowlistedMemberCount: maintainerAuthority.allowlistedMemberCount,
      allowlistedMembers: maintainerAuthority.allowlistedMembers,
      memberCount: maintainerAuthority.memberCount,
      digest: maintainerAuthority.digest,
      fetchedAt: maintainerAuthority.fetchedAt,
      codeownersPath: maintainerAuthority.codeowners.path,
      baseRef: maintainerAuthority.base.ref,
      baseSha: maintainerAuthority.base.sha,
    },
    untrustedReleaseMarks,
    authorExempt: authorSignoffExempt,
    slackRelease,
    issueCommentRelease,
    heldIssue: earlyDiscussionIssue
      ? {
        number: earlyDiscussionIssue.number, state: earlyDiscussionIssue.state, mode: earlyDiscussionIssue.mode ?? 'normal',
        // [MIVO-PATCH issue-binding] 写 issue(补关)前要知道它是不是绑定本 PR:issue-not-bound 时不能写。
        ...(earlyDiscussionIssue.releaseUntrusted ? { releaseUntrusted: earlyDiscussionIssue.releaseUntrusted } : {}),
      }
      : null,
    triggers: signoffTriggers,
    blocking: signoffBlocking,
    currentBlocker: currentBlocker ? { kind: currentBlocker.kind, detail: currentBlocker.detail } : null,
    held: holdMarker,
    discussionIssue,
    prMaintainerComments,
    labels: {
      hasLabel: hasSignoffLabel,
      hasAnyLabel: hasAnySignoffLabel,
      desired: signoffBlocking,
      stale: hasSignoffLabel !== signoffBlocking || legacyGateLabels.length > 0,
      legacyToRemove: legacyGateLabels,
    },
    note: '维护者讨论门:六类触发共用 CODEOWNERS 唯一 `* @org/team` 根 Team active 成员与 maintainerAllowlist 的并集。authorIsMaintainer=true 时不在审查前重复 hold，由本轮独立代码审查完成后自动走 guarded Approve；它不再豁免最终 Approve。普通评论、旧 hold 记录和摘标签不构成通过;waitingForAuthor=true 表示当前 head 被维护者 Request Changes。released 只认最终维护者集合成员的 GitHub Approve,或 `by` 仍在最终集合的 signoff-release 手动标记;缺 by / 非成员标记列在 untrustedReleaseMarks,绝不放行。Approve 仍按现行策略持久有效,但审批人从 Team 和白名单都移除后其旧 Approve 不再算维护者确认。authority.digest 必须一路带到 guarded approve / dismiss / pre-merge,任何变化都重新启动 review。标签 awaiting-discussion 只同步外部状态,失败不改变内部判定但必须进异常汇总;汇总写 currentBlocker,不写 held.kind',
  };
  // ── 1.6.5.1 CI 总门(2026-08-04 起本脚本**直接读 CI**,不再只靠 meta.mergeStateStatus 间接体现)──
  // 旧口径的洞:GitHub 只把 required check 失败算进 BLOCKED,非 required 的红 CI 给的是
  // UNSTABLE —— 只在 BLOCKED 时看 CI 等于对它完全不设防。现无条件读双源:
  //   - rollup(statusCheckRollup):覆盖全部 CI 来源(Actions / 外部 check-run / commit status),
  //     required 与非 required 一视同仁;fine-grained PAT 可能读不到 → null;
  //   - ciRuns(classifyHeadChecks,actions/runs):rollup 403 时的兜底 + awaiting 探测
  //     (fork / 首次贡献者 workflow 待批准才能跑 —— 待批时 check run 常根本不出现在 rollup 里。
  //     这与 blockedAwaitingApproval(缺 reviewer approval)是两个不同的 BLOCKED 来源,不要混;
  //     真批由 approve-workflows.mjs 做,这里只探测供 1.7 报告 + auto 分流)。
  // 总判定单一真相源在 lib.mjs evaluateCiStatus(单测 ci-status.test.mjs):
  // **ci.status=pass(全绿或无任何 check)才可合并**;unknown(两源都读不到 / UNSTABLE 但
  // 已读到的来源全绿)不得视为通过。权限/网络异常降级为 null,绝不炸掉 context。
  // [MIVO-PATCH ci-ignore] 本流程自己的 review-pr check 不算作者 CI,否则会自己拦自己。
  const rawRollupContexts = fetchCiRollup(slug, pr);
  const rollupContexts = filterIgnoredCiContexts(rawRollupContexts, prRules);
  const rollup = rollupContexts ? classifyRollupContexts(rollupContexts) : null;
  const { ciRuns } = classifyHeadChecks(slug, meta.headRefOid);
  const ci = evaluateCiStatus({ rollup, ciRuns, mergeStateStatus: ciMergeStateIgnoring(meta.mergeStateStatus, rawRollupContexts, prRules) });
  const workflowsAwaitingApproval = ciRuns ? ciRuns.awaiting : null; // null=未查/查不到;[]=无;非空=待批清单
  const hasWorkflowsAwaiting = Array.isArray(workflowsAwaitingApproval) && workflowsAwaitingApproval.length > 0;

  // ── 1.6.5.2 未解决 conversation(纯布尔,不分作者)──
  const unresolvedThreads = reviewThreads.filter((t) => !t.isResolved);

  // ── 自解死锁判定:BLOCKED 仅因「viewer(本流程账号)自己挂的 CHANGES_REQUESTED」而起,
  // 且所有 conversation 都已 resolve。这是 auto 流程自己 3B 打回后、作者改完 resolve、
  // 但旧 CR review 没撤导致 reviewDecision 永远 CHANGES_REQUESTED → BLOCKED → skip-gate
  // 永远跳过的死锁。命中时这条 CR 不计入硬 blocker:走重审,审查子 agent 逐条核实问题
  // 真被改了(历史承接),再由合并阶段处理自己的旧 CR:普通作者 approve-reviewed-pr 覆盖,免 Approve
  // 作者只 dismiss 自己的旧 review。⚠️ 只要掺了「别人」的 CR(allChangesRequestedBySelf=false)、
  // 或还有 thread 没 resolve,
  // 就不命中 → 照旧硬拦,绝不替别人撤 review。
  // [MIVO-PATCH self-review] GitHub 按登录名只认最后一条实质 review,审查机后发的 CR 会把
  // 同一账号更早的人工 CR 从 latestSubstantiveReviews 里盖掉。人工 CR 仍有效时不能自解。
  const standingHumanChangesRequest = selectStandingViewerHumanChangesRequest(prReviews, viewerLogin);
  const allChangesRequestedBySelf =
    hasChangesRequested && viewerLogin !== '' &&
    // [MIVO-PATCH identity-env] 按小写比:REVIEW_PR_VIEWER_LOGIN 的大小写可能和 GitHub 返回的不同。GitHub 登录名不分大小写,没设变量时结果不变。
    changesRequestedReviews.every((r) => (r.author?.login ?? '').toLowerCase() === viewerLower) &&
    !standingHumanChangesRequest;
  const selfBlockedResolvable =
    meta.mergeStateStatus === 'BLOCKED' &&
    meta.reviewDecision === 'CHANGES_REQUESTED' &&
    allChangesRequestedBySelf &&
    unresolvedThreads.length === 0;
  const STANDING_HUMAN_CR_BLOCKER = '审查账号上有维护者本人的 Request Changes，需本人 Approve 或 dismiss 后再审';

  // ── 1.6.5.3 评论类:bot 总结评论 + reviewer 历史打回(issue comment 形式)──
  const botComments = comments
    .filter((c) => c.isBot)
    .map((c) => ({ author: c.author, createdAt: c.createdAt, url: c.url, snippet: clip(c.body, 800) }));
  const reviewerPushbacks = comments
    .filter((c) => !c.isBot && c.author !== authorLogin)
    .map((c) => {
      const strong = PUSHBACK_STRONG_RE.test(c.body);
      const weak = PUSHBACK_WEAK_RE.test(c.body);
      if (!strong && !weak) return null;
      return {
        author: c.author,
        createdAt: c.createdAt,
        url: c.url,
        signal: strong ? 'strong' : 'weak',
        hasNewerCommit: latestCommitDate ? latestCommitDate > c.createdAt : false,
        snippet: clip(c.body, 400),
      };
    })
    .filter(Boolean);

  // ── 1.6.5.4 前置门结论 ──
  const blockers = [];
  // workflow 待批准导致的 BLOCKED 单独标记:这是「待 approve 才能跑 CI」而非「作者要改」,
  // 解法是 approve workflow(由 owner / auto 放行),不是打回作者。它仍是 blocker(现在确实不可合),
  // 但 auto 路由要把它和「真要作者处理」的 blocker 区分开 → 走 approve-workflows 而非 skip-gate。
  const WORKFLOW_AWAIT_BLOCKER = hasWorkflowsAwaiting
    ? `${workflowsAwaitingApproval.length} 个 workflow 待批准才能跑 CI(approve 后 CI 跑完即可解除 BLOCKED)`
    : null;
  // mergeStateStatus 区分:DIRTY=冲突(硬拦);BLOCKED=用 reviewDecision(权威)+ CI run 分类细分。
  // blockClass 把 BLOCKED 成因显式分档,供 1.7 报告 / auto 分流 / 3A bypass 决策共用。
  let blockClass = 'none';
  let structuralBlock = null; // 结构性门(永不上报的必需检查)详情:{requiredCheckRules, canBypass, rulesetIds} | null
  if (meta.mergeStateStatus === 'DIRTY') {
    blockers.push('mergeStateStatus=DIRTY(有冲突)');
    blockClass = 'conflict';
  } else if (meta.mergeStateStatus === 'BLOCKED') {
    if (WORKFLOW_AWAIT_BLOCKER) {
      // BLOCKED 根因已确定是 fork workflow 待批准(required check 没报告)——专属文案,不走泛化分类。
      blockers.push(WORKFLOW_AWAIT_BLOCKER);
      blockClass = 'workflow-awaiting';
    } else if (reviewDecision === 'CHANGES_REQUESTED') {
      if (selfBlockedResolvable) {
        // 死锁:仅 viewer 自己挂的 CR、且 thread 全 resolve。不计硬 blocker——走重审核实问题真被改了,
        // 再由合并阶段 approve-reviewed-pr 解锁(见 selfBlockedResolvable 注释)。
        blockClass = 'self-resolvable';
      } else {
        if (!standingHumanChangesRequest) {
          blockers.push('mergeStateStatus=BLOCKED(reviewDecision=CHANGES_REQUESTED,仍有 reviewer 要求修改)');
        }
        blockClass = 'review-changes-requested';
      }
    } else if (isApprovalPendingReviewDecision(reviewDecision)) {
      // 缺 approval(含空 reviewDecision、刚 approve 完 GitHub 还在重算)→ 不视硬 blocker。
      // 所有作者审查通过后都走 approve-reviewed-pr；维护者作者也不再免 Approve。
      blockClass = 'awaiting-approval';
    } else if (unresolvedThreads.length > 0) {
      // reviewDecision=APPROVED 但仍有 thread 没 resolve → BLOCKED 很可能来自 ruleset 的
      // required_review_thread_resolution。blocker 由下面 unresolvedThreads 统一押,这里只定 class。
      blockClass = 'threads-unresolved';
    } else if (ci.status === 'failed') {
      // CI 真失败(双源判定,含外部 CI)→ 真 blocker(该打回 / 不合)。
      blockers.push(`mergeStateStatus=BLOCKED(${ci.reason})`);
      blockClass = 'ci-failed';
    } else if (ci.status === 'pending') {
      // 还在跑 → 等跑完再合(transient,auto 下轮重试,别打回作者)。
      blockers.push(`mergeStateStatus=BLOCKED(${ci.reason},等跑完即可)`);
      blockClass = 'ci-pending';
    } else if (ci.status === 'awaiting') {
      // 只从 rollup 看到 awaiting(ciRuns 读不到时 WORKFLOW_AWAIT_BLOCKER 为 null)→ 同样按待批处理。
      blockers.push(`mergeStateStatus=BLOCKED(${ci.reason};批准后等 CI 跑绿再合)`);
      blockClass = 'workflow-awaiting';
    } else if (ci.status === 'unknown') {
      // CI 状态读取不完整 → 不得往 structural-check 推(那条路通向 admin bypass),如实押 blocker。
      blockers.push(`mergeStateStatus=BLOCKED 且 ${ci.reason}`);
      blockClass = 'ci-unknown';
    } else {
      // review 满足(APPROVED)+ 线程已 resolve + CI 全绿(双源确认),但仍 BLOCKED
      // → 残留的是「永不上报结果的必需检查门」:典型 org ruleset 的 code_scanning(CodeQL)/
      // code_quality(本仓库根本没产出对应结果),或被 job 级 if 跳过的必需 check。
      // 这类不是作者要改 —— 要么 owner 用 admin bypass 合、要么修该门让它能上报结果。
      blockClass = 'structural-check';
      structuralBlock = probeBranchProtection(slug, meta.baseRefName);
    }
    // [MIVO-PATCH ci-ignore] 只差本流程自己的必需检查(review-pr)未上报/未通过时不是结构性卡点:
    // 送审之后才会产出它,当成卡点会死锁。其余任何必需检查缺失仍按结构性卡点处理。
    if (blockClass === 'structural-check' &&
        onlyOwnRequiredChecksPending({ probe: structuralBlock, rollupContexts: rawRollupContexts, rules: prRules })) {
      blockClass = 'none';
    } else if (blockClass === 'structural-check') {
      const ruleHint = structuralBlock?.requiredCheckRules?.length
        ? structuralBlock.requiredCheckRules.join(' / ')
        : 'code_scanning / code_quality 等';
      const bypassHint = structuralBlock?.canBypass && structuralBlock.canBypass !== 'never'
        ? `当前账号可 bypass(${structuralBlock.canBypass})`
        : 'bypass 权限未知';
      blockers.push(
        `mergeStateStatus=BLOCKED(必需检查门「${ruleHint}」未上报结果;review 与 CI(双源)均无问题——非作者可处理,需 admin bypass 合或修该门;${bypassHint})`,
      );
    }
  }
  // [MIVO-PATCH self-review] 审查机后来 Approve 过时 GitHub reviewDecision 可能不再是
  // CHANGES_REQUESTED,人工 CR 仍有效,同样硬拦,不能进审查后再用 Approve 盖掉它。
  if (standingHumanChangesRequest) {
    blockers.push(STANDING_HUMAN_CR_BLOCKER);
    if (blockClass === 'none' || blockClass === 'awaiting-approval' || blockClass === 'self-resolvable') {
      blockClass = 'review-changes-requested';
    }
  }
  // ── CI 总门(权威,独立于 mergeStateStatus):CI 全绿才可合并,required 与非 required
  // 一视同仁(2026-08-04)。BLOCKED 分支可能因 reviewDecision 提前定类(awaiting-approval /
  // review-changes-requested 等)而没把 CI 亮出来;UNSTABLE(非 required check 失败/在跑)
  // 根本不进 BLOCKED。这里统一兜住:ci.status 非 pass 一律押 blocker。
  // awaiting 尽量复用 WORKFLOW_AWAIT_BLOCKER 原文——auto 分流靠字符串比对把它从
  // otherBlockers 里剔除,措辞变了 approve-workflows 路由就失效。
  const CI_CLASSES = new Set(['ci-failed', 'ci-pending', 'workflow-awaiting', 'ci-unknown']);
  if (ci.status !== 'pass' && !CI_CLASSES.has(blockClass)) {
    if (ci.status === 'awaiting') {
      blockers.push(WORKFLOW_AWAIT_BLOCKER ?? `CI 未全过:${ci.reason}`);
    } else {
      blockers.push(`CI 未全过:${ci.reason}`);
    }
    if (blockClass === 'none' || blockClass === 'awaiting-approval') {
      blockClass = ci.status === 'failed' ? 'ci-failed'
        : ci.status === 'pending' ? 'ci-pending'
          : ci.status === 'awaiting' ? 'workflow-awaiting'
            : 'ci-unknown';
    }
  }
  // thread blocker 单独提成常量:auto 分流要按引用剔除它判「是不是唯一阻塞」
  // (同 WORKFLOW_AWAIT_BLOCKER 的比对手法)——措辞变了 triage 路由就失效。
  const THREAD_BLOCKER = unresolvedThreads.length
    ? `${unresolvedThreads.length} 条 conversation 未 resolve(不分作者)`
    : null;
  if (THREAD_BLOCKER) blockers.push(THREAD_BLOCKER);
  // 堆叠 PR:base PR 已合并但 GitHub 还没 retarget → 当前 diff / mergeable 是对旧 base 算的,
  // 拿它当基线会审错(#526)。先 skip,等 retarget 完成、CI 在新 base 上重跑再进审查。
  if (needsRetarget) {
    blockers.push(
      `base 分支 ${meta.baseRefName} 对应的 PR #${basePr?.number} 已合并,GitHub 尚未把本 PR retarget 到 ${defaultBranch}(先等 retarget 再审,见 SKILL 前置检查)`,
    );
  }
  // reviewer 强信号打回 + 之后零新 commit = 确定未解决,硬列
  const hardPushbacks = reviewerPushbacks.filter((p) => p.signal === 'strong' && !p.hasNewerCommit);
  if (hardPushbacks.length) blockers.push(`${hardPushbacks.length} 条 reviewer 打回([阻断]/[必改])之后零新 commit`);

  // ── 机器人静默期(见 lib.mjs evaluateBotSettle)──
  // 在**扫描阶段**就拦,而不是等到 pre-merge-check:机器人对新 push 几乎必然再提意见
  // (#716 十三轮 push 轮轮有新 thread),静默期没过就起审查 agent 等于把审查白跑一遍 ——
  // 先 skip、下一轮等机器人说完再一次性审 + 合,省 token 也不会抢跑。
  // pre-merge-check 仍会在合并前再判一次(TOCTOU 双保险,那才是权威关口)。
  const botActivityForSettle = [
    ...prReviews.map((r) => ({ author: r.author?.login ?? '', at: r.submittedAt ?? '' })),
    ...rawThreads.flatMap((t) => (t.comments?.nodes ?? []).map((c) => ({ author: c.author?.login ?? '', at: c.createdAt ?? '' }))),
    ...botCheckActivity(rawRollupContexts, BOT_SETTLE_RULES), // [MIVO-PATCH bot-check-settle]
  ].filter((a) => a.author && a.at);
  // [MIVO-PATCH bot-settle-ready] 超时从 max(提交, 推送, 转 Ready) 起算:推送时间用 head 上最早的检查开始时间估(rollup 已拿到,零请求);
  // 转 Ready 只有按这个起点算已超时才读一次 REST 事件(见 lib.mjs),常规路径不多打请求。
  // [MIVO-PATCH bot-settle-base-only] patch 哈希用本轮已扫的 diff;上一 head 表态先读本机快照,
  // 没有再试本地合 main 提交(服务器 checkout 了 PR head 时),都不另打 GraphQL。
  const filePatchHashes = filePatchHashesFromDiff(scannedDiff ?? '');
  const nowIso = new Date().toISOString();
  const previousSettle = loadBotSettleSnapshot({ owner, repo, pr })
    ?? previousSettleFromLocalMerge({
      headSha: meta.headRefOid, baseSha: meta.baseRefOid, currentHashes: filePatchHashes,
      activity: botActivityForSettle, cfg: BOT_SETTLE_RULES, nowIso,
    });
  const botSettle = evaluateBotSettleSinceReady({
    headCommittedDate: latestCommitDate,
    headPushedAt: toHeadPushedAt(rawRollupContexts),
    nowIso,
    activity: botActivityForSettle,
    cfg: BOT_SETTLE_RULES,
    filePatchHashes,
    previousSettle,
  }, () => fetchRestPages(`repos/${slug}/issues/${pr}/events`));
  if (botSettle.settled && !botSettle.timedOut) {
    saveBotSettleSnapshot({ owner, repo, pr, settle: botSettle, filePatchHashes, headCommittedDate: latestCommitDate });
  }
  if (!botSettle.settled) blockers.push(`机器人静默期未过:${botSettle.reason}`);

  // ── stale-rebase: behind_by > 0 且 merge base 距今超过阈值 → 需要 rebase ──
  // merge base = PR 从 main 分叉的点,作者 rebase 一次它前移一次,计时自动归零。
  // behind_by = 0 时(PR 已和 main 同步)不触发——merge base 再老也不需要 rebase。
  const staleRebase = fetchStaleRebase({ slug, baseRef: meta.baseRefOid || meta.baseRefName,
    headSha: meta.headRefOid, cfg: prRules.staleRebase ?? {} });
  if (!staleRebase.verified) {
    blockers.push(staleRebase.reason);
    if (blockClass === 'none' || blockClass === 'awaiting-approval') blockClass = 'stale-rebase-unknown';
  }
  if (staleRebase.blocking) blockers.push(`需要 rebase:${staleRebase.reason}`);

  // softFlags:需要 LLM 读内容定性的项(不直接判死,但不能无脑放行)
  const softFlags = [];
  if (blockClass === 'awaiting-approval') {
    softFlags.push('mergeStateStatus=BLOCKED(缺少 reviewer approval，审查通过后可先提交 APPROVE review 再合并)');
  }
  if (botComments.length) softFlags.push(`${botComments.length} 条 bot / 工具账号评论,需读内容判断是不是要处理的问题`);
  if (securityScanError != null) {
    softFlags.push('敏感内容扫描不完整(security.error:diff 拉取失败)——未证明无凭证/隐私泄露,审查 agent 必须人工确认 diff 后才能给 pass');
  } else if (security.softHitCount > 0) {
    softFlags.push(`${security.softHitCount} 处疑似敏感内容软命中(security.softHits),审查 agent 需逐条定性(真实凭证/个人数据=P0)`);
  }
  const softPushbacks = reviewerPushbacks.filter((p) => !(p.signal === 'strong' && !p.hasNewerCommit));
  if (softPushbacks.length) softFlags.push(`${softPushbacks.length} 条疑似 / 已有新 commit 的 reviewer 打回,需逐条核实改没改`);

  const gatePass = blockers.length === 0;

  // ── auto 模式分流(把 SKILL「候选轮转」的「跳过 vs 处理」判定代码化)──
  // 仅 auto 模式消费;交互模式忽略 auto.*、仍走用户拍板。
  // 优先级与 skill 流程一致:格式门(1.2)在前置门(1.6.5)之前——formatPass=false 时
  // 根本不评估 gate(1.2.5 直接走 3B)。
  // 「stale 打回」= 该 PR 之前被打回过、且作者在最近一次打回后没提新 commit → 再打回没意义,
  // 跳过等作者动。打回时间取两类来源的最晚值:
  //   ① CHANGES_REQUESTED review 的 submittedAt(新机制:3B 用 REQUEST_CHANGES,含纯格式门
  //      打回那种 only-body review —— 它不进 issue comments 也不产生 reviewThread,只有这里能抓到);
  //   ② 旧 issue-comment 形式打回 reviewerPushbacks 的 createdAt(历史遗留)。
  const pushbackDates = [
    ...prReviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.submittedAt),
    ...reviewerPushbacks.map((p) => p.createdAt),
  ].filter(Boolean);
  const latestPushbackDate = pushbackDates.sort().pop() ?? '';
  const wasPushedBack = latestPushbackDate !== '';
  const authorActedSincePushback =
    wasPushedBack && latestCommitDate !== '' && latestCommitDate > latestPushbackDate;
  const hasStalePushback = wasPushedBack && !authorActedSincePushback;

  let autoAction, autoReason, autoSkip;
  let needsTriage = false;
  // 安全与隐私门优先级最高:凭证已推到公网,越早打回越早轮换,连产品/架构门都不包裹它
  const securityBlocked = security.hardHitCount > 0;
  if (securityBlocked) {
    if (hasStalePushback) {
      autoAction = 'skip-stale-pushback';
      autoReason = '安全与隐私门硬命中,但上次已打回、作者未提交新 commit,跳过等作者清理';
      autoSkip = true;
    } else {
      autoAction = 'pushback-security';
      autoReason = `安全与隐私门未通过:${security.hardHitCount} 处凭证/密钥硬命中(${securityHardKinds.join(' / ')})——打回,要求移除内容、清理分支历史并轮换已泄露凭证;打回评论只写文件/行号/类型,不引用命中原文`;
      autoSkip = false;
    }
  } else if (protectedFiles.length > 0) {
    // .github 等受保护路径:命中即不自动合并,交人工处理。不看作者、不看标题类型、不看 diff 大小。
    autoAction = 'skip-protected-path';
    autoReason = `改动受保护路径 ${protectedFiles.slice(0, 5).join(' / ')}${protectedFiles.length > 5 ? ' 等' : ''}(共 ${protectedFiles.length} 个)——自动流程不合并,交人工处理`;
    autoSkip = true;
  } else if (!formatPass) {
    if (hasStalePushback) {
      autoAction = 'skip-stale-pushback';
      autoReason = '格式门未通过,但上次已打回、作者未提交新 commit,跳过';
      autoSkip = true;
    } else {
      autoAction = 'pushback-format';
      autoReason = '格式门未通过且未被打回过(或打回后已有新 commit),用 request-changes-reviewed-pr.mjs 绑定本轮 head 后打回';
      autoSkip = false;
    }
  } else if (!gatePass) {
    // 若 gate 未过的「唯一」原因就是 workflow 待批准(除它之外没有别的 blocker)→ 不是打回作者,
    // 而是放行 CI:没改 CI 配置就自动 approve、改了就跳过让 owner 手动批。
    // 否则(还有未 resolve thread / 冲突 / 别人的 CR 等真要先处理的 blocker)→ 照旧 skip-gate,
    // CI 批准可以等那些处理完再说。
    const otherBlockers = WORKFLOW_AWAIT_BLOCKER ? blockers.filter((b) => b !== WORKFLOW_AWAIT_BLOCKER) : blockers;
    if (hasWorkflowsAwaiting && otherBlockers.length === 0) {
      const names = workflowsAwaitingApproval.map((w) => w.name).join(' / ');
      if (prTouchesCiFiles) {
        autoAction = 'skip-workflow-ci-change';
        autoReason = `${workflowsAwaitingApproval.length} 个 workflow 待批准才能跑 CI(${names}),但该 PR 改了 CI 配置(${ciFiles.join(' / ')})——不自动批,需人工 approve`;
        autoSkip = true;
      } else {
        autoAction = 'approve-workflows';
        autoReason = `${workflowsAwaitingApproval.length} 个 workflow 待批准才能跑 CI(${names}),未改 CI 配置——自动 approve 放行 CI(下一轮 CI 跑完再审 / 合)`;
        autoSkip = false;
      }
    } else if (blockClass === 'structural-check') {
      // 结构性 BLOCKED:review + CI(双源全绿)都没问题,只卡在永不上报的必需检查门(code_scanning/code_quality 等)。
      if (structuralBlock && (structuralBlock.canBypass === 'always' || structuralBlock.canBypass === 'pull_requests')) {
        // 当前账号有 bypass 权限,auto 模式直接走 admin bypass 合并(安全前提:review APPROVED + ci.status=pass(双源全绿)+ 0 未 resolve thread)
        autoAction = 'bypass-structural-block';
        autoReason = `结构性 BLOCKED(${structuralBlock.requiredCheckRules.join('/')} 永不上报结果),当前账号可 bypass——自动 admin bypass 合并`;
        autoSkip = false;
      } else {
        // 没有 bypass 权限,只能跳过通知 owner
        autoAction = 'skip-structural-block';
        autoReason = `结构性 BLOCKED(非作者可处理,当前账号无 bypass 权限):${blockers.join(';')}`;
        autoSkip = true;
      }
    } else if (THREAD_BLOCKER && blockers.every((b) => b === THREAD_BLOCKER)) {
      // 唯一前置阻塞 = 未 resolve thread → 不再 skip-gate 短路。历史缺口:skip-gate 把
      // 这类候选挡在处理清单外,SKILL ④ 的 triage 永远轮不到它们(实锤 2026-08-06:全仓
      // 0 条 triage 标记回复,37 个 open PR 全靠作者手点 Resolve)。改走处理清单先 triage:
      // **只代 resolve 对照当前 head 核实「意见确实已被处理」或「意见基于可独立验证的
      // 错误事实」的 thread,拿不准一律保持阻断**(口径见 SKILL 第 4 节,判定是 LLM 的
      // 语义责任,本脚本只路由)。清空后按 review 继续;仍有剩余 → 按 threads-unresolved
      // 跳过 + notify-author-resolve 催办。
      // 安全前提:走到这里必然已过机器人静默期——botSettle 未过时 blockers 里有它的条目,
      // every() 不成立 → 照旧 skip,不会抢在 bot 还没说完话时清 thread。混着冲突 / CI 失败 /
      // 别人的 CR 等其他 blocker 时同理照旧 skip-gate,绝不扩大 triage 的作用面。
      autoAction = 'review';
      autoReason = `前置门唯一阻塞是「${THREAD_BLOCKER}」→ 先 thread 清理(triage,SKILL ④):逐条对照当前 head 核实意见确实已被处理才代 resolve,拿不准保持阻断;清空后进入代码审查,仍有剩余按 threads-unresolved 跳过并催办`;
      autoSkip = false;
      needsTriage = true;
    } else if (staleRebase?.blocking) {
      // stale-rebase:分支落后 base 太久——不是作者在 GitHub 上点个按钮能解决的,
      // 必须本地 rebase 后重新推送。不混入 skip-gate:单独分类,方便汇总与通知分流。
      autoAction = 'skip-stale-rebase';
      autoReason = `需要 rebase:${staleRebase.reason}`;
      autoSkip = true;
    } else {
      autoAction = 'skip-gate';
      // 拼上具体 blockers,飞书汇总行直接用得上(别只写泛化的「前置门未通过」)
      autoReason = `前置门未通过:${blockers.join(';')}`;
      autoSkip = true;
    }
  } else {
    autoAction = 'review';
    autoReason = selfBlockedResolvable
      ? (approvalPolicy.viewerCanApprove
        ? '前置门唯一阻塞是 viewer 自己挂的 CHANGES_REQUESTED 且 thread 全 resolve;进入重审,通过后由 approve-reviewed-pr 覆盖为 Approve'
        : '前置门唯一阻塞是 viewer 自己挂的 CHANGES_REQUESTED 且 thread 全 resolve;当前 viewer 不能为该 PR Approve，重审后仍需另一位维护者接手')
      : '格式门 + 前置门均通过,进入代码审查';
    autoSkip = false;
  }

  // ── 维护者确认门包裹(优先级最高,压过格式门 / 前置门;仅安全与隐私内容门在它之前):
  // blocking 触发在场时先让维护者确认——格式 / gate 问题等通过后由下一轮正常拦。
  // 原走向存进 auto.fallback:主 agent 语义定性「product/arch 触发不属产品变更 / 较大架构调整」
  // 或「rules 触发是纯排版」时按 fallback 继续,不用重推。
  let gateFallback = null;
  if (signoffBlocking && !securityBlocked) {
    gateFallback = { action: autoAction, reason: autoReason, isSkip: autoSkip };
    autoAction = 'signoff-gate';
    const triggerLines = blockingTriggers.map((t) => `${t.kind}:${t.detail}(维护者 ${t.maintainers.join(' / ')})`).join('、');
    const issueHint = discussionIssue
      ? (discussionIssue.maintainerComments === null
        ? `;已有讨论 issue(${discussionIssue.url})但评论读取失败,如实进汇总让维护者看`
        : `;已有讨论 issue(${discussionIssue.url}),维护者留言 ${discussionIssue.maintainerComments.length} 条(信息位,不构成通过——表过态但没 Approve 的进汇总提示去 Approve)${discussionIssue.unattributedSlackComments?.length ? `、另有 ${discussionIssue.unattributedSlackComments.length} 条 Slack 同步消息归属不了发送者` : ''}`)
      : '';
    const prCommentHint = prMaintainerComments?.length
      ? `;PR 评论区另有维护者留言 ${prMaintainerComments.length} 条(signoff.prMaintainerComments,同为信息位)`
      : '';
    autoReason = `维护者确认门在拦:${triggerLines}。作者 ${authorLogin} 不是维护者,且无维护者的有效 Approve${issueHint}${prCommentHint}。消费规则见 signoff.note:通过只认维护者的 GitHub Approve(要改就 Request Changes,作者改完再 Approve)或维护者明确指示时的 signoff-release.mjs 标记;product/arch/rules 是唯一允许语义 fallback 的三类:逐文件读当前 diff 判为 bugfix/已有功能补充/纯技术改动/不改变规则含义的机械编辑 → 必须执行 auto.fallback.action(不得创建 hold、不得只摘标签后停下),汇总同时写 fallback.action/reason;security/coldUpdate/pluginBase 不走 fallback、不看 diff 大小、拿不准从严。确认要拦且从未 hold(signoff.held=null)→ signoff-hold.mjs(开 issue+评论+打标签,不转 draft);已 hold → 保持等待,标签同步走 signoff-hold.mjs --labels-only --kind <currentBlocker.kind>(门重新亮起来时脚本会自动给作者补一条状态回帖,按 head sha 去重,不用你拟文案)。仍在拦时本 PR 不得合并,该轮只做审查并把待确认写进汇总`;
    autoSkip = false;
  }
  // ── 审查分档(tier):确定性信号决定审查深度,信号不亮的检查不做(SKILL「分档审查」)──
  // heavy = 安全相关信号任一命中 → 独立审查 + 恶意代码与数据外发专项 + security-scan.mjs;
  // light = 轻档 type 且纯文档/文案改动、零触发零命中 → 主 agent 直接读 diff,不起审查 agent;
  // 其余 standard = 独立审查 agent 按 rule-map 审,不跑扫描。
  const heavyReasons = [
    securityTrigger ? `安全敏感触发(${securityReasons.join(";")})` : null,
    riskyHits.soft.length > 0 ? `危险写法软命中 ${riskyHits.soft.length} 处(需审查 agent 逐条定性)` : null,
    newDependencyNames.length > 0 ? `新增第三方依赖 ${newDependencyNames.slice(0, 5).join(" / ")}` : null,
    redlinePaths.length > 0 ? `红线路径(${redlinePaths.slice(0, 3).join(" / ")})` : null,
  ].filter(Boolean);
  const DOC_ONLY_RE = /\.(md|mdx|txt)$/i;
  const LOCALE_PATH_RE = /(?:^|\/)i18n\/locales\//;
  const docOnly = files.length > 0 && files.every((f) => DOC_ONLY_RE.test(f.path) || LOCALE_PATH_RE.test(f.path));
  const tier = heavyReasons.length > 0
    ? "heavy"
    : (isLight && docOnly && signoffTriggers.length === 0 && security.hardHitCount === 0 && riskyHits.hard.length === 0)
      ? "light"
      : "standard";
  const review = {
    tier,
    heavyReasons,
    docOnly,
    // [MIVO-PATCH p2-blocking] light 档也按 P0/P1/P2 口径判(P2 报告并阻断,P3 不报)
    note: "tier=light → 不起审查 agent:主 agent 自己通读 diff(纯文档/文案),按 P0/P1/P2 口径判,security.softHits 顺带定性;tier=standard → 独立审查 agent 按 rule-map 审,不跑 security-scan;tier=heavy → 独立审查 agent + 恶意代码与数据外发专项 + security-scan.mjs(heavyReasons 是原因清单)。分档只决定审查深度,不影响维护者确认门与合并前提",
  };

  // ── 展示标签(status:* / touches:*,判定见 lib.mjs computeDisplayLabels)──
  // **只做展示,不参与任何判定**:本字段不进 blockers、不影响 auto.action、不影响能否合并。
  // 之所以在这里算:状态本来就是这份 context 算出来的,再由别处重算一遍必然漂移。
  // 落地只有一个消费方 —— scripts/sync-status-labels.mjs <N> --desired <逗号分隔>。
  const displayCfg = loadDisplayLabelConfig(prRules);
  // fix-handoff 跟进会话是否在跟这条 PR(本机状态文件,读不到就按「没有」算 —— 方向安全:
  // 最多少挂一个 status:auto-fixing,不会挂错。跨机器跑时另一台看不到会退回 awaiting-author)
  let fixSessionActive = false;
  let fixNeedsHuman = false;
  let fixWatchdogExpired = false;
  try {
    const fixState = JSON.parse(readFileSync(stateFile('fix-sessions.json'), 'utf8'));
    const fixEntry = fixState?.[String(pr)];
    fixNeedsHuman = fixEntry?.needsHuman === true;
    const dispatchedAt = Date.parse(fixEntry?.dispatchedAt);
    fixWatchdogExpired = Number.isFinite(dispatchedAt) && (Date.now() - dispatchedAt) >= FIX_WATCHDOG_MS;
    fixSessionActive = Boolean(fixEntry?.sessionId) && !fixNeedsHuman;
  } catch { /* 无文件 / 损坏 = 没有跟进会话 */ }
  const displayLabels = displayCfg.enabled
    ? computeDisplayLabels({
      signoffLabelDesired: signoffBlocking,
      securityHardHit: securityBlocked,
      formatPass,
      autoAction,
      blockClass,
      hasStalePushback,
      hardPushbackCount: hardPushbacks.length,
      botSettled: botSettle.settled,
      needsRetarget,
      basePrOpen: Boolean(basePr) && basePr.state === 'OPEN',
      fixSessionActive,
      fixNeedsHuman,
      fixWatchdogExpired,
      triggerKinds: signoffTriggers.map((t) => t.kind),
      newDependency: newDependencyNames.length > 0,
      redline: redlinePaths.length > 0,
      docOnly,
      totalDiffLines,
      largeDiffLines: displayCfg.largeDiffLines,
      managed: displayCfg.managed,
    })
    : { status: null, touches: [], desired: [], statusReason: '展示标签已在 pr-rules.json statusLabels.enabled 关闭' };
  const currentDisplayLabels = currentLabelNames.filter((n) => displayCfg.managed.includes(n));
  const statusLabels = {
    enabled: displayCfg.enabled,
    ...displayLabels,
    current: currentDisplayLabels,
    managed: displayCfg.managed,
    stale:
      displayLabels.desired.length !== currentDisplayLabels.length ||
      displayLabels.desired.some((n) => !currentDisplayLabels.includes(n)),
    note: '展示标签,**只做展示、不参与任何判定**:贴错 / 贴不上 / 被人手工摘掉都不改变能否合并(合并前防线只认 awaiting-discussion)。status:* 同时最多一个(维护者确认门在拦时一个都不挂,那条状态由 awaiting-discussion 表达);touches:* 是 diff 事实、可多挂、几乎不变。stale=true 才需要落地:node scripts/sync-status-labels.mjs <N> --desired "<desired 逗号分隔>"(desired 为空传 --desired "" 表示全摘)。只增删 managed 里的名字,人工手挂的标签一概不碰。失败只写一行进汇总,不进「⚠️ 异常」组',
  };

  // scan / full 共用同一份自动分流对象,避免新增字段只落在其中一种输出。
  const auto = {
    action: autoAction,
    reason: autoReason,
    isSkip: autoSkip,
    fallback: gateFallback,
    needsMaintainerApproval: autoAction === 'review' && selfBlockedResolvable && approvalPolicy.viewerCanApprove,
    needsOwnReviewDismissal: autoAction === 'review' && selfBlockedResolvable && approvalPolicy.authorIsMaintainer,
    needsTriage,
    selfFix: isSelfFixAuthor,
    wasPushedBack,
    latestPushbackDate,
    note: 'selfFix=true→作者在 selfFixAuthors 名单(pr-rules.json):该 PR 卡在作者侧问题(pushback-security / pushback-format / 审查不通过 / skip-gate 冲突·未 resolve·CI 失败 / skip-stale-pushback)时不打回不催办,改走 auto SKILL「自动跟进修复(fix-handoff)」开跟进会话自己修(own-pr 无法 REQUEST_CHANGES)。auto 模式分流(交互模式忽略本字段):isSkip=true→跳过类(扫描不 checkout,无需清理);isSkip=false→进本轮处理清单(pushback-format 直接打回 / review 按 review.tier 分档审查 / approve-workflows 调 approve-workflows.mjs / bypass-structural-block 走 admin bypass 合并 / signoff-gate 按 signoff.note 的消费规则处理或按 fallback 继续)。action ∈ {review, pushback-security, pushback-format, signoff-gate, skip-gate, skip-stale-pushback, skip-stale-rebase, skip-protected-path, approve-workflows, skip-workflow-ci-change, bypass-structural-block, skip-structural-block}。pushback-security=安全与隐私门硬命中(security.hardHits 非空,优先级最高、不被维护者确认门包裹)→ 打回要求移除内容、清理分支历史并轮换凭证,评论只写文件/行号/类型不引用原文;signoff-gate=维护者确认门在拦(判定与确认材料全在 signoff 字段,fallback 存被包裹前的原走向)。approve-workflows=fork workflow 待批且未改 CI 配置→自动 approve 放行 CI(下一轮 CI 跑完再审);skip-workflow-ci-change=待批但改了 CI 配置→跳过、汇总点名让 owner 手动批;skip-protected-path=改动受保护路径(.github/** 等)→ 一律跳过不合并、交人工处理;bypass-structural-block=结构性 BLOCKED + 当前账号可 bypass→auto 模式直接 gh pr merge --admin 合并(安全前提:reviewDecision=APPROVED + gate.ci.status=pass(双源全绿)+ 0 未 resolve thread);skip-structural-block=结构性 BLOCKED 但当前账号无 bypass 权限→跳过、汇总点名让 owner 处理。needsMaintainerApproval=true→当前 viewer 是作者之外的最终维护者集合成员,PR 唯一阻塞是 viewer 自己挂的 CR；重审通过后走 approve-reviewed-pr.mjs 覆盖为 Approve。viewer=作者或不在最终维护者集合时不得自批,必须等待另一位维护者。needsOwnReviewDismissal=true→维护者作者处于同样死锁时跳过格式/安全阶段的提前 dismiss；最终重审通过后直接由 approve-reviewed-pr 覆盖 viewer 自己的旧 CR，不单独 dismiss。needsTriage=true→前置门唯一阻塞是未 resolve thread(混着其他 blocker 时不给):该候选不 skip、进处理清单先走 SKILL ④ thread 清理——**只代 resolve 对照当前 head 核实「意见确实已被处理」或「意见基于可独立验证的错误事实」的 thread,拿不准一律保持阻断(没解决的绝不许点)**;清空后按 review 继续,仍有剩余按 threads-unresolved 跳过并催办',
  };

  // Bracket all collection with fresh immutable revision identifiers. A pushed
  // head or retargeted/moving base invalidates the scan, not just its cache.
  const revisionAfter = ghJson(['pr', 'view', String(pr), '--repo', slug,
    '--json', 'headRefOid,baseRefOid,baseRefName']);
  if (!sameCodeRevision(meta, revisionAfter)) throw new Error('采集期间 PR head/base 发生变化，请重新读取 context');
  if (diffOutput && (securityScanError || scannedDiff == null)) throw new Error('本轮 diff 未完整扫描，不能保存可复用 evidence：' + (securityScanError || '未获取 diff'));
  if (diffOutput) writeDiffFile(diffOutput, scannedDiff);
  const evidence = securityScanError || scannedDiff == null ? null : createContextEvidence({
    repo: slug, pr, meta, files, diff: scannedDiff,
    diffFile: diffOutput || cachedCode.diffFile || null,
  });
  const cache = { reusedDiff: cachedCode.reused, reason: cachedCode.reason };
  const scanMode = process.argv.includes('--scan');
  if (scanMode) {
    // 精简输出:无 body / 历史全文(见文件头 --scan 说明)。字段增删要同步 SKILL「候选批处理」阶段 1。
    print({
      ok: true,
      pr,
      scan: true,
      repo: { owner, repo },
      evidence,
      cache,
      meta: {
        number: meta.number,
        title,
        state: meta.state,
        isDraft: meta.isDraft,
        mergedAt: meta.mergedAt,
        author: authorLogin,
        baseRefName: meta.baseRefName,
        baseRefOid: meta.baseRefOid,
        defaultBranch,
        needsRetarget,
        basePr,
        basePrLookup,
        headRefOid: meta.headRefOid,
        url: meta.url,
        mergeStateStatus: meta.mergeStateStatus,
        reviewDecision: meta.reviewDecision,
      },
      filePaths: files.map((f) => f.path),
      totalDiffLines,
      maintainerAuthority: signoff.authority,
      approvalPolicy,
      signoff,
      protectedPath,
      statusLabels,
      review,
      security,
      format: { formatPass, formatIssues, hitsServer, uiCodeFiles, bodyHasUiEvidence, bodyUiEvidenceKinds, uiEvidenceMissing, uiEvidenceNotice, uiEvidenceRequired, uiEvidenceDeclaredNotApplicable, uiEvidenceAuthorAdmin },
      gate: {
        gatePass,
        blockClass,
        blockers,
        softFlags,
        ci,
        staleRebase,
        unresolvedThreadCount: unresolvedThreads.length,
        botSettle,
      },
      auto,
      note: 'scan 精简输出,仅供 auto 批处理阶段 1 扫描分类与汇总;需要 body / 历史全文时对该 PR 单独跑不带 --scan 的全量模式(审查子 agent 在自己 worktree 里自取,别在主 session 拉全量)',
    });
  } else {
  print({
    ok: true,
    pr,
    repo: { owner, repo },
    evidence,
    cache,
    meta: {
      number: meta.number,
      title,
      state: meta.state,
      isDraft: meta.isDraft,
      mergedAt: meta.mergedAt,
      author: authorLogin,
      headRefName: meta.headRefName,
      headRefOid: meta.headRefOid,
      baseRefName: meta.baseRefName,
      baseRefOid: meta.baseRefOid,
      defaultBranch,
      // needsRetarget=true:base 是另一个**已合并** PR 的分支(stacked),GitHub 还没把本 PR
      // retarget 到默认分支。此时 diff / mergeable 都是对旧 base 算的,别拿它当审查基线 ——
      // 先等 retarget、重拉元数据与 CI(见 SKILL 前置检查)。basePr 是被依赖的那条 PR。
      needsRetarget,
      basePr,
      basePrLookup,
      url: meta.url,
      mergeable: meta.mergeable,
      mergeStateStatus: meta.mergeStateStatus,
      reviewDecision: meta.reviewDecision,
      labels: (meta.labels ?? []).map((l) => l.name),
      body,
    },
    files,
    totalDiffLines,
    maintainerAuthority: signoff.authority,
    approvalPolicy,
    signoff,
    protectedPath,
    statusLabels,
    review,
    security,
    format: {
      type,
      template,
      titleTypeOk,
      titleVague,
      sections,
      missingSections,
      checklist: { hasSection: checklistHasSection, total: checklistTotal, done: checklistDone, ratio: Number(checklistRatio.toFixed(2)) },
      redlinePaths,
      hitsUpdater,
      hitsServer,
      serverFiles,
      uiCodeFiles,
      bodyHasUiEvidence,
      bodyUiEvidenceKinds,
      uiEvidenceMissing,
      uiEvidenceNotice,
      uiEvidenceRequired,
      uiEvidenceAuthorAdmin,
      uiEvidenceDeclaredNotApplicable,
      formatPass,
      formatIssues,
      note: 'formatPass=false 一定不合规;true 仍需 LLM 判段落是否实质、title 语言(关 3)。uiCodeFiles 非空而无证据时 uiEvidenceMissing=true(截图/录屏或 HTML 界面都算证据,类型见 bodyUiEvidenceKinds)——不进 formatIssues、不打回,由主 agent 把 uiEvidenceNotice 作为非阻断评论发给作者(SKILL 3.2);[MIVO-PATCH ui-evidence] uiEvidenceRequired=true 时缺证据已记进 formatIssues、按格式门打回;已附证据的,内容与 diff 是否一致、界面是否符合 DESIGN.md 由阶段二审查 agent 判',
    },
    history: { comments, reviewThreads, commits, latestCommitDate },
    gate: {
      unresolvedThreads,
      reviewerPushbacks,
      botComments,
      blockers,
      softFlags,
      blockClass,
      structuralBlock,
      ci,
      ciRuns,
      blockedAwaitingApproval: blockClass === 'awaiting-approval',
      workflowsAwaitingApproval,
      prTouchesCiFiles,
      ciFiles,
      selfBlockedResolvable,
      staleRebase,
      botSettle,
      gatePass,
      note: 'gatePass=false → 1.7 必须卡 gate;softFlags 里的项由 LLM 读内容定性,别无脑放行。**ci 是合并硬前提**(evaluateCiStatus 双源判定,required 与非 required 一视同仁):ci.status=pass 才可合并;failed → 不合并并把 ci.failed 名单如实提示用户/作者;pending → 等跑完;awaiting → 走 approve-workflows;unknown → CI 状态读取不完整,不得视为通过。blockClass 是阻断成因分档:conflict / workflow-awaiting(fork 待批 CI)/ review-changes-requested(reviewDecision=CHANGES_REQUESTED,真要作者改)/ self-resolvable(仅 viewer 自己的 CR、thread 全 resolve)/ awaiting-approval(缺 approve 且 CI 全绿;所有作者都走 approve-reviewed-pr,维护者作者也不再免 Approve)/ threads-unresolved / ci-failed(CI 真失败,含非 required 与外部 CI)/ ci-pending(还在跑)/ ci-unknown(状态读取不完整,不得视为通过)/ structural-check(review+CI 双源全绿、仍 BLOCKED——永不上报的必需检查门 code_scanning/code_quality 等,需 admin bypass 合或修门,非作者可处理)。structuralBlock(仅 structural-check 时非空):{requiredCheckRules, canBypass, rulesetIds},canBypass=always/pull_requests 表示当前账号可 admin bypass。ciRuns(actions/runs,null=读不到):{failed,pending,awaiting,all};ci 综合了它与 statusCheckRollup。workflowsAwaitingApproval=ciRuns.awaiting(fork 待批 workflow)。与 blockedAwaitingApproval(缺 reviewer approval)是两回事。botSettle = 机器人静默期(见 lib.mjs evaluateBotSettle):settled=false 即本轮不审不合(blockers 里已押),原因是外部 review 机器人还没对当前 head 表态 —— 本流程从「作者推最后一个 commit」到「合并完」实测只要 3.2 分钟,而 Copilot 要 6~11 分钟,不等就会把未审代码合进主干(实锤 PR #716:合并后 3 分钟 Copilot 提 1 条、7.7 分钟 Codex 提 4 条,5 条全是真 P1)。timedOut=true = 等到上限仍有机器人没表态、已通过,汇总必须写明 pending 里那几个的意见可能在合并后才到',
    },
    auto,
  });
  }
} catch (e) {
  fail(e);
}
