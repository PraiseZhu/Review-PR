// SC-R7 行为测试:双状态机、激活核验(fixHead 精确匹配)、幂等 upsert 不降级、
// 损坏 fail-closed、paths 求交、landed 目标存在性、以及**端到端注入**——种子 hazard
// 必须真出现在 build-review-task 的产物文本里(删接线点即红)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveHazardId, loadKnownHazards, hazardsForPaths, upsertHazard,
  verifyActivation, loadInbox, saveInbox, validateHazardShape, activateInboxItems, EVOLUTION_LEDGER,
} from '../scripts/lib.escaped-hazards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, '..', 'scripts', 'build-review-task.mjs');
const CLI = join(__dirname, '..', 'scripts', 'record-escaped-finding.mjs');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('R7 种子:#469→#483 假等待 hazard 已在 canonical evolution/ledger.json 且 active/landed 指向真实规则', () => {
  const loaded = loadKnownHazards();
  assert.equal(loaded.incomplete, false, loaded.reason);
  const seed = loaded.hazards.find((h) => h.originPr === 469 && h.fixPr === 483);
  assert.ok(seed, '种子条目必须存在');
  assert.equal(seed.activationStatus, 'active');
  assert.equal(seed.promotionStatus, 'landed');
  assert.equal(seed.promotionTarget.kind, 'rule');
  assert.equal(seed.promotionTarget.ruleId, 'playwright-waitforfunction-async-predicate');
  assert.equal(seed.repo, 'xindong/mivo-canvas', 'hazard 必须绑定 repo(防跨仓误用)');
  assert.ok(seed.fingerprint);
  assert.equal(seed.grandfathered, true, '#483 早于本机制上线,无可核验 fixHead——必须显式标 grandfathered');
  assert.equal(seed.fixHead, null);
});

test('R7 复审:hazard schema 完整性 fail-closed——缺 repo/fingerprint/paths/fixHead 一律判不完整', () => {
  const full = {
    hazardId: 'hz1-a', repo: 'o/r', fingerprint: 'hzf1-a', originPr: 1, fixPr: 2, fixHead: 'a'.repeat(40),
    pattern: 'p', paths: ['a/**'], activationStatus: 'active', promotionStatus: 'pending',
  };
  assert.equal(validateHazardShape(full).ok, true, JSON.stringify(validateHazardShape(full).errors));
  for (const k of ['repo', 'fingerprint', 'paths', 'fixHead', 'pattern', 'originPr', 'fixPr']) {
    const bad = { ...full }; delete bad[k];
    assert.equal(validateHazardShape(bad).ok, false, `缺 ${k} 应判不完整`);
  }
  // grandfather:显式标记时允许缺 fixHead
  const gf = { ...full, grandfathered: true }; delete gf.fixHead;
  assert.equal(validateHazardShape(gf).ok, true);
  // landed 必须有可解析 target
  assert.equal(validateHazardShape({ ...full, promotionStatus: 'landed' }).ok, false);
  assert.equal(validateHazardShape({ ...full, promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: 'x' } }).ok, true);
  assert.equal(validateHazardShape({ ...full, promotionStatus: 'recorded-only' }).ok, false, 'recorded-only 必须带理由');
});

test('R7 复审:loadKnownHazards 对 schema 不完整的条目判 incomplete(不是只验 id+双状态)', () => {
  const tmp = join(mkdtempSync(join(tmpdir(), 'hz-schema-')), 'ledger.json');
  const full = {
    hazardId: 'hz1-s', repo: 'o/r', fingerprint: 'hzf1-s', originPr: 1, fixPr: 2, fixHead: 'a'.repeat(40),
    pattern: 'p', paths: ['a/**'], activationStatus: 'active', promotionStatus: 'pending',
  };
  upsertHazard(tmp, full);
  assert.equal(loadKnownHazards(tmp).incomplete, false);
  // 逐字段抽掉 → 必须 incomplete(且 hazards 为空,不得伪装成"没有 hazard")
  for (const k of ['repo', 'fingerprint', 'paths', 'fixHead', 'pattern']) {
    const bad = { ...full }; delete bad[k];
    writeFileSync(tmp, JSON.stringify({ escapedHazards: [bad] }, null, 2));
    const loaded = loadKnownHazards(tmp);
    assert.equal(loaded.incomplete, true, `缺 ${k} 时 loadKnownHazards 必须判 incomplete`);
    assert.deepEqual(loaded.hazards, []);
    assert.match(loaded.reason, new RegExp(k === 'paths' ? 'paths' : k));
  }
});

test('R7 复审:激活核验——origin PR 未合并即拒(即使 originHead 恰好对上)', () => {
  // 隔离出"只有 MERGED 状态不满足"这一个变量:originHead 与探针返回一致
  const item = { originPr: 469, fixPr: 483, fixHead: 'a'.repeat(40), originHead: 'c'.repeat(40) };
  const probe = (pr) => (pr === 483
    ? { state: 'MERGED', headRefOid: 'a'.repeat(40) }
    : { state: 'OPEN', headRefOid: 'c'.repeat(40) });
  const r = verifyActivation({ item, probe });
  assert.equal(r.ok, false, 'origin PR 还开着时逃逸前提不成立,不得激活');
  assert.match(r.reason, /origin PR/);
});

test('R7 复审:repo 绑定——别的仓不吃本仓 hazard', () => {
  const tmp = join(mkdtempSync(join(tmpdir(), 'hz-repo-')), 'ledger.json');
  upsertHazard(tmp, {
    hazardId: 'hz1-r', repo: 'o/r', fingerprint: 'hzf1-r', originPr: 1, fixPr: 2, fixHead: 'a'.repeat(40),
    pattern: 'p', paths: ['a/**'], activationStatus: 'active', promotionStatus: 'pending',
  });
  assert.equal(hazardsForPaths(loadKnownHazards(tmp), ['a/x.ts'], 'o/r').length, 1);
  assert.equal(hazardsForPaths(loadKnownHazards(tmp), ['a/x.ts'], 'other/repo').length, 0, '别的仓不得吃到');
});

test('R7 复审:激活核验也核 origin PR(originPr 写成未合并的 PR → 拒激活)', () => {
  const item = { originPr: 469, fixPr: 483, fixHead: 'a'.repeat(40), originHead: 'c'.repeat(40) };
  const merged = { state: 'MERGED', headRefOid: 'a'.repeat(40) };
  // fix 合了,但 origin 还开着 → 逃逸前提不成立
  assert.equal(verifyActivation({ item, probe: (pr) => (pr === 483 ? merged : { state: 'OPEN' }) }).ok, false);
  // origin head 与登记不符 → 拒
  const mism = verifyActivation({ item, probe: (pr) => (pr === 483 ? merged : { state: 'MERGED', headRefOid: 'd'.repeat(40) }) });
  assert.equal(mism.ok, false);
  // 全对 → 过
  assert.equal(verifyActivation({ item, probe: (pr) => (pr === 483 ? merged : { state: 'MERGED', headRefOid: 'c'.repeat(40) }) }).ok, true);
});

test('R7 端到端注入:改动命中 hazard paths → hazardId 与模式文本真出现在 build-review-task 产物里', () => {
  const work = mkdtempSync(join(tmpdir(), 'hz-e2e-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'README.md'), '# x\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  mkdirSync(join(repo, 'scripts', 'e2e'), { recursive: true });
  writeFileSync(join(repo, 'scripts/e2e/a.mjs'), 'export const x = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'head'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const rulesFile = join(work, 'pr-rules.json');
  writeFileSync(rulesFile, JSON.stringify({ admins: [] }));
  const taskFile = join(work, 'task.json');
  const promptFile = join(work, 'prompt.md');
  const r = spawnSync('node', [BUILD, '469', '--base', base, '--head', head, '--out-task', taskFile, '--out-prompt', promptFile], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: stateDir, REVIEW_PR_RULES_FILE: rulesFile },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  const prompt = readFileSync(promptFile, 'utf8');
  assert.equal(task.hazardsIncomplete, false);
  assert.ok(task.knownHazards.length >= 1, 'scripts/e2e 改动应命中种子 hazard');
  const seed = task.knownHazards.find((h) => h.originPr === 469);
  assert.ok(seed);
  assert.ok(prompt.includes('## 已知逃逸风险'), 'prompt 必须有 hazard 段');
  assert.ok(prompt.includes(seed.hazardId), 'prompt 必须含 hazardId');
  assert.ok(prompt.includes('Promise 恒 truthy'), 'prompt 必须含模式文本本身,不只是 id');
  // 不命中路径的 PR 不注入
  const repo2 = join(work, 'repo2');
  mkdirSync(repo2);
  git(['init', '-q', '-b', 'main'], repo2);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo2);
  writeFileSync(join(repo2, 'README.md'), '# a\n');
  git(['add', '-A'], repo2);
  git(['commit', '-q', '-m', 'base'], repo2);
  const b2 = git(['rev-parse', 'HEAD'], repo2);
  writeFileSync(join(repo2, 'docs.md'), '# doc\n');
  git(['add', '-A'], repo2);
  git(['commit', '-q', '-m', 'head'], repo2);
  const h2 = git(['rev-parse', 'HEAD'], repo2);
  const t2 = join(work, 'task2.json');
  const p2 = join(work, 'prompt2.md');
  const r2 = spawnSync('node', [BUILD, '470', '--base', b2, '--head', h2, '--out-task', t2, '--out-prompt', p2], {
    cwd: repo2, encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repo2, REVIEW_PR_STATE_DIR: join(work, 'state2'), REVIEW_PR_RULES_FILE: rulesFile },
  });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepEqual(JSON.parse(readFileSync(t2, 'utf8')).knownHazards, [], '只改 docs 不应注入 e2e hazard');
});

test('R7 hazardsForPaths:仅 active 进 prompt;pending-fix-merge 不进;损坏 → incomplete 且不伪装成空', () => {
  const tmpLedger = join(mkdtempSync(join(tmpdir(), 'hz-')), 'ledger.json');
  const mk = (over) => ({
    hazardId: 'hz1-x', repo: 'o/r', fingerprint: 'hzf1-x', originPr: 1, fixPr: 2, fixHead: 'a'.repeat(40),
    pattern: 'p', paths: ['a/**'], activationStatus: 'active', promotionStatus: 'pending', ...over,
  });
  upsertHazard(tmpLedger, mk());
  assert.equal(hazardsForPaths(loadKnownHazards(tmpLedger), ['a/b.ts'], 'o/r').length, 1);
  assert.equal(hazardsForPaths(loadKnownHazards(tmpLedger), ['c/b.ts'], 'o/r').length, 0);
  upsertHazard(tmpLedger, mk({ hazardId: 'hz1-y', activationStatus: 'pending-fix-merge' }));
  assert.equal(hazardsForPaths(loadKnownHazards(tmpLedger), ['a/b.ts'], 'o/r').length, 1, 'pending 的不进 prompt');
  writeFileSync(tmpLedger, '{broken');
  const bad = loadKnownHazards(tmpLedger);
  assert.equal(bad.incomplete, true);
  assert.deepEqual(bad.hazards, [], '损坏时 hazards 为空但必须 incomplete=true(不得伪装成"没有 hazard")');
});

test('R7 幂等 upsert:重复登记不增条、不降级(active→pending / landed→pending 都不回退)', () => {
  const tmpLedger = join(mkdtempSync(join(tmpdir(), 'hz-')), 'ledger.json');
  const h = { hazardId: 'hz1-z', repo: 'o/r', fingerprint: 'hzf1-z', originPr: 1, fixPr: 2, fixHead: 'b'.repeat(40), pattern: 'p', paths: ['a/**'], activationStatus: 'active', promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: 'x', ruleVersion: 'v1' } };
  upsertHazard(tmpLedger, h);
  const again = upsertHazard(tmpLedger, { ...h, activationStatus: 'pending-fix-merge', promotionStatus: 'pending' });
  assert.equal(again.hazard.activationStatus, 'active');
  assert.equal(again.hazard.promotionStatus, 'landed');
  assert.equal(loadKnownHazards(tmpLedger).hazards.length, 1, '不增条');
});

test('R7 激活核验:fix PR 未合并 / merged head 与登记 fixHead 不符 → 拒激活', () => {
  const item = { fixPr: 483, fixHead: 'a'.repeat(40) };
  assert.equal(verifyActivation({ item, probe: () => ({ state: 'OPEN' }) }).ok, false);
  const mismatch = verifyActivation({ item, probe: () => ({ state: 'MERGED', headRefOid: 'b'.repeat(40) }) });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /不一致/);
  assert.equal(verifyActivation({ item, probe: () => ({ state: 'MERGED', headRefOid: 'A'.repeat(40) }) }).ok, true, '大小写归一后应匹配');
});

test('R7 inbox:可重放队列(未激活保留);deriveHazardId 稳定归一', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-inbox-'));
  assert.deepEqual(loadInbox(dir).items, []);
  saveInbox(dir, [{ hazardId: 'hz1-a' }]);
  assert.equal(loadInbox(dir).items.length, 1);
  writeFileSync(join(dir, 'escaped-hazards-inbox.json'), '{bad');
  assert.equal(loadInbox(dir).ok, false, 'inbox 损坏必须 fail-closed 上报,不当空队列');
  const a = deriveHazardId({ repo: 'o/r', originPr: 469, pattern: ' Async  谓词 ', paths: ['b/**', 'a/**'] });
  const b = deriveHazardId({ repo: 'o/r', originPr: 469, pattern: 'async谓词', paths: ['a/**', 'b/**'] });
  assert.equal(a, b, '归一化后同内容同 id(顺序/空白/大小写无关)');
});

test('R7 landed 目标存在性:CLI 拒绝指向不存在的 rule/profile/check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-cli-'));
  // CLI 现在要求 hazard 绑定 repo(防跨仓误用)——给它一个真 git 仓 + origin
  git(['init', '-q', '-b', 'main'], dir);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], dir);
  // 状态目录必须与 repo 分开:repo 内的目录过不了状态根校验(未被 .gitignore 忽略)
  const stateRoot = mkdtempSync(join(tmpdir(), 'hz-cli-state-'));
  const env = { ...process.env, REVIEW_PR_STATE_DIR: stateRoot, REVIEW_PR_REPO_ROOT: dir };
  const base = ['--register', '--origin-pr', '1', '--fix-pr', '2', '--fix-head', 'a'.repeat(40), '--pattern', 'p', '--paths', 'a/**'];
  const bad = spawnSync('node', [CLI, ...base, '--promotion', 'landed', '--promote-rule', 'no-such-rule'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /不存在/);
  const badCheck = spawnSync('node', [CLI, ...base, '--promotion', 'landed', '--promote-profile', 'test-infra', '--promote-check', 'nope'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(badCheck.status, 0);
  const recordedNoReason = spawnSync('node', [CLI, ...base, '--promotion', 'recorded-only'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(recordedNoReason.status, 0, 'recorded-only 必须带理由');
  const ok = spawnSync('node', [CLI, ...base, '--promotion', 'landed', '--promote-rule', 'playwright-waitforfunction-async-predicate'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // CLI 写的是 lib 的 STATE_DIR(= <root>/<repoStateKey>),不是 env 给的根
  const sub = readdirSync(stateRoot).find((d) => existsSync(join(stateRoot, d, 'escaped-hazards-inbox.json')));
  assert.ok(sub, `应在状态目录下产生 inbox,got ${readdirSync(stateRoot)}`);
  const box = loadInbox(join(stateRoot, sub));
  assert.equal(box.items.length, 1, '合法登记应入 inbox(pending-fix-merge)');
  assert.equal(box.items[0].activationStatus, 'pending-fix-merge');
});

test('R7 复审:CLI 无法解析仓库时拒绝登记(hazard 必须绑定 repo)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-norepo-'));
  const env = { ...process.env, REVIEW_PR_STATE_DIR: dir, REVIEW_PR_REPO_ROOT: dir };
  const r = spawnSync('node', [CLI, '--register', '--origin-pr', '1', '--fix-pr', '2', '--fix-head', 'a'.repeat(40), '--pattern', 'p', '--paths', 'a/**'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /绑定 repo/);
});

test('R7 复审:ack 严格晚于 push——push 失败/skipped 的条目留在 inbox 重放,不算激活', () => {
  const item = {
    hazardId: 'hz1-ack', repo: 'o/r', fingerprint: 'hzf1-ack', originPr: 1, fixPr: 2,
    fixHead: 'a'.repeat(40), originHead: 'b'.repeat(40), pattern: 'p', paths: ['a/**'],
    activationStatus: 'pending-fix-merge', promotionStatus: 'pending',
  };
  const probe = (pr) => (pr === 2
    ? { state: 'MERGED', headRefOid: 'a'.repeat(40) }
    : { state: 'MERGED', headRefOid: 'b'.repeat(40) });
  const upsert = (x) => ({ hazard: { ...x } });
  const readback = () => ({ incomplete: false, hazards: [{ hazardId: 'hz1-ack', activationStatus: 'active' }] });

  // push 失败 → 不 ack
  for (const bad of [{ ok: false, pushed: false, error: 'non-fast-forward' }, { ok: true, pushed: false, skipped: 'not-on-main' }, null]) {
    const r = activateInboxItems({ items: [item], probe, upsert, readback, sync: () => bad });
    assert.deepEqual(r.activated, [], `push 未成功(${JSON.stringify(bad)})时不得 ack`);
    assert.equal(r.kept.length, 1);
    assert.match(r.kept[0].lastActivationCheck, /push 未成功/);
  }
  // push 成功 → ack
  const ok = activateInboxItems({ items: [item], probe, upsert, readback, sync: () => ({ ok: true, pushed: true }) });
  assert.deepEqual(ok.activated, ['hz1-ack']);
  assert.deepEqual(ok.kept, []);
  // 回读校验失败 → 不 ack(即便 push 会成功)
  const badRead = activateInboxItems({ items: [item], probe, upsert, readback: () => ({ incomplete: true, hazards: [] }), sync: () => ({ ok: true, pushed: true }) });
  assert.deepEqual(badRead.activated, []);
  assert.match(badRead.kept[0].lastActivationCheck, /回读校验失败/);
  // 激活核验失败 → 连 upsert 都不该发生
  let upserted = 0;
  const notMerged = activateInboxItems({
    items: [item], probe: () => ({ state: 'OPEN' }),
    upsert: (x) => { upserted += 1; return { hazard: x }; }, readback, sync: () => ({ ok: true, pushed: true }),
  });
  assert.deepEqual(notMerged.activated, []);
  assert.equal(upserted, 0, '核验没过时不得动 canonical');
});
