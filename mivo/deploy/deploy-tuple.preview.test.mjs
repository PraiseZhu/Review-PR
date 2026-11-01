// deploy-tuple.mjs --preview 的命令行行为:夹具见 deploy-tuple.fixture.mjs。
// 临时 HOME 里没有 ~/.claude/state/approve-exec/mivo-review-trust.json,ssh 替身一被调用就留下记录:
// 换版本只该连 Mini(这里 --on mini 就是本机),不该再碰 Pro、Air 的 trust(PraiseZhu/Review-PR#161)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HERE, SCRIPT, setupFixture, WF_NEW, WF_OLD } from './deploy-tuple.fixture.mjs';

test('没有 trust 文件、ssh 不可用:--preview 照样通过,打印新旧 tuple,不提 trust,没有任何 ssh 调用', (t) => {
  const f = setupFixture(t);
  assert.equal(f.exists('.claude'), false, '夹具里不放 trust 文件');
  const r = f.deploy({ extra: ['--preview'] });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`Review-PR +${f.oldSkill} → ${f.newSkill}`));
  assert.match(r.stdout, new RegExp(`review-pr\\.yml ${WF_OLD} → ${WF_NEW}`));
  assert.match(r.stdout, /仓库变量、Mini 检出都是旧值/);
  assert.match(r.stdout, /只读预检通过/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /trust/i);
  assert.equal(fs.existsSync(f.sshLog), false, `不该有 ssh 调用:${fs.existsSync(f.sshLog) ? fs.readFileSync(f.sshLog, 'utf8') : ''}`);
  assert.equal(f.exists('.claude'), false, '预检不创建 trust 文件');
  assert.deepEqual(f.ghState().sets, [], '预览不改仓库变量');
});

test('仓库变量不是预期的旧值:预检失败,不往下走', (t) => {
  const f = setupFixture(t, { variable: 'e'.repeat(40) });
  const r = f.deploy({ extra: ['--preview'] });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /仓库变量现在是 e{40},不是预期的旧值/);
});

test('不带 --pr 时 main 上的 review-pr.yml 必须已是新值:对不上就失败', (t) => {
  const f = setupFixture(t, { workflows: ['别的内容\n'] });
  const r = f.deploy({ extra: ['--preview'] });
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
