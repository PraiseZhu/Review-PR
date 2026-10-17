// code-scan.mjs — review:merge-ready 的代码扫描 / 代码质量门(解释部分是纯函数;读取部分的 gh 调用由调用方注入)。
// 背景(2026-10-17 #1025):目标分支受组织规则集的 code_scanning(CodeQL)与 code_quality 约束。#1025 head 上的 CodeQL check 是
// neutral「1 configuration not found」,GitHub 判不出本 PR 引入了什么告警,mergeStateStatus=BLOCKED;审查机挂标签前的复核只看
// CI、讨论、冲突,照样挂了 review:merge-ready,标签说能合、GitHub 不让合。
// 事实由两处读:pre-merge-check.mjs(服务器挂标前,随 preMerge 回执)与 round.mjs(Mini 摘标,读一次规则并按 base 缓存);这里只做解释。
// 事实的形状:
//   rules:  [{type:'code_scanning'|'code_quality', parameters}] | null(读不到);rulesError:读不到的原因
//   checks: [{name, appSlug, status, conclusion, title, completedAt}] | null(读不到或没读全);checksError:原因
// 代码质量(code_quality)在 PR 上对应的 check 官方叫「CodeQL - Code Quality」,但 Mivo 目标仓没启用:近期 PR 的 head 上只有 CodeQL 一个
// 扫描类 check。所以质量门只在 head 上真的出现该 check 时要求 success,缺失不拦(否则所有 PR 都挂不上标签)。

export const CODE_SCAN_APP_SLUG = 'github-advanced-security';
// 规则里要求的 check 还没出现,但别的 check 刚跑完(或还在跑):结果可能只是还没上报,按瞬态处理;过了这个窗口仍没有就是稳定缺失。
export const MISSING_GRACE_MS = 20 * 60_000;
// 目标分支的规则很少变,按 base 缓存;太久不刷新会让已撤销的规则继续拦。
export const RULES_TTL_MS = 30 * 60_000;
const ACTIONS_APP_SLUG = 'github-actions';
const QUALITY_NAME_RE = /code[\s_-]*quality/i;
const TITLE_MAX = 160;

// ── 读取(事实)────────────────────────────────────────────────────────────

/** rules/branches 的原始条目 → 只留 code_scanning / code_quality 两类的 {type, parameters}。形状不对返回 null。 */
export function toRuleFacts(rules) {
  if (!Array.isArray(rules)) return null;
  return rules.filter((rule) => rule?.type === 'code_scanning' || rule?.type === 'code_quality')
    .map((rule) => ({ type: rule.type, parameters: rule.parameters ?? null }));
}

/** check-runs 的 REST 条目 → {name, appSlug, status, conclusion, title, completedAt}。传入的不是数组返回 null。 */
export function toCheckFacts(runs) {
  if (!Array.isArray(runs)) return null;
  return runs.map((run) => ({
    name: String(run?.name ?? ''),
    appSlug: run?.app?.slug ?? null,
    status: run?.status ?? null,
    conclusion: run?.conclusion ?? null,
    title: run?.output?.title ?? null,
    completedAt: run?.completed_at ?? null,
  }));
}

/**
 * 读一个 PR 的代码扫描事实(Mini 摘标签用):规则按 base 缓存 RULES_TTL_MS,head 上的 check run 每次读一次(REST,一页)。
 * 规则读不到不缓存;规则没有要求代码扫描 / 质量时不读 check run;check run 条数超过一页按读不到处理(不能把"没读全"当成"没有 CodeQL")。
 * ghFn(args) → {ok, stdout, stderr};cache 是 {get(key), set(key, value)}。
 */
export function fetchCodeScanFacts({ ghFn, repo, baseRefName, head, cache = null, nowMs = Date.now() } = {}) {
  const key = `${repo}|${baseRefName}`;
  let rules = null;
  let rulesError = null;
  const cached = cache?.get(key);
  const cachedRules = Array.isArray(cached?.rules) ? toRuleFacts(cached.rules) : null;
  if (cachedRules && Number.isFinite(cached.at) && nowMs - cached.at >= 0 && nowMs - cached.at < RULES_TTL_MS) {
    rules = cachedRules;
  } else {
    const read = ghFn(['api', `repos/${repo}/rules/branches/${encodeURIComponent(baseRefName)}?per_page=100`]);
    if (!read.ok) {
      rulesError = String(read.stderr || read.stdout || '').trim().slice(0, 200) || 'rules/branches 读取失败';
    } else {
      try {
        rules = toRuleFacts(JSON.parse(read.stdout || '[]'));
        if (!rules) rulesError = 'rules/branches 返回的形状不是数组';
      } catch (error) {
        rulesError = `rules/branches JSON 解析失败:${error.message}`;
      }
    }
    if (rules) cache?.set(key, { at: nowMs, rules });
  }
  if (!rules) return { rules: null, rulesError, checks: null, checksError: null };
  if (rules.length === 0) return { rules, rulesError: null, checks: [], checksError: null };
  const read = ghFn(['api', `repos/${repo}/commits/${head}/check-runs?per_page=100`]);
  if (!read.ok) {
    return { rules, rulesError: null, checks: null, checksError: String(read.stderr || read.stdout || '').trim().slice(0, 200) || 'check-runs 读取失败' };
  }
  try {
    const body = JSON.parse(read.stdout || '{}');
    const runs = body?.check_runs;
    if (!Array.isArray(runs)) return { rules, rulesError: null, checks: null, checksError: 'check-runs 返回的形状不对' };
    if (Number(body.total_count) > runs.length) {
      return { rules, rulesError: null, checks: null, checksError: `check-runs 共 ${body.total_count} 条,一页只读到 ${runs.length} 条` };
    }
    return { rules, rulesError: null, checks: toCheckFacts(runs), checksError: null };
  } catch (error) {
    return { rules, rulesError: null, checks: null, checksError: `check-runs JSON 解析失败:${error.message}` };
  }
}

// ── 解释 ─────────────────────────────────────────────────────────────────

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
const toMs = (iso) => { const ms = Date.parse(iso ?? ''); return Number.isFinite(ms) ? ms : null; };

function toCheckState(check) {
  if (check.status !== 'completed') return 'pending';
  const conclusion = String(check.conclusion ?? '').toLowerCase();
  if (conclusion === 'success') return 'pass';
  // 没有结论(GitHub 判不出告警、被跳过、过期)不等于通过:组织规则不会把它当成"没有新告警"
  if (['neutral', 'skipped', 'stale'].includes(conclusion)) return 'neutral';
  return 'failure';
}

// 同名多条取最新:进行中(没有 completedAt)视为最新,同时间取数组里靠后的。
function latestOf(checks) {
  let best = null;
  let bestKey = -Infinity;
  for (const check of checks) {
    const key = check.status !== 'completed' ? Infinity : (toMs(check.completedAt) ?? -1);
    if (best === null || key >= bestKey) { best = check; bestKey = key; }
  }
  return best;
}

const isScanResultOf = (tool) => (check) => {
  if (String(check.name ?? '').trim().toLowerCase() !== tool.toLowerCase()) return false;
  // CodeQL 的结果只认 GitHub 自己的代码扫描 app;其它 tool 只要不是 Actions job 就行(job 名字任何人都能起)
  if (tool.toLowerCase() === 'codeql') return check.appSlug === CODE_SCAN_APP_SLUG;
  return Boolean(check.appSlug) && check.appSlug !== ACTIONS_APP_SLUG;
};
const isQualityResult = (check) => QUALITY_NAME_RE.test(String(check.name ?? '')) && Boolean(check.appSlug) && check.appSlug !== ACTIONS_APP_SLUG;

// 规则里要求的 check 没出现:别的 check 还在跑,或刚跑完不久,结果可能只是没上报;否则是稳定缺失。
function isMissingTransient(checks, nowMs) {
  if (checks.some((check) => check.status && check.status !== 'completed')) return true;
  const done = checks.map((check) => toMs(check.completedAt)).filter((ms) => ms !== null);
  return done.length > 0 && nowMs - Math.max(...done) < MISSING_GRACE_MS;
}

const blocked = (code, reason, retry, required = true) => ({ required, items: [], blockers: [{ code, reason }], retry });

// 读失败里"等也等不来"的:没权限、没有这个资源、凭证无效(令牌缺 Metadata 读权限等),标 retry 只会每轮重新派发白烧额度。
// 限流(403 但提示 rate limit)、5xx、超时、断线是瞬态,值得下一轮重读。
const isStableReadError = (message) => /Resource not accessible|HTTP (?:401|404)\b|Not Found|Bad credentials/i.test(String(message ?? '')) &&
  !/rate limit|secondary/i.test(String(message ?? ''));

/**
 * 挂 review:merge-ready 之前的代码扫描 / 质量门。规则不要求就不判;要求时 check 必须是明确的 success。
 * @returns {{required: boolean, items: Array<{kind: 'scan'|'quality', tool: string, state: string, title: string, reason?: string}>,
 *   blockers: Array<{code: string, reason: string}>, retry: boolean}}
 *   state: pass / pending(进行中)/ neutral(没有结论,含 configuration not found)/ failure / missing。
 *   retry 只给会自己变化的状态(进行中、刚跑完还没出现、读不到):neutral / failure 要人处理(重跑 CodeQL、修告警),
 *   靠 PR 指纹变化(mergeStateStatus 等)唤醒重判;标 retry 会让 Mini 每 3 分钟重新派发一次服务器审查,dailyCap 很快用完。
 */
export function toCodeScanGate(facts, { nowMs = Date.now() } = {}) {
  if (!facts || typeof facts !== 'object') {
    return blocked('code-scanning-not-reported', '合并前门禁复核没有带回代码扫描结果(pre-merge-check 版本与服务器代码对不上),无法确认 CodeQL', false);
  }
  if (!Array.isArray(facts.rules)) {
    return blocked('code-scanning-unverified', `目标分支的代码扫描规则没读到:${clean(facts.rulesError) || '未知'}`, !isStableReadError(facts.rulesError));
  }
  const scanRules = facts.rules.filter((rule) => rule?.type === 'code_scanning');
  const qualityRequired = facts.rules.some((rule) => rule?.type === 'code_quality');
  const tools = [];
  for (const rule of scanRules) {
    const listed = rule.parameters?.code_scanning_tools;
    if (!Array.isArray(listed)) {
      return blocked('code-scanning-unverified', 'code_scanning 规则里没有 code_scanning_tools,认不出要求哪些扫描工具', false);
    }
    for (const entry of listed) {
      const name = String(entry?.tool ?? '').trim();
      if (name && !tools.some((tool) => tool.toLowerCase() === name.toLowerCase())) tools.push(name);
    }
  }
  if (tools.length === 0 && !qualityRequired) return { required: false, items: [], blockers: [], retry: false };
  if (!Array.isArray(facts.checks)) {
    return blocked('code-scanning-unverified', `head 上的检查结果没读全:${clean(facts.checksError) || '未知'}`, !isStableReadError(facts.checksError));
  }

  const items = [];
  for (const tool of tools) {
    const found = facts.checks.filter(isScanResultOf(tool));
    if (found.length === 0) {
      const transient = isMissingTransient(facts.checks, nowMs);
      items.push({ kind: 'scan', tool, state: 'missing', title: '', retry: transient,
        reason: `规则要求代码扫描(${tool}),但 head 上还没有它的结果${transient ? '(其它检查刚跑完或还在跑,可能只是还没上报)' : ''}` });
      continue;
    }
    items.push(toItem('scan', tool, latestOf(found)));
  }
  // 质量检查只在 head 上真的出现时才要求;规则里没有 code_quality 时出现的同名 check 不算
  if (qualityRequired) {
    const found = facts.checks.filter(isQualityResult);
    if (found.length > 0) {
      const latest = latestOf(found);
      items.push(toItem('quality', latest.name, latest));
    }
  }

  const failing = items.filter((item) => item.state !== 'pass');
  return {
    required: true,
    items: items.map(({ retry, ...item }) => item),
    blockers: failing.map((item) => ({ code: `${item.kind === 'scan' ? 'code-scanning' : 'code-quality'}-${item.state === 'failure' ? 'failed' : item.state}`, reason: item.reason })),
    retry: failing.some((item) => item.retry),
  };
}

function toItem(kind, tool, check) {
  const state = toCheckState(check);
  const label = kind === 'scan' ? `代码扫描(${tool})` : `代码质量检查(${tool})`;
  const title = clean(check.title) || clean(check.conclusion) || clean(check.status);
  const reasons = {
    pass: '',
    pending: `${label}还在跑`,
    neutral: `${label}没有结论:${title}。GitHub 判不出本 PR 引入的告警,组织规则会挡合并,需要重跑 ${tool}`,
    failure: `${label}没通过:${title}`,
  };
  return { kind, tool, state, title, reason: reasons[state], retry: state === 'pending' };
}

/**
 * Mini 摘 review:merge-ready 的判据:代码扫描 / 质量门稳定不通过(neutral / failure)才给原因。
 * 进行中、缺失、读不到、通过、不受约束都返回 null——标签挂着时 CodeQL 重跑一次就摘,跑完又加回,会来回抖动。
 */
export function toStaleCodeScanReason(gate) {
  const item = gate?.items?.find((entry) => entry.state === 'neutral' || entry.state === 'failure');
  return item ? `代码扫描门未过:${item.reason}` : null;
}
