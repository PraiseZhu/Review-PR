#!/usr/bin/env node
// context.mjs — review-pr 的一次性「采集 + 客观判定」核心(只读,在当前分支跑即可)
//
// 把 skill 步骤 1.1 / 1.2 / 1.3 / 1.5 / 1.6.5 里所有「确定性」的活一次性做完,输出
// 一份结构化 JSON 给 LLM:PR 元数据、文件 / diffstat、格式硬判定、讨论历史、前置门判定。
// LLM 拿到后只需做「语义判断 + 决策」:
//   - 格式:formatPass=false 一定不合规;true 仍需 LLM 判段落是否实质、title 语言(关 3)。
//   - 前置门:gate.gatePass=false → 1.7 必须卡 gate;gate.softFlags 里的 bot 评论 /
//     疑似打回由 LLM 读内容定性。
//
// 本脚本不发评论、不改本地、不起审查。退出码恒 0(除脚本自身出错=1);
// 判定结论全在 JSON 字段里(formatPass / gate.gatePass),不靠退出码分流。
//
// --scan 精简模式(auto 批处理阶段 1 专用):判定全量照算,但输出**不含** body 全文、
// 评论 / review thread / 提交时间线全文——只留分类决策与汇总所需的最小字段 + filePaths
// (供文件重叠守卫比对)。动机:批处理要对几十个候选各跑一次本脚本,全量 JSON(含全文
// 历史)会把主 agent 的 session 上下文撑爆并造成跨 PR 串扰;全文只应进对应 PR 的审查
// 子 agent 隔离上下文(子 agent 在自己 worktree 里跑不带 --scan 的全量模式自取)。
//
// --scan-all 批量模式(auto 批处理阶段 1 专用):不传 PR 号,脚本自己拉全部 open 非 draft
// 候选,内部并行(4 并发)spawn 自身的单 PR `--scan` 模式,聚合输出 results 数组——把主
// agent「N 个候选 = N 次工具调用」压成 1 次;核心判定逻辑与单 PR 模式**同一份代码**
// (就是 spawn 自己),不存在两套判定漂移。单个候选失败不炸整批(该条 ok:false)。
// 扫描完成后顺手落盘空转指纹(.last-scan.json,供 scheduler pre-check.mjs 比对,见 lib.mjs)。
//
// 跑:node <skill-root>/scripts/context.mjs <PR> [--scan]
//     node <skill-root>/scripts/context.mjs --scan-all

import { parseRepo, parsePR, gh, ghJson, ghGraphql, classifyHeadChecks, classifyStatusRollup, probeBranchProtection, loadOrgRosters, parseRosterLine, print, fail, fetchOpenPrSnapshot, computePrSetFingerprint, SCAN_STATE_FILE, spawnScriptJson, mapPool, PRODUCT_GATE_MARKER_PREFIX, parseLastHoldMarker, parseFingerprintGuard, matchColdUpdatePaths, loadRules, detectLoopExclusion, fetchHeadCheckContexts, classifyRequiredChecks, findApproveMergeAuthorization, evaluateAuthorizedFastMerge, decideStructuralBypassRoute } from './lib.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── PR 提交规范与维护者 gate 配置：单一真相源在 Skill config/pr-rules.json ──
// featureSections / bugfixSections 需与 .github/PULL_REQUEST_TEMPLATE.md 的必填段落
// 一致；公开仓库可用自己的轻量 CI 校验模板，不读取本私有配置。
// titleTypes 无模板锚点,单一真相源就是那个 json 自己;
// lightTypes / redlinePaths / serverPaths 也只在那个 json(供本脚本判定,PR 模板无对应)。
const prRules = loadRules();
const TITLE_TYPE_RE = new RegExp(`^(${prRules.titleTypes.join('|')})(\\([^)]+\\))?!?: .+`);
const LIGHT_TYPES = prRules.lightTypes; // 轻档:不强制段落
const FEATURE_SECTIONS = prRules.featureSections;
const BUGFIX_SECTIONS = prRules.bugfixSections;
const REDLINE_PATH_RE = new RegExp(prRules.redlinePaths.join('|'));
// CI 配置敏感路径:PR 改了它们 → approve fork workflow 会执行被改过的 CI(详见 approve-workflows.mjs 安全门)
const CI_SENSITIVE_RE = prRules.ciSensitivePaths?.length ? new RegExp(prRules.ciSensitivePaths.join('|')) : null;
// 产品/UI 变更门:白名单(GitHub login,大小写不敏感)+ UI 面路径前缀(详见 SKILL「产品 / UI 变更门」)
const PRODUCT_WHITELIST = (prRules.productWhitelist ?? []).map((s) => s.toLowerCase());
const UI_PATH_PREFIXES = prRules.uiPaths ?? [];
// uiPaths 内的排除前缀:多语言 locale 等纯文案数据文件不算 UI 改动(不触发 UI 证据提醒,也不触发产品门的 UI 路径触发器)
const UI_EXCLUDE_PREFIXES = prRules.uiExcludePaths ?? [];
// 技术架构变更门:与产品门同机制的技术侧平行门(详见 SKILL「技术架构变更门」)。
// 触发器三选一命中即进语义定性:核心路径改动量 / refactor 大 diff / 任意类型超大 diff。
const ARCH_RULES = prRules.archGate ?? {};
const ARCH_WHITELIST = (ARCH_RULES.whitelist ?? []).map((s) => s.toLowerCase());
const ARCH_CORE_PATHS = ARCH_RULES.corePaths ?? [];
const ARCH_CORE_DIFF_LINES = Number(ARCH_RULES.coreDiffLines) || 150;
const ARCH_REFACTOR_DIFF_LINES = Number(ARCH_RULES.refactorDiffLines) || 400;
const ARCH_ANY_DIFF_LINES = Number(ARCH_RULES.anyTypeDiffLines) || 800;
// 冷更(mobile runtime fingerprint)触发器:指纹一变,存量装机就拿不到本次及后续 OTA 热更,
// 必须冷更出包 —— 代价与技术框架变动同级,因此并入本门,且**不设 diff 行数阈值**:改到即需
// 技术白名单明确同意才能合并(仓库侧规则见 docs/dev-rules/mobile-development.md「冷更边界」)。
// coldUpdatePaths 是指纹输入路径(启发式网);coldUpdateGuardMarker 定位 CI fingerprint guard
// 的 sticky comment —— guard 真算过 base vs 合并结果,它的结论优先于路径启发式。
// coldUpdateApprovers 是冷更**唯一**的放行人名单:谁改手机端会触发冷更的代码都要进一步确认,
// 作者身份(哪怕在技术白名单里)、普通 Approve、标回 ready 都不构成豁免;名单内成员自己提的
// PR 同样要显式确认(只是这份确认由他本人给)。名单为空 = 冷更门未启用,退回普通架构门口径。
const ARCH_COLD_UPDATE_PATHS = ARCH_RULES.coldUpdatePaths ?? [];
const COLD_UPDATE_GUARD_MARKER = ARCH_RULES.coldUpdateGuardMarker ?? '';
const COLD_UPDATE_APPROVERS = (ARCH_RULES.coldUpdateApprovers ?? []).map((s) => s.toLowerCase());
// 结构性 BLOCKED(blockClass='structural-check')可自动 --admin bypass 的必需检查类型
// allowlist:即便当前账号 canBypass=always/pull_requests,命中的必需检查类型不在这份
// allowlist 里也不自动 bypass(如 required_status_checks 范围太宽,可能盖住真实还没
// 跑完/配错的检查,不能一律当"永不上报结果的门"处理)。仅 code_scanning/code_quality
// 这类"确定性地从不产出结果"的门才默认放进 allowlist,其余需要人工评估后手动加。
// pr-rules.json 未配置该键时用这两个默认值(与此前"canBypass 即自动 bypass"的行为基本
// 一致);要扩大/收紧范围可显式配置 structuralBypassAllowlist 覆盖默认值。
const STRUCTURAL_BYPASS_ALLOWLIST = new Set(prRules.structuralBypassAllowlist ?? ['code_scanning', 'code_quality']);
// 安全审查路径:review-pr 自身脚本/配置、CI workflow/actions、部署的 skill 定义、
// package.json 与常见 lockfile 等——这条门防的是「自动化改坏自己」,不是防外部攻击
// (是否适用取决于目标仓库的贡献者可信度模型,由仓库自己配置决定):命中就转人工看一眼,
// 不让 review-pr 用可能已被这次改动改坏的自己版本去审查/合并这次改动本身,详见 SKILL
// 「审查执行环境安全」。配置缺失(securityReviewPaths 为空)= 功能关闭,不扫描不拦截。
const SECURITY_REVIEW_RE = prRules.securityReviewPaths?.length ? new RegExp(prRules.securityReviewPaths.join('|')) : null;
// 自动跟进修复名单:这些作者的 PR 卡在作者侧问题时不打回 / 不催办,由 skill 开跟进会话自己修
// (owner 本人的 PR 对自动化账号是 own-pr,GitHub 禁止对自己的 PR 提 REQUEST_CHANGES / APPROVE,
// 打回路径本来就走不通),详见 SKILL「自动跟进修复(fix-handoff)」。
const SELF_FIX_AUTHORS = (prRules.selfFixAuthors ?? []).map((s) => s.toLowerCase());
// admins:结构性 BLOCKED 三层分级合并策略的信任名单(见 SKILL 5.1/5.3、internal-gates.md
// 「作者侧与仓库侧 gate」)。① 名单成员在 PR 评论发 `/approve-merge` = 授权快速通道,跳过
// 阶段二审查直接合(findApproveMergeAuthorization);② 名单成员的 PR 撞结构性 BLOCKED 且
// 缺 reviewDecision=APPROVED(典型 ownPr,GitHub 禁止自批准)时,允许改用「本轮独立审查
// 实际跑完且 0 P0/P1」替代 APPROVED 再 admin bypass;③ 非名单成员一律维持原口径,必须
// reviewDecision=APPROVED 才能 admin bypass。缺失/为空 = fail-closed,①②两条路径均不生效。
const ADMINS = new Set((prRules.admins ?? []).map((s) => s.toLowerCase()));
// Slack 同步 bot(信任锚):只有这些账号发的讨论 issue 评论才允许按正文「发送者:」归属真实发言人,
// 防止普通用户伪造「发送者:<白名单成员>」冒充放行。比对时去掉 GitHub App 的 [bot] 后缀。
const SLACK_SYNC_BOTS = (prRules.slackSyncBots ?? []).map((s) => s.toLowerCase());
const normalizeBotLogin = (login) => (login ?? '').toLowerCase().replace(/\[bot\]$/, '');
// Slack 显示名 → GitHub login 别名(大小写不敏感):兜「Slack 名与名录中文名对不上」的情况(Dash=dashhuang)
const SLACK_SENDER_ALIASES = Object.fromEntries(
  Object.entries(prRules.slackSenderAliases ?? {}).map(([k, v]) => [k.toLowerCase(), (v ?? '').toLowerCase()]),
);
// Loop 托管 PR 排除:与目标仓库自有的自动修 bug loop(如有)共存,避免两套合并主体打架
// (详见 SKILL「Loop 托管 PR 排除」)。titlePrefix 命中即判该 PR 由 loop 托管;
// t1BodyMarkers/t2BodyMarkers 从 PR body 里找 loop 自己声明的 T-level(最贴近 PR 开出那一刻
// 的一手信号,优先采信);两者都没命中 → 退回读本地台账(stateFile)按 PR 号反查
// cluster.tCap;仍拿不到结论 → defaultWhenAmbiguous(保守默认 skip)。配置缺失(pr-rules.json
// 未配置 loopPrExclusion)= 功能整套关闭,detectLoopExclusion 对所有 PR 恒返回 null。
const LOOP_EXCLUSION_RULES = prRules.loopPrExclusion ?? null;
// detectLoopExclusion 本体在 lib.mjs(与 notify-merge-ack.mjs 共用同一份判定,防两处判据漂移)。

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

// ── 以下是 review-pr skill 自身的执行细则(非 agent 约束文档内容,留在脚本里)──
const TITLE_VAGUE_RE = /:\s*(bug|update|improve|fix issue|优化|调整|更新|misc|若干|一些)\s*$/i;

// ── 前置门判定常量(复刻 SKILL.md 1.6.5)──
// 注:check-runs / commit-status / 分支保护(branches/*/protection)端点在本项目 PAT 下常 403,
// 故不逐条读 CI;但 actions/runs 与 rulesets 读得到 —— BLOCKED 时用 classifyHeadChecks 把
// workflow run 分成 awaiting / failed / pending,再用 reviewDecision(权威聚合)区分 review 维度,
// 三类 CI 都空且 review 满足却仍 BLOCKED → 结构性门(永不上报结果的 code_scanning/code_quality 等),
// 靠 admin bypass 合或修门,而不是作者要改(见下方 blockClass='structural-check')。
const PUSHBACK_STRONG_RE = /\[阻断\]|\[必改\]/;
const PUSHBACK_WEAK_RE = /不能合|这次先没合|先没合|需要改后再合|先别合|这次先不合|changes?\s*requested|request\s*changes/i;

// 一次拉全 PR 的讨论 / 时间线(reviewThreads + comments + commits)
const GQL = `
  query($owner:String!,$repo:String!,$num:Int!){
    viewer{ login }
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100){ nodes{
          isResolved isOutdated path
          comments(first:50){ nodes{ author{ login __typename } body createdAt } }
        }}
        comments(first:100){ nodes{ author{ login __typename } body createdAt updatedAt url } }
        timeline: commits(last:100){ nodes{ commit{ committedDate messageHeadline oid } } }
        readyEvents: timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT], last:10){
          nodes{ ... on ReadyForReviewEvent { actor{ login } createdAt } }
        }
      }
    }
  }`;

const isBot = (a) => a?.__typename === 'Bot' || /\[bot\]$/i.test(a?.login ?? '');
const clip = (s, n) => (s ?? '').replace(/\r/g, '').slice(0, n);

// ── --scan-all 批量驱动(见文件头说明;判定本体在下方单 PR 流程,这里只做编排)──
if (process.argv.includes('--scan-all')) {
  const SELF_PATH = fileURLToPath(import.meta.url);
  try {
    const { owner, repo } = parseRepo();
    const slug = `${owner}/${repo}`;
    const rawList = JSON.parse(
      gh(
        ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100', '--json', 'number,title,author,createdAt,isDraft,url'],
        { timeoutMs: 60_000 },
      ).stdout || '[]',
    );
    // 候选口径与 pick.mjs 同源:open 且非 draft,按 createdAt 升序
    const candidates = rawList
      .filter((p) => !p.isDraft)
      .map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? '', createdAt: p.createdAt, url: p.url }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // ── 被 hold 的 draft 预筛(产品/架构门自动放行的入口)──
    // 白名单同意发生在讨论 issue 上、不改 PR 自身状态,所以被 product-hold 转 draft 的 PR
    // 必须主动扫,否则同意永远没机会被消费(作者只能自己标回 ready,违背「同意即自动放行」)。
    // 普通 draft(作者自己转的)照旧跳过;识别靠 PR 评论里的 hold 标记——一条聚合 GraphQL
    // 查所有 draft 的评论做廉价预筛,查失败时退化为「全部 draft 都进扫描」(fail-open:
    // 宁可多扫几条,不可让被 hold 的 PR 被静默饿死)。
    const drafts = rawList
      .filter((p) => p.isDraft)
      .map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? '', createdAt: p.createdAt, url: p.url }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let heldDraftCandidates = [];
    let heldPrefilterError = null;
    if (drafts.length > 0) {
      try {
        const q = `query{ repository(owner:"${owner}",name:"${repo}"){ ${drafts
          .map((p, i) => `d${i}: pullRequest(number:${p.number}){ number comments(last:100){ nodes{ body } } }`)
          .join(' ')} } }`;
        const repoData = ghGraphql(q, {}, { timeoutMs: 60_000 })?.data?.repository ?? {};
        heldDraftCandidates = drafts.filter((p, i) =>
          (repoData[`d${i}`]?.comments?.nodes ?? []).some((c) => (c.body ?? '').includes(PRODUCT_GATE_MARKER_PREFIX)),
        );
      } catch (e) {
        heldPrefilterError = String(e?.message ?? e).slice(0, 200);
        heldDraftCandidates = drafts; // 预筛失败 → 全量兜底,单 PR 扫描自己会判 held 与否
      }
    }

    // 只读扫描,4 并发安全;单条失败折叠成 ok:false 条目,不炸整批
    const results = await mapPool(candidates, 4, async (c) => {
      const r = await spawnScriptJson(SELF_PATH, [String(c.number), '--scan']);
      return r && r.ok ? r : { ok: false, pr: c.number, error: r?.error ?? '未知失败' };
    });
    // 被 hold 的 draft 同样跑单 PR --scan(输出带 held 字段与 discussionIssue 白名单留言原料);
    // 预筛失败兜底进来的普通 draft 扫完 held=null,主 agent 直接忽略即可
    const heldDraftResults = (await mapPool(heldDraftCandidates, 4, async (c) => {
      const r = await spawnScriptJson(SELF_PATH, [String(c.number), '--scan']);
      return r && r.ok ? r : { ok: false, pr: c.number, error: r?.error ?? '未知失败' };
    })).filter((r) => !r.ok || r.held != null);

    // 空转指纹落盘(供 scheduler pre-check.mjs 比对)。allSkip 必须「全部扫描成功且全为
    // 跳过类」才为 true——任一候选/held draft 扫描失败或预筛失败即 false(「查不了」≠「没活」,
    // 下轮照常起会话)。held draft 本身按跳过类参与 allSkip:它是否可放行取决于讨论 issue
    // 的白名单留言,而 heldIssues(issue updatedAt)已进指纹判据——issue 没动 → 语义判定
    // 结论不变,skip 安全;issue 有新留言 → pre-check 比对失配放行。若会话在「扫描落盘后、
    // 放行动作前」意外挂掉,兜底是 pre-check 的 6h 强制心跳,不会永久饿死。
    // 快照拉取失败只影响省钱(pre-check 拿不到新指纹 → 放行),绝不影响扫描结果本身。
    let scanState = null;
    let scanStateError = null;
    try {
      const snapshot = fetchOpenPrSnapshot({ owner, repo, timeoutMs: 60_000, settleUnknown: true });
      // held draft → 讨论 issue 的 number + updatedAt(pre-check 逐条比对;读不到的记 null,
      // pre-check 视 null 为「不可证不变」→ 放行)
      const heldIssues = heldDraftResults
        .filter((r) => r.ok)
        .map((r) => {
          const d = r.productGate?.discussionIssue ?? r.archGate?.discussionIssue ?? null;
          return { pr: r.pr, number: d?.number ?? r.held?.issueNumber ?? null, updatedAt: d?.updatedAt ?? null };
        });
      scanState = {
        version: 1,
        savedAt: new Date().toISOString(),
        allSkip:
          heldPrefilterError == null &&
          results.every((r) => r.ok && r.auto?.isSkip === true) &&
          heldDraftResults.every((r) => r.ok),
        fingerprint: computePrSetFingerprint(snapshot),
        candidateCount: candidates.length,
        heldIssues,
        prNumbers: snapshot.map((s) => s.number),
      };
      writeFileSync(SCAN_STATE_FILE, JSON.stringify(scanState, null, 2));
    } catch (e) {
      scanStateError = String(e?.message ?? e).slice(0, 200);
    }

    print({
      ok: true,
      scanAll: true,
      repo: { owner, repo },
      candidateCount: candidates.length,
      draftSkipped: rawList.length - candidates.length - heldDraftResults.length,
      candidates,
      scanFailures: [...results, ...heldDraftResults].filter((r) => !r.ok).map((r) => ({ pr: r.pr ?? null, error: r.error })),
      results,
      heldDraftResults,
      ...(heldPrefilterError ? { heldPrefilterError } : {}),
      scanState: scanState
        ? { allSkip: scanState.allSkip, savedAt: scanState.savedAt }
        : { error: scanStateError },
      note: 'results 每条与逐候选跑 `context.mjs <PR> --scan` 的输出逐字段一致(内部就是 spawn 单 PR 模式);ok:false 的条目请单独重跑一次 `context.mjs <PR> --scan` 兜底,仍失败按跳过类记入汇总。heldDraftResults = 被产品/架构门 hold 转 draft 的 PR(held 字段非空):读 discussionIssue.whitelistComments 与对应门的 prWhitelistComments(白名单成员直接在 PR 评论区的回复,同等采信)判白名单是否已明确同意推进——任一来源同意 → 跑 product-release.mjs 自动标回 Ready 后按 auto.fallback 归类继续;未同意 → 保持 draft 无需任何动作(不再 hold、不评论)。空转指纹已落盘 .last-scan.json 供 scheduler 预检,skill 流程无需消费该文件',
    });
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;

  // ── 1.1 + 1.3 元数据 / 文件 ──
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,title,body,state,headRefName,headRefOid,isCrossRepository,baseRefName,author,url,mergeable,mergeStateStatus,reviewDecision,isDraft,mergedAt,labels,files,statusCheckRollup',
  ]);
  const title = meta.title ?? '';
  const body = meta.body ?? '';
  // ── Loop 托管 PR 判定(与目标仓库自有的自动修 bug loop 共存;详见 SKILL「Loop 托管 PR 排除」;
  // LOOP_EXCLUSION_RULES 未配置时恒为 null)──
  const loopExclusion = detectLoopExclusion({ title, body, pr, rules: LOOP_EXCLUSION_RULES });
  const files = (meta.files ?? []).map((f) => ({
    path: f.path,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
  const totalDiffLines = files.reduce((s, f) => s + f.additions + f.deletions, 0);

  // ── 获取 PR reviews，用于区分 BLOCKED 原因 ──
  // mergeStateStatus=BLOCKED 可能是"需要 approval"，也可能是 CI/冲突。
  // 如果没有 APPROVED 且没有 CHANGES_REQUESTED review → 大概率是"等待 approval"
  const reviewsMeta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'reviews',
  ]);
  const prReviews = reviewsMeta.reviews ?? [];
  const changesRequestedReviews = prReviews.filter((r) => r.state === 'CHANGES_REQUESTED');
  const hasChangesRequested = changesRequestedReviews.length > 0;
  // reviewDecision 是 GitHub 按「每个 reviewer 最新一条 review」聚合的权威结论——
  // 用它判 review 维度,而不是 hasChangesRequested(后者只看历史里有没有出现过 CR:
  // 同一 reviewer 先 CHANGES_REQUESTED 后 APPROVED 时,历史里仍有那条 CR,但 reviewDecision
  // 已是 APPROVED。旧逻辑用 hasChangesRequested 会把这种「已被同人 approve 覆盖」误判成
  // 「仍有未解决 CR」,从而把真正的 BLOCKED 成因(结构性必需检查门)说成 review 问题)。
  const reviewDecision = meta.reviewDecision ?? null;
  // loop 托管的 PR 标题固定带 loopPrExclusion.titlePrefix(如 `[bug-doctor] `),不是
  // `<type>(<scope>): <描述>` 格式;命中该前缀时先剥掉再判 type,否则 T2 loop PR(本该走
  // review-pr 正常审查)会被格式门误判"缺 type 前缀"打回。前缀本身来自 pr-rules.json
  // 配置(不硬编码字面量);未命中 loopExclusion 时 titleForFormat 就是原始 title,行为不变。
  const titleForFormat = (loopExclusion && LOOP_EXCLUSION_RULES?.titlePrefix)
    ? title.slice(LOOP_EXCLUSION_RULES.titlePrefix.length)
    : title;
  const type = (titleForFormat.match(/^(\w+)/)?.[1] ?? '').toLowerCase();
  const titleTypeOk = TITLE_TYPE_RE.test(titleForFormat);
  const titleVague = TITLE_VAGUE_RE.test(titleForFormat);
  const isLight = LIGHT_TYPES.includes(type);
  const template = type === 'fix' ? 'bugfix' : isLight ? 'light' : 'feature';
  // loop 托管的 PR(实际只有 t2 会走到这里,t1 已在 auto.action 整体跳过)body 遵循 loop
  // 自己的证据结构,不是本仓 PR 模板——按 featureSections/bugfixSections 三段式逐字匹配
  // 检查注定每次都判"缺段落",但这不是这些 PR 真的不合规,只是它们遵循了另一套同样有效
  // 的既定契约,常规打回反而是误判,因此豁免段落存在性检查。豁免范围只到段落检查,标题
  // type 检查(见上方 titleForFormat)与其余门(前置门/审查)都不受影响,仍照常走。
  const wantSections = loopExclusion
    ? []
    : template === 'bugfix' ? BUGFIX_SECTIONS : template === 'feature' ? FEATURE_SECTIONS : [];
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
  // ── 安全审查门(对应 SKILL「审查执行环境安全」):命中 pr-rules.json 的 securityReviewPaths ──
  // 目的:防自动化改坏自己,不是防外部攻击。auto 批处理会先 checkout 到 PR 分支再跑
  // context.mjs 依赖的确定性脚本 / 读取 pr-rules.json 配置本身;如果 PR 改的正是这些脚本 /
  // 配置(或 CI workflow/actions / 部署的 skill 定义 / package.json 与 lockfile),继续让
  // review-pr 用可能已被这次改动改坏的版本去自动审查并合并这次改动,会形成"改坏的版本审过
  // 并合入了自己"的自我损坏闭环——一律转人工,不自动审、不自动合(见下方 auto 覆盖)。
  const securityReviewFiles = SECURITY_REVIEW_RE ? files.map((f) => f.path).filter((p) => SECURITY_REVIEW_RE.test(p)) : [];
  const hitsSecurityReviewPaths = securityReviewFiles.length > 0;

  // UI 面路径命中(产品门与 UI 证据提醒共用;证据检查只看代码改动,排除纯 .md 文档)。
  // uiExcludePaths(多语言 locale 等纯文案数据)整体不算 UI:证据与产品门都不触发。
  const uiFiles = files
    .map((f) => f.path)
    .filter(
      (p) =>
        UI_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)) &&
        !UI_EXCLUDE_PREFIXES.some((prefix) => p.startsWith(prefix)),
    );
  const touchesUi = uiFiles.length > 0;
  // 证据提醒只对可能渲染的代码文件:.md 文档与 .d.ts 纯类型声明(如 vite-env.d.ts)
  // 不可能产生视觉变化,不触发 UI 证据提醒(2026-07-25 维护者拍板;产品门 touchesUi 不受影响)。
  const uiCodeFiles = uiFiles.filter((p) => {
    const lower = p.toLowerCase();
    return !lower.endsWith('.md') && !lower.endsWith('.d.ts');
  });
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
  let securityScanError = null;
  try {
    const diffText = gh(['pr', 'diff', String(pr), '--repo', slug], { timeoutMs: 120_000 }).stdout ?? '';
    let curFile = null;
    let curAllowed = false;
    let newLine = 0;
    for (const raw of diffText.split('\n')) {
      if (raw.startsWith('+++ ')) {
        curFile = raw.replace(/^\+\+\+ /, '').replace(/^b\//, '').trim();
        curAllowed = curFile === '/dev/null' || (SENSITIVE_ALLOW_RE?.test(curFile) ?? false);
        continue;
      }
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { newLine = Number(hunk[1]); continue; }
      if (raw.startsWith('+')) {
        if (!curAllowed && curFile) scanSensitiveLine(raw.slice(1), { file: curFile, line: newLine }, secHits);
        newLine += 1;
      } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
        newLine += 1;
      }
    }
  } catch (e) {
    // diff 拉不到 ≠ 干净:scanned=false 交下游「未证明无泄露」处理,不在这里硬拦(网络抖动不该打回作者)
    securityScanError = clip(String(e?.message ?? e), 200);
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
  // 文案里的"符合 <设计规范>"这半句只在 ruleFiles.uiRequired 真配了文件时才写:
  // 没配(目标仓库没有独立设计规范文档)还硬写 DESIGN.md,等于让作者去对一份不存在的文件。
  const uiRequiredFiles = (prRules.ruleFiles?.uiRequired ?? []).filter(Boolean);
  const uiEvidenceNotice = uiEvidenceMissing
    ? `命中 UI 路径(${uiCodeFiles.slice(0, 3).join(' / ')}${uiCodeFiles.length > 3 ? ' 等' : ''})但 description 未附界面效果证据——建议补充改动后效果:截图/录屏,或改动后界面的 HTML 页面(\`\`\`html 代码块、.html 附件或在线预览链接)${uiRequiredFiles.length > 0 ? `,便于确认界面符合 ${uiRequiredFiles.join(' / ')} 设计规范` : ',便于确认界面呈现符合预期'}`
    : null;
  const formatPass = formatIssues.length === 0;

  // ── 1.5 + 1.6.5:GraphQL 拉历史 ──
  // ghGraphql 容忍 GraphQL 部分成功(某字段被 token 拒时其余字段仍能拿到),作通用兜底。
  const gqlData = ghGraphql(GQL, { owner, repo, num: pr })?.data ?? {};
  const g = gqlData.repository?.pullRequest ?? {};
  const viewerLogin = gqlData.viewer?.login ?? '';
  const authorLogin = meta.author?.login ?? '';
  const isSelfFixAuthor = SELF_FIX_AUTHORS.includes(authorLogin.toLowerCase());
  // isOwnPr(= viewer 自己的 PR)与 isSelfFixAuthor(= selfFixAuthors 名单)彻底解耦——
  // 前者是「GitHub API 层面能不能对这个 PR 提 REQUEST_CHANGES/APPROVE」的事实判定(GitHub
  // 硬性禁止对自己的 PR 提交这两种 review event,422),后者只决定「卡在作者侧问题时是否
  // 自动开跟进会话去修」。selfFixAuthors 当前可能为空,但只要 viewer==author 就一定会撞
  // 422,与名单是否配置无关;3B/3A 第 0 步等一切要提交 review event 的地方都必须读 isOwnPr,
  // 不能只查 selfFixAuthors。
  const isOwnPr = viewerLogin !== '' && authorLogin !== '' && viewerLogin.toLowerCase() === authorLogin.toLowerCase();
  // isAdminAuthor:作者(不是 viewer)在 admins 名单——结构性 BLOCKED 分级合并策略(SC0-3)
  // 的判据,与 isOwnPr/isSelfFixAuthor 各自独立,三者可以任意组合。ADMINS 为空时恒 false
  // (fail-closed)。
  const isAdminAuthor = ADMINS.size > 0 && ADMINS.has(authorLogin.toLowerCase());

  // 1.5.2 review threads
  const rawThreads = g.reviewThreads?.nodes ?? [];
  const reviewThreads = rawThreads.map((t) => {
    const cs = t.comments?.nodes ?? [];
    return {
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      author: cs[0]?.author?.login ?? '(unknown)',
      isBot: isBot(cs[0]?.author),
      count: cs.length,
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
    body: clip(c.body, 600),
  }));

  // 1.5.3 commits 时间线
  const commits = (g.timeline?.nodes ?? []).map((n) => ({
    oid: (n.commit?.oid ?? '').slice(0, 8),
    date: n.commit?.committedDate,
    headline: n.commit?.messageHeadline,
  }));
  const latestCommitDate = commits.reduce((mx, c) => (c.date > mx ? c.date : mx), '');

  // ── 产品/UI 变更门(确定性部分;「是否真属产品/UI 修改」「issue / PR 评论里白名单是否同意推进」
  // 两项语义定性留给 LLM,见 SKILL「产品 / UI 变更门」)──
  // 目的:牵涉产品方向 / UI 的改动必须有白名单成员「明确同意推进」才能进自动审;bugfix / 已有功能补充不受限。
  // hold 标记(product-hold.mjs 写入):非空 = 该 PR 被产品/架构门 hold 过。isDraft + 标记非空
  // = 「被 hold 中的 draft」,是自动放行(product-release.mjs)的判定对象——此时无论豁免与否
  // 都要读讨论 issue,主 agent 判出白名单同意后自动标回 Ready,作者无需任何操作。
  const holdMarker = parseLastHoldMarker(rawComments.map((c) => c.body));
  const heldDraft = meta.isDraft === true && holdMarker != null;
  const inWhitelist = (login) => PRODUCT_WHITELIST.includes((login ?? '').toLowerCase());
  const authorInWhitelist = inWhitelist(authorLogin);
  // 白名单 review 清单(信息位,供汇总/定性参考):非 viewer 的白名单成员任意 state 都列;viewer(本流程
  // 自动化账号)只列 APPROVED——自动化自己会以 viewer 身份发 REQUEST_CHANGES(3B 打回),不能当白名单信号。
  const viewerLower = viewerLogin.toLowerCase();
  const whitelistReviews = prReviews
    .filter((r) => {
      const login = (r.author?.login ?? '').toLowerCase();
      if (!inWhitelist(login)) return false;
      return login !== viewerLower || r.state === 'APPROVED';
    })
    .map((r) => ({ author: r.author?.login ?? '', state: r.state, submittedAt: r.submittedAt }));
  // 豁免只认「明确同意」:白名单成员在 PR 上点过 Approve(APPROVED)才算;COMMENTED / CHANGES_REQUESTED
  // 只代表「看过 / 有意见」,不代表同意推进(收紧自旧版「任意 review 都算」)。viewer 的 APPROVED 可安全计入:
  // self-approve 只发生在产品门已过、重审通过之后,时序上不可能反向豁免一个被产品门拦着的 PR。
  const whitelistApprovals = whitelistReviews.filter((r) => r.state === 'APPROVED');
  // 最近一次「标回 Ready for review」的操作者:白名单成员点 ready = 明确放行信号。
  // 自动化侧只有 product-release.mjs 会标 ready,且它只在「主 agent 判定讨论 issue 里白名单
  // 已明确同意」之后执行——所以无论该事件来自人肉还是自动放行,语义都是「放行已发生」,
  // viewer 账号的 ready 事件同样可信(转 draft 的 product-hold.mjs 从不标 ready)。
  const readyEvents = (g.readyEvents?.nodes ?? []).map((n) => ({ actor: n.actor?.login ?? '', createdAt: n.createdAt }));
  const latestReadyBy = readyEvents.length ? readyEvents[readyEvents.length - 1].actor : '';
  const readyByWhitelist = latestReadyBy !== '' && inWhitelist(latestReadyBy);
  const productExempt = authorInWhitelist || whitelistApprovals.length > 0 || readyByWhitelist;
  // 确定性触发器:feat 类型或命中 UI 面路径。命中且未豁免 → auto 走 product-gate,由主 agent 语义定性;
  // fix / 轻档 type 且没碰 UI 面的,直接视为 bugfix / 技术改动,不触发。
  const needsProductCheck = !productExempt && (type === 'feat' || touchesUi);
  // 讨论 issue 的白名单留言(放行主路径的确定性原料;仅命中门的 PR 才查,省 API):
  // 从 PR 评论里 product-hold.mjs 的隐藏标记读出当初开的讨论 issue(取最后一条带 issue= 的标记,与
  // product-hold 口径一致),拉 issue 全部评论、过滤出白名单成员的留言原文。「留言是否构成明确同意推进」
  // 是语义活,由主 agent 判(拿不准从严),脚本只给原料不下结论。viewer 账号在讨论期间不会往 issue 发言
  // (只在 PR 合并后 close 时发),所以 open issue 上 viewer 的留言可视为本人人肉发言,不做 viewer 特判。
  /**
   * 读取该 PR 被 hold 时开的讨论 issue + 其中白名单成员留言(产品门 / 架构门共用——
   * hold 机制是同一套 product-hold.mjs,marker 同前缀,marker 里可带 kind=arch;
   * 唯一差异是「按哪份白名单过滤留言」,由 whitelistFn 注入)。未被 hold 过返回 null。
   */
  function readDiscussionIssue(whitelistFn) {
    const heldIssueUrl = holdMarker?.issueUrl ?? null;
    const issueNum = holdMarker?.issueNumber ?? null;
    if (issueNum) {
      try {
        const issueMeta = ghJson(['issue', 'view', String(issueNum), '--repo', slug, '--json', 'state,comments,updatedAt']);
        // 白名单留言两个来源:① 白名单成员本人直接评论;② Slack 同步 bot 代发的评论——
        // GitHub 作者是 bot,真实发言人在正文「发送者:<名字>」里,拿名字去 org 名录反查
        // GitHub 账号(要求唯一命中)再对白名单。名录只在真的碰到 bot 评论时才加载(省 IO)。
        const whitelistComments = [];
        const unattributedSlackComments = [];
        let rosterErrors = null;
        let rosterCache = null;
        for (const c of issueMeta.comments ?? []) {
          const login = c.author?.login ?? '';
          if (whitelistFn(login)) {
            whitelistComments.push({ author: login, createdAt: c.createdAt, body: clip(c.body, 600) });
            continue;
          }
          if (!SLACK_SYNC_BOTS.includes(normalizeBotLogin(login))) continue;
          // 新版同步署名:「来自 Slack #<频道> · @<GitHub login>(<显示名>)」——直接带 GitHub
          // 账号,零反查即可归属(信任锚仍是 bot 作者本身,普通用户的评论进不了本分支)。
          const inlineLogin = (c.body ?? '').match(/来自\s*Slack[^\n]*?·\s*@([A-Za-z0-9][A-Za-z0-9-]*)/)?.[1] ?? null;
          if (inlineLogin) {
            if (whitelistFn(inlineLogin)) {
              whitelistComments.push({ author: login, via: 'slack-sync', sender: inlineLogin, resolvedLogin: inlineLogin.toLowerCase(), resolvedBy: 'inline-login', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            continue; // 归属已确定:非白名单 = 普通参与讨论者,静默忽略
          }
          // 旧版署名:「发送者:」后是真人名字;冒号全角(：)半角都兼容。两种署名都没有的
          // 同步评论是 AI 机器人自己的回复(如「本评论由 Cindy ... 回复后自动同步而来」),
          // 非人类发言,静默跳过——既不计白名单,也不进 unattributed 刷屏。
          const sender = (c.body ?? '').match(/发送者\s*[:：]\s*([^\n\r]+)/)?.[1]?.trim() ?? null;
          if (!sender) continue;
          // 别名优先(不依赖名录,零 IO):命中即定论,白名单进留言、非白名单静默忽略
          const aliasLogin = SLACK_SENDER_ALIASES[sender.toLowerCase()] ?? null;
          if (aliasLogin) {
            if (whitelistFn(aliasLogin)) {
              whitelistComments.push({ author: login, via: 'slack-sync', sender, resolvedLogin: aliasLogin, resolvedBy: 'alias', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            continue;
          }
          if (!rosterCache) {
            const loaded = loadOrgRosters(prRules.feishuNotify?.orgMappingRepos ?? []);
            rosterCache = loaded.rosters;
            rosterErrors = loaded.fetchErrors.length ? loaded.fetchErrors : null;
          }
          // 名字 → 名录行 → GitHub login:行里必须真解析出 name 且与发送者一致(相等或包含,
          // 兼容「陈祝宇 (Zhuyu)」这类带备注的名录写法),防止名字子串误中别的单元格。
          const logins = new Set();
          for (const { text } of rosterCache) {
            for (const line of text.split('\n')) {
              if (!line.includes('|') || !line.includes(sender)) continue;
              const parsed = parseRosterLine(line);
              if (!parsed?.githubLogin || !parsed.name) continue;
              if (parsed.name === sender || parsed.name.includes(sender)) logins.add(parsed.githubLogin.toLowerCase());
            }
          }
          if (logins.size === 1) {
            const resolvedLogin = [...logins][0];
            if (whitelistFn(resolvedLogin)) {
              whitelistComments.push({ author: login, via: 'slack-sync', sender, resolvedLogin, resolvedBy: 'roster', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            // 唯一命中但不在白名单 → 普通参与讨论者,静默忽略
          } else {
            // 名录没这人 / 同名多人 → 归属不了,不计白名单也不丢弃信息,交主 agent 酌情上报
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
        return {
          url: heldIssueUrl,
          number: Number(issueNum),
          state: issueMeta.state ?? null,
          updatedAt: issueMeta.updatedAt ?? null,
          whitelistComments,
          ...(unattributedBySender.length ? { unattributedSlackComments: unattributedBySender } : {}),
          ...(rosterErrors ? { rosterErrors } : {}),
        };
      } catch (e) {
        // issue 读不到(被删 / 权限 / 网络)→ 保留 URL 供人工查看,whitelistComments=null 表示「未知」,
        // 主 agent 不得把「未知」当「无同意」直接再 hold 骚扰,应如实进汇总让 owner 看一眼。
        return { url: heldIssueUrl, number: Number(issueNum), state: null, updatedAt: null, whitelistComments: null, error: String(e?.message ?? e).slice(0, 200) };
      }
    }
    return null;
  }

  // PR 内白名单留言(语义判定原料,与讨论 issue 留言同等采信):白名单成员直接在 PR 评论区
  // 回复「可以 / 合适 / 同意推进」同样构成同意材料,是否真属明确同意仍由主 agent 语义判定
  // (拿不准从严)。两类评论必须剔除:① viewer(本流程自动化账号)的评论——自动化会以
  // viewer 身份发 hold 告知、resolve 催办等 PR 评论(催办评论不带隐藏标记,无法可靠区分
  // 人肉/机器),一律不采信,viewer 本人表态请走讨论 issue / Approve / 标 ready;② 带
  // `<!-- review-pr:` 隐藏标记的评论——自动化产物(hold / release 告知),即使发帖账号
  // 后来换过也不能当人肉表态。Slack 同步 bot 只写讨论 issue 不写 PR,这里不做 bot 归属。
  function collectPrWhitelistComments(whitelistFn) {
    return rawComments
      .filter((c) => {
        const login = (c.author?.login ?? '').toLowerCase();
        if (!whitelistFn(login) || login === viewerLower) return false;
        return !(c.body ?? '').includes('<!-- review-pr:');
      })
      .map((c) => ({ author: c.author?.login ?? '', createdAt: c.createdAt, url: c.url, body: clip(c.body, 600) }));
  }

  // held draft 无论豁免与否都读讨论 issue(自动放行需要白名单留言原料 + issue updatedAt 进空转指纹)
  const discussionIssue = needsProductCheck || (heldDraft && holdMarker.kind === 'product')
    ? readDiscussionIssue(inWhitelist)
    : null;
  const prWhitelistComments = needsProductCheck || (heldDraft && holdMarker.kind === 'product')
    ? collectPrWhitelistComments(inWhitelist)
    : null;
  const productGate = {
    whitelist: prRules.productWhitelist ?? [],
    authorInWhitelist,
    whitelistReviews,
    whitelistApprovals,
    latestReadyBy,
    readyByWhitelist,
    uiFiles,
    touchesUi,
    exempt: productExempt,
    needsProductCheck,
    discussionIssue,
    prWhitelistComments,
    note: 'exempt=true → 产品门确定性放行(作者在白名单 / 白名单成员在 PR 上点过 Approve(whitelistApprovals)/ 白名单成员把 PR 标回 ready)。needsProductCheck=true → 疑似产品/UI 变更且无确定性放行信号,主 agent 按 SKILL「产品 / UI 变更门」做两步语义判断:① discussionIssue.whitelistComments 或 prWhitelistComments(白名单成员直接在 PR 评论区的回复,已剔除自动化账号与带隐藏标记的评论)非空时先判白名单留言是否明确同意推进——任一来源明确同意即算 → 按 auto.fallback 继续(视同放行);via=slack-sync 的条目是 Slack 同步消息经 org 名录归属到白名单成员(sender→resolvedLogin)的发言,与本人直接评论同等采信;unattributedSlackComments 非空且内容像同意表态 → 不得采信,进汇总点名让 owner 确认发送者身份;whitelistComments=null(带 error)= issue 读不到,如实进汇总别当「无同意」再 hold;rosterErrors 非空 = 名录读不到、Slack 消息归属可能不完整,同样如实说明。② 未同意 / 无 issue 时再判「是否真属产品/UI 修改」——确属 → product-hold.mjs(自动开讨论 issue + 评论告知作者 + 转 draft);属 bugfix / 已有功能补充 → 按 auto.fallback 继续原流程。两步语义判断拿不准都从严。被 hold 的 draft(顶层 held.heldDraft=true)判出「已同意」(讨论 issue 留言或 PR 内白名单留言任一来源明确同意即算)或 exempt=true 时 → 跑 product-release.mjs 自动把 PR 标回 Ready(作者无需操作)再继续',
  };

  // ── 技术架构变更门(确定性部分;「是否真属较大架构调整」「issue 里技术白名单是否同意」由 LLM 判,
  // 见 SKILL「技术架构变更门」)。与产品门同机制(hold=product-hold.mjs --kind arch),差异只有三处:
  // 触发器(核心路径改动量 / refactor 大 diff / 超大 diff)、白名单(archGate.whitelist)、语义定性口径。
  // 优先级:产品门 > 架构门——一个 PR 同时命中两门时先走产品门(产品方向都没对齐,技术讨论为时过早);
  // 产品门放行后若仍命中架构门,下一轮再走架构门。
  const inArchWhitelist = (login) => ARCH_WHITELIST.includes((login ?? '').toLowerCase());
  const archAuthorInWhitelist = inArchWhitelist(authorLogin);
  // 白名单 review / ready 放行信号:口径与产品门完全一致(只认 APPROVED / 亲自标 ready)
  const archWhitelistReviews = prReviews
    .filter((r) => {
      const login = (r.author?.login ?? '').toLowerCase();
      if (!inArchWhitelist(login)) return false;
      return login !== viewerLower || r.state === 'APPROVED';
    })
    .map((r) => ({ author: r.author?.login ?? '', state: r.state, submittedAt: r.submittedAt }));
  const archWhitelistApprovals = archWhitelistReviews.filter((r) => r.state === 'APPROVED');
  const readyByArchWhitelist = latestReadyBy !== '' && inArchWhitelist(latestReadyBy);
  // 冷更触发器:CI fingerprint guard 的 sticky comment 是权威结论(它在同一 runner 上真算过
  // base(main) 与合并结果两份指纹),压过路径启发式两个方向:
  //   - guard 说变 → 一定触发冷更,即便没碰 coldUpdatePaths(原生依赖版本可能只体现在 lockfile 上);
  //   - guard 说没变 → 路径命中也不触发(只改 eas.json 的 beta-* profile、或被 app.config.js
  //     剥离/覆写而进不到 resolved config 的字段,都是指纹中性的)。
  // 结论行由 apps/mobile/scripts/ci-fingerprint.mjs 的 guardChangedMarker 写入(机器可读);
  // 老版 guard 评论没有该行时退回标题文案判定,两者都读不出 → changed=null(当作未知,不放行,
  // 由路径启发式接管)。guard 评论是 sticky(原地更新),取最后一条并带 updatedAt 供主 agent
  // 判断结论是否已覆盖最新 head。
  const coldUpdateGuard = parseFingerprintGuard(rawComments, COLD_UPDATE_GUARD_MARKER, latestCommitDate);
  const coldUpdateFiles = matchColdUpdatePaths(files.map((f) => f.path), ARCH_COLD_UPDATE_PATHS);
  const coldUpdateTrigger = coldUpdateGuard?.changed === true
    ? `cold-update-confirmed(fingerprint guard 判定合并后指纹变化 → 必须冷更出包${coldUpdateFiles.length ? `;命中指纹输入 ${coldUpdateFiles.slice(0, 5).join(' / ')}` : ''})`
    : coldUpdateGuard?.changed === false
      ? null
      : coldUpdateFiles.length > 0
        ? `cold-update-suspect(改到指纹输入 ${coldUpdateFiles.slice(0, 5).join(' / ')}${coldUpdateFiles.length > 5 ? ' 等' : ''}${coldUpdateGuard ? ';guard 结论读不出' : ';无 guard 结论'} → 需确认是否触发冷更)`
        : null;
  // 触发器(任一命中即需语义定性;阈值配置在 pr-rules.json archGate)
  const archCoreFiles = files.filter((f) => ARCH_CORE_PATHS.some((prefix) => f.path.startsWith(prefix)));
  const archCoreDiffLines = archCoreFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  const archTriggers = [
    coldUpdateTrigger,
    archCoreFiles.length > 0 && archCoreDiffLines >= ARCH_CORE_DIFF_LINES ? `core-paths(核心路径改动 ${archCoreDiffLines} 行 ≥ ${ARCH_CORE_DIFF_LINES})` : null,
    type === 'refactor' && totalDiffLines >= ARCH_REFACTOR_DIFF_LINES ? `refactor-large(refactor 类型且 ${totalDiffLines} 行 ≥ ${ARCH_REFACTOR_DIFF_LINES})` : null,
    totalDiffLines >= ARCH_ANY_DIFF_LINES ? `huge-diff(${totalDiffLines} 行 ≥ ${ARCH_ANY_DIFF_LINES})` : null,
  ].filter(Boolean);
  // 冷更触发时,架构门的常规豁免信号(作者在白名单 / 白名单 Approve / 白名单标回 ready)一律作废:
  // 谁改手机端会触发冷更的代码都要进一步确认,放行只认 coldUpdateApprovers 明确针对冷更的表态。
  const isColdUpdateApprover = (login) => COLD_UPDATE_APPROVERS.includes((login ?? '').toLowerCase());
  const needsColdUpdateCheck = coldUpdateTrigger != null && COLD_UPDATE_APPROVERS.length > 0;
  const archExemptSignals = archAuthorInWhitelist || archWhitelistApprovals.length > 0 || readyByArchWhitelist;
  const archExempt = archExemptSignals && !needsColdUpdateCheck;
  // 白名单与放行人名单都为空 = 功能未启用(archGate 输出 null,auto 分流不包裹)
  const archGateEnabled = ARCH_WHITELIST.length > 0 || COLD_UPDATE_APPROVERS.length > 0;
  const needsArchCheck = archGateEnabled && archTriggers.length > 0
    && (needsColdUpdateCheck || (ARCH_WHITELIST.length > 0 && !archExempt));
  // 冷更在场时,放行材料要连把关人的留言一起收(把关人不一定在技术白名单里)
  const gateWhitelistFn = needsColdUpdateCheck
    ? (login) => inArchWhitelist(login) || isColdUpdateApprover(login)
    : inArchWhitelist;
  const archDiscussionIssue = (!needsProductCheck && needsArchCheck) || (heldDraft && holdMarker.kind === 'arch')
    ? readDiscussionIssue(gateWhitelistFn)
    : null;
  const archPrWhitelistComments = (!needsProductCheck && needsArchCheck) || (heldDraft && holdMarker.kind === 'arch')
    ? collectPrWhitelistComments(gateWhitelistFn)
    : null;
  // 把关人候选表态(供主 agent 逐条判「是否明确针对冷更同意」):讨论 issue 侧从已收留言里过滤,
  // PR 侧单独收一遍 —— 与 collectPrWhitelistComments 只差一处:**不剔除 viewer 账号的评论**。
  // 本流程的自动化账号很可能就是把关人本人(selfFixAuthors),一律剔除会把她本人写在 PR 里的
  // 冷更确认吞掉。带 `<!-- review-pr:` 标记的自动化产物照旧剔除;viaViewerAccount=true 的条目
  // 由主 agent 读正文确认是人肉表态(hold 告知 / resolve 催办这类自动化文案不构成同意)。
  const coldUpdateApproverComments = needsColdUpdateCheck
    ? [
      ...(archDiscussionIssue?.whitelistComments ?? [])
        .filter((c) => isColdUpdateApprover(c.resolvedLogin ?? c.author))
        .map((c) => ({ from: 'discussion-issue', ...c })),
      ...rawComments
        .filter((c) => isColdUpdateApprover(c.author?.login) && !(c.body ?? '').includes('<!-- review-pr:'))
        .map((c) => ({
          from: 'pr-comment',
          author: c.author?.login ?? '',
          viaViewerAccount: (c.author?.login ?? '').toLowerCase() === viewerLower,
          createdAt: c.createdAt,
          url: c.url,
          body: clip(c.body, 600),
        })),
    ]
    : null;
  const archGate = archGateEnabled
    ? {
      whitelist: ARCH_RULES.whitelist ?? [],
      authorInWhitelist: archAuthorInWhitelist,
      whitelistReviews: archWhitelistReviews,
      whitelistApprovals: archWhitelistApprovals,
      latestReadyBy,
      readyByWhitelist: readyByArchWhitelist,
      triggers: archTriggers,
      coreFilePaths: archCoreFiles.map((f) => f.path).slice(0, 30),
      coreDiffLines: archCoreDiffLines,
      totalDiffLines,
      coldUpdate: {
        guard: coldUpdateGuard,
        files: coldUpdateFiles.slice(0, 30),
        trigger: coldUpdateTrigger,
        approvers: ARCH_RULES.coldUpdateApprovers ?? [],
        needsColdUpdateCheck,
        // 常规豁免信号存在、但因为触发冷更而被作废(作者在白名单 / 有白名单 Approve / 白名单标回 ready)
        exemptOverridden: archExemptSignals && needsColdUpdateCheck,
        approverComments: coldUpdateApproverComments,
      },
      exempt: archExempt,
      needsArchCheck,
      discussionIssue: archDiscussionIssue,
      prWhitelistComments: archPrWhitelistComments,
      note: 'exempt=true → 架构门确定性放行(作者在技术白名单 / 技术白名单成员 PR 上 Approve 过 / 技术白名单成员把 PR 标回 ready)。needsArchCheck=true → 触发器命中且无放行信号,主 agent 按 SKILL「技术架构变更门」做两步语义判断(口径同产品门,只是判「是否真属较大架构调整」;discussionIssue、prWhitelistComments 的消费规则与 productGate 完全一致,留言按技术白名单过滤,PR 内技术白名单成员的直接回复同等采信)。产品门优先:needsProductCheck=true 时本门让位(auto 分流只会给 product-gate),下一轮产品门放行后再评估本门。coldUpdate = mobile 冷更触发器(与技术框架变动同级,不设 diff 阈值,且**不受本门常规豁免**):needsColdUpdateCheck=true 时 exempt 一定是 false —— 谁改手机端会触发冷更的代码都要进一步确认,作者在技术白名单、白名单成员的普通 Approve、白名单标回 ready 都不算放行(exemptOverridden=true 表示确实有这些信号但已作废);唯一放行信号是 coldUpdate.approvers 里的把关人**明确针对冷更**的表态(候选材料已收进 coldUpdate.approverComments,逐条判是否构成明确同意:必须能看出知道这次会冷更并同意,泛泛的「看过了 / 可以合」不算;approvers 名单内成员自己提的 PR 同样要有这样一条显式表态,不能靠身份过;脚本不采集 review 正文,把关人只点 Approve 不留言不构成同意;viaViewerAccount=true 的条目要读正文确认是人肉表态而非自动化文案;拿不准从严 hold)。trigger 为 cold-update-confirmed 时不适用「是否较大架构调整」这套定性——fingerprint guard 已经算出合并后指纹会变,存量装机拿不到本次及后续热更,必须技术白名单明确同意才能合并,不得因为「diff 很小 / 只是配置一行」自行放行;此时的语义活只有两件:① 白名单留言是否已明确同意(同意 → 按 auto.fallback 继续)② PR Description 是否写清了为什么冷更不可避免、存量装机影响与发版节奏(没写清 → hold 时在 issue / 评论里点名要求补)。trigger 为 cold-update-suspect 时先判「这次改动是否真的进 resolved config / 真的动指纹」(判据见 docs/dev-rules/mobile-development.md「冷更边界」:被哈希的是解析后的 ExpoConfig,被 app.config.js 剥离或覆写的字段、eas.json 的 beta-* profile 都指纹中性),确属动指纹 → 同 confirmed 口径,拿不准从严 hold;guard.changed=false 时脚本已不触发本项(guard 结论压过路径启发式)。guard.staleVsHead=true 表示 guard 结论比最新 commit 旧,结论可能未覆盖当前 head,别拿旧结论放行',
    }
    : null;

  // ── 1.6.5.1 CI:本脚本不读(见文件头部说明),CI 是否全过由 meta.mergeStateStatus 间接体现 ──

  // ── 1.6.5.2 未解决 conversation(纯布尔,不分作者)──
  const unresolvedThreads = reviewThreads.filter((t) => !t.isResolved);

  // ── head commit 的 workflow run 分类(只在 BLOCKED 时查,省掉正常 PR 的额外 API)──
  // classifyHeadChecks 一次拉 actions/runs 得到 awaiting / failed / pending:
  //   - awaiting:fork / 首次贡献者 workflow 待批准才能跑(required check 没报告)。这与
  //     blockedAwaitingApproval(缺 reviewer approval)是两个不同的 BLOCKED 来源,不要混;
  //     真批由 approve-workflows.mjs 做,这里只探测供 1.7 报告 + auto 分流。
  //   - failed / pending:真失败 / 还在跑,用于 BLOCKED 细分。
  // 权限/网络异常降级为 ciRuns=null(未知),绝不炸掉 context。
  const { ciRuns } = meta.mergeStateStatus === 'BLOCKED'
    ? classifyHeadChecks(slug, meta.headRefOid)
    : { ciRuns: null };
  const workflowsAwaitingApproval = ciRuns ? ciRuns.awaiting : null; // null=未查/查不到;[]=无;非空=待批清单
  const hasWorkflowsAwaiting = Array.isArray(workflowsAwaitingApproval) && workflowsAwaitingApproval.length > 0;
  const ciFailed = ciRuns ? ciRuns.failed : [];
  const ciPending = ciRuns ? ciRuns.pending : [];
  // head commit 上「所有已上报检查」的全集(含第三方 App check-run 与 commit status)。
  // classifyHeadChecks 走 actions/runs,只看得见 GitHub Actions 的 workflow run —— 第三方
  // App(Greptile 等)的 check-run 与 commit status 它一条都看不到。BLOCKED 细分若只信
  // ciRuns,一个「非 required 的第三方检查真失败」的 PR 会因「已跑 CI 无失败」直接落进
  // structural-check 分支,再被 auto --admin bypass 合并(实测 #318:Greptile Review
  // conclusion=failure,却被判 bypass-structural-block)。rollup 是全集,BLOCKED 也必须查。
  const headRollup = meta.mergeStateStatus === 'BLOCKED'
    ? classifyStatusRollup(meta.statusCheckRollup)
    : null;

  // ── 自解死锁判定:BLOCKED 仅因「viewer(本流程账号)自己挂的 CHANGES_REQUESTED」而起,
  // 且所有 conversation 都已 resolve。这是 auto 流程自己 3B 打回后、作者改完 resolve、
  // 但旧 CR review 没撤导致 reviewDecision 永远 CHANGES_REQUESTED → BLOCKED → skip-gate
  // 永远跳过的死锁。命中时这条 CR 不计入硬 blocker:走重审,审查子 agent 逐条核实问题
  // 真被改了(历史承接),再由合并阶段同身份 self-approve 覆盖掉自己的 CR 解锁。
  // ⚠️ 只要掺了「别人」的 CR(allChangesRequestedBySelf=false)、或还有 thread 没 resolve,
  // 就不命中 → 照旧硬拦,绝不替别人撤 review。
  const allChangesRequestedBySelf =
    hasChangesRequested && viewerLogin !== '' &&
    changesRequestedReviews.every((r) => (r.author?.login ?? '') === viewerLogin);
  const selfBlockedResolvable =
    meta.mergeStateStatus === 'BLOCKED' &&
    meta.reviewDecision === 'CHANGES_REQUESTED' &&
    allChangesRequestedBySelf &&
    unresolvedThreads.length === 0;

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

  // ── 授权快速合并通道(见 lib.mjs findApproveMergeAuthorization / evaluateAuthorizedFastMerge、
  // SKILL 5.1「授权快速合并通道」):admins 名单成员发 `/approve-merge` = 人工已过安全与
  // 代码审查的明确授权,可跳过阶段二独立审查与 securityReviewPaths 门直接进合并。这是
  // 紧急通道——owner 2026-08-01 拍板收窄阻断面:管理员显式授权即自担责任,机器的职责从
  // "拦"变成"留痕"。任何情况不可压过的只剩:泄密硬门(security.hardHits)、物理不可合
  // (mergeStateStatus=DIRTY)、required 检查未全绿/读取失败。格式门未过、未 resolve
  // thread、非 required 检查失败**不再阻断 eligible**,改为 reportOnly——必须显著写进
  // 报告/汇总/合并致谢,不能悄悄吞掉(见 evaluateAuthorizedFastMerge 与其 reportOnly)。
  const approveMergeAuth = findApproveMergeAuthorization({ comments, admins: prRules.admins, latestCommitDate });
  const authorizedFastMerge = {
    adminsConfigured: approveMergeAuth.adminsConfigured,
    requested: approveMergeAuth.authorized != null,
    eligible: false,
    admin: approveMergeAuth.authorized?.author ?? null,
    commentUrl: approveMergeAuth.authorized?.url ?? null,
    commentCreatedAt: approveMergeAuth.authorized?.createdAt ?? null,
    staleComments: approveMergeAuth.stale,
    blockedReason: null,
    reportOnly: { formatIssues: [], unresolvedThreadCount: 0, nonRequiredFailures: [] },
  };
  if (approveMergeAuth.authorized) {
    const checkNodes = fetchHeadCheckContexts({ owner, repo, pr });
    const requiredChecks = checkNodes ? classifyRequiredChecks(checkNodes) : null;
    const evaluation = evaluateAuthorizedFastMerge({
      hasSecurityHardHit: security.hardHitCount > 0,
      mergeStateStatus: meta.mergeStateStatus,
      unresolvedThreadCount: unresolvedThreads.length,
      formatPass,
      formatIssues,
      requiredChecks,
    });
    authorizedFastMerge.eligible = evaluation.eligible;
    authorizedFastMerge.blockedReason = evaluation.blockedReason;
    authorizedFastMerge.reportOnly = evaluation.reportOnly;
  }

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
  let structuralAllowlisted = false; // structuralBlock.requiredCheckRules 是否全部命中 STRUCTURAL_BYPASS_ALLOWLIST
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
        // 再由合并阶段 self-approve 解锁(见 selfBlockedResolvable 注释)。
        blockClass = 'self-resolvable';
      } else {
        blockers.push('mergeStateStatus=BLOCKED(reviewDecision=CHANGES_REQUESTED,仍有 reviewer 要求修改)');
        blockClass = 'review-changes-requested';
      }
    } else if (reviewDecision === 'REVIEW_REQUIRED' || reviewDecision == null) {
      // 缺 approval(含刚 approve 完 GitHub 还在重算)→ 不视硬 blocker,审查通过后提交 APPROVE 即解除。
      blockClass = 'awaiting-approval';
    } else if (unresolvedThreads.length > 0) {
      // reviewDecision=APPROVED 但仍有 thread 没 resolve → BLOCKED 很可能来自 ruleset 的
      // required_review_thread_resolution。blocker 由下面 unresolvedThreads 统一押,这里只定 class。
      blockClass = 'threads-unresolved';
    } else if (ciRuns === null) {
      // CI 状态读不到(权限 / 网络 / 解析失败,见 lib.mjs classifyHeadChecks)——不知道 CI
      // 到底过没过,绝不能当「无失败 / 无 pending」直接落进下面的 structural-check 分支再被
      // auto --admin bypass 放过(某些仓库当前账号对必需检查门可能 canBypass=always,一旦
      // 误判就是真的会自动 bypass 合并未知 CI 状态的 PR)。单列 skip,不可 bypass、不催办——
      // 下一轮重新探测,读到了自然会分流去该去的地方。
      blockers.push('mergeStateStatus=BLOCKED,但 CI 状态读取失败(权限/网络/解析问题,见 lib.mjs classifyHeadChecks)——CI 是否通过未知,本轮不动,下轮再看,不当结构性门处理、不可 bypass');
      blockClass = 'ci-unknown';
    } else if (ciFailed.length > 0) {
      // 有 workflow run 真失败 → 真 blocker(该打回 / 不合)。
      blockers.push(`mergeStateStatus=BLOCKED(CI 失败:${ciFailed.join(' / ')})`);
      blockClass = 'ci-failed';
    } else if (ciPending.length > 0) {
      // workflow run 还在跑 → 等跑完再合(transient,auto 下轮重试,别打回作者)。
      blockers.push(`mergeStateStatus=BLOCKED(CI 还在跑:${ciPending.join(' / ')},等跑完即可)`);
      blockClass = 'ci-pending';
    } else if (headRollup === null) {
      // rollup 读不到(字段没取 / 权限异常)→ 第三方 App check-run 与 commit status 是否失败
      // 未知。与上面 ciRuns===null 同口径 fail-closed:不当结构性门、不可 bypass,下轮再看。
      blockers.push('mergeStateStatus=BLOCKED,但 statusCheckRollup 读取失败——第三方 App check-run / commit status 是否失败未知(classifyHeadChecks 只看得到 GitHub Actions),不当结构性门处理、不可 bypass,下轮再看');
      blockClass = 'ci-unknown';
    } else if (headRollup.failed.length > 0) {
      // 已跑的 GitHub Actions 全绿,但 head 上仍有已上报检查失败 → 只可能来自 actions/runs
      // 看不见的那部分(第三方 App check-run / commit status)。这是真 blocker,绝不能当成
      // 「永不上报的结构性门」被 admin bypass 掉。
      blockers.push(`mergeStateStatus=BLOCKED(head 上已上报检查失败:${headRollup.failed.join(' / ')}——第三方 App check-run / commit status,classifyHeadChecks 看不到;修绿前不合并)`);
      blockClass = 'ci-failed';
    } else if (headRollup.pending.length > 0) {
      blockers.push(`mergeStateStatus=BLOCKED(head 上已上报检查还在跑:${headRollup.pending.join(' / ')},等跑完即可)`);
      blockClass = 'ci-pending';
    } else {
      // review 满足(APPROVED)+ 线程已 resolve + CI 来源明确完整(ciRuns 非 null)且无失败/
      // 进行中/待批的 workflow run,但仍 BLOCKED → 残留的是「永不上报结果的必需检查门」:
      // 典型 org ruleset 的 code_scanning(CodeQL)/ code_quality(本仓库根本没产出对应结果),
      // 或被 job 级 if 跳过的必需 check。这类不是作者要改 —— 要么 owner 用 admin bypass 合、
      // 要么修该门让它能上报结果。
      blockClass = 'structural-check';
      // 把 head rollup 里已通过的检查名传给 probe:required_status_checks 规则若已被全绿的
      // context 满足,就不再算「未上报的必需检查门」,否则 allowlist 判据永远差一项,
      // code_scanning/code_quality 这类真空门的自动 bypass 被永久锁死。
      const rollupOk = headRollup?.ok;
      structuralBlock = probeBranchProtection(slug, meta.baseRefName, {
        satisfiedContexts: rollupOk ? new Set(rollupOk) : null,
      });
      structuralAllowlisted = !!structuralBlock?.requiredCheckRules?.length &&
        structuralBlock.requiredCheckRules.every((r) => STRUCTURAL_BYPASS_ALLOWLIST.has(r));
      const ruleHint = structuralBlock?.requiredCheckRules?.length
        ? structuralBlock.requiredCheckRules.join(' / ')
        : 'code_scanning / code_quality 等';
      const bypassHint = structuralBlock?.canBypass && structuralBlock.canBypass !== 'never'
        ? `当前账号可 bypass(${structuralBlock.canBypass})${structuralAllowlisted ? '' : ',但命中的必需检查类型不在 structuralBypassAllowlist 里,不自动 bypass'}`
        : 'bypass 权限未知';
      blockers.push(
        `mergeStateStatus=BLOCKED(必需检查门「${ruleHint}」未上报结果;review 与已跑 CI 均无问题——非作者可处理,需 admin bypass 合或修该门;${bypassHint})`,
      );
    }
  } else if (meta.mergeStateStatus === 'UNSTABLE') {
    // UNSTABLE = GitHub 判「可合并,但有非 required 检查失败/未完成」。分支保护不拦它,
    // 这里必须拦:跑在 PR 上但没升门的检查(PG smoke / bench)、第三方 App check(Greptile)
    // 失败都会落在这个状态,漏掉就是自动合并带病 PR。用 statusCheckRollup 而不是
    // classifyHeadChecks——actions/runs 看不到第三方 App 的 check-run,rollup 是全集。
    const rollup = classifyStatusRollup(meta.statusCheckRollup);
    if (rollup === null) {
      // rollup 读不到 → 未知,与 BLOCKED 的 ci-unknown 同口径:本轮不动,下轮再看。
      blockers.push('mergeStateStatus=UNSTABLE,但 statusCheckRollup 读取失败——哪些检查失败未知,本轮不动,下轮再看');
      blockClass = 'ci-unknown';
    } else if (rollup.failed.length > 0) {
      blockers.push(`mergeStateStatus=UNSTABLE(非 required 检查失败:${rollup.failed.join(' / ')}——GitHub 不拦但本流程拦,失败检查修绿前不合并)`);
      blockClass = 'ci-failed';
    } else if (rollup.pending.length > 0) {
      blockers.push(`mergeStateStatus=UNSTABLE(非 required 检查还在跑:${rollup.pending.join(' / ')},等跑完即可)`);
      blockClass = 'ci-pending';
    } else {
      // rollup 全绿却仍 UNSTABLE:GitHub 异步重算的暂态(或 rollup 与状态位短暂不一致)。
      // 保守处理:本轮不动,下轮状态稳定后自然分流。
      blockers.push('mergeStateStatus=UNSTABLE 但 rollup 无失败/未完成项——状态暂态不一致,本轮不动,下轮再看');
      blockClass = 'ci-unknown';
    }
  }
  if (unresolvedThreads.length) blockers.push(`${unresolvedThreads.length} 条 conversation 未 resolve(不分作者)`);
  // reviewer 强信号打回 + 之后零新 commit = 确定未解决,硬列
  const hardPushbacks = reviewerPushbacks.filter((p) => p.signal === 'strong' && !p.hasNewerCommit);
  if (hardPushbacks.length) blockers.push(`${hardPushbacks.length} 条 reviewer 打回([阻断]/[必改])之后零新 commit`);

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
  // 安全与隐私门优先级最高:凭证已推到公网,越早打回越早轮换,连产品/架构门都不包裹它
  const securityBlocked = security.hardHitCount > 0;
  if (securityBlocked) {
    if (hasStalePushback) {
      autoAction = 'skip-stale-pushback';
      autoReason = '安全与隐私门硬命中,但上次已打回、作者未提交新 commit,跳过等作者清理';
      autoSkip = true;
    } else {
      autoAction = 'pushback-security';
      autoReason = `安全与隐私门未通过:${security.hardHitCount} 处凭证/密钥硬命中(${securityHardKinds.join(' / ')})——走 3B 打回,要求移除内容、清理分支历史并轮换已泄露凭证;打回评论只写文件/行号/类型,不引用命中原文`;
      autoSkip = false;
    }
  } else if (!formatPass) {
    if (hasStalePushback) {
      autoAction = 'skip-stale-pushback';
      autoReason = '格式门未通过,但上次已打回、作者未提交新 commit,跳过';
      autoSkip = true;
    } else {
      autoAction = 'pushback-format';
      autoReason = '格式门未通过且未被打回过(或打回后已有新 commit),走 3B 提交 REQUEST_CHANGES';
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
      // 结构性 BLOCKED:review + 已跑 CI 都没问题,只卡在永不上报的必需检查门(code_scanning/code_quality 等)。
      // 机械前提(三者同时成立才可能 bypass,任一不满足只能跳过通知 owner):CI 来源完整
      // (能走到 structural-check 分支本身已隐含 ciRuns 非 null,见 blockClass 判定)+ 当前账号
      // 有 bypass 权限 + 命中的必需检查类型在 structuralBypassAllowlist 里(structuralAllowlisted)。
      // 机械前提满足后,「谁来担保这次没人审过也能合」按三层分级(见 internal-gates.md「作者侧
      // 与仓库侧 gate」):① reviewDecision=APPROVED(真实 GitHub review,任何作者都适用,
      // 不看 admins)→ 直接 admin bypass 合并;② 缺 APPROVED 但作者在 admins 名单(典型是
      // ownPr,GitHub 422 禁止自批准导致 APPROVED 永远拿不到)→ 不再免审直接合,改进入独立
      // 审查,通过(0 P0/P1)后由合并阶段(pre-merge-check.mjs structuralBypassAvailable)
      // 认「本轮审查实际跑完且干净」为 APPROVED 的等价物,同样走 admin bypass;③ 既无
      // APPROVED 也非 admins 名单 → 跳过,不自动合并(这是 2026-08-01 修复的 fail-open 口子:
      // 此前不管 reviewDecision 是什么,机械前提满足就直接 bypass,PR #342/#366 曾在零 review
      // 情况下被自动 admin 合入)。
      const structuralCanBypass = !!structuralBlock && structuralAllowlisted &&
        (structuralBlock.canBypass === 'always' || structuralBlock.canBypass === 'pull_requests');
      const { route: structuralRoute } = decideStructuralBypassRoute({ structuralCanBypass, reviewDecision, isAdminAuthor });
      if (structuralRoute === 'bypass-structural-block') {
        autoAction = 'bypass-structural-block';
        autoReason = `结构性 BLOCKED(${structuralBlock.requiredCheckRules.join('/')} 永不上报结果,均在 structuralBypassAllowlist 内),reviewDecision=APPROVED 且当前账号可 bypass——自动 admin bypass 合并`;
        autoSkip = false;
      } else if (structuralRoute === 'review-pending-admin-bypass') {
        autoAction = 'review';
        autoReason = `结构性 BLOCKED(${structuralBlock.requiredCheckRules.join('/')} 永不上报结果),作者 ${authorLogin} 在 admins 名单但缺 reviewDecision=APPROVED(常见于 ownPr,GitHub 422 禁止自批准)——按管理员分级合并策略进入独立审查,审查通过(0 P0/P1)后合并阶段走 admin bypass,不要求 APPROVED(见 internal-gates.md;不得跳过本轮独立审查直接合并)`;
        autoSkip = false;
      } else {
        // 机械前提不满足,或满足但既无 APPROVED 也非 admins 名单 → 跳过通知 owner
        autoAction = 'skip-structural-block';
        autoReason = !structuralCanBypass
          ? (structuralBlock && !structuralAllowlisted && structuralBlock.canBypass && structuralBlock.canBypass !== 'never'
            ? `结构性 BLOCKED,当前账号本可 bypass,但命中的必需检查类型(${(structuralBlock.requiredCheckRules ?? []).join('/')})不在 structuralBypassAllowlist 里——不自动 bypass,需 owner 人工确认后手动处理`
            : `结构性 BLOCKED(非作者可处理,当前账号无 bypass 权限):${blockers.join(';')}`)
          : `结构性 BLOCKED,当前账号可 bypass 但缺 reviewDecision=APPROVED(作者 ${authorLogin} 不在 admins 名单)——不自动合并,需白名单成员 Approve,或将作者加入 pr-rules.json 的 admins 名单走管理员分级合并策略(进独立审查、通过后再 admin bypass)`;
        autoSkip = true;
      }
    } else {
      autoAction = 'skip-gate';
      // 拼上具体 blockers,飞书汇总行直接用得上(别只写泛化的「前置门未通过」)
      autoReason = `前置门未通过:${blockers.join(';')}`;
      autoSkip = true;
    }
  } else {
    autoAction = 'review';
    autoReason = selfBlockedResolvable
      ? '前置门唯一阻塞是 viewer 自己挂的 CHANGES_REQUESTED 且 thread 全 resolve;进入重审,通过后 self-approve 解锁再合并'
      : '格式门 + 前置门均通过,进入代码审查';
    autoSkip = false;
  }

  // ── 授权快速合并通道覆盖(见 authorizedFastMerge 计算与 SKILL 5.1「授权快速合并通道」):
  // admins 名单成员明确 /approve-merge 授权 + 机械前提全过时,压过上面主开关算出的一切结论
  // (含 bypass-structural-block / skip-structural-block / skip-gate / review 等)直接进
  // 合并,跳过阶段二独立审查。但让位于产品/UI 门与技术架构门(下方紧接的包裹逻辑仍会在
  // needsProductCheck/needsArchCheck 时整体覆盖本结论)——授权只解决"要不要再审一轮代码",
  // 不解决"这次改动该不该推进"这类更上游的产品方向判断,不能用合并授权去顶替产品/架构对齐。──
  if (authorizedFastMerge.eligible) {
    autoAction = 'authorized-fast-merge';
    // reportOnly 三项不阻断,但必须显著写进 autoReason(飞书汇总/合并致谢直接用得上)——
    // 紧急通道的机器职责是"留痕",不是悄悄吞掉这些信号。
    const reportHints = [
      authorizedFastMerge.reportOnly.formatIssues.length
        ? `格式门未过(${authorizedFastMerge.reportOnly.formatIssues.join(';')})`
        : null,
      authorizedFastMerge.reportOnly.unresolvedThreadCount > 0
        ? `${authorizedFastMerge.reportOnly.unresolvedThreadCount} 条 conversation 未 resolve`
        : null,
      authorizedFastMerge.reportOnly.nonRequiredFailures.length
        ? `${authorizedFastMerge.reportOnly.nonRequiredFailures.length} 项非 required 检查未过(${authorizedFastMerge.reportOnly.nonRequiredFailures.join(' / ')})`
        : null,
    ].filter(Boolean);
    const reportHint = reportHints.length ? `;不阻断但已写入汇总,需在报告里显著提示:${reportHints.join('、')}` : '';
    autoReason = `管理员授权快速合并:${authorizedFastMerge.admin} 于 ${authorizedFastMerge.commentCreatedAt} 发出 /approve-merge(晚于最后一次 push,授权有效)——跳过阶段二独立审查${hitsSecurityReviewPaths ? '与安全审查路径门(securityReviewPaths,授权=人工已过的凭证)' : ''},required 检查全绿即可合${reportHint}`;
    autoSkip = false;
  }

  // ── 产品/UI 门包裹(优先级最高,压过格式门 / 前置门):疑似产品/UI 且无白名单放行信号时,
  // 先让人肉讨论——格式 / gate 问题等放行回流后由 fallback 之外的下一轮正常拦。原走向存进
  // auto.fallback:主 agent 语义定性「不属产品/UI 修改」时按 fallback 继续,不用重推。
  // (gateFallback 为产品门 / 架构门共用——两门互斥包裹,产品门优先,见 archGate 注释。)
  let gateFallback = null;
  if (needsProductCheck && !securityBlocked) {
    gateFallback = { action: autoAction, reason: autoReason, isSkip: autoSkip };
    const trigger = [
      type === 'feat' ? 'feat 类型' : '',
      touchesUi ? `命中 UI 路径(${uiFiles.slice(0, 3).join(' / ')}${uiFiles.length > 3 ? ' 等' : ''})` : '',
    ].filter(Boolean).join(' + ');
    autoAction = 'product-gate';
    const issueHint = discussionIssue
      ? (discussionIssue.whitelistComments === null
        ? `;已有讨论 issue(${discussionIssue.url})但评论读取失败,如实进汇总让 owner 看,别当「无同意」再 hold`
        : `;已有讨论 issue(${discussionIssue.url}),白名单留言 ${discussionIssue.whitelistComments.length} 条${discussionIssue.unattributedSlackComments?.length ? `、另有 ${discussionIssue.unattributedSlackComments.length} 条 Slack 同步消息归属不了发送者(不得当白名单同意采信)` : ''}——先判白名单留言是否明确同意推进,同意 → 按 auto.fallback 继续(视同放行)`)
      : '';
    const prCommentHint = prWhitelistComments?.length
      ? `;PR 评论区另有白名单成员留言 ${prWhitelistComments.length} 条(productGate.prWhitelistComments,与讨论 issue 留言同等采信,明确同意即视同放行)`
      : '';
    autoReason = `疑似产品/UI 变更(${trigger}),作者 ${authorLogin} 非白名单且无确定性放行信号(白名单 PR Approve / 标回 ready)${issueHint}${prCommentHint}。未同意 / 无留言时语义定性:确属产品/UI → product-hold(自动开讨论 issue + 评论告知作者 + 转 draft);属 bugfix/已有功能补充 → 按 auto.fallback 继续`;
    autoSkip = false;
  }

  // ── 技术架构门包裹(优先级低于产品门:needsProductCheck 时不包裹,见 archGate 注释)──
  if (!needsProductCheck && needsArchCheck && !securityBlocked) {
    gateFallback = { action: autoAction, reason: autoReason, isSkip: autoSkip };
    autoAction = 'arch-gate';
    const archIssueHint = archDiscussionIssue
      ? (archDiscussionIssue.whitelistComments === null
        ? `;已有讨论 issue(${archDiscussionIssue.url})但评论读取失败,如实进汇总让 owner 看,别当「无同意」再 hold`
        : `;已有讨论 issue(${archDiscussionIssue.url}),技术白名单留言 ${archDiscussionIssue.whitelistComments.length} 条${archDiscussionIssue.unattributedSlackComments?.length ? `、另有 ${archDiscussionIssue.unattributedSlackComments.length} 条 Slack 同步消息归属不了发送者(不得当同意采信)` : ''}——先判留言是否明确同意推进,同意 → 按 auto.fallback 继续(视同放行)`)
      : '';
    const archPrCommentHint = archPrWhitelistComments?.length
      ? `;PR 评论区另有技术白名单成员留言 ${archPrWhitelistComments.length} 条(archGate.prWhitelistComments,与讨论 issue 留言同等采信,明确同意即视同放行)`
      : '';
    // 冷更类触发要单独说清口径:它不是「大改动才拦」,而是「动了指纹就得白名单点头」——
    // 语义定性只判「是否真动指纹 / 是否已获同意」,不判改动大小(见 archGate.coldUpdate.note)。
    // 冷更是唯一触发器时,连汇总口径都不能写成「疑似较大架构调整」(会误导人按大小放行),
    // 且不带那套「属局部实现就继续」的定性话术——那套话术对冷更是错的。
    const archOnlyColdUpdate = coldUpdateTrigger != null && archTriggers.length === 1;
    const archHeadline = archOnlyColdUpdate ? '命中 mobile 冷更门' : '疑似较大技术架构调整';
    const archQualifyHint = archOnlyColdUpdate
      ? ''
      : '。未同意 / 无留言时语义定性:确属较大架构调整 → product-hold --kind arch(自动开技术讨论 issue + 评论告知作者 + 转 draft);属局部实现/普通改动/机械性大 diff → 按 auto.fallback 继续';
    // 冷更放行口径要在汇总里写死,避免主 agent 看到「作者是白名单」就顺手放行
    const coldApproverHint = needsColdUpdateCheck
      ? `放行只认 ${(ARCH_RULES.coldUpdateApprovers ?? []).join(' / ')} 明确针对冷更的表态(作者身份 / 普通 Approve / 标回 ready 都不算${archExemptSignals ? ',本 PR 确实有这类信号但已作废' : ''};候选留言见 archGate.coldUpdate.approverComments)`
      : '须技术白名单明确同意';
    const coldUpdateHint = coldUpdateTrigger
      ? (coldUpdateGuard?.changed === true
        ? `。⚠️ 本 PR 触发 mobile 冷更(fingerprint guard 已判定指纹变化${coldUpdateGuard.staleVsHead === true ? ',但该结论比最新 commit 旧,需确认是否覆盖当前 head' : ''}):与技术框架变动同级,存量装机拿不到本次及后续热更,不得以「diff 小 / 只改一行配置」放行。${coldApproverHint} → 未确认即 product-hold --kind arch,并在 issue / 评论里要求作者在 Description 写清为什么冷更不可避免、存量装机影响与发版节奏`
        : `。⚠️ 本 PR 改到 mobile 指纹输入(${coldUpdateFiles.slice(0, 5).join(' / ')}):先判是否真的进 resolved config / 真的动指纹(判据见 docs/dev-rules/mobile-development.md「冷更边界」)。确属动指纹 → 与技术框架变动同级,${coldApproverHint},未确认即 product-hold --kind arch;确属指纹中性 → 按 auto.fallback 继续;拿不准从严 hold`)
      : '';
    // 有豁免信号却仍进门 = 冷更把它作废了,汇总里必须这么写(否则「无放行信号」与事实不符)
    const archSignalClause = archExemptSignals
      ? `作者 ${authorLogin},常规放行信号(技术白名单身份 / PR Approve / 标回 ready)存在但因触发冷更已作废`
      : `作者 ${authorLogin} 非技术白名单且无放行信号(技术白名单 PR Approve / 标回 ready)`;
    autoReason = `${archHeadline}(${archTriggers.join(' + ')}),${archSignalClause}${archIssueHint}${archPrCommentHint}${archQualifyHint}${coldUpdateHint}`;
    autoSkip = false;
  }

  // ── Loop 托管 PR 覆盖(优先级最高,压过产品门 / 架构门 / 格式门 / 前置门,但让位于已确定的
  // 安全与隐私门硬命中——凭证已泄露必须打回,不因 loop 托管而沉默):判定为 loop 自管
  // (T1 或拿不准)的 PR,review-pr 不审、不合、不催,原样交给 loop 自己收尾。
  // LOOP_EXCLUSION_RULES 未配置时 loopExclusion 恒为 null,本覆盖天然不生效。──
  if (!securityBlocked && loopExclusion && loopExclusion.verdict !== 't2') {
    autoAction = 'skip-loop-managed';
    autoReason = loopExclusion.verdict === 't1'
      ? `自动修 bug loop 自管的机械档(T1)PR,由它自己合并,review-pr 不审不合不催(判据来源:${loopExclusion.source})`
      : `自动修 bug loop 托管的 PR,但读不出明确 T-level(判据来源:${loopExclusion.source}),保守按自管处理,不碰`;
    autoSkip = true;
  }

  // ── 安全审查门覆盖(优先级仅次于 loop 托管排除——loop 托管已经不审不合,本门无需重复覆盖;
  // 压过产品门 / 架构门 / 格式门 / 前置门的一切结论,但同样让位于安全与隐私门硬命中):
  // 命中 securityReviewPaths 一律转人工,不自动审、不自动合(详见 SKILL「审查执行环境安全」)。
  // securityReviewPaths 未配置时 hitsSecurityReviewPaths 恒为 false,本覆盖天然不生效。
  // authorizedFastMerge.eligible=true 时也不覆盖(decision:授权通道可以压过 securityReviewPaths,
  // 因为授权本身就是"人工已过的凭证",见 SKILL 5.1「授权快速合并通道」)。──
  if (!securityBlocked && hitsSecurityReviewPaths && autoAction !== 'skip-loop-managed' && autoAction !== 'authorized-fast-merge') {
    autoAction = 'skip-security-review';
    autoReason = `命中安全审查路径(${securityReviewFiles.join(' / ')})——这类改动涉及 review-pr 自身的执行/供应链能力面,继续让 review-pr 自动审查并合并这类改动,一旦改坏了自动化本身,会形成"改坏的版本审过并合入了自己"的自我损坏闭环,一律转人工审查,不自动审也不自动合`;
    autoSkip = true;
  }

  const scanMode = process.argv.includes('--scan');
  if (scanMode) {
    // 精简输出:无 body / 历史全文(见文件头 --scan 说明)。字段增删要同步 SKILL「候选批处理」阶段 1。
    print({
      ok: true,
      pr,
      scan: true,
      repo: { owner, repo },
      meta: {
        number: meta.number,
        title,
        state: meta.state,
        isDraft: meta.isDraft,
        mergedAt: meta.mergedAt,
        author: authorLogin,
        baseRefName: meta.baseRefName,
        headRefOid: meta.headRefOid,
        url: meta.url,
        mergeStateStatus: meta.mergeStateStatus,
        reviewDecision: meta.reviewDecision,
      },
      filePaths: files.map((f) => f.path),
      totalDiffLines,
      held: holdMarker ? { ...holdMarker, heldDraft } : null,
      loopExclusion,
      security,
      format: { formatPass, formatIssues, hitsServer, hitsSecurityReviewPaths, securityReviewFiles, uiCodeFiles, bodyHasUiEvidence, bodyUiEvidenceKinds, uiEvidenceMissing, uiEvidenceNotice },
      gate: {
        gatePass,
        blockClass,
        blockers,
        softFlags,
        unresolvedThreadCount: unresolvedThreads.length,
      },
      productGate,
      archGate,
      authorizedFastMerge,
      auto: {
        action: autoAction,
        reason: autoReason,
        isSkip: autoSkip,
        fallback: gateFallback,
        needsSelfApproval: autoAction === 'review' && selfBlockedResolvable,
        selfFix: isSelfFixAuthor,
        ownPr: isOwnPr,
        isAdmin: isAdminAuthor,
        structuralBypassPending: autoAction === 'review' && blockClass === 'structural-check' && isAdminAuthor,
      },
      note: 'scan 精简输出,仅供 auto 批处理阶段 1 扫描分类与汇总;需要 body / 历史全文时对该 PR 单独跑不带 --scan 的全量模式(审查子 agent 在自己 worktree 里自取,别在主 session 拉全量)。structuralBypassPending=true→本轮 action=review 是因为结构性 BLOCKED + 作者在 admins 名单但缺 APPROVED,审查通过(0 P0/P1)后合并阶段应走 admin bypass 不要求 APPROVED,不是普通审查流程,见 SKILL 5.1/5.3。authorizedFastMerge.eligible=true 时 action 已是 authorized-fast-merge,可直接进合并跳过审查——但 reportOnly(formatIssues/unresolvedThreadCount/nonRequiredFailures)非空时必须在汇总里显著提示,不阻断不代表可以吞掉;eligible=false 但 requested=true 时看 blockedReason(还差什么条件,只剩泄密硬门/冲突/required 检查三类)或 staleComments(授权评论早于最后一次 push,已作废需重发)。',
    });
  } else {
  print({
    ok: true,
    pr,
    repo: { owner, repo },
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
      url: meta.url,
      mergeable: meta.mergeable,
      mergeStateStatus: meta.mergeStateStatus,
      reviewDecision: meta.reviewDecision,
      labels: (meta.labels ?? []).map((l) => l.name),
      body,
    },
    files,
    totalDiffLines,
    held: holdMarker ? { ...holdMarker, heldDraft } : null,
    loopExclusion,
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
      hitsSecurityReviewPaths,
      securityReviewFiles,
      uiCodeFiles,
      bodyHasUiEvidence,
      bodyUiEvidenceKinds,
      uiEvidenceMissing,
      uiEvidenceNotice,
      formatPass,
      formatIssues,
      note: 'formatPass=false 一定不合规;true 仍需 LLM 判段落是否实质、title 语言(关 3)。uiCodeFiles 非空而无证据时 uiEvidenceMissing=true(截图/录屏或 HTML 界面都算证据,类型见 bodyUiEvidenceKinds)——不进 formatIssues、不打回,由主 agent 把 uiEvidenceNotice 作为非阻断评论发给作者(SKILL 3.2);已附证据的,内容与 diff 是否一致、界面是否符合 DESIGN.md 由阶段二审查 agent 判',
    },
    history: { comments, reviewThreads, commits, latestCommitDate },
    productGate,
    archGate,
    authorizedFastMerge,
    gate: {
      unresolvedThreads,
      reviewerPushbacks,
      botComments,
      blockers,
      softFlags,
      blockClass,
      structuralBlock,
      ciRuns,
      blockedAwaitingApproval: blockClass === 'awaiting-approval',
      workflowsAwaitingApproval,
      prTouchesCiFiles,
      ciFiles,
      selfBlockedResolvable,
      gatePass,
      note: 'gatePass=false → 1.7 必须卡 gate;softFlags 里的项由 LLM 读内容定性,别无脑放行。blockClass 是 BLOCKED 成因分档:conflict / workflow-awaiting(fork 待批 CI)/ review-changes-requested(reviewDecision=CHANGES_REQUESTED,真要作者改)/ self-resolvable(仅 viewer 自己的 CR、thread 全 resolve)/ awaiting-approval(缺 approve,审查通过后提交 APPROVE 即解)/ threads-unresolved / ci-unknown(CI 状态读不到——权限/网络/解析失败,不当结构性门、不可 bypass,下轮再看)/ ci-failed(head 上有已上报检查真失败:workflow run,或 actions/runs 看不到的第三方 App check-run / commit status)/ ci-pending(还在跑)/ structural-check(review + head 上全部已上报检查(workflow run 与 rollup 全集)都过、CI 来源明确、仍 BLOCKED——永不上报的必需检查门 code_scanning/code_quality 等,需 admin bypass 合或修门,非作者可处理)。structuralBlock(仅 structural-check 时非空):{requiredCheckRules, canBypass, rulesetIds},canBypass=always/pull_requests 表示当前账号可 admin bypass,但**是否真的自动 bypass 还要看 requiredCheckRules 是否全部命中 pr-rules.json 的 structuralBypassAllowlist**(不在 allowlist 里即便可 bypass 也不自动合,见 auto.reason)。ciRuns(仅 BLOCKED 时查,null=未知——null 时 blockClass 必为 ci-unknown,不会误落进 structural-check):{failed,pending,awaiting,all}。workflowsAwaitingApproval=ciRuns.awaiting(fork 待批 workflow)。与 blockedAwaitingApproval(缺 reviewer approval)是两回事',
    },
    auto: {
      action: autoAction,
      reason: autoReason,
      isSkip: autoSkip,
      fallback: gateFallback,
      needsSelfApproval: autoAction === 'review' && selfBlockedResolvable,
      selfFix: isSelfFixAuthor,
      ownPr: isOwnPr,
      isAdmin: isAdminAuthor,
      structuralBypassPending: autoAction === 'review' && blockClass === 'structural-check' && isAdminAuthor,
      wasPushedBack,
      latestPushbackDate,
      note: 'structuralBypassPending=true→本轮 action=review 是因为结构性 BLOCKED(gate.blockClass=structural-check)+ 作者在 admins 名单但缺 reviewDecision=APPROVED(常见 ownPr,GitHub 422 禁止自批准)——这轮独立审查是"能否 admin bypass 合并"的实质替代凭证,通过(0 P0/P1)才能在合并阶段(pre-merge-check.mjs)走 admin bypass,不要求 APPROVED;不通过就是真的要修,不能因为作者是 admin 就放宽审查标准。authorizedFastMerge(见同名顶层字段)与本字段是两条独立路径:前者靠 admins 成员发 /approve-merge 跳过本轮审查直接合,后者仍要审查、只是审查通过后不需要 APPROVED。ownPr=true→viewer(本流程账号)与作者是同一人,GitHub 硬性禁止对自己的 PR 提交 REQUEST_CHANGES/APPROVE(422)——3B 打回改发 event=COMMENT(保留行级 thread 但不触发"变更请求"语义)。真正挡合并的不是 event 类型,而是仓库自己的分支保护规则若配了 required_review_thread_resolution:只要提交的 review 里有 comments[] 生成的 thread 处于未 resolve,mergeStateStatus 就会停在 BLOCKED,与谁提交、什么 event 无关——这正是 ownPr=true 时要把每条 [阻断]/[必改] 尽最大努力锚成行级评论的原因;锚不到行、只能落进 body 总述的意见,若仓库没有该项 required check 就没有任何机制挡住合并,必须在报告 / 汇总里以"需要你"显著提示。3A 第 0 步的 self-approve 同理对 own-PR 不适用(APPROVE 一样会 422,needsSelfApproval 场景不会与 ownPr 同时成立,因为自己没法先挂 CR)。ownPr 与 selfFix 是两个独立轴:selfFix 只决定"卡住时是否自动开跟进会话",不决定 review API 能不能调,即便 selfFixAuthors 为空、ownPr=true 时 3B 仍必须走 COMMENT 分支。selfFix=true→作者在 selfFixAuthors 名单(pr-rules.json):该 PR 卡在作者侧问题(pushback-security / pushback-format / 审查不通过 / skip-gate 冲突·未 resolve·CI 失败 / skip-stale-pushback)时 3B 仍照常提交(event 按 ownPr 选,不因 selfFix 跳过),额外改走 SKILL「自动跟进修复(fix-handoff)」开跟进会话自己修。auto 模式分流(交互模式忽略本字段):isSkip=true→跳过类(扫描不 checkout,无需清理);isSkip=false→进本轮处理清单,全量处理不设固定名额、并行度由宿主 agent 上限自然限流(pushback-format 直接 3B / review 起审查子 agent 并行审 / approve-workflows 调 approve-workflows.mjs / bypass-structural-block 走 admin bypass 合并 / product-gate、arch-gate 主 agent 语义定性后 product-hold(arch 加 --kind arch)或按 fallback 继续),详见 SKILL「候选批处理」「产品 / UI 变更门」「技术架构变更门」。action ∈ {review, pushback-security, pushback-format, product-gate, arch-gate, skip-gate, skip-stale-pushback, approve-workflows, skip-workflow-ci-change, bypass-structural-block, skip-structural-block, skip-loop-managed, skip-security-review, authorized-fast-merge}。pushback-security=安全与隐私门硬命中(security.hardHits 非空,优先级最高、不被产品/架构门包裹,压过 loop 托管排除与安全审查门覆盖)→ 3B 打回要求移除内容、清理分支历史并轮换凭证,评论只写文件/行号/类型不引用原文;skip-loop-managed=命中 loopPrExclusion 且判定为 loop 自管(T1 或拿不准),不审不合不催(见 SKILL「Loop 托管 PR 排除」;配置缺失时本 action 永不出现)。skip-security-review=命中 securityReviewPaths,一律转人工审查,不自动审也不自动合(见 SKILL「审查执行环境安全」;优先级仅次于 skip-loop-managed,压过其余一切结论;配置缺失时本 action 永不出现)。product-gate=疑似产品/UI 变更且无白名单明确同意信号(确定性信号=白名单 PR Approve / 标回 ready;先语义判 productGate.discussionIssue.whitelistComments 与 productGate.prWhitelistComments(PR 评论区白名单直接回复,同等采信)是否明确同意推进,任一同意→按 fallback 继续,见 productGate 字段),fallback 存被包裹前的原走向。arch-gate=疑似较大技术架构调整且无技术白名单放行信号(消费规则同 product-gate,读 archGate 字段;产品门优先,两门不会同时出现)。触发器里的 cold-update-confirmed / cold-update-suspect 是 mobile 冷更(runtime fingerprint 变化):与技术框架变动同级但不看改动大小,也不受本门常规豁免——作者在白名单 / 普通 Approve / 标回 ready 都不算放行,只认 archGate.coldUpdate.approvers 明确针对冷更的表态(名单内成员自己提的 PR 也要显式确认),详见 archGate.coldUpdate 与其 note。approve-workflows=fork workflow 待批且未改 CI 配置→自动 approve 放行 CI(下一轮 CI 跑完再审);skip-workflow-ci-change=待批但改了 CI 配置→跳过、飞书点名让 owner 手动批;bypass-structural-block=结构性 BLOCKED + 当前账号可 bypass + 命中的必需检查类型全部在 structuralBypassAllowlist 内 + **reviewDecision=APPROVED**→auto 模式直接 gh pr merge --admin 合并(安全前提:真实 APPROVED review + 已跑 CI 无失败 + 0 未 resolve thread + CI 来源明确非 ci-unknown;2026-08-01 起 APPROVED 是硬性前提,不因作者是谁而减免,修复此前"机械前提满足就直接 bypass、reviewDecision 是什么都不看"的 fail-open)。同样命中结构性 BLOCKED 但缺 APPROVED 时看作者是否在 admins 名单:在→action=review 且 auto.structuralBypassPending=true(进独立审查,通过后合并阶段改认"本轮审查通过"为 APPROVED 的替代凭证,见 auto.structuralBypassPending 的 note 与 pre-merge-check.mjs);不在→skip-structural-block,飞书点名让 owner 人工 Approve 或把作者加入 admins。skip-structural-block=结构性 BLOCKED 但机械前提不满足(无 bypass 权限 / 命中类型不在 allowlist 里),或机械前提满足但既无 APPROVED 也非 admins 名单→跳过、飞书点名让 owner 处理。authorized-fast-merge=顶层 authorizedFastMerge.eligible=true(admins 名单成员发 /approve-merge、晚于最后一次 push、无泄密硬命中、无冲突、head 上 required 检查全绿)→跳过阶段二独立审查与 securityReviewPaths 直接进合并;这是紧急通道,格式门未过 / 未 resolve thread / 非 required 检查失败(如 Greptile)**不阻断** eligible,改记入 authorizedFastMerge.reportOnly(formatIssues/unresolvedThreadCount/nonRequiredFailures)——必须在汇总与合并致谢里显著提示,不能悄悄吞掉(机器职责从"拦"变成"留痕",owner 显式授权即自担责任);泄密硬门(security.hardHits)、mergeStateStatus=DIRTY、required 检查未全绿三者任何情况不可压过。产品/架构门优先级高于本通道,命中时不会落到这个 action。needsSelfApproval=true→该 PR 唯一阻塞是 viewer 自己挂的 CR、重审通过后合并前须先 gh pr review --approve 撤掉自己的 CR 再合(见 SKILL 3A)',
    },
  });
  }
} catch (e) {
  fail(e);
}
