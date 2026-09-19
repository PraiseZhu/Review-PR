// server-dist.test.mjs — 审查机独立席产物验收
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildDist, checkDist, productTreeHash } from '../scripts/build-dist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const MANIFEST = join(SRC, 'scripts', 'server-dist.manifest.json');
const REPO_DIST = resolve(SRC, '..', 'server-dist');

const STRIPPED = [
  'dispatch-review.mjs',
  'evolution-note.mjs',
  'sync-skill-repo.mjs',
  'merge-pr.mjs',
  'self-approve.mjs',
  'notify-summary.mjs',
  'notify-merge-ack.mjs',
  'fix-session-state.mjs',
];
const KEPT = [
  'review-server.mjs',
  'lib.server-review.mjs',
  'context.mjs',
  'review-preflight.mjs',
  'build-review-task.mjs',
  'deliver-review-segment.mjs',
  'consume-review-output.mjs',
];
const DIMS = [
  '安全与隐私',
  '格式',
  '规则对照',
  '影响面',
  '验证真实性',
  '描述真实性',
  '**UI**',
  'P0/P1/P2',
  'family',
  '本席交卷',
];

test('[server 门] 仓内 server-dist/ 必须与当前源 fresh', () => {
  const res = checkDist({ sourceDir: SRC, manifestPath: MANIFEST, distDir: REPO_DIST });
  assert.equal(res.fresh, true, `server-dist 过期,先跑:\nnode scripts/build-dist.mjs --manifest scripts/server-dist.manifest.json --out ../server-dist\n${res.problems.join('\n')}`);
});

test('[SC-1] 幂等:两次构建 product_tree_hash 一致', () => {
  const o1 = mkdtempSync(join(tmpdir(), 'server-a-'));
  const o2 = mkdtempSync(join(tmpdir(), 'server-b-'));
  try {
    const m1 = buildDist({ sourceDir: SRC, manifestPath: MANIFEST, outDir: o1 });
    const m2 = buildDist({ sourceDir: SRC, manifestPath: MANIFEST, outDir: o2 });
    assert.equal(m1.product_tree_hash, m2.product_tree_hash);
    assert.equal(productTreeHash(o1), productTreeHash(o2));
  } finally {
    rmSync(o1, { recursive: true, force: true });
    rmSync(o2, { recursive: true, force: true });
  }
});

test('[SC-4] 剥离脚本与台账 absent', () => {
  for (const f of STRIPPED) {
    assert.equal(existsSync(join(REPO_DIST, 'scripts', f)), false, `不应含 scripts/${f}`);
  }
  for (const rel of ['EVOLUTION.md', 'evolution', 'tests', 'scripts/build-dist.mjs', 'scripts/dist']) {
    assert.equal(existsSync(join(REPO_DIST, rel)), false, `不应含 ${rel}`);
  }
});

test('[SC-2] 宿主脚本保留且入口禁止再派席', () => {
  for (const f of KEPT) {
    const p = join(REPO_DIST, 'scripts', f);
    assert.equal(existsSync(p), true, `应保留 ${f}`);
    execFileSync(process.execPath, ['--check', p]);
  }
  const skill = readFileSync(join(REPO_DIST, 'SKILL.md'), 'utf8');
  assert.match(skill, /name: review-pr-server/);
  assert.match(skill, /你就是独立审查席/);
  assert.match(skill, /禁止.*Agent/);
  assert.match(skill, /禁止 invoke 完整 review-pr Skill/);
  assert.equal(skill.includes('dispatch-review'), false);
  assert.doesNotMatch(skill, /只允许 `general-purpose` \+ 隔离 worktree/);
  const lines = skill.split('\n').length;
  assert.ok(lines <= 150, `入口 ${lines} 行,超过 150`);
});

test('[SC-3] 十维仍在,第 10 维是本席交卷', () => {
  const skill = readFileSync(join(REPO_DIST, 'SKILL.md'), 'utf8');
  for (const dim of DIMS) {
    assert.match(skill, new RegExp(dim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `缺维度 ${dim}`);
  }
  assert.match(skill, /schemaVersion: "rro-1"/);
  assert.match(skill, /consume-review-output\.mjs/);
  assert.match(skill, /禁止再派 `general-purpose`/);
});

test('[SC-4] README 写明不自动接到 seat1', () => {
  const readme = readFileSync(join(REPO_DIST, 'README.md'), 'utf8');
  assert.match(readme, /不自动接到插件仓 seat1/);
  assert.match(readme, /审查机独立席/);
});

test('[D] server manifest exclude 每条目在源树中必须存在', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const missing = (m.exclude ?? []).filter((e) => !existsSync(join(SRC, e)));
  assert.equal(missing.length, 0, `server manifest exclude 引用不存在的路径:\n${missing.join('\n')}`);
});

test('[反向] 去掉 dispatch-review exclude 后产物会出现该文件', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const target = 'scripts/dispatch-review.mjs';
  assert.ok(m.exclude.includes(target), '测试前提:manifest 应含 dispatch-review exclude');
  const mutated = JSON.parse(JSON.stringify(m));
  mutated.exclude = mutated.exclude.filter((x) => x !== target);
  mutated.absent = mutated.absent.filter((x) => x !== target);
  const dir = mkdtempSync(join(tmpdir(), 'server-mut-'));
  const mutatedManifestPath = join(dir, 'manifest.json');
  const outDir = join(dir, 'out');
  try {
    writeFileSync(mutatedManifestPath, JSON.stringify(mutated, null, 2));
    mkdirSync(outDir, { recursive: true });
    try {
      buildDist({ sourceDir: SRC, manifestPath: mutatedManifestPath, outDir });
    } catch (e) {
      assert.match(String(e.message), /forbidden-scan|dispatch-review/, `变异构建应因禁词或 absent 失败,实际: ${e.message}`);
      return;
    }
    assert.equal(existsSync(join(outDir, target)), true, 'exclude 去掉后产物应出现 dispatch-review.mjs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
