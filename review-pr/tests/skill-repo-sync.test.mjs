import './helpers.isolated-state-dir.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freshTempDir } from './helpers.mjs';

const LIB = join(import.meta.dirname, '..', 'scripts', 'lib.mjs');
const ALERT = join(import.meta.dirname, '..', 'scripts', 'notify-sync-alert.mjs');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败(status=${r.status}): ${r.stderr || r.stdout || r.error}`);
  return r.stdout.trim();
};

const ledger = (entries) => `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
const entry = (fp, title) => ({
  fingerprint: fp, tier: 'auto', title, detail: null, proposal: null,
  status: 'open', commit: null, note: null, occurrences: 1,
  firstSeen: '2026-08-17T00:00:00.000Z', lastSeen: '2026-08-17T00:00:00.000Z',
});

function writeSkillTree(dir, { md, json, skillMd = 'skill\n', script = 'export const x=1;\n' }) {
  mkdirSync(join(dir, 'evolution'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'preview-dist'), { recursive: true });
  writeFileSync(join(dir, 'EVOLUTION.md'), md);
  writeFileSync(join(dir, 'evolution', 'ledger.json'), json);
  writeFileSync(join(dir, 'SKILL.md'), skillMd);
  writeFileSync(join(dir, 'scripts', 'context.mjs'), script);
  writeFileSync(join(dir, 'preview-dist', 'SKILL.md'), 'preview\n');
}

function setupDiverged({ dirtyPreview = false } = {}) {
  const work = freshTempDir('skill-sync-');
  const origin = join(work, 'origin.git');
  mkdirSync(origin, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main'], origin);
  const seed = join(work, 'seed');
  mkdirSync(seed);
  git(['init', '-q', '-b', 'main'], seed);
  git(['config', 'user.email', 't@t'], seed);
  git(['config', 'user.name', 't'], seed);
  git(['config', 'commit.gpgsign', 'false'], seed);
  writeSkillTree(seed, {
    md: '# evo\n\n- `shared` **s**\n',
    json: ledger([entry('shared', 'shared')]),
  });
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'base'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['push', '-q', '-u', 'origin', 'main'], seed);

  const remote = join(work, 'remote-wt');
  git(['clone', '-q', origin, remote], work);
  git(['config', 'user.email', 't@t'], remote);
  git(['config', 'user.name', 't'], remote);
  git(['config', 'commit.gpgsign', 'false'], remote);
  writeFileSync(join(remote, 'EVOLUTION.md'), '# evo\n\n- `shared` **s**\n- `remote-only` **r**\n');
  writeFileSync(join(remote, 'evolution', 'ledger.json'), ledger([
    entry('shared', 'shared'), entry('remote-only', 'remote'),
  ]));
  git(['add', '-A'], remote);
  git(['commit', '-q', '-m', 'evo: remote ledger'], remote);
  git(['push', '-q', 'origin', 'main'], remote);

  const local = join(work, 'local');
  git(['clone', '-q', origin, local], work);
  git(['config', 'user.email', 't@t'], local);
  git(['config', 'user.name', 't'], local);
  git(['config', 'commit.gpgsign', 'false'], local);
  git(['reset', '--hard', 'HEAD~1'], local);
  writeFileSync(join(local, 'EVOLUTION.md'), '# evo\n\n- `shared` **s**\n- `local-only` **l**\n');
  writeFileSync(join(local, 'evolution', 'ledger.json'), ledger([
    entry('shared', 'shared'), entry('local-only', 'local'),
  ]));
  git(['add', 'EVOLUTION.md', 'evolution/ledger.json'], local);
  git(['commit', '-q', '-m', 'evo: local ledger'], local);
  if (dirtyPreview) writeFileSync(join(local, 'preview-dist', 'SKILL.md'), 'DIRTY PREVIEW\n');
  return { work, origin, local };
}

async function loadLib(skillRoot) {
  process.env.REVIEW_PR_SKILL_ROOT_OVERRIDE = skillRoot;
  return import(`${pathToFileURL(LIB).href}?sync=${encodeURIComponent(skillRoot)}`);
}

test('SC-2/SC-3:纯台账分叉 + 脏 preview-dist,pull 仍收敛且本地条目还在', async () => {
  const { local } = setupDiverged({ dirtyPreview: true });
  const lib = await loadLib(local);
  const r = lib.skillRepoPull({ timeoutMs: 30_000, pushAfterConverge: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.diverged, true, `收敛后不得再标 diverged:${JSON.stringify(r)}`);
  const fps = JSON.parse(readFileSync(join(local, 'evolution', 'ledger.json'), 'utf8'))
    .entries.map((e) => e.fingerprint).sort();
  assert.deepEqual(fps, ['local-only', 'remote-only', 'shared']);
  assert.equal(readFileSync(join(local, 'preview-dist', 'SKILL.md'), 'utf8'), 'DIRTY PREVIEW\n');
  const counts = spawnSync('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD'], {
    cwd: local, encoding: 'utf8',
  }).stdout.trim();
  assert.equal(counts, '0\t0', `应对齐 origin: ${counts}`);
});

test('SC-4:evo: 提交卸下源 SKILL.md 与 scripts/*.mjs,台账留下', async () => {
  const work = freshTempDir('skill-evo-');
  const origin = join(work, 'origin.git');
  mkdirSync(origin, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main'], origin);
  const local = join(work, 'local');
  mkdirSync(local);
  git(['init', '-q', '-b', 'main'], local);
  git(['config', 'user.email', 't@t'], local);
  git(['config', 'user.name', 't'], local);
  git(['config', 'commit.gpgsign', 'false'], local);
  writeSkillTree(local, {
    md: '# evo\n',
    json: ledger([entry('shared', 'shared')]),
  });
  git(['add', '-A'], local);
  git(['commit', '-q', '-m', 'base'], local);
  git(['remote', 'add', 'origin', origin], local);
  git(['push', '-q', '-u', 'origin', 'main'], local);

  writeFileSync(join(local, 'evolution', 'ledger.json'), ledger([
    entry('shared', 'shared'), entry('new-fp', 'new'),
  ]));
  writeFileSync(join(local, 'EVOLUTION.md'), '# evo\n- new\n');
  writeFileSync(join(local, 'SKILL.md'), 'CHANGED SKILL\n');
  writeFileSync(join(local, 'scripts', 'context.mjs'), 'export const x=2;\n');

  const lib = await loadLib(local);
  const r = lib.skillRepoCommitPush({ message: 'evo: ledger new-fp' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.droppedEvoCode?.some((p) => p.endsWith('SKILL.md')), JSON.stringify(r));
  const names = spawnSync('git', ['show', '--name-only', '--pretty=', 'HEAD'], {
    cwd: local, encoding: 'utf8',
  }).stdout.trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(names, ['EVOLUTION.md', 'evolution/ledger.json']);
  assert.equal(readFileSync(join(local, 'SKILL.md'), 'utf8'), 'CHANGED SKILL\n');
});

test('SC-5:diverged 告警文案不再默认归咎脚本/SKILL.md', () => {
  const src = readFileSync(ALERT, 'utf8');
  assert.doesNotMatch(src, /走到这一步说明冲突在脚本 \/ SKILL\.md/);
  assert.match(src, /dirtyFiles \/ conflictFiles/);
});
