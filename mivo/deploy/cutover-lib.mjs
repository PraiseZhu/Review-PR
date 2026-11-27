// 换仓切换(cutover.mjs)用的纯函数:切换清单校验、路径规则收集与匹配、新旧文件树漂移对比、
// GitHub 设置与 Mini 本机核对、切换当天的命令清单。只做判断和拼文字,不读网络、不写文件;离线测试覆盖。
import { REPO_RE } from '../lib/common.mjs';
import { toRuleMapPlan, matchesRulePath } from '../lib/prompt.mjs';
import { HANDOFF_WORKFLOW_PATH } from '../lib/handoff.mjs';
import { PRODUCT_RULES_DIR } from '../lib/product-rules.mjs';
import { CHECK_WORKFLOW } from '../lib/model-switch.mjs';
import { WF_PATH, RULES_PATH } from './tuple-lib.mjs';

export const KINDS = ['transfer', 'fresh'];
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// 结论:fail 类(缺项、漂移、不合法)让预检退出 1;unknown(查不了)退出 2;其余不影响退出码。
export const FAIL_STATUSES = ['missing', 'drift', 'invalid', 'mismatch'];

// ── 切换清单 ─────────────────────────────────────────────────────────────

/** 切换清单(JSON 原文)→ 规范化对象;不合法就抛错,写明字段、期望与实际。 */
export function toManifest(text) {
  let raw;
  try { raw = JSON.parse(String(text)); } catch { throw new Error('切换清单不是合法 JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('切换清单要是 JSON 对象');
  const bad = (field, rule) => new Error(`切换清单的 ${field} ${rule},实际 ${JSON.stringify(raw[field] ?? null).slice(0, 120)}`);
  if (raw.version !== 1) throw bad('version', '须是 1');
  for (const field of ['oldRepo', 'newRepo']) if (typeof raw[field] !== 'string' || !REPO_RE.test(raw[field])) throw bad(field, '须是 owner/name');
  if (!KINDS.includes(raw.kind)) throw bad('kind', `须是 ${KINDS.join(' / ')}(transfer=GitHub 转移,PR 与 issue 编号保留;fresh=新建仓,编号从 1 开始)`);
  const branch = (field) => {
    const value = raw[field] ?? 'main';
    if (typeof value !== 'string' || !BRANCH_RE.test(value)) throw bad(field, '须是分支名');
    return value;
  };
  const runnerLabel = raw.runnerLabel ?? 'mivo-review';
  if (typeof runnerLabel !== 'string' || !LABEL_RE.test(runnerLabel)) throw bad('runnerLabel', '须是 runner 标签名');
  return { version: 1, oldRepo: raw.oldRepo, newRepo: raw.newRepo, kind: raw.kind,
    oldBranch: branch('oldBranch'), defaultBranch: branch('defaultBranch'), runnerLabel };
}

// ── 路径规则 ─────────────────────────────────────────────────────────────
// 匹配方式与审查时一致(review-pr/scripts/context.mjs、lib.mjs matchPathPatterns、mivo/lib/prompt.mjs matchesRulePath):
//   regex  new RegExp(条目) 测整条路径;prefix  startsWith;glob  `**/名字` 任意目录同名文件、`/` 结尾目录前缀、其余整路径相等;
//   exact  整路径相等;rule-map  matchesRulePath。
const PR_RULES_FIELDS = [
  ['redlinePaths', 'regex'], ['ciSensitivePaths', 'regex'], ['sensitiveContent.allowPaths', 'regex'],
  ['signoffGate.security.riskyPatterns.allowPaths', 'regex'], ['signoffGate.security.dependencyScan.excludePaths', 'regex'],
  ['serverPaths', 'prefix'], ['signoffGate.product.uiPaths', 'prefix'], ['signoffGate.product.uiExcludePaths', 'prefix'],
  ['signoffGate.arch.corePaths', 'prefix'],
  ['protectedPaths.paths', 'glob'], ['signoffGate.security.paths', 'glob'], ['signoffGate.security.excludePaths', 'glob'],
  ['signoffGate.rules.paths', 'glob'], ['signoffGate.rules.excludePaths', 'glob'], ['signoffGate.coldUpdate.paths', 'glob'],
  ['signoffGate.pluginBase.paths', 'glob'], ['signoffGate.pluginBase.excludePaths', 'glob'],
  ['ciIgnoreWorkflows.paths', 'exact'],
];
// 审查机代码里写死的 Mivo 仓内文件(改名或搬走就有功能失效),来源写在 why。
export const REQUIRED_FILES = [
  { path: WF_PATH, why: '服务器审查入口;换版本预检要求它登记且 active' },
  { path: RULES_PATH, why: '换版本预检要求可读' },
  { path: HANDOFF_WORKFLOW_PATH, why: '作者交接检查 pr-handoff-gate(lib/handoff.mjs)' },
  { path: `.github/workflows/${CHECK_WORKFLOW}`, why: '换模型验证(models/switch.mjs 派发)' },
  { path: '.github/workflows/review-watchdog.yml', why: '前置审查心跳的看门狗' },
  { path: '.github/workflows/ci.yml', why: '任务书「CI 已覆盖」一节引用(lib/focus.mjs)' },
  { path: 'docs/pr/README.md', why: '打回文案引用(lib/gates.mjs)' },
  { path: 'scripts/pr-handoff/check.mjs', why: '打回文案引用(lib/gates.mjs)' },
];
export const REQUIRED_DIRS = [
  { prefix: PRODUCT_RULES_DIR, why: '产品规则(lib/product-rules.mjs)' },
];

const pick = (obj, dotted) => dotted.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), obj);
const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : []);

/**
 * 收集所有要核对的路径规则。prRules / features 是 review-pr/config/pr-rules.json 与 mivo/config/review-features.json 的对象,
 * ruleMap 是 review-pr/references/rule-map.md 原文。unclassified 列出 pr-rules.json 里名字以 paths 结尾、
 * 这里没登记匹配方式的非空数组:新加的路径字段要先在 PR_RULES_FIELDS 登记,否则漂移检查会漏掉它。
 */
export function toPathRules({ prRules, features, ruleMap }) {
  const rules = [];
  for (const [field, kind] of PR_RULES_FIELDS) {
    for (const pattern of stringList(pick(prRules, field))) rules.push({ source: `pr-rules.json ${field}`, kind, pattern });
  }
  const known = new Set(PR_RULES_FIELDS.map(([field]) => field));
  const unclassified = [];
  const walk = (value, prefix) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(child) && /paths$/i.test(key) && stringList(child).length && !known.has(dotted)) unclassified.push(dotted);
      else walk(child, dotted);
    }
  };
  walk(prRules, '');
  for (const pattern of stringList(pick(features, 'taskIssue.alwaysInScope'))) {
    // 'docs/pr/<pr>/' 这类带占位的条目按占位前的目录核对
    const cut = pattern.indexOf('<');
    rules.push({ source: 'review-features.json taskIssue.alwaysInScope', kind: 'prefix', pattern: cut < 0 ? pattern : pattern.slice(0, cut) });
  }
  const plan = toRuleMapPlan(ruleMap);
  for (const path of plan.mustRead) rules.push({ source: 'rule-map.md 所有 PR 必读', kind: 'exact', pattern: path });
  for (const row of plan.rows) {
    for (const pattern of row.patterns) rules.push({ source: 'rule-map.md 按改动路径(命中路径)', kind: 'rule-map', pattern });
    for (const path of row.files) rules.push({ source: 'rule-map.md 按改动路径(必读规则)', kind: 'exact', pattern: path });
  }
  for (const { path, why } of REQUIRED_FILES) rules.push({ source: `审查机代码:${why}`, kind: 'exact', pattern: path });
  for (const { prefix, why } of REQUIRED_DIRS) rules.push({ source: `审查机代码:${why}`, kind: 'prefix', pattern: prefix });
  // 同一条规则来自多处时只核一次,来源合并写
  const merged = new Map();
  for (const rule of rules) {
    const key = `${rule.kind}\u0000${rule.pattern}`;
    if (merged.has(key)) merged.get(key).sources.push(rule.source);
    else merged.set(key, { kind: rule.kind, pattern: rule.pattern, sources: [rule.source] });
  }
  return { rules: [...merged.values()], unclassified };
}

/** 一条规则 → (路径) => 是否命中。regex 编译不了时抛错(调用方记 invalid)。 */
export function toPathMatcher({ kind, pattern }) {
  if (kind === 'regex') {
    const re = new RegExp(pattern);
    return (file) => re.test(file);
  }
  if (kind === 'prefix') return (file) => file.startsWith(pattern);
  if (kind === 'glob') {
    if (pattern.startsWith('**/')) {
      const base = pattern.slice(3);
      return (file) => file === base || file.endsWith(`/${base}`);
    }
    return pattern.endsWith('/') ? (file) => file.startsWith(pattern) : (file) => file === pattern;
  }
  if (kind === 'exact') return (file) => file === pattern;
  if (kind === 'rule-map') return (file) => matchesRulePath(pattern, file);
  throw new Error(`不认识的匹配方式:${kind}`);
}

// focus.ciCovered 里的命令:`npm run <脚本>` 核 package.json scripts,`node <文件>` 核文件,其余只能人工看。
export function toCommandCheck(command) {
  const npm = /^npm run ([\w:.-]+)$/.exec(command);
  if (npm) return { kind: 'npm-script', name: npm[1] };
  const node = /^node ([\w./-]+\.m?js)$/.exec(command);
  if (node) return { kind: 'file', name: node[1] };
  return { kind: 'manual', name: command };
}

/**
 * 新旧文件树对比。old/new:{ files: string[], scripts: object|null }(scripts 是 package.json 的 scripts,读不到为 null)。
 * 规则在旧仓命中、新仓一个都不命中 = drift(新仓目录结构变了,这条规则会悄悄失效);两边都不命中 = absent(本来就是防将来出现的规则);
 * 新仓有命中 = ok。审查机代码写死的文件新仓没有 = missing(不管旧仓)。
 */
export function toDriftReport({ rules, unclassified = [], ciCovered = [], old: oldTree, new: newTree }) {
  const items = [];
  const required = new Set([...REQUIRED_FILES.map((f) => f.path), ...REQUIRED_DIRS.map((d) => d.prefix)]);
  for (const rule of rules) {
    let match;
    try { match = toPathMatcher(rule); } catch (error) {
      items.push({ area: '路径规则', ...rule, status: 'invalid', detail: `规则写法不合法:${error.message}` });
      continue;
    }
    const oldCount = oldTree.files.filter(match).length;
    const newCount = newTree.files.filter(match).length;
    const status = newCount > 0 ? 'ok'
      : required.has(rule.pattern) ? 'missing'
        : oldCount > 0 ? 'drift' : 'absent';
    items.push({ area: '路径规则', ...rule, oldCount, newCount, status });
  }
  for (const field of unclassified) {
    items.push({ area: '路径规则', kind: 'unclassified', pattern: field, sources: ['pr-rules.json'], status: 'unknown',
      detail: '这个路径字段没有登记匹配方式(cutover-lib.mjs PR_RULES_FIELDS),漂移检查没核它' });
  }
  for (const command of ciCovered) {
    const check = toCommandCheck(command);
    const base = { area: 'CI 已覆盖命令', kind: check.kind, pattern: command, sources: ['review-features.json focus.ciCovered'] };
    if (check.kind === 'manual') { items.push({ ...base, status: 'manual', detail: '不是 npm run / node 形式,人工核对' }); continue; }
    const has = (tree) => (check.kind === 'file' ? tree.files.includes(check.name)
      : tree.scripts ? Object.hasOwn(tree.scripts, check.name) : null);
    const inNew = has(newTree);
    const inOld = has(oldTree);
    const status = inNew === null ? 'unknown' : inNew ? 'ok' : inOld ? 'drift' : 'missing';
    items.push({ ...base, status, ...(inNew === null ? { detail: '新仓 package.json 读不到' } : {}) });
  }
  return items;
}

// ── GitHub 设置 ──────────────────────────────────────────────────────────
// 来源:Mivo 仓 origin/main 的 review-pr.yml、review-model-check.yml、review-watchdog.yml(2026-11-25 核对)。
export const REQUIRED_SECRETS = ['LITELLM_CREDENTIALS_JSON', 'PRAISEBUILD_PRIVATE_KEY', 'PRAISEREVIEW_PRIVATE_KEY'];
export const REQUIRED_ORG_SECRETS = ['ANTHROPIC_API_KEY'];
export const REQUIRED_ENVIRONMENTS = ['slack-inbound'];
// Mini 前置审查运行时写的变量:新仓不用照抄,前置审查跑起来自己写。
export const RUNTIME_VARIABLES = ['MIVO_PREREVIEW_HEARTBEAT', 'MIVO_REVIEW_KEY_STATUS', 'MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL'];
// 审查机自己的仓库变量(服务器审查、换模型、看门狗读的):只核对、只抄这些。旧仓里别的变量(自动合并等)归各自负责方迁,
// 照抄会在新仓误开那些自动化,新建仓时它们里面的 issue 编号也指向旧仓。
const REVIEW_VARIABLE_NAMES = ['PRAISEBUILD_APP_ID', 'PRAISEREVIEW_APP_ID', 'MIVO_SLACK_CHANNEL_ID'];
export const isReviewVariable = (name) => (/^MIVO_REVIEW_/.test(name) || REVIEW_VARIABLE_NAMES.includes(name)) && !RUNTIME_VARIABLES.includes(name);

const unknownItem = (area, item, read) => ({ area, item, status: 'unknown', detail: `查不了:${read.error}` });
// 只有 GitHub 明确回 404 才算「缺」;401/403、限流、超时、5xx 都是「查不了」,不能当成新仓没建好。
const toAbsentOrUnknown = (area, item, read) => (/HTTP 404/.test(String(read.error ?? ''))
  ? { area, item, status: 'missing', detail: `读不到:${read.error}` }
  : unknownItem(area, item, read));
const missingNames = (want, have) => want.filter((name) => !have.includes(name));
// 值不按旧仓对照的变量:MODE 按命令清单先写 dry-run;RUNNER_LABEL 另按清单核;新建仓的看门狗 issue 要换成新仓的编号。
const isValueExempt = (name, kind) => name === 'MIVO_REVIEW_MODE' || name === 'MIVO_REVIEW_RUNNER_LABEL'
  || (kind === 'fresh' && name === 'MIVO_REVIEW_WATCHDOG_ISSUE');
const toShownValue = (value) => { const text = JSON.stringify(value); return text.length > 60 ? `${text.slice(0, 60)}…` : text; };
// 数组按元素排序、对象按键排序后的 JSON:规则参数里的数组(必需检查、合并方式)是集合,重建时顺序可能变。
const toCanonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(toCanonicalJson).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${toCanonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};
// a 里有、b 里抵扣不掉的规则类型(同一条规则在两套规则集里各出现一次,两边都要两次)。元素是 { type, key }。
const toUnmatchedTypes = (a, b) => {
  const left = b.map((rule) => rule.key);
  return a.filter((rule) => { const at = left.indexOf(rule.key); if (at < 0) return true; left.splice(at, 1); return false; }).map((rule) => rule.type);
};
const toRequiredChecks = (rules) => [...new Set(rules.filter((rule) => rule.type === 'required_status_checks')
  .flatMap((rule) => (rule.parameters?.required_status_checks ?? []).map((check) => check.context)))].sort();

/**
 * 默认分支上实际生效的规则(仓库、组织、企业三级合起来),新仓按旧仓逐条对照。只比类型和参数,不比挂在哪个规则集上:
 * 换仓后规则集 id 必然不同,规则集同名也不代表内容一样。oldRules / newRules 是读数 { ok, value: [{type, parameters}] }。
 */
function toBranchRulesItems(area, oldRules, newRules) {
  if (!oldRules.ok) return [unknownItem(area, '旧仓默认分支生效规则(对照基准)', oldRules)];
  if (!newRules.ok) return [unknownItem(area, '新仓默认分支生效规则', newRules)];
  const [oldChecks, newChecks] = [toRequiredChecks(oldRules.value), toRequiredChecks(newRules.value)];
  const lackingChecks = missingNames(oldChecks, newChecks);
  const extraChecks = missingNames(newChecks, oldChecks);
  const differ = (lacking, extra) => [lacking.length ? `新仓缺 ${lacking.join('、')}` : '', extra.length ? `新仓多 ${extra.join('、')}` : ''].filter(Boolean).join(';');
  const keyed = (rules) => rules.map((rule) => ({ type: rule.type, key: toCanonicalJson({ type: rule.type, parameters: rule.parameters ?? null }) }));
  const [oldKeyed, newKeyed] = [keyed(oldRules.value), keyed(newRules.value)];
  const lackingRules = toUnmatchedTypes(oldKeyed, newKeyed);
  const extraRules = toUnmatchedTypes(newKeyed, oldKeyed);
  return [
    { area, item: '默认分支必需检查(按旧仓对照)', status: lackingChecks.length || extraChecks.length ? 'mismatch' : 'ok',
      detail: differ(lackingChecks, extraChecks) || `${oldChecks.length} 项一致` },
    { area, item: '默认分支生效规则(含组织、企业级,按旧仓逐条对照)', status: lackingRules.length || extraRules.length ? 'mismatch' : 'ok',
      detail: lackingRules.length || extraRules.length ? `类型或参数对不上:${differ(lackingRules, extraRules)}` : `${oldKeyed.length} 条一致` },
  ];
}

/**
 * 新仓的 GitHub 设置。每个读数是 { ok: true, value } 或 { ok: false, error }:
 * repo {full_name, default_branch, archived};workflow(review-pr.yml 的 state);oldVariables / newVariables {名字: 值};
 * secrets / orgSecrets / environments / labels / oldLabels / rulesets / oldRulesets 名字数组;runners [{status, labels}];
 * oldBranchRules / newBranchRules 两边默认分支上实际生效的规则 [{type, parameters}]。
 */
export function toSettingsReport(manifest, reads) {
  const items = [];
  const area = '新仓 GitHub 设置';
  const { repo, workflow, oldVariables, newVariables, secrets, orgSecrets, environments, labels, oldLabels, rulesets, oldRulesets, oldBranchRules, newBranchRules, runners } = reads;
  if (!repo.ok) items.push(toAbsentOrUnknown(area, `仓 ${manifest.newRepo}`, repo));
  else {
    items.push({ area, item: `仓 ${manifest.newRepo}`, status: repo.value.archived ? 'invalid' : 'ok', detail: repo.value.archived ? '仓已归档' : '' });
    if (repo.value.default_branch !== manifest.defaultBranch) {
      items.push({ area, item: '默认分支', status: 'mismatch', detail: `期望 ${manifest.defaultBranch},实际 ${repo.value.default_branch}` });
    }
  }
  if (!workflow.ok) items.push(toAbsentOrUnknown(area, `${WF_PATH} 登记`, workflow));
  else items.push({ area, item: `${WF_PATH} 登记`, status: workflow.value === 'active' ? 'ok' : 'invalid', detail: `state=${workflow.value}` });

  if (!newVariables.ok) items.push(unknownItem(area, '仓库变量', newVariables));
  else {
    const have = Object.keys(newVariables.value);
    if (!oldVariables.ok) items.push(unknownItem(area, '旧仓的仓库变量(对照基准)', oldVariables));
    else {
      const want = Object.keys(oldVariables.value).filter(isReviewVariable).sort();
      const lacking = missingNames(want, have);
      items.push({ area, item: '审查机仓库变量(按旧仓对照)', status: lacking.length ? 'missing' : 'ok', detail: lacking.length ? `缺 ${lacking.join('、')}` : `${want.length} 个都在` });
      for (const name of want) {
        const [newValue, oldValue] = [newVariables.value[name], oldVariables.value[name]];
        if (newValue === undefined || newValue === oldValue || isValueExempt(name, manifest.kind)) continue;
        items.push({ area, item: name, status: 'mismatch', detail: name === 'MIVO_REVIEW_SKILL_SHA'
          ? `新仓 ${newValue.slice(0, 7)},旧仓 ${oldValue.slice(0, 7)}:两边要钉同一个审查机版本`
          : `新仓 ${toShownValue(newValue)},旧仓 ${toShownValue(oldValue)}:要和旧仓一样` });
      }
    }
    const label = newVariables.value.MIVO_REVIEW_RUNNER_LABEL;
    items.push({ area, item: 'MIVO_REVIEW_RUNNER_LABEL', status: label === manifest.runnerLabel ? 'ok' : 'mismatch',
      detail: label === manifest.runnerLabel ? label : `期望 ${manifest.runnerLabel},实际 ${label ?? '未设置(workflow 会落到缺省 mivo-review-next,任务一直排队)'}` });
    if (Object.hasOwn(newVariables.value, 'MIVO_REVIEW_MODE')) items.push({ area, item: 'MIVO_REVIEW_MODE', status: 'info', detail: newVariables.value.MIVO_REVIEW_MODE });
  }
  const names = (item, read, want) => {
    if (!read.ok) return items.push(unknownItem(area, item, read));
    const lacking = missingNames(want, read.value);
    return items.push({ area, item, status: lacking.length ? 'missing' : 'ok', detail: lacking.length ? `缺 ${lacking.join('、')}` : want.join('、') });
  };
  names('仓库 secrets', secrets, REQUIRED_SECRETS);
  names('组织 secrets(本仓可见)', orgSecrets, REQUIRED_ORG_SECRETS);
  names('环境', environments, REQUIRED_ENVIRONMENTS);
  if (!oldLabels.ok) items.push(unknownItem(area, '旧仓 label(对照基准)', oldLabels));
  else names('label(按旧仓对照)', labels, [...oldLabels.value].sort());
  if (!oldRulesets.ok) items.push(unknownItem(area, '旧仓规则集(对照基准)', oldRulesets));
  else names('规则集(含组织级,按旧仓对照)', rulesets, [...oldRulesets.value].sort());
  items.push(...toBranchRulesItems(area, oldBranchRules, newBranchRules));
  if (!runners.ok) items.push(unknownItem(area, `带 ${manifest.runnerLabel} 标签的在线 runner`, runners));
  else {
    const online = runners.value.filter((r) => r.status === 'online' && r.labels.includes(manifest.runnerLabel)).length;
    items.push({ area, item: `带 ${manifest.runnerLabel} 标签的在线 runner`, status: online ? 'ok' : 'missing', detail: `${online} 个` });
  }
  return items;
}

// ── Mini 本机 ────────────────────────────────────────────────────────────

/**
 * Mini 上还写着旧仓的地方。config:实例配置对象、null(文件不存在)或 { unreadable: 原因 }(读不了或 JSON 坏了);routers [{name, repos|null}];
 * monitor [{file, line}] 旧仓名出现的位置;issueAgent [{file, allow|null}] 或 null(找不到目录)。
 */
export function toMiniReport(manifest, { config, routers, monitor, issueAgent }) {
  const area = 'Mini 本机';
  const items = [];
  if (!config) items.push({ area, item: '实例配置 config/mivo.json', status: 'missing', detail: '没有这个文件' });
  else if (config.unreadable) items.push({ area, item: '实例配置 config/mivo.json', status: 'unknown', detail: `查不了:${config.unreadable}` });
  else {
    const pointsNew = config.targetRepo === manifest.newRepo && config.workflowRepo === manifest.newRepo;
    items.push({ area, item: '实例配置 config/mivo.json', status: pointsNew ? 'ok' : 'info',
      detail: `targetRepo=${config.targetRepo ?? '空'},workflowRepo=${config.workflowRepo ?? '空'},mode=${config.mode ?? '空'}` });
  }
  for (const router of routers) {
    const has = Array.isArray(router.repos) && router.repos.includes(manifest.newRepo);
    items.push({ area, item: `App 分流白名单 ${router.name}`, status: has ? 'ok' : 'missing', detail: has ? '已含新仓' : '还没有新仓' });
  }
  items.push({ area, item: '巡检脚本里的旧仓名', status: monitor.length ? 'missing' : 'ok',
    detail: monitor.length ? monitor.slice(0, 5).map((m) => `${m.file}:${m.line}`).join('、') + (monitor.length > 5 ? ` 等 ${monitor.length} 处` : '') : '没有' });
  if (issueAgent === null) items.push({ area, item: 'issue 评估 repoAllowlist', status: 'unknown', detail: '找不到 issue 评估配置目录' });
  else {
    for (const entry of issueAgent) {
      const has = Array.isArray(entry.allow) && entry.allow.includes(manifest.newRepo);
      items.push({ area, item: `issue 评估 ${entry.file}`, status: has ? 'ok' : 'missing', detail: has ? '已含新仓' : 'repoAllowlist 还没有新仓' });
    }
  }
  return items;
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

export function toExitCode(items) {
  if (items.some((item) => FAIL_STATUSES.includes(item.status))) return 1;
  if (items.some((item) => item.status === 'unknown')) return 2;
  return 0;
}

const MARK = { ok: '✓', missing: '✗', drift: '✗', invalid: '✗', mismatch: '✗', unknown: '?', absent: '·', manual: '·', info: '·' };
const STATUS_TEXT = { ok: '通过', missing: '缺', drift: '漂移', invalid: '不合法', mismatch: '不一致', unknown: '查不了', absent: '两边都没有', manual: '人工核对', info: '' };

/** 给人看的报告:按区域分组,只展开没通过的条目和 info;通过的路径规则只计数。 */
export function toReportText(items, { verbose = false } = {}) {
  const lines = [];
  const areas = [...new Set(items.map((item) => item.area))];
  for (const area of areas) {
    const own = items.filter((item) => item.area === area);
    lines.push(`## ${area}`);
    const counts = Object.entries(own.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {}))
      .map(([status, n]) => `${STATUS_TEXT[status] || status} ${n}`).join(',');
    lines.push(counts);
    for (const item of own) {
      if (!verbose && (item.status === 'ok' || item.status === 'absent') && area === '路径规则') continue;
      const name = item.item ?? `${item.kind} ${item.pattern}`;
      const counted = item.oldCount === undefined ? '' : `(旧仓 ${item.oldCount} 个文件 → 新仓 ${item.newCount} 个)`;
      const from = item.sources ? ` ← ${item.sources.join(';')}` : '';
      const status = STATUS_TEXT[item.status] ? `${STATUS_TEXT[item.status]}:` : '';
      lines.push(`${MARK[item.status] ?? '?'} ${status}${name}${counted}${item.detail ? ` — ${item.detail}` : ''}${from}`);
    }
    lines.push('');
  }
  const code = toExitCode(items);
  lines.push(code === 0 ? '结论:全部通过。' : code === 1 ? '结论:有缺项或漂移(✗),补齐后再切换。' : '结论:没有缺项,但有查不了的项(?),要人工核对。');
  return `${lines.join('\n')}\n`;
}

// ── 切换当天的命令清单 ───────────────────────────────────────────────────

const shq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/**
 * 切换当天按角色排好的命令清单(Markdown)。oldVariables 是旧仓变量 {名字: 值}(读不到传 null,命令里留占位);
 * skillSha 是线上审查机提交(读不到传 null)。只拼文字,不执行任何命令。
 */
export function toCutoverPlan({ manifest, oldVariables = null, skillSha = null, date = '<YYYYMMDD>' }) {
  const { oldRepo, newRepo, kind, defaultBranch, runnerLabel } = manifest;
  const sha = skillSha ?? '<线上 MIVO_REVIEW_SKILL_SHA>';
  const fresh = kind === 'fresh';
  const others = oldVariables ? Object.keys(oldVariables).filter((name) => !isReviewVariable(name) && !RUNTIME_VARIABLES.includes(name)).sort() : [];
  const variableLines = oldVariables
    ? Object.keys(oldVariables).filter(isReviewVariable).sort().map((name) => {
      const value = name === 'MIVO_REVIEW_MODE' ? 'dry-run' : name === 'MIVO_REVIEW_RUNNER_LABEL' ? runnerLabel : oldVariables[name];
      const note = name === 'MIVO_REVIEW_MODE' ? '  # 先 dry-run,测试 PR 通过后再改 live'
        : fresh && name === 'MIVO_REVIEW_WATCHDOG_ISSUE' ? '  # 新建仓:先在新仓开看门狗 issue,换成它的编号' : '';
      return `gh variable set ${name} -R ${newRepo} --body ${shq(value)}${note}`;
    })
    : [`# 旧仓变量读不到:按 gh api repos/${oldRepo}/actions/variables 逐个抄,MIVO_REVIEW_MODE 先设 dry-run,MIVO_REVIEW_RUNNER_LABEL 设 ${runnerLabel}`];
  const secretLines = REQUIRED_SECRETS.map((name) => `agent-secret run ${name} -- sh -c 'printf %s "$${name}" | gh secret set ${name} -R ${newRepo}'`);
  return [
    `# 审查机换仓切换清单:${oldRepo} → ${newRepo}(${fresh ? '新建仓,编号从 1 开始' : 'GitHub 转移,编号保留'})`,
    '',
    '本清单只列命令,不执行。每段做完跑一次只读预检,✗ 清零再往下:',
    '',
    '```bash',
    `node mivo/deploy/cutover.mjs --manifest <切换清单.json> --preview`,
    '```',
    '',
    '## 1. 新仓管理员 / 组织 owner(GitHub 设置)',
    '',
    `1. 安装 App 到新仓:PraiseBuild、Praise Reviewer(服务器审查发布与读取),PraiseTriage、PraiseWatch(Mini 分流),praise-merge(合并);换了组织就是新的安装。`,
    `2. 组织 secret ${REQUIRED_ORG_SECRETS.join('、')} 勾选新仓可见;CODEOWNERS 里的团队对新仓有 write;组织规则集 trunk-guard 覆盖新仓。`,
    `3. 审查机的仓库变量(值抄自旧仓,Mini 运行时写的 ${RUNTIME_VARIABLES.join('、')} 不抄):`,
    '',
    '```bash',
    ...variableLines,
    '```',
    '',
    ...(others.length ? [`   旧仓另有 ${others.length} 个不属于审查机的变量,本清单不迁(照抄会在新仓误开那些自动化),交各自负责方:${others.join('、')}。`, ''] : []),
    '4. 仓库 secrets(GitHub 读不回旧值,从密钥目录注入;目录里还没有的先登记再 set):',
    '',
    '```bash',
    ...secretLines,
    '```',
    '',
    `5. 环境 ${REQUIRED_ENVIRONMENTS.join('、')}(部署分支只允许 ${defaultBranch})和它的 MIVO_SLACK_BOT_TOKEN。`,
    `6. label:${fresh ? `gh label clone ${oldRepo} -R ${newRepo}` : '转移时随仓过去,预检会核对'}。`,
    `7. 规则集与分支保护:按旧仓 gh api 'repos/${oldRepo}/rulesets?includes_parents=true' 逐套重建(组织级的确认也管到新仓);重建后跑 --preview,它按旧仓逐条对照默认分支上实际生效的规则和必需检查。`,
    '',
    '## 2. 服务器管理员(Mivo 服务器,生产服务,当次点名授权后做)',
    '',
    `1. 前提:Mivo 仓的 runner 安装脚本已改成可传仓地址(另一个 PR,还没做)。`,
    `2. 新仓 admin 生成一次性注册令牌:gh api -X POST repos/${newRepo}/actions/runners/registration-token --jq .token(1 小时有效,不贴进对话,存 0600 文件交给管理员)。`,
    `3. 管理员把 runner 注册到 https://github.com/${newRepo},标签 ${runnerLabel};mivo-review-install 的克隆地址换新仓并加 deploy key。`,
    '',
    '## 3. Mini',
    '',
    '1. 在 Mini 的 Cindy 自动化里暂停「Mivo 审查机每天换版本」(等正在跑的那一轮结束再暂停)。',
    '2. 等在途审查收完,停前置审查:',
    '',
    '```bash',
    'launchctl bootout "gui/$(id -u)/com.mivo.prereview.mivo"',
    ...(fresh
      ? [`# 新建仓:PR 编号从 1 开始,旧状态按 PR 号存,必须整体归档,否则新 #5 会读到旧 #5 的记录`,
        `mv ~/mivo-prereview/state/mivo ~/mivo-prereview/state/mivo.${oldRepo.replace('/', '__')}-${date}`,
        `mv ~/mivo-prereview/repos/mivo ~/mivo-prereview/repos/mivo.${oldRepo.replace('/', '__')}-${date}`]
      : [`# 转移:编号保留,状态沿用;镜像改指新地址(install-mini.sh 会核对 origin 等于目标仓)`,
        `git -C ~/mivo-prereview/repos/mivo remote set-url origin https://github.com/${newRepo}.git`]),
    '```',
    '',
    `3. App 分流白名单:~/mivo-gh-router/{praisebuild,praisetriage,praisewatch}/config.json 的 repos 加 ${newRepo}(换组织还要换 installationId);~/mivo-prereview/praise-qa-gh.sh 同理。`,
    `4. 巡检脚本 ~/mivo-prereview/monitor/scripts/schedule-checks/ 里的旧仓名(预检列出了文件和行)。`,
    `5. issue 评估 runtime-primary.json / runtime-fallback.json 的 repoAllowlist、codeRepoMap 加新仓。`,
    '6. 装新实例,先 dry-run(实例名保持 mivo:心跳、主备 key 状态、换版本锁都只认这个名字):',
    '',
    '```bash',
    `bash ~/mivo-prereview/skill/mivo/prereview/install-mini.sh --sha ${sha} --instance mivo --target-repo ${newRepo} --workflow-repo ${newRepo} --mode dry-run --workflow-ref ${defaultBranch}`,
    '```',
    '',
    `7. 在新仓开一个测试 PR:看 ~/Library/Logs/mivo-prereview/mivo/round-<UTC 日期>.jsonl 的判门与派发事件、新仓 Actions 的 review-pr 运行。`,
    '8. 通过后切正式:',
    '',
    '```bash',
    `gh variable set MIVO_REVIEW_MODE -R ${newRepo} --body live`,
    `bash ~/mivo-prereview/skill/mivo/prereview/install-mini.sh --sha ${sha} --instance mivo --target-repo ${newRepo} --workflow-repo ${newRepo} --mode live --workflow-ref ${defaultBranch}`,
    '```',
    '',
    '9. 恢复「Mivo 审查机每天换版本」;第二天 06:30 看它改的是新仓变量。',
    ...(fresh ? ['', `## 4. 旧仓收尾(新建仓)`, '', `- 旧仓还开着的 PR 要作者在新仓重开;维护者在旧 PR 上的「不改」裁定不会带过去,首轮会全量重审。`] : []),
    '',
  ].join('\n');
}
