// build-dist.test.mjs — dist 构建器与分发版验收(PR-D,SC-13′/14/15‴/16′/23/24/25)
// 本文件同时充当 freshness 无条件门:任何一次 `node --test` 都会核验仓内 dist/ 与当前源一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildDist, checkDist, assertTagAvailable, productTreeHash } from '../scripts/build-dist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const MANIFEST = join(SRC, 'scripts', 'dist.manifest.json');
const REPO_DIST = resolve(SRC, '..', 'dist');

test('[SC-15‴ 门] 仓内 dist/ 必须与当前源 fresh(无条件跑,过期即红)', () => {
  const res = checkDist({ sourceDir: SRC, manifestPath: MANIFEST, distDir: REPO_DIST });
  assert.equal(res.fresh, true, `dist 过期,先跑 node scripts/build-dist.mjs 重建:\n${res.problems.join('\n')}`);
});

test('[SC-14/16′] 幂等:两次构建 product_tree_hash 与逐字节一致', () => {
  const o1 = mkdtempSync(join(tmpdir(), 'dist-a-'));
  const o2 = mkdtempSync(join(tmpdir(), 'dist-b-'));
  try {
    const m1 = buildDist({ sourceDir: SRC, manifestPath: MANIFEST, outDir: o1 });
    const m2 = buildDist({ sourceDir: SRC, manifestPath: MANIFEST, outDir: o2 });
    assert.equal(m1.product_tree_hash, m2.product_tree_hash);
    assert.equal(productTreeHash(o1), productTreeHash(o2));
  } finally { rmSync(o1, { recursive: true, force: true }); rmSync(o2, { recursive: true, force: true }); }
});

test('[SC-13′] 剥离断言:台账/入口/个人名单零残留,stub 生效', async () => {
  for (const rel of ['EVOLUTION.md', 'evolution', 'scripts/evolution-note.mjs', 'tests', 'scripts/build-dist.mjs']) {
    assert.equal(existsSync(join(REPO_DIST, rel)), false, `dist 不应含 ${rel}`);
  }
  // 个人名单 token 全树为零(builder 的 forbidden-scan 已在构建时断言;这里独立复核防 builder 自身回归)
  for (const token of ['PraiseZhu', 'magiclizi']) {
    let hit = '';
    try { hit = execFileSync('grep', ['-rl', token, REPO_DIST], { encoding: 'utf8' }); } catch { /* 无命中 exit 1 */ }
    assert.equal(hit.trim(), '', `dist 中不应出现 ${token}`);
  }
  const neutral = JSON.parse(readFileSync(join(REPO_DIST, 'config/pr-rules.json'), 'utf8'));
  assert.deepEqual(neutral.productWhitelist, []);
  assert.deepEqual(neutral.archGate.whitelist, []);
  assert.deepEqual(neutral.archGate.coldUpdateApprovers, []);
  assert.equal(neutral.feishuNotify.archRecipientName, '');
});

test('[SC-24] dist 冒烟:全部 .mjs 语法可载,中性 config 可加载,stub 显式 skipped', async () => {
  const mjs = execFileSync('find', [REPO_DIST, '-name', '*.mjs'], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(mjs.length > 20, 'dist 应含完整脚本集');
  for (const f of mjs) execFileSync(process.execPath, ['--check', f]); // 语法门
  const lib = await import(join(REPO_DIST, 'scripts', 'lib.mjs'));
  const r = lib.skillRepoCommitPush({ message: 'should-not-write' });
  assert.deepEqual(r, { ok: true, committed: false, pushed: false, skipped: 'dist-readonly' });
  process.env.REVIEW_PR_RULES_FILE = join(REPO_DIST, 'config', 'pr-rules.json');
  try {
    const { rules } = lib.loadRulesWithSource();
    assert.ok(Array.isArray(rules.titleTypes) && rules.titleTypes.length > 0);
    assert.deepEqual(rules.productWhitelist, []);
  } finally { delete process.env.REVIEW_PR_RULES_FILE; }
});

// ---- 迷你沙盒:SC-15‴ 三态 + SC-25 提交后无自引用 ----
function mkMiniSource() {
  const root = mkdtempSync(join(tmpdir(), 'dist-mini-'));
  const src = join(root, 'skill');
  mkdirSync(join(src, 'scripts', 'dist'), { recursive: true });
  mkdirSync(join(src, 'config'), { recursive: true });
  writeFileSync(join(src, 'SKILL.md'), '# mini\n正文\n<!-- dist:strip:start x -->\n秘密章节\n<!-- dist:strip:end x -->\n尾部\n');
  writeFileSync(join(src, 'scripts', 'lib.mjs'), '// dist:stub:start f\nexport function f() { return "real"; }\n// dist:stub:end f\nexport const K = 1;\n');
  writeFileSync(join(src, 'config', 'pr-rules.json'), JSON.stringify({ productWhitelist: ['SomeOne'] }, null, 2));
  writeFileSync(join(src, 'scripts', 'dist', 'README.dist.md'), '# mini dist\n');
  const manifest = {
    exclude: ['scripts/dist/', 'scripts/dist.manifest.json'],
    markerStrips: [{ file: 'SKILL.md', name: 'x' }],
    stubs: [{ file: 'scripts/lib.mjs', name: 'f', replacement: ['export function f() { return "stub"; }'] }],
    replacements: [],
    neutralize: { file: 'config/pr-rules.json', emptyArrays: ['productWhitelist'], emptyStrings: [] },
    replaceFiles: [{ src: 'scripts/dist/README.dist.md', dest: 'README.md' }],
    forbidden: [{ token: '秘密章节', allow: [] }, { token: 'SomeOne', allow: [] }],
    absent: ['scripts/dist']
  };
  const manifestPath = join(src, 'scripts', 'dist.manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, src, manifestPath, dist: join(root, 'dist') };
}

test('[SC-15‴] 三态:fresh 绿 / 改源不重建红 / 改 manifest 不重建红 / 篡改 dist 红 / 重建复绿', () => {
  const { root, src, manifestPath, dist } = mkMiniSource();
  try {
    buildDist({ sourceDir: src, manifestPath, outDir: dist });
    assert.equal(checkDist({ sourceDir: src, manifestPath, distDir: dist }).fresh, true);
    // 改任一源输入不重建 → 红
    appendFileSync(join(src, 'SKILL.md'), '新增一行\n');
    let res = checkDist({ sourceDir: src, manifestPath, distDir: dist });
    assert.equal(res.fresh, false);
    assert.match(res.problems.join(';'), /source_input_tree_hash/);
    // 重建 → 绿
    buildDist({ sourceDir: src, manifestPath, outDir: dist });
    assert.equal(checkDist({ sourceDir: src, manifestPath, distDir: dist }).fresh, true);
    // 改 manifest 自身不重建 → 红(strip_config_hash)
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.forbidden.push({ token: '另一个词', allow: [] });
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    res = checkDist({ sourceDir: src, manifestPath, distDir: dist });
    assert.equal(res.fresh, false);
    // manifest 也是源树文件 → 两项都红,strip_config_hash 必在其中
    assert.match(res.problems.join(';'), /strip_config_hash/);
    buildDist({ sourceDir: src, manifestPath, outDir: dist });
    // 手改 dist 产物 → 红(product_tree_hash)
    appendFileSync(join(dist, 'SKILL.md'), '手改\n');
    res = checkDist({ sourceDir: src, manifestPath, distDir: dist });
    assert.equal(res.fresh, false);
    assert.match(res.problems.join(';'), /product_tree_hash/);
    // 审 D-F1 复现已死:手改 dist + 伪造 dist_manifest.product_tree_hash 为实际树 hash → 仍红
    // (记录值锚定的是重建产物,不是 dist 自身重算;实际树 vs 重建产物比对同时露馅)
    const forged = JSON.parse(readFileSync(join(dist, 'dist_manifest.json'), 'utf8'));
    forged.product_tree_hash = productTreeHash(dist);
    writeFileSync(join(dist, 'dist_manifest.json'), JSON.stringify(forged, null, 2) + '\n');
    res = checkDist({ sourceDir: src, manifestPath, distDir: dist });
    assert.equal(res.fresh, false, '伪造 manifest 补 hash 不得洗白手改的 dist');
    assert.match(res.problems.join(';'), /product_tree_hash/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[D-F2] dist 激活 ack:sync 返回 dist-readonly 时回读通过即 ack,不永久重放;主仓语义 kept 不变', async () => {
  const HEADS = { 9: 'b'.repeat(40), 8: 'c'.repeat(40) };
  const item = {
    repo: 'o/r', title: 't', paths: ['x.mjs'], evidence: 'e', severity: 'major', pattern: 'p',
    promotionStatus: 'recorded-only', promotionTarget: { reason: 'r' },
    sourceEvent: { kind: 'fix-pr-merged', fixPr: 9, findingId: 'f1' },
    fixPr: 9, fixHead: HEADS[9], originPr: 8, originHead: HEADS[8],
    recordedAt: '2026-08-06T00:00:00Z', activationStatus: 'pending-verification',
    // id/fingerprint 由身份字段复算得出(validateHazardShape 拒伪造 id)
    hazardId: 'hz2-5fe1bdf54d5dae61', fingerprint: 'hzf2-5fe1bdf54d5dae61'
  };
  const deps = () => ({
    items: [item],
    probe: (pr) => ({ state: 'MERGED', headRefOid: HEADS[pr] }),
    upsert: (h) => ({ hazard: h }),
    readback: () => ({ incomplete: false, hazards: [{ hazardId: item.hazardId, activationStatus: 'active' }] }),
    sync: () => ({ ok: true, committed: false, pushed: false, skipped: 'dist-readonly' }),
    currentRepo: 'o/r'
  });
  // dist 版:回读通过 + dist-readonly → ack(审 D-F2)
  const ehDist = await import(join(REPO_DIST, 'scripts', 'lib.escaped-hazards.mjs'));
  const rDist = ehDist.activateInboxItems(deps());
  assert.deepEqual(rDist.activated, [item.hazardId], `dist 必须 ack,实际 kept: ${rDist.kept[0]?.lastActivationCheck ?? ''}`);
  // 主仓版:同输入必须 kept 重放(dist-readonly 分支在主仓不可达,push 语义不放宽)
  const ehSrc = await import(new URL('../scripts/lib.escaped-hazards.mjs', import.meta.url));
  const rSrc = ehSrc.activateInboxItems(deps());
  assert.deepEqual(rSrc.activated, []);
  assert.match(rSrc.kept[0].lastActivationCheck, /push 未成功/);
});

test('[SC-25] 提交 dist(含 dist_manifest) 后重跑 check 仍绿(无 HEAD 自引用/不追尾)', () => {
  const { root, src, manifestPath, dist } = mkMiniSource();
  try {
    buildDist({ sourceDir: src, manifestPath, outDir: dist });
    // 显式禁签名:继承全局 commit.gpgsign 时,temp-git 用例会撞 gpg(R0 可移植性)
    const g = (...a) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'fx@test'); g('config', 'user.name', 'fx');
    g('add', '-A'); g('commit', '-qm', 'build dist');
    // 提交后(HEAD 变了)check 仍绿——manifest 记的是 source input tree hash 而非 commit SHA
    assert.equal(checkDist({ sourceDir: src, manifestPath, distDir: dist }).fresh, true);
    // 再 commit 一次无关文件,依旧绿
    writeFileSync(join(root, 'unrelated.txt'), 'x\n');
    g('add', '-A'); g('commit', '-qm', 'unrelated');
    assert.equal(checkDist({ sourceDir: src, manifestPath, distDir: dist }).fresh, true);
    // 源文件变化(提交与否无关)→ 红
    appendFileSync(join(src, 'SKILL.md'), 'drift\n');
    g('add', '-A'); g('commit', '-qm', 'drift');
    assert.equal(checkDist({ sourceDir: src, manifestPath, distDir: dist }).fresh, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[SC-23] tag 不可覆盖:已存在(本地或远端)一律拒绝', () => {
  const d = mkdtempSync(join(tmpdir(), 'tag-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', d, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'fx@test'); g('config', 'user.name', 'fx');
    writeFileSync(join(d, 'a.txt'), '1\n'); g('add', '.'); g('commit', '-qm', 'c');
    g('remote', 'add', 'origin', d); // origin 指向自身,ls-remote 可用
    g('tag', 'review-pr-dist-v2026.01.01.1');
    assert.throws(() => assertTagAvailable(d, 'review-pr-dist-v2026.01.01.1'), /本地已存在/);
    assert.doesNotThrow(() => assertTagAvailable(d, 'review-pr-dist-v2026.01.01.2'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
