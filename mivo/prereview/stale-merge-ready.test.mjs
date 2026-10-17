// Mini 摘 review:merge-ready 的接线(round.mjs 的 dropStaleMergeReady / readCodeScanGate)。
// 2026-10-18 #1025:CodeQL neutral 时 GitHub 挡合并,标签却说能合;标签已挂上之后代码扫描变成稳定不通过,Mini 也要能摘。
// 只在稳定不通过(neutral / failure)时摘,进行中 / 缺失 / 读不到不摘(避免来回加摘);规则按 base 缓存,check run 一次 REST。
// 做法同 round-rolling.test.mjs:从 round.mjs 源码抽出具名函数,放进 vm,gh / 文件 / 日志用替身;判据函数用真的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { toStaleMergeReadyReason } from '../lib/gates.mjs';
import { fetchCodeScanFacts, toCodeScanGate } from '../lib/code-scan.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
function extractFunction(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  assert.ok(declaration, `round.mjs 里找不到函数 ${name}`);
  const closing = /^\}/m.exec(source.slice(declaration.index));
  assert.ok(closing, `${name} 没有顶格的结束括号`);
  return source.slice(declaration.index, declaration.index + closing.index + 1);
}

const LABEL = 'review:merge-ready';
const NOW = Date.parse('2026-10-17T19:30:00Z');
const SCAN_RULE = { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } };
const check = (patch = {}) => ({ name: 'CodeQL', app: { slug: 'github-advanced-security' }, status: 'completed', conclusion: 'success',
  output: { title: 'No new alerts in code changed by this pull request' }, completed_at: new Date(NOW - 300_000).toISOString(), ...patch });

function makeWorld({ rules = [SCAN_RULE], rulesStatus = 'ok', runs = [check()], cleanHead = 'head-7', labels = [LABEL], ghThrows = false } = {}) {
  const files = new Map();
  const gh = [];
  const deletes = [];
  const logs = [];
  const ok = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '' });
  const ghRead = (args) => {
    gh.push(args[1]);
    if (ghThrows) throw new Error('spawn gh ENOENT');
    if (args[1].includes('/rules/branches/')) return rulesStatus === 'ok' ? ok(rules) : { ok: false, stdout: '', stderr: 'HTTP 404: Not Found' };
    if (args[1].includes('/check-runs')) return ok({ total_count: runs.length, check_runs: runs });
    throw new Error(`意外的读取:${args.join(' ')}`);
  };
  const sandbox = {
    toStaleMergeReadyReason, fetchCodeScanFacts, toCodeScanGate, MERGE_READY_LABEL: LABEL, encodeURIComponent, Date,
    CONFIG: { targetRepo: 'o/r', repoRoot: '/repo' }, ENV: {},
    loadStore: () => ({ prs: { 7: { cleanHead } } }),
    stateFile: (name) => `/state/mivo/${name}`,
    readJson: (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback),
    writeJson: (file, value) => files.set(file, structuredClone(value)),
    assertNotFenced() {},
    log: (event, detail) => logs.push({ event, ...detail }),
    ghRead,
    run: (command, args) => { deletes.push(args.join(' ')); return { ok: true, stdout: '', stderr: '' }; },
  };
  vm.runInNewContext(`${extractFunction('dropStaleMergeReady')}\n${extractFunction('codeScanCache')}\n${extractFunction('readCodeScanGate')}\nglobalThis.api = { dropStaleMergeReady };`, sandbox);
  const drop = ({ pr = 7, head = 'head-7', base = 'main', meta = {}, decision = { stage: 'review', outcome: null } } = {}) => {
    const result = { warnings: [] };
    sandbox.api.dropStaleMergeReady({ meta: { labels, ...meta } }, { pr, head, baseRefName: base }, result, decision);
    return result;
  };
  return { drop, gh, deletes, logs, files };
}

test('#1025:标签已挂,之后 CodeQL 稳定变成 neutral(1 configuration not found):摘标签,日志写明原因', () => {
  const world = makeWorld({ runs: [check({ conclusion: 'neutral', output: { title: '1 configuration not found' } })] });
  world.drop();
  assert.equal(world.deletes.length, 1);
  assert.match(world.deletes[0], /issues\/7\/labels\/review%3Amerge-ready/);
  assert.match(world.logs[0].reason, /代码扫描门未过.*1 configuration not found/);
});

test('CodeQL failure 同样摘', () => {
  const world = makeWorld({ runs: [check({ conclusion: 'failure', output: { title: '2 new alerts' } })] });
  world.drop();
  assert.equal(world.deletes.length, 1);
});

test('CodeQL success / 进行中 / 缺失 / 规则读不到:不摘(进行中不算稳定不通过,避免来回加摘)', () => {
  for (const [name, options] of [
    ['success', {}],
    ['进行中', { runs: [check({ status: 'in_progress', conclusion: null, completed_at: null })] }],
    ['缺失', { runs: [] }],
    ['规则读不到', { rulesStatus: 'fail' }],
  ]) {
    const world = makeWorld(options);
    world.drop();
    assert.equal(world.deletes.length, 0, name);
  }
});

test('分支不受代码扫描规则约束:只读一次规则,不读 check run,不摘', () => {
  const world = makeWorld({ rules: [{ type: 'deletion' }], runs: [check({ conclusion: 'neutral' })] });
  world.drop({ base: 'feat/automerge-gate' });
  assert.equal(world.deletes.length, 0);
  assert.deepEqual(world.gh, ['repos/o/r/rules/branches/feat%2Fautomerge-gate?per_page=100']);
});

test('规则按 base 缓存:同 base 的第二个 PR 不再读规则,只读自己 head 的 check run', () => {
  const world = makeWorld();
  world.drop();
  world.drop();
  assert.equal(world.gh.filter((path) => path.includes('/rules/branches/')).length, 1);
  assert.equal(world.gh.filter((path) => path.includes('/check-runs')).length, 2);
  assert.ok(world.files.has('/state/mivo/code-scan-rules.json'));
});

test('不该读的时候不读:PR 没有标签 / head 已不是审查通过的那个(本来就要摘)/ 判门已有别的失效原因', () => {
  const noLabel = makeWorld({ labels: [] });
  noLabel.drop();
  assert.equal(noLabel.gh.length, 0);
  assert.equal(noLabel.deletes.length, 0);
  const moved = makeWorld({ cleanHead: 'older-head' });
  moved.drop();
  assert.equal(moved.gh.length, 0, 'head 变了照旧摘,不多读 API');
  assert.equal(moved.deletes.length, 1);
  assert.equal(moved.logs[0].reason, 'head-changed');
  const conflict = makeWorld();
  conflict.drop({ meta: { mergeStateStatus: 'DIRTY' } });
  assert.equal(conflict.gh.length, 0, '已经因冲突要摘,不多读 API');
  assert.equal(conflict.deletes.length, 1);
  assert.match(conflict.logs[0].reason, /冲突/);
});

test('读代码扫描事实时出意外(gh 起不来、缓存文件损坏):按读不到处理,不摘、不抛,日志留一笔', () => {
  const broken = makeWorld({ runs: [check({ conclusion: 'neutral' })], ghThrows: true });
  broken.drop();
  assert.equal(broken.deletes.length, 0);
  assert.equal(broken.logs[0].event, 'code-scan-gate-error');
  assert.match(broken.logs[0].error, /ENOENT/);
  // 缓存文件内容不是对象(被改坏):当作没命中,重读规则,照常判
  const corrupt = makeWorld({ runs: [check({ conclusion: 'neutral' })] });
  corrupt.files.set('/state/mivo/code-scan-rules.json', null);
  corrupt.drop();
  assert.equal(corrupt.deletes.length, 1);
});
