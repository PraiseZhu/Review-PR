// deploy-tuple.mjs --preview 的命令行行为:临时 HOME 里放一个假的 Mini skill 检出,PATH 最前面放 gh 和 ssh 替身。
// 临时 HOME 里没有 ~/.claude/state/approve-exec/mivo-review-trust.json,ssh 替身一被调用就让用例失败:
// 换版本只该连 Mini(这里 --on mini 就是本机),不该再碰 Pro、Air 的 trust(#161)。
// 不覆盖真正切换那一步(要 launchctl、停点),那一步由 deploy-tuple.mjs --selftest 和上线核对兜住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'deploy-tuple.mjs');
const WORKFLOW = 'name: review-pr\n';
const WF = createHash('sha256').update(WORKFLOW).digest('hex');
const OLD_WF = 'd'.repeat(64);
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
const a = process.argv.slice(2).join(' ');
const out = (v) => process.stdout.write(String(v) + '\\n');
if (a.startsWith('variable get MIVO_REVIEW_SKILL_SHA -R xindong/mivo-canvas-plugin')) out(s.variable);
else if (a.startsWith('api repos/PraiseZhu/Review-PR/commits/') && a.endsWith('--jq .sha')) out(s.newSkill);
else if (a.startsWith('api repos/PraiseZhu/Review-PR/compare/')) out(JSON.stringify({ status: 'identical', aheadBy: 0, messages: [] }));
else if (a.includes('contents/.github/workflows/review-pr.yml')) out(Buffer.from(s.workflow).toString('base64'));
else { process.stderr.write('gh 替身没准备这个调用: ' + a); process.exit(1); }
`;
// 任何 ssh 调用都记下来并失败:Air 离线、Pro 不可达时换版本也必须能预检通过。
const FAKE_SSH = `#!/bin/sh
echo "$@" >> "$FAKE_SSH_LOG"
echo "ssh: Connection timed out during banner exchange" >&2
exit 255
`;

// helpers
function setup(t, { variable } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-deploy-tuple-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const skill = path.join(home, 'mivo-prereview/skill');
  fs.mkdirSync(skill, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', skill, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'old');
  const oldSkill = git('rev-parse', 'HEAD').stdout.trim();
  git('commit', '-q', '--allow-empty', '-m', 'new');
  const newSkill = git('rev-parse', 'HEAD').stdout.trim();
  git('-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', oldSkill);
  assert.match(oldSkill, /^[0-9a-f]{40}$/);
  assert.match(newSkill, /^[0-9a-f]{40}$/);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify({ variable: variable ?? oldSkill, newSkill, workflow: WORKFLOW }));
  const sshLog = path.join(root, 'ssh.log');
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_SCENARIO: path.join(root, 'scenario.json'), FAKE_SSH_LOG: sshLog };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const preview = (extra = []) => run('--on', 'mini', '--old-skill', oldSkill, '--new-skill', newSkill, '--old-wf', OLD_WF, '--new-wf', WF,
    '--record-dir', path.join(root, 'records'), '--preview', ...extra);
  return { home, root, oldSkill, newSkill, preview, sshLog, run };
}

test('没有 trust 文件、ssh 不可用:--preview 照样通过,打印新旧 tuple,不提 trust,没有任何 ssh 调用', (t) => {
  const { home, preview, oldSkill, newSkill, sshLog } = setup(t);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, '夹具里不放 trust 文件');
  const r = preview();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`Review-PR +${oldSkill} → ${newSkill}`));
  assert.match(r.stdout, new RegExp(`review-pr\\.yml ${OLD_WF} → ${WF}`));
  assert.match(r.stdout, /仓库变量、Mini 检出都是旧值/);
  assert.match(r.stdout, /只读预检通过/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /trust/i);
  assert.equal(fs.existsSync(sshLog), false, `不该有 ssh 调用:${fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8') : ''}`);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, '预检不创建 trust 文件');
});

test('仓库变量不是预期的旧值:预检失败,不往下走', (t) => {
  const { preview } = setup(t, { variable: 'e'.repeat(40) });
  const r = preview();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /仓库变量现在是 e{40},不是预期的旧值/);
});

test('不带 --pr 时 main 上的 review-pr.yml 必须已是新值:对不上就失败', (t) => {
  const { run, oldSkill, newSkill, root } = setup(t);
  const r = run('--on', 'mini', '--old-skill', oldSkill, '--new-skill', newSkill, '--old-wf', OLD_WF, '--new-wf', 'f'.repeat(64),
    '--record-dir', path.join(root, 'records'), '--preview');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /不合 PR 时 main 上 \.github\/workflows\/review-pr\.yml 必须已经是新值/);
});

test('源码里不再有 trust 读写、prerequisites 步骤和 prereq-check.mjs', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const gone of ['TRUST_REL', 'readTrust', 'casTrust', 'switchTrust', 'trustTuple', 'toTrustText', 'prerequisites', 'PREREQ_SOURCE']) {
    assert.doesNotMatch(source, new RegExp(`\\b${gone}\\b`), `${gone} 应已删除`);
  }
  assert.doesNotMatch(source, /prereq-check/);
  assert.equal(fs.existsSync(path.join(HERE, 'prereq-check.mjs')), false);
  assert.match(source, /\bverifyTuple\(\)/, '切换后仍核对变量、Mini 检出和 main 上的 workflow');
  const steps = /const STEPS = \[([\s\S]*?)\n\];/.exec(source)?.[1] ?? '';
  assert.deepEqual([...steps.matchAll(/name: '([^']+)'/g)].map((m) => m[1]), ['variable', 'checkout']);
});
