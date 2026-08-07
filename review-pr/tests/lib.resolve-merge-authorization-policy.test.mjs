// lib.resolve-merge-authorization-policy.test.mjs — resolveMergeAuthorizationPolicy
// 单一解析函数的配置形态矩阵(三审共识 finding A1/A2,2026-08-08)。
//
// 背景(Review-PR 三审共识):
//   A1(配置 shape 漂移):resolver 只读 `rules.mergeAuthorization.*`,但权威默认配置
//     (config/pr-rules.json 与重建产物 dist/preview-dist)此前把两个新键放在**顶层**。
//     实际 packaged config load 后 resolve 返回 require=false,breakGlass 回退 admins,
//     显式 [] 关闭失效——配置写了等于没写,还带着回退 warning。修复:两个键移入
//     `mergeAuthorization` 对象(与 Mivo 一致),保留中性默认 false/[]。
//   A2(malformed require flag 静默 fail-open):`requireAutomatedReviewForAutoMerge:
//     'true'` 这类非 boolean 值此前被 `=== true` 静默变 false 且无 warning,结构性
//     approved 可免 current-head clean 回执直接合。修复:键缺失 = 兼容 false;
//     键存在但值非 boolean(null/string/number/object/undefined 等显式 malformed,
//     null 按「显式写了但写错」算 malformed 而非缺失)= fail-closed 按 true 处理
//     (从安全方向强制审查)+ 显著 warning。
//
// 环境隔离纪律(复验失败后补强,2026-08-08):本文件**不在测试进程内直接调用
// `loadRules()`**——它读 REVIEW_PR_RULES_FILE env > 进程 CWD 的
// <REPO_ROOT>/agent-use/docs/pr-rules.json > skill 默认 config 三层优先级,测试进程
// CWD 不同(如 lead 的 Mivo 主仓)会读到完全不同的配置实例甚至 TypeError。
// 改为:
//   ① packaged config 集成断言绑定 `parse(CONFIG)`——JSON.parse 直接读本 skill 实际
//      落盘的 config/pr-rules.json,不依赖进程 CWD/env;
//   ② loadRules 的真实优先级行为用**隔离子进程**验证:显式设置 cwd/REVIEW_PR_REPO_ROOT
//      到不含目标仓 config 的临时目录、显式清除 REVIEW_PR_RULES_FILE,再断言
//      loadRulesWithSource() 读到的文件路径精确等于 CONFIG(确定性,不猜);
//   ③ 目标仓形态(Mivo 现状:mergeAuthorization 只有 ownAccountApprovalRequiresAck,
//      无 breakGlassApprovers)用临时仓库根 + 子进程回归,证明 loadRules 优先级与
//      resolver 在该形态下的设计行为(缺失 → 回退 admins + warning)双双有测试覆盖。
// 同一命令从任意 CWD 运行结果一致。
//
// 反向变异:把 resolver 改回旧写法 `mergeAuth.requireAutomatedReviewForAutoMerge === true`
// (malformed 当 false),A2 矩阵全部红;把配置 shape 改回顶层,A1 packaged-config 用例
// (断言无回退 warning)当场红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveMergeAuthorizationPolicy } from '../scripts/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(__dirname, '..', 'config', 'pr-rules.json');
const DIST_CONFIG = join(__dirname, '..', '..', 'dist', 'config', 'pr-rules.json');
const PREVIEW_CONFIG = join(__dirname, '..', '..', 'preview-dist', 'config', 'pr-rules.json');
const LIB = join(__dirname, '..', 'scripts', 'lib.mjs');
const parse = (p) => JSON.parse(readFileSync(p, 'utf8'));

// 在隔离子进程里跑 loadRulesWithSource():cwd/repoRoot 显式给定、REVIEW_PR_RULES_FILE
// 显式清除——测试进程自身的 CWD/env 完全不影响结果。
function runLoadRulesIn(cwd, repoRoot) {
  const script = [
    `import { loadRulesWithSource } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
    'const { rules, rulesFile } = loadRulesWithSource();',
    'console.log(JSON.stringify({ rulesFile, hasMergeAuth: rules && typeof rules.mergeAuthorization === "object" && rules.mergeAuthorization !== null }));',
  ].join('\n');
  const env = { ...process.env };
  delete env.REVIEW_PR_RULES_FILE;
  env.REVIEW_PR_REPO_ROOT = repoRoot;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd, env, encoding: 'utf8' });
}

// ── A1:packaged config 必须是嵌套 mergeAuthorization 形态,resolver 结果中性且无回退 ──

test('A1 源配置 shape:breakGlassApprovers/requireAutomatedReviewForAutoMerge 在 mergeAuthorization 对象内,不在顶层', () => {
  const cfg = parse(CONFIG);
  assert.deepEqual(cfg.mergeAuthorization, {
    breakGlassApprovers: [],
    requireAutomatedReviewForAutoMerge: false,
  }, '两个键必须收进 mergeAuthorization 对象');
  assert.equal('breakGlassApprovers' in cfg, false, '顶层不得残留 breakGlassApprovers(旧漂移 shape)');
  assert.equal('requireAutomatedReviewForAutoMerge' in cfg, false, '顶层不得残留 requireAutomatedReviewForAutoMerge(旧漂移 shape)');
});

test('A1 实际 packaged config(JSON.parse 源文件绑定)喂 resolver:require=false、breakGlass=[],无回退 warning', () => {
  // 直接 parse(CONFIG) 绑定本 skill 实际落盘配置——不调用 loadRules(),不依赖进程
  // CWD/env(测试进程 CWD 不同会读到别的配置实例,复验失败根因)。
  const rules = parse(CONFIG);
  assert.equal(rules.mergeAuthorization.breakGlassApprovers.length, 0);
  assert.equal(rules.mergeAuthorization.requireAutomatedReviewForAutoMerge, false);
  const { requireAutomatedReviewForAutoMerge, breakGlassApprovers, warnings } = resolveMergeAuthorizationPolicy(rules);
  assert.equal(requireAutomatedReviewForAutoMerge, false, '中性默认必须 false');
  assert.deepEqual(breakGlassApprovers, [], '显式 [] 必须生效(不再是未配置回退)');
  assert.deepEqual(warnings, [], '显式 [] 已配置 → 不得产出 breakGlass 回退 warning(旧漂移 shape 会回退 admins 并告警)');
});

test('A1 loadRules 默认优先级(隔离子进程):无目标仓 config + 清除 REVIEW_PR_RULES_FILE → 读 skill 默认 config 路径', () => {
  const work = mkdtempSync(join(tmpdir(), 'review-pr-loadrules-isolated-'));
  const r = runLoadRulesIn(work, work);
  assert.equal(r.status, 0, `子进程失败: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.rulesFile, resolve(CONFIG), '隔离 cwd 无 agent-use/docs/pr-rules.json 时必须落到 skill 默认 config 路径');
  assert.equal(out.hasMergeAuth, true, '默认 config 必须带 mergeAuthorization 对象');
});

test('A1 目标仓形态回归(隔离子进程,模拟 Mivo cwd):REPO_ROOT 有 agent-use/docs/pr-rules.json → loadRules 读目标仓配置,缺失 breakGlass 回退+warning 是设计行为', () => {
  const work = mkdtempSync(join(tmpdir(), 'review-pr-loadrules-target-'));
  const repo = join(work, 'repo');
  mkdirSync(join(repo, 'agent-use', 'docs'), { recursive: true });
  // Mivo 现状形态:mergeAuthorization 只有 ownAccountApprovalRequiresAck,无 breakGlassApprovers
  const targetRules = { admins: ['PraiseZhu'], mergeAuthorization: { ownAccountApprovalRequiresAck: true } };
  writeFileSync(join(repo, 'agent-use', 'docs', 'pr-rules.json'), JSON.stringify(targetRules));
  const r = runLoadRulesIn(work, repo);
  assert.equal(r.status, 0, `子进程失败: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.rulesFile, resolve(join(repo, 'agent-use', 'docs', 'pr-rules.json')), '目标仓 config 存在时必须读它(优先级 ②)');
  // 该形态喂 resolver:require 缺失 → false;breakGlass 缺失 → 回退 admins + warning(设计行为,不是漂移)
  const policy = resolveMergeAuthorizationPolicy(parse(join(repo, 'agent-use', 'docs', 'pr-rules.json')));
  assert.equal(policy.requireAutomatedReviewForAutoMerge, false);
  assert.deepEqual(policy.breakGlassApprovers, ['praisezhu'], '缺失 → 兼容回退 admins');
  assert.ok(policy.warnings.some((w) => /breakGlassApprovers 未配置.*回退到 admins/.test(w)), '回退必须显式告警');
});

test('A1 重建产物 dist/preview-dist 与源配置同 shape:嵌套形态 + resolver 结果一致(防 dist 再漂移)', () => {
  for (const [label, path] of [['dist', DIST_CONFIG], ['preview-dist', PREVIEW_CONFIG]]) {
    const cfg = parse(path);
    assert.deepEqual(cfg.mergeAuthorization, {
      breakGlassApprovers: [],
      requireAutomatedReviewForAutoMerge: false,
    }, `${label}:mergeAuthorization 对象必须与源同 shape`);
    assert.equal('breakGlassApprovers' in cfg, false, `${label}:顶层不得残留旧漂移 shape`);
    assert.equal('requireAutomatedReviewForAutoMerge' in cfg, false, `${label}:顶层不得残留旧漂移 shape`);
    const r = resolveMergeAuthorizationPolicy(cfg);
    assert.equal(r.requireAutomatedReviewForAutoMerge, false, `${label}:require 中性默认 false`);
    assert.deepEqual(r.breakGlassApprovers, [], `${label}:breakGlass 显式 [] 生效`);
    assert.deepEqual(r.warnings, [], `${label}:无回退 warning`);
  }
});

test('A1 目标仓嵌套配置生效:mergeAuthorization 块直接喂 resolver → true + 名单,无 warning', () => {
  const r = resolveMergeAuthorizationPolicy({
    admins: ['outsider'],
    mergeAuthorization: {
      requireAutomatedReviewForAutoMerge: true,
      breakGlassApprovers: ['PraiseZhu', 'KIROZENG'],
    },
  });
  assert.equal(r.requireAutomatedReviewForAutoMerge, true, '目标仓显式 true 必须生效');
  assert.deepEqual(r.breakGlassApprovers, ['praisezhu', 'kirozeng'], '名单归一化小写');
  assert.deepEqual(r.warnings, [], '显式配置 → 无 warning');
});

test('A1 反向守卫:旧漂移 shape(顶层键)不得被静默当成有效配置——回退 admins + 必须可见告警', () => {
  // 目标仓若仍按旧文档把两个键放顶层:resolver 读不到 mergeAuthorization.*,require 落
  // 兼容 false(行为不变),breakGlass 落回退(admins),且**必须**产出回退 warning——
  // fail-visible,配置错误不许悄悄吞掉。
  const r = resolveMergeAuthorizationPolicy({
    admins: ['PraiseZhu'],
    breakGlassApprovers: [],
    requireAutomatedReviewForAutoMerge: true,
  });
  assert.equal(r.requireAutomatedReviewForAutoMerge, false, '顶层键不生效(兼容 false),但必须靠 warning 暴露');
  assert.deepEqual(r.breakGlassApprovers, ['praisezhu'], '顶层键不生效 → breakGlass 回退 admins');
  assert.ok(r.warnings.some((w) => /breakGlassApprovers 未配置.*回退到 admins/.test(w)), '回退必须带 warning,不能静默');
});

// ── A2:requireAutomatedReviewForAutoMerge 的类型矩阵(缺失兼容 false,存在必须 boolean)──

test('A2 缺失矩阵:键不存在 / mergeAuthorization 整体缺失或为 null → 兼容 false,且绝不产出 require malformed warning', () => {
  // 注意:整体缺失 mergeAuthorization 时 breakGlass 会走兼容回退(admins)+ 回退 warning,
  // 那是 breakGlass 维度的既有行为,与本用例要锁的 require 维度无关——断言只针对
  // requireAutomatedReviewForAutoMerge:值必须 false,且 warning 里不得出现它的 malformed 告警。
  const noRequireWarn = (warnings) => !warnings.some((w) => w.includes('requireAutomatedReviewForAutoMerge'));
  const cases = [
    ['无 mergeAuthorization 键', { admins: [] }],
    ['mergeAuthorization 为 null', { admins: [], mergeAuthorization: null }],
    ['mergeAuthorization 空对象', { admins: [], mergeAuthorization: {} }],
    ['mergeAuthorization 只配 breakGlass(require 键缺失)', { admins: [], mergeAuthorization: { breakGlassApprovers: [] } }],
    ['rules 为 null', null],
    ['rules 为空对象', {}],
  ];
  for (const [label, rules] of cases) {
    const r = resolveMergeAuthorizationPolicy(rules);
    assert.equal(r.requireAutomatedReviewForAutoMerge, false, `${label}:缺失必须兼容 false`);
    assert.ok(noRequireWarn(r.warnings), `${label}:require 键缺失不得产出 malformed warning(那是键存在才有的语义)`);
  }
  // 对照:mergeAuthorization 存在且 breakGlass 显式配了 [] → 全部无 warning(require 键缺失
  // 是正常兼容路径,不告警;breakGlass 显式 [] 也不告警)
  const clean = resolveMergeAuthorizationPolicy({ admins: [], mergeAuthorization: { breakGlassApprovers: [] } });
  assert.deepEqual(clean.warnings, [], 'require 键缺失 + breakGlass 显式 [] → 零 warning(两个维度都干净)');
});

test('A2 malformed 矩阵:键存在但值非 boolean(null/string/number/object/undefined)→ fail-closed true + warning 可见', () => {
  const malformed = [
    ['null(显式写了但写错,算 malformed 不算缺失)', null],
    ['字符串 "true"(旧 fail-open 形态)', 'true'],
    ['字符串 "false"', 'false'],
    ['字符串 "yes"', 'yes'],
    ['数字 1', 1],
    ['数字 0', 0],
    ['空对象', {}],
    ['数组', []],
    ['undefined 显式键', undefined],
  ];
  for (const [label, value] of malformed) {
    const r = resolveMergeAuthorizationPolicy({ mergeAuthorization: { requireAutomatedReviewForAutoMerge: value } });
    assert.equal(r.requireAutomatedReviewForAutoMerge, true, `${label}:malformed 必须 fail-closed 按 true(宁严勿松),不能变 false`);
    assert.ok(r.warnings.some((w) => /配置形态不合法/.test(w) && /fail-closed/.test(w)),
      `${label}:必须产出形态不合法 warning 且声明 fail-closed 处理`);
  }
});

test('A2 合法矩阵:true → true 无 warning;false → false 无 warning(对照,证明不是一律开闸)', () => {
  // breakGlass 显式配 [] 避免兼容回退 warning 干扰,只锁 require 维度
  const on = resolveMergeAuthorizationPolicy({ mergeAuthorization: { breakGlassApprovers: [], requireAutomatedReviewForAutoMerge: true } });
  assert.equal(on.requireAutomatedReviewForAutoMerge, true);
  assert.deepEqual(on.warnings, []);
  const off = resolveMergeAuthorizationPolicy({ mergeAuthorization: { breakGlassApprovers: [], requireAutomatedReviewForAutoMerge: false } });
  assert.equal(off.requireAutomatedReviewForAutoMerge, false);
  assert.deepEqual(off.warnings, []);
});

test('A2 反向变异声明:旧实现 `=== true` 下 "true"/null/1 全变 false 且无 warning → 本矩阵全红', () => {
  // 本用例不是多余断言,是把「反向变异必须红」落成可执行的契约:逐一对旧语义
  // (`mergeAuth.requireAutomatedReviewForAutoMerge === true`)必红的输入做显式断言。
  // 若有人把 resolver 改回旧写法,下面每一条都会红——矩阵不是纸面承诺。
  for (const v of ['true', null, 1, {}, []]) {
    const r = resolveMergeAuthorizationPolicy({ mergeAuthorization: { requireAutomatedReviewForAutoMerge: v } });
    assert.equal(r.requireAutomatedReviewForAutoMerge, true, `malformed ${JSON.stringify(v)} 必须 fail-closed true(旧实现这里红)`);
    assert.ok(r.warnings.length > 0, `malformed ${JSON.stringify(v)} 必须带 warning(旧实现这里红)`);
  }
  // 同一输入下 breakGlass 键不受影响(独立维度,不互相牵连)
  const both = resolveMergeAuthorizationPolicy({
    mergeAuthorization: { requireAutomatedReviewForAutoMerge: 'true', breakGlassApprovers: ['PraiseZhu'] },
  });
  assert.deepEqual(both.breakGlassApprovers, ['praisezhu']);
  assert.equal(both.requireAutomatedReviewForAutoMerge, true);
});
