// SC-R7 行为测试:双状态机、激活核验(fixHead/originHead 精确匹配 + 同仓)、幂等 upsert
// 不降级、损坏 fail-closed、paths 求交、landed 目标存在性、稳定事件身份、以及**端到端注入**
// ——种子 hazard 必须真出现在 build-review-task 的产物文本里(删接线点即红)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveHazardId, deriveHazardFingerprint, loadKnownHazards, hazardsForPaths, upsertHazard,
  verifyActivation, loadInbox, saveInbox, validateHazardShape, activateInboxItems,
  mergeHazardPair, GRANDFATHERED_IDS,
} from '../scripts/lib.escaped-hazards.mjs';
import { BUILTIN_RULES } from '../scripts/lib.preflight-rules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, '..', 'scripts', 'build-review-task.mjs');
const CLI = join(__dirname, '..', 'scripts', 'record-escaped-finding.mjs');
const REAL_RULE = 'playwright-waitforfunction-async-predicate';
const RULE_VERSION = BUILTIN_RULES.find((r) => r.ruleId === REAL_RULE).ruleVersion;

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    // 显式禁签名:继承全局 commit.gpgsign 时,并发跑 temp-git 用例会撞 gpg
    // 「Cannot allocate memory」而随机红(核验席实测 409/414)。测试仓不需要签名。
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** 完整合法 hazard 夹具。第 3 轮核验后 id/fingerprint 必须与身份字段**复算等值**,
 *  所以夹具不能再手写 id —— 由 derive 函数产出(想造"伪造 id"的反例就显式覆盖)。 */
const FULL = (over = {}) => {
  const base = {
    repo: 'o/r', originPr: 1, fixPr: 2,
    fixHead: 'a'.repeat(40), originHead: 'b'.repeat(40),
    pattern: 'p', evidence: '判定依据', paths: ['a/**'],
    activationStatus: 'active', promotionStatus: 'pending', ...over,
  };
  return { ...base, hazardId: deriveHazardId(base), fingerprint: deriveHazardFingerprint(base), ...over };
};

test('R7 种子:#469→#483 假等待 hazard 已在 canonical ledger,两侧 head 都可核验(grandfather 豁免已取消)', () => {
  const loaded = loadKnownHazards();
  assert.equal(loaded.incomplete, false, loaded.reason);
  const seed = loaded.hazards.find((h) => h.originPr === 469 && h.fixPr === 483);
  assert.ok(seed, '种子条目必须存在');
  assert.equal(seed.activationStatus, 'active');
  assert.equal(seed.promotionStatus, 'landed');
  assert.equal(seed.promotionTarget.kind, 'rule');
  assert.equal(seed.promotionTarget.ruleId, REAL_RULE);
  assert.equal(seed.repo, 'xindong/mivo-canvas', 'hazard 必须绑定 repo(防跨仓误用)');
  assert.match(seed.fixHead, /^[0-9a-f]{40}$/, '#483 已合并,fixHead 必须是真 SHA(不再 grandfather)');
  assert.match(seed.originHead, /^[0-9a-f]{40}$/);
  assert.equal(seed.grandfathered, undefined, 'grandfather 豁免整体取消');
  assert.equal(GRANDFATHERED_IDS.size, 0, '白名单必须为空——不存在免 head 核验的通道');
  // id/fingerprint 必须由稳定事件身份派生(换措辞不生成新条目)
  assert.equal(seed.hazardId, deriveHazardId(seed));
  assert.equal(seed.fingerprint, deriveHazardFingerprint(seed));
});

test('R7 稳定事件身份:pattern/paths 换措辞不改 hazardId(幂等);任一 head/PR/仓变化才是新事件', () => {
  const a = FULL();
  assert.equal(deriveHazardId(a), deriveHazardId({ ...a, pattern: '完全不同的描述', paths: ['z/**'] }),
    '自由文本只作 evidence,不参与身份(此前换措辞就生成新 ID,幂等被破坏)');
  for (const over of [{ repo: 'x/y' }, { originPr: 9 }, { fixPr: 9 }, { originHead: 'c'.repeat(40) }, { fixHead: 'd'.repeat(40) }]) {
    assert.notEqual(deriveHazardId(a), deriveHazardId({ ...a, ...over }), `${JSON.stringify(over)} 变化必须是新事件`);
  }
});

test('R7 schema fail-closed:缺任一必填字段判不完整;grandfathered 只对白名单生效;landed 目标须真实存在', () => {
  assert.equal(validateHazardShape(FULL()).ok, true, JSON.stringify(validateHazardShape(FULL()).errors));
  for (const k of ['repo', 'fingerprint', 'paths', 'fixHead', 'originHead', 'pattern', 'evidence', 'originPr', 'fixPr']) {
    const bad = FULL(); delete bad[k];
    assert.equal(validateHazardShape(bad).ok, false, `缺 ${k} 应判不完整`);
  }
  // head 必须是完整 40 位 SHA(短 SHA / 占位串不算)
  assert.equal(validateHazardShape(FULL({ fixHead: 'abc1234' })).ok, false);
  assert.equal(validateHazardShape(FULL({ originHead: 'not-a-sha' })).ok, false);
  // grandfathered:白名单为空 → 任何条目自称 grandfathered 都被拒(此前是免 fixHead 的万能钥匙)
  const gf = FULL({ grandfathered: true }); delete gf.fixHead;
  const gfRes = validateHazardShape(gf);
  assert.equal(gfRes.ok, false, '白名单外的 grandfathered:true 必须被拒');
  assert.match(gfRes.errors.join(';'), /白名单/);
  // landed 目标存在性:注册表里没有的 ruleId/profileId/checkId 一律拒
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed' })).ok, false, 'landed 缺 target');
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: 'no-such-rule' } })).ok, false, '不存在的 ruleId 不得算 landed');
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: REAL_RULE, ruleVersion: RULE_VERSION } })).ok, true);
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: REAL_RULE } })).ok, false, 'rule 目标必须记 ruleVersion');
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: REAL_RULE, ruleVersion: 'nope' } })).ok, false, 'ruleVersion 形态非法不得算 landed');
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: REAL_RULE, ruleVersion: 'v1' } })).ok, true, '历史版本合法(不要求等于注册表当前版本,否则每次 bump 都作废 canonical)');
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'profile', profileId: 'test-infra', checkId: 'nope' } })).ok, false, '不存在的 checkId 不得算 landed');
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'profile', profileId: 'test-infra', checkId: 'could-be-always-green' } })).ok, true);
  assert.equal(validateHazardShape(FULL({ promotionStatus: 'recorded-only' })).ok, false, 'recorded-only 必须带理由');
});

test('R7 复审:loadKnownHazards 对 schema 不完整的条目判 incomplete(不是只验 id+双状态)', () => {
  const tmp = join(mkdtempSync(join(tmpdir(), 'hz-schema-')), 'ledger.json');
  upsertHazard(tmp, FULL({ fixPr: 21 }));
  assert.equal(loadKnownHazards(tmp).incomplete, false);
  for (const k of ['repo', 'fingerprint', 'paths', 'fixHead', 'originHead', 'pattern', 'evidence']) {
    const bad = FULL({ fixPr: 21 }); delete bad[k];
    writeFileSync(tmp, JSON.stringify({ escapedHazards: [bad] }, null, 2));
    const loaded = loadKnownHazards(tmp);
    assert.equal(loaded.incomplete, true, `缺 ${k} 时 loadKnownHazards 必须判 incomplete`);
    assert.deepEqual(loaded.hazards, []);
  }
});

test('R7 复审:激活核验——origin PR 未合并即拒(即使 originHead 恰好对上)', () => {
  const item = FULL({ originPr: 469, fixPr: 483, fixHead: 'a'.repeat(40), originHead: 'c'.repeat(40) });
  const probe = (pr) => (pr === 483
    ? { state: 'MERGED', headRefOid: 'a'.repeat(40) }
    : { state: 'OPEN', headRefOid: 'c'.repeat(40) });
  const r = verifyActivation({ item, probe });
  assert.equal(r.ok, false, 'origin PR 还开着时逃逸前提不成立,不得激活');
  assert.match(r.reason, /origin PR/);
});

test('R7 repo 绑定:别的仓不吃本仓 hazard;repo 解析不出时**返空**(不得退化成不过滤)', () => {
  const tmp = join(mkdtempSync(join(tmpdir(), 'hz-repo-')), 'ledger.json');
  upsertHazard(tmp, FULL({ fixPr: 22 }));
  const loaded = loadKnownHazards(tmp);
  assert.equal(hazardsForPaths(loaded, ['a/x.ts'], 'o/r').length, 1);
  assert.equal(hazardsForPaths(loaded, ['a/x.ts'], 'other/repo').length, 0, '别的仓不得吃到');
  assert.equal(hazardsForPaths(loaded, ['a/x.ts'], null).length, 0, 'repo=null 必须 fail-closed 返空');
  assert.equal(hazardsForPaths(loaded, ['a/x.ts'], null, { allowNoRepo: true }).length, 1, '只读展示可显式放开');
});

test('R7 复审:激活核验也核 origin PR + 同仓 + originHead 完整性', () => {
  const item = FULL({ originPr: 469, fixPr: 483, fixHead: 'a'.repeat(40), originHead: 'c'.repeat(40) });
  const merged = { state: 'MERGED', headRefOid: 'a'.repeat(40) };
  assert.equal(verifyActivation({ item, probe: (pr) => (pr === 483 ? merged : { state: 'OPEN' }) }).ok, false);
  const mism = verifyActivation({ item, probe: (pr) => (pr === 483 ? merged : { state: 'MERGED', headRefOid: 'd'.repeat(40) }) });
  assert.equal(mism.ok, false);
  const good = (pr) => (pr === 483 ? merged : { state: 'MERGED', headRefOid: 'c'.repeat(40) });
  assert.equal(verifyActivation({ item, probe: good }).ok, true);
  // 跨仓激活必须拒
  const cross = verifyActivation({ item, probe: good, currentRepo: 'other/repo' });
  assert.equal(cross.ok, false);
  assert.match(cross.reason, /不得跨仓激活/);
  assert.equal(verifyActivation({ item, probe: good, currentRepo: 'o/r' }).ok, true);
  // originHead 缺失/非法 → 拒(此前 non-null 才比对,null 直接旁路整道门)
  const noHead = verifyActivation({ item: { ...item, originHead: null }, probe: good });
  assert.equal(noHead.ok, false);
  assert.match(noHead.reason, /originHead/);
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
  const bodyFile = join(work, 'body.md');
  writeFileSync(bodyFile, '普通改动。\n');
  const taskFile = join(work, 'task.json');
  const promptFile = join(work, 'prompt.md');
  const r = spawnSync('node', [BUILD, '469', '--base', base, '--head', head, '--out-task', taskFile, '--out-prompt', promptFile, '--pr-body-file', bodyFile], {
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
  const r2 = spawnSync('node', [BUILD, '470', '--base', b2, '--head', h2, '--out-task', t2, '--out-prompt', p2, '--pr-body-file', bodyFile], {
    cwd: repo2, encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repo2, REVIEW_PR_STATE_DIR: join(work, 'state2'), REVIEW_PR_RULES_FILE: rulesFile },
  });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepEqual(JSON.parse(readFileSync(t2, 'utf8')).knownHazards, [], '只改 docs 不应注入 e2e hazard');
});

test('R7 hazardsForPaths:仅 active 进 prompt;pending-fix-merge 不进;损坏 → incomplete 且不伪装成空', () => {
  const tmpLedger = join(mkdtempSync(join(tmpdir(), 'hz-')), 'ledger.json');
  upsertHazard(tmpLedger, FULL({ fixPr: 23 }));
  assert.equal(hazardsForPaths(loadKnownHazards(tmpLedger), ['a/b.ts'], 'o/r').length, 1);
  assert.equal(hazardsForPaths(loadKnownHazards(tmpLedger), ['c/b.ts'], 'o/r').length, 0);
  upsertHazard(tmpLedger, FULL({ fixPr: 24, activationStatus: 'pending-fix-merge' }));
  assert.equal(hazardsForPaths(loadKnownHazards(tmpLedger), ['a/b.ts'], 'o/r').length, 1, 'pending 的不进 prompt');
  writeFileSync(tmpLedger, '{broken');
  const bad = loadKnownHazards(tmpLedger);
  assert.equal(bad.incomplete, true);
  assert.deepEqual(bad.hazards, [], '损坏时 hazards 为空但必须 incomplete=true(不得伪装成"没有 hazard")');
});

test('R7 幂等 upsert:重复登记不增条、不降级(active→pending / landed→pending 都不回退)', () => {
  const tmpLedger = join(mkdtempSync(join(tmpdir(), 'hz-')), 'ledger.json');
  const h = FULL({ fixPr: 25, promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: REAL_RULE, ruleVersion: RULE_VERSION } });
  upsertHazard(tmpLedger, h);
  const again = upsertHazard(tmpLedger, { ...h, activationStatus: 'pending-fix-merge', promotionStatus: 'pending', promotionTarget: null });
  assert.equal(again.hazard.activationStatus, 'active');
  assert.equal(again.hazard.promotionStatus, 'landed');
  assert.deepEqual(again.hazard.promotionTarget, { kind: 'rule', ruleId: REAL_RULE, ruleVersion: RULE_VERSION }, '状态升级时其附属 target 必须同源保留');
  assert.equal(loadKnownHazards(tmpLedger).hazards.length, 1, '不增条');
});

test('R7 第 2 轮核验:mergeHazardPair 方向无关——显式 promotionTarget:null 不得把 landed 的 target 冲掉', () => {
  // 两侧刻意在**非状态**字段上也不一致(evidence/registeredAt)——否则 `{...a,...b}` 这种
  // 方向相关的实现在"其余字段完全相同"的夹具下测不出来(实测:变异不咬合)。
  const landed = FULL({ promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: REAL_RULE, ruleVersion: RULE_VERSION }, activationStatus: 'active', activatedAt: '2026-08-05T00:00:00.000Z', evidence: 'A 侧依据', registeredAt: '2026-08-01T00:00:00.000Z' });
  const pending = FULL({ promotionStatus: 'pending', promotionTarget: null, activationStatus: 'pending-fix-merge', evidence: 'B 侧依据', registeredAt: '2026-08-02T00:00:00.000Z' });
  const ab = mergeHazardPair(landed, pending);
  const ba = mergeHazardPair(pending, landed);
  assert.deepEqual(ab, ba, '两个方向必须得到完全相同的结果(实测:旧实现一方 null 一方 target)');
  assert.equal(ab.promotionStatus, 'landed');
  assert.deepEqual(ab.promotionTarget, { kind: 'rule', ruleId: REAL_RULE, ruleVersion: RULE_VERSION });
  assert.equal(ab.activationStatus, 'active');
  assert.equal(ab.activatedAt, '2026-08-05T00:00:00.000Z', 'activation 的附属时间戳同样取自赢家');
  assert.equal(validateHazardShape(ab).ok, true, '合并结果必须仍是合法 hazard');

  // 状态与附属元数据必须**同源**:两侧的 promotionTarget 都非空但语义不同(landed 的规则目标
  // vs recorded-only 的理由)时,只按字段各自挑会挑出"landed 却带 recorded-only 理由"的畸形。
  const recordedOnly = FULL({ promotionStatus: 'recorded-only', promotionTarget: { kind: 'recorded-only', reason: '只记录不晋升' } });
  const mixed = mergeHazardPair(landed, recordedOnly);
  assert.deepEqual(mixed, mergeHazardPair(recordedOnly, landed));
  assert.equal(mixed.promotionStatus, 'landed');
  assert.deepEqual(mixed.promotionTarget, { kind: 'rule', ruleId: REAL_RULE, ruleVersion: RULE_VERSION }, 'landed 的 target 必须取自 landed 那一侧');
  assert.equal(validateHazardShape(mixed).ok, true, 'landed + recorded-only 理由 是畸形,必须被同源覆盖挡住');

  // activatedAt 同理:活的那一侧没有时间戳时,不得从**pending 侧**捡一个来充数
  const staleStamp = FULL({ activationStatus: 'pending-fix-merge', activatedAt: '2026-07-01T00:00:00.000Z' });
  const activeNoStamp = FULL({ activationStatus: 'active' });
  const m2 = mergeHazardPair(staleStamp, activeNoStamp);
  assert.deepEqual(m2, mergeHazardPair(activeNoStamp, staleStamp));
  assert.equal(m2.activationStatus, 'active');
  assert.equal(m2.activatedAt, null, 'active 侧没有 activatedAt 时必须是 null,不能拿 pending 侧的时间戳');
});

test('R7 激活核验:fix PR 未合并 / merged head 与登记 fixHead 不符 → 拒激活', () => {
  const item = FULL({ fixPr: 483, fixHead: 'a'.repeat(40), originHead: 'b'.repeat(40) });
  const originOk = { state: 'MERGED', headRefOid: 'b'.repeat(40) };
  assert.equal(verifyActivation({ item, probe: (pr) => (pr === 483 ? { state: 'OPEN' } : originOk) }).ok, false);
  const mismatch = verifyActivation({ item, probe: (pr) => (pr === 483 ? { state: 'MERGED', headRefOid: 'c'.repeat(40) } : originOk) });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /不一致/);
  assert.equal(verifyActivation({ item, probe: (pr) => (pr === 483 ? { state: 'MERGED', headRefOid: 'A'.repeat(40) } : originOk) }).ok, true, '大小写归一后应匹配');
});

test('R7 inbox:可重放队列(未激活保留);损坏 fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-inbox-'));
  assert.deepEqual(loadInbox(dir).items, []);
  saveInbox(dir, [{ hazardId: 'hz2-a' }]);
  assert.equal(loadInbox(dir).items.length, 1);
  writeFileSync(join(dir, 'escaped-hazards-inbox.json'), '{bad');
  assert.equal(loadInbox(dir).ok, false, 'inbox 损坏必须 fail-closed 上报,不当空队列');
});

test('R7 landed 目标存在性:CLI 拒绝指向不存在的 rule/profile/check;缺 --origin-head 也拒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-cli-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], dir);
  const stateRoot = mkdtempSync(join(tmpdir(), 'hz-cli-state-'));
  const env = { ...process.env, REVIEW_PR_STATE_DIR: stateRoot, REVIEW_PR_REPO_ROOT: dir };
  const base = ['--register', '--origin-pr', '1', '--fix-pr', '2', '--fix-head', 'a'.repeat(40), '--origin-head', 'b'.repeat(40), '--pattern', 'p', '--evidence', '依据', '--paths', 'a/**'];
  const noOrigin = spawnSync('node', [CLI, '--register', '--origin-pr', '1', '--fix-pr', '2', '--fix-head', 'a'.repeat(40), '--pattern', 'p', '--paths', 'a/**'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(noOrigin.status, 0);
  assert.match(noOrigin.stdout + noOrigin.stderr, /origin-head/);
  const bad = spawnSync('node', [CLI, ...base, '--promotion', 'landed', '--promote-rule', 'no-such-rule'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /不存在/);
  const badCheck = spawnSync('node', [CLI, ...base, '--promotion', 'landed', '--promote-profile', 'test-infra', '--promote-check', 'nope'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(badCheck.status, 0);
  const recordedNoReason = spawnSync('node', [CLI, ...base, '--promotion', 'recorded-only'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(recordedNoReason.status, 0, 'recorded-only 必须带理由');
  const ok = spawnSync('node', [CLI, ...base, '--promotion', 'landed', '--promote-rule', REAL_RULE], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const sub = readdirSync(stateRoot).find((d) => existsSync(join(stateRoot, d, 'escaped-hazards-inbox.json')));
  assert.ok(sub, `应在状态目录下产生 inbox,got ${readdirSync(stateRoot)}`);
  const box = loadInbox(join(stateRoot, sub));
  assert.equal(box.items.length, 1, '合法登记应入 inbox(pending-fix-merge)');
  assert.equal(box.items[0].activationStatus, 'pending-fix-merge');
  assert.match(box.items[0].originHead, /^[0-9a-f]{40}$/);
});

test('R7 复审:CLI 无法解析仓库时拒绝登记(hazard 必须绑定 repo)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-norepo-'));
  const env = { ...process.env, REVIEW_PR_STATE_DIR: dir, REVIEW_PR_REPO_ROOT: dir };
  const r = spawnSync('node', [CLI, '--register', '--origin-pr', '1', '--fix-pr', '2', '--fix-head', 'a'.repeat(40), '--origin-head', 'b'.repeat(40), '--pattern', 'p', '--paths', 'a/**'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /绑定 repo/);
});

test('R7 复审:ack 严格晚于 push——push 失败/skipped 的条目留在 inbox 重放,不算激活', () => {
  const item = FULL({ activationStatus: 'pending-fix-merge' });
  const probe = (pr) => (pr === 2
    ? { state: 'MERGED', headRefOid: 'a'.repeat(40) }
    : { state: 'MERGED', headRefOid: 'b'.repeat(40) });
  const upsert = (x) => ({ hazard: { ...x } });
  const readback = () => ({ incomplete: false, hazards: [{ hazardId: item.hazardId, activationStatus: 'active' }] });

  for (const bad of [{ ok: false, pushed: false, error: 'non-fast-forward' }, { ok: true, pushed: false, skipped: 'not-on-main' }, null]) {
    const r = activateInboxItems({ items: [item], probe, upsert, readback, sync: () => bad });
    assert.deepEqual(r.activated, [], `push 未成功(${JSON.stringify(bad)})时不得 ack`);
    assert.equal(r.kept.length, 1);
    assert.match(r.kept[0].lastActivationCheck, /push 未成功/);
  }
  const ok = activateInboxItems({ items: [item], probe, upsert, readback, sync: () => ({ ok: true, pushed: true }) });
  assert.deepEqual(ok.activated, [item.hazardId]);
  assert.deepEqual(ok.kept, []);
  const badRead = activateInboxItems({ items: [item], probe, upsert, readback: () => ({ incomplete: true, hazards: [] }), sync: () => ({ ok: true, pushed: true }) });
  assert.deepEqual(badRead.activated, []);
  assert.match(badRead.kept[0].lastActivationCheck, /回读校验失败/);
  let upserted = 0;
  const notMerged = activateInboxItems({
    items: [item], probe: () => ({ state: 'OPEN' }),
    upsert: (x) => { upserted += 1; return { hazard: x }; }, readback, sync: () => ({ ok: true, pushed: true }),
  });
  assert.deepEqual(notMerged.activated, []);
  assert.equal(upserted, 0, '核验没过时不得动 canonical');
});

test('R7 第 2 轮核验:push 成功后崩在 ack 前——重放拿到 nothing-to-push,须凭**远端核验**安全 ack', () => {
  const item = FULL({ activationStatus: 'pending-fix-merge', pattern: 'crash-case' });
  const probe = (pr) => (pr === 2
    ? { state: 'MERGED', headRefOid: 'a'.repeat(40) }
    : { state: 'MERGED', headRefOid: 'b'.repeat(40) });
  const upsert = (x) => ({ hazard: { ...x } });
  const readback = () => ({ incomplete: false, hazards: [{ hazardId: item.hazardId, activationStatus: 'active' }] });
  const nothing = () => ({ ok: true, pushed: false, reason: 'nothing-to-push' });
  // 远端确认已含该 active hazard → 安全 ack(旧逻辑在这里永远保留 inbox)
  const acked = activateInboxItems({ items: [item], probe, upsert, readback, sync: nothing, remoteVerify: () => ({ ok: true, present: true }) });
  assert.deepEqual(acked.activated, [item.hazardId]);
  // 远端没有 / 读不到 → 仍保留重放(不得据 nothing-to-push 就当推过了)
  for (const rv of [{ ok: true, present: false }, { ok: false, error: '远端读不到' }, null]) {
    const kept = activateInboxItems({ items: [item], probe, upsert, readback, sync: nothing, remoteVerify: () => rv });
    assert.deepEqual(kept.activated, [], `远端核验未确认(${JSON.stringify(rv)})时不得 ack`);
    assert.match(kept.kept[0].lastActivationCheck, /远端核验未确认/);
  }
  // 未注入 remoteVerify → 保守保留
  const noVerifier = activateInboxItems({ items: [item], probe, upsert, readback, sync: nothing });
  assert.deepEqual(noVerifier.activated, []);
});

test('R7 第 3 轮核验:id/fingerprint 必须与身份字段复算等值(伪造串不再能过 schema)', () => {
  const good = FULL();
  assert.equal(validateHazardShape(good).ok, true);
  const forgedId = validateHazardShape({ ...good, hazardId: 'hz2-forged' });
  assert.equal(forgedId.ok, false, '伪造 hazardId 必须被拒');
  assert.match(forgedId.errors.join(';'), /复算不符/);
  assert.equal(validateHazardShape({ ...good, fingerprint: 'hzf2-forged' }).ok, false, '伪造 fingerprint 必须被拒');
  // 身份字段被改但 id 没跟着改 → 同样是不一致
  assert.equal(validateHazardShape({ ...good, fixPr: 999 }).ok, false, '改身份字段而不重算 id → 拒');
});

test('R7 第 3 轮核验:坏输入零 canonical 变更(existing 非数组 / incoming 不合法 / 身份冲突)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-nomut-'));
  const file = join(dir, 'ledger.json');
  // ① existing 段非数组:拒绝覆写(此前当 [] 直接盖掉)
  writeFileSync(file, JSON.stringify({ escapedHazards: { oops: 1 } }));
  const before = readFileSync(file, 'utf8');
  assert.throws(() => upsertHazard(file, FULL()), /形状非法/);
  assert.equal(readFileSync(file, 'utf8'), before, 'canonical 必须一个字节都没变');
  // ② incoming 不合法(缺 evidence):零变更
  writeFileSync(file, JSON.stringify({ escapedHazards: [] }));
  const empty = readFileSync(file, 'utf8');
  const bad = FULL(); delete bad.evidence;
  assert.throws(() => upsertHazard(file, bad), /不合法/);
  assert.equal(readFileSync(file, 'utf8'), empty, 'canonical 必须一个字节都没变');
  // ③ 同 id 但身份字段不一致:拒绝合并
  upsertHazard(file, FULL());
  const withOne = readFileSync(file, 'utf8');
  assert.throws(() => upsertHazard(file, { ...FULL(), originPr: 77 }), /身份字段不一致|复算不符/);
  assert.equal(readFileSync(file, 'utf8'), withOne);
});

test('R7 第 3 轮核验:mergeHazardPair 的 paths 取并集(取一侧会缩小未来匹配面)', () => {
  const a = FULL({ paths: ['a/**', 'c/**'] });
  const b = FULL({ paths: ['b/**', 'a/**'] });
  const m = mergeHazardPair(a, b);
  assert.deepEqual(m.paths, ['a/**', 'b/**', 'c/**']);
  assert.deepEqual(m, mergeHazardPair(b, a), '并集天然对称');
});

test('R7 第 3 轮核验:激活前先验 inbox 条目形状 → 零 upsert 调用(此前先写成 active 坏条目再失败)', () => {
  const bad = FULL({ activationStatus: 'pending-fix-merge' });
  delete bad.evidence;
  let upserted = 0;
  const r = activateInboxItems({
    items: [bad],
    probe: () => ({ state: 'MERGED', headRefOid: 'a'.repeat(40) }),
    upsert: (x) => { upserted += 1; return { hazard: x }; },
    readback: () => ({ incomplete: false, hazards: [] }),
    sync: () => ({ ok: true, pushed: true }),
  });
  assert.deepEqual(r.activated, []);
  assert.equal(upserted, 0, '坏条目不得触达 canonical');
  assert.match(r.kept[0].lastActivationCheck, /不合法/);
});

test('R7 第 3 轮核验:nothing-to-push 的远端核验必须**内容等价**(同 id+active 但内容旧 → 不 ack)', () => {
  const item = FULL({ activationStatus: 'pending-fix-merge', paths: ['a/**', 'new/**'] });
  const probe = (pr) => (pr === 2
    ? { state: 'MERGED', headRefOid: 'a'.repeat(40) }
    : { state: 'MERGED', headRefOid: 'b'.repeat(40) });
  const upsert = (x) => ({ hazard: { ...x } });
  const readback = () => ({ incomplete: false, hazards: [{ hazardId: item.hazardId, activationStatus: 'active' }] });
  const nothing = () => ({ ok: true, pushed: false, reason: 'nothing-to-push' });
  // 远端那条只是"同 id + active",paths 还是旧的 → present 判 false → 保留重放
  const stale = activateInboxItems({
    items: [item], probe, upsert, readback, sync: nothing,
    remoteVerify: (hazard) => ({ ok: true, present: JSON.stringify({ ...hazard, paths: ['a/**'] }) === JSON.stringify(hazard) }),
  });
  assert.deepEqual(stale.activated, [], '内容不等价时不得 ack');
  // 完全等价 → ack
  const same = activateInboxItems({
    items: [item], probe, upsert, readback, sync: nothing,
    remoteVerify: (hazard) => ({ ok: true, present: JSON.stringify(hazard) === JSON.stringify(hazard) }),
  });
  assert.deepEqual(same.activated, [item.hazardId]);
});
