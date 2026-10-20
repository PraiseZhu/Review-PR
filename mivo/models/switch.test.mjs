// models/switch.mjs 端到端(本机):PATH 前面放一个假 gh,用文件模拟仓库变量、派发验证、run 列表与产物下载。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SWITCH = fileURLToPath(new URL('./switch.mjs', import.meta.url));
const REPO = 'o/r';

// 假 gh:vars.json 是仓库变量;ctl.json 控制验证入口是否上线、验证结论;dispatches.log 记每次派发的参数。
function writeFakeGh(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const vars = () => JSON.parse(fs.readFileSync(path.join(dir, 'vars.json'), 'utf8'));
const saveVars = (v) => fs.writeFileSync(path.join(dir, 'vars.json'), JSON.stringify(v));
const ctl = JSON.parse(fs.readFileSync(path.join(dir, 'ctl.json'), 'utf8'));
const flag = (name) => args[args.indexOf(name) + 1];
const fields = () => Object.fromEntries(args.flatMap((a, i) => (a === '-f' ? [args[i + 1].split('=')] : [])));
if (args[0] === 'api' && args[1].includes('/actions/variables')) {
  for (const [k, v] of Object.entries(vars())) console.log(JSON.stringify([k, v]));
} else if (args[0] === 'api' && args[1].includes('/actions/workflows/')) {
  if (!ctl.workflow) { console.error('HTTP 404'); process.exit(1); }
  console.log('active');
} else if (args[0] === 'variable' && args[1] === 'set') {
  if (ctl.setFails) { console.error('HTTP 500'); process.exit(1); }
  const v = vars(); v[args[2]] = flag('--body'); saveVars(v);
} else if (args[0] === 'variable' && args[1] === 'delete') {
  const v = vars(); delete v[args[2]]; saveVars(v);
} else if (args[0] === 'workflow' && args[1] === 'run') {
  const f = fields();
  fs.appendFileSync(path.join(dir, 'dispatches.log'), JSON.stringify(f) + '\\n');
  const smoke = (ok) => ({ ok, error: ok ? null : 'unexpected status 404 Not Found', keyFailure: null });
  const check = { version: 1, requestId: f.request_id, role: f.role, model: f.model, effort: f.effort, ok: ctl.pass,
    keys: { primary: { configured: true, models: { ok: true, present: ctl.pass, available: ['openai/gpt-6-luna'] }, smoke: smoke(ctl.pass) }, backup: { configured: true, smoke: smoke(true) } } };
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify(check));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify([{ databaseId: 555, displayTitle: 'review-model-check ' + f.role + ' ' + f.request_id }]));
} else if (args[0] === 'run' && args[1] === 'list') {
  process.stdout.write(fs.existsSync(path.join(dir, 'run.json')) ? fs.readFileSync(path.join(dir, 'run.json'), 'utf8') : '[]');
} else if (args[0] === 'run' && args[1] === 'view') {
  console.log(JSON.stringify({ status: 'completed', conclusion: 'success' }));
} else if (args[0] === 'run' && args[1] === 'download') {
  fs.copyFileSync(path.join(dir, 'check.json'), path.join(flag('-D'), 'check.json'));
} else { console.error('fake gh: unhandled ' + args.join(' ')); process.exit(1); }
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

function setup({ vars = {}, workflow = true, pass = true, setFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mivo-model-switch-'));
  writeFileSync(join(dir, 'vars.json'), JSON.stringify(vars));
  writeFileSync(join(dir, 'ctl.json'), JSON.stringify({ workflow, pass, setFails }));
  const bin = writeFakeGh(dir);
  const run = (...args) => spawnSync(process.execPath, [SWITCH, '--repo', REPO, '--json', ...args], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, MIVO_MODEL_SWITCH_STATE: join(dir, 'state'), MIVO_MODEL_SWITCH_POLL_MS: '20' } });
  const out = (r) => { assert.ok(r.stdout.trim(), r.stderr); return { code: r.status, ...JSON.parse(r.stdout.trim().split('\n').pop()) }; };
  return {
    dir, switchTo: (role, model, effort) => out(run('--role', role, '--model', model, '--effort', effort, '--provider', 'art-cindy')),
    rollback: (role) => out(run('--role', role, '--rollback')), status: () => out(run('--status')),
    vars: () => JSON.parse(readFileSync(join(dir, 'vars.json'), 'utf8')),
    dispatches: () => (existsSync(join(dir, 'dispatches.log')) ? readFileSync(join(dir, 'dispatches.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('验证通过才写角色变量;写入的值带模型、档位和验证 run;再次运行同一配置不动;回退恢复原值', () => {
  const t = setup();
  try {
    const r = t.switchTo('primary', 'gpt-6-luna', 'max');
    assert.equal(r.code, 0, r.summary);
    assert.equal(r.changed, true);
    assert.match(r.summary, /已切换 主审 → openai\/gpt-6-luna \/ max/);
    assert.deepEqual(t.dispatches().map(({ role, model, effort }) => ({ role, model, effort })), [{ role: 'primary', model: 'openai/gpt-6-luna', effort: 'max' }]);
    const value = JSON.parse(t.vars().MIVO_REVIEW_ROLE_PRIMARY);
    assert.deepEqual({ model: value.model, effort: value.effort, cindyModel: value.cindyModel, provider: value.provider, checkRunId: value.checkRunId },
      { model: 'openai/gpt-6-luna', effort: 'max', cindyModel: 'gpt-6-luna', provider: 'art-cindy', checkRunId: 555 });
    const again = t.switchTo('primary', 'openai/gpt-6-luna', 'max');
    assert.equal(again.changed, false);
    assert.match(again.summary, /已经是/);
    assert.equal(t.dispatches().length, 1, '同一配置不再派验证');
    assert.match(t.status().summary, /主审:openai\/gpt-6-luna \/ max\n备用模型:openai\/gpt-6\.1-sol \/ medium\(默认值\)/);
    const back = t.rollback('primary');
    assert.equal(back.code, 0, back.summary);
    assert.match(back.summary, /默认值\(删除变量\)/);
    assert.equal(t.vars().MIVO_REVIEW_ROLE_PRIMARY, undefined);
  } finally { t.done(); }
});

test('验证没通过、验证入口没上线、单档覆盖变量压住主审:都不写变量,退出码 1;选了 Claude 模型或没选档位直接拒绝', () => {
  for (const [opts, pattern] of [[{ pass: false }, /服务器验证没通过.*网关模型清单里没有 openai\/gpt-x/], [{ workflow: false }, /还没在 o\/r 的 main 上线/],
    [{ vars: { MIVO_REVIEW_MODEL_LIGHT: 'openai/test' } }, /单档覆盖变量 MIVO_REVIEW_MODEL_LIGHT/]]) {
    const t = setup(opts);
    try {
      const r = t.switchTo('primary', 'gpt-x', 'high');
      assert.equal(r.code, 1, r.summary);
      assert.match(r.summary, pattern);
      assert.equal(t.vars().MIVO_REVIEW_ROLE_PRIMARY, undefined);
    } finally { t.done(); }
  }
  const t = setup();
  try {
    assert.match(t.switchTo('verifier', 'claude-opus-5-5', 'high').summary, /非 gpt 模型要选网关同名的来源/);
    assert.match(t.switchTo('fallback', 'gpt-6.1-sol', '').summary, /先在自动化里选好档位/);
    assert.deepEqual(t.dispatches(), []);
  } finally { t.done(); }
});

test('写入失败:恢复原值,报没切换;独立性告警随结果给出', () => {
  const t = setup({ setFails: true });
  try {
    const r = t.switchTo('verifier', 'gpt-6-luna', 'high');
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /写入没有生效/);
    assert.match(r.warnings.join('\n'), /核对员和主审是同一个模型/);
  } finally { t.done(); }
});

test('后台方式:--detach 立刻返回 job id;--wait 没跑完退出码 3,跑完给出结果;参数错直接拒绝不开后台', async () => {
  const t = setup();
  try {
    const env = { ...process.env, PATH: `${join(t.dir, 'bin')}${delimiter}${process.env.PATH}`, MIVO_MODEL_SWITCH_STATE: join(t.dir, 'state'), MIVO_MODEL_SWITCH_POLL_MS: '20' };
    const call = (...args) => {
      const r = spawnSync(process.execPath, [SWITCH, '--repo', REPO, '--json', ...args], { encoding: 'utf8', timeout: 60_000, env });
      return { code: r.status, ...JSON.parse(r.stdout.trim().split('\n').pop()) };
    };
    const bad = call('--role', 'primary', '--model', 'claude-opus-5-5', '--effort', 'max', '--detach');
    assert.equal(bad.code, 1);
    assert.match(bad.summary, /非 gpt 模型要选网关同名的来源/);
    const started = call('--role', 'fallback', '--model', 'gpt-6.1-sol', '--effort', 'high', '--provider', 'xd', '--detach');
    assert.equal(started.code, 0, started.summary);
    assert.match(started.jobId, /^job-fallback-[0-9a-f]{12}$/);
    let done = null;
    for (let i = 0; i < 20 && !done; i += 1) {
      const r = call('--wait', started.jobId, '--max-wait-sec', '3');
      if (r.code !== 3) done = r;
    }
    assert.ok(done, '后台任务没有在预期时间内结束');
    assert.equal(done.code, 0, done.summary);
    assert.match(done.summary, /已切换 备用模型 → openai\/gpt-6\.1-sol \/ high/);
    assert.equal(JSON.parse(t.vars().MIVO_REVIEW_ROLE_FALLBACK).provider, 'xd');
    assert.equal(call('--wait', 'job-fallback-000000000000').code, 1, '不存在的 job');
    assert.throws(() => JSON.parse(spawnSync(process.execPath, [SWITCH, '--wait', '../../etc'], { encoding: 'utf8', env }).stdout), Error, 'job id 不合法时也只输出说明');
  } finally { t.done(); }
});

test('变量已写好但历史写不进去:仍报已切换(退出码 0),附告警说明这次不能 --rollback', () => {
  const t = setup();
  try {
    mkdirSync(join(t.dir, 'state', 'history.jsonl'), { recursive: true });
    const r = t.switchTo('verifier', 'gpt-6.1-sol', 'high');
    assert.equal(r.code, 0, r.summary);
    assert.equal(r.changed, true);
    assert.match(r.summary, /已切换 核对员/);
    assert.ok(r.warnings.some((w) => /历史没记上/.test(w)), JSON.stringify(r.warnings));
    assert.equal(JSON.parse(t.vars().MIVO_REVIEW_ROLE_VERIFIER).effort, 'high');
  } finally { t.done(); }
});

test('--wait:后台任务的 pid 已被别的进程复用(命令行里没有这个 job id)就按意外结束处理,不会一直报还在进行', () => {
  const t = setup();
  try {
    const id = 'job-primary-abcdef012345';
    const jobs = join(t.dir, 'state', 'jobs');
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, `${id}.started.json`), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), role: 'primary' }));
    const r = spawnSync(process.execPath, [SWITCH, '--repo', REPO, '--json', '--wait', id, '--max-wait-sec', '2'], { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, MIVO_MODEL_SWITCH_STATE: join(t.dir, 'state'), MIVO_MODEL_SWITCH_POLL_MS: '20' } });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(r.status, 2, out.summary);
    assert.match(out.summary, /意外结束/);
  } finally { t.done(); }
});
