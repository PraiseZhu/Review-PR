import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { toGitHubPlan } from './cutover-apply-github.mjs';

const cli = fileURLToPath(new URL('./cutover.mjs', import.meta.url));
const manifest = { version: 1, oldRepo: 'owner/old', newRepo: 'owner/new', kind: 'fresh', defaultBranch: 'main', runnerLabel: 'fixture-runner' };

function fakeGh() {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE, 'utf8'));
  const save = () => fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
  if (args[0] === 'secret') {
    const name = args[2];
    const secret = fs.readFileSync(0, 'utf8');
    if (![('value-for-' + name), ('CUTOVER_REHEARSAL_PLACEHOLDER_' + name)].includes(secret) ||
        Object.values(process.env).includes(secret) || args.includes(secret)) process.exit(7);
    fs.appendFileSync(process.env.TEST_REQUESTS, 'SECRET ' + name + '\n');
    state[args.includes('--env') ? 'environmentSecrets' : 'secrets'].push({ name });
    save();
    return;
  }
  const [, , method, address] = args;
  const [endpoint] = address.split('?');
  const old = endpoint.startsWith('repos/owner/old');
  const relative = endpoint.split('/').slice(3).join('/');
  const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
  const done = (result) => {
    if (method !== 'GET') save();
    if (result !== undefined) console.log(JSON.stringify(args.includes('--slurp') ? [result] : result));
  };
  const stop = (code) => { console.error('gh: test (HTTP ' + code + ')'); process.exit(1); };
  fs.appendFileSync(process.env.TEST_REQUESTS, method + ' ' + endpoint + '\n');
  if (method !== 'GET' && old) stop(409);
  if (method !== 'GET' && process.env.TEST_FAIL === relative) stop(403);
  if (method === 'GET') {
    if (!relative) return done({ full_name: 'owner/new', private: true, default_branch: 'main', archived: false });
    if (relative === 'actions/variables') return done({ variables: old ? state.oldVariables : state.variables });
    if (relative === 'actions/secrets') return done({ secrets: state.secrets });
    if (relative === 'labels') return done(old ? [] : state.labels);
    if (relative === 'rulesets') return done([]);
    if (relative === 'environments') return done({ environments: state.environment ? [{ name: 'slack-inbound' }] : [] });
    if (relative.endsWith('/deployment-branch-policies')) return done({ branch_policies: state.branchPolicies });
    if (relative.endsWith('/slack-inbound/secrets')) return done({ secrets: state.environmentSecrets });
    if (relative === 'environments/slack-inbound') return done(state.environment);
    return stop(404);
  }
  if (relative === 'actions/variables' && method === 'POST') {
    state.variables.push(body);
    return done();
  }
  if (relative.startsWith('actions/variables/')) {
    const name = relative.split('/').at(-1);
    if (method === 'DELETE') state.variables = state.variables.filter((entry) => entry.name !== name);
    else state.variables.find((entry) => entry.name === name).value = body.value;
    return done();
  }
  if (relative === 'environments/slack-inbound') {
    state.environment = method === 'DELETE' ? null : body;
    return done();
  }
  if (relative.includes('/deployment-branch-policies')) {
    if (method === 'DELETE') state.branchPolicies = [];
    else state.branchPolicies.push({ id: 23, ...body });
    return done({ id: 23 });
  }
  if (relative.includes('/secrets/') && method === 'DELETE') {
    const key = relative.startsWith('environments/') ? 'environmentSecrets' : 'secrets';
    state[key] = state[key].filter(({ name }) => name !== relative.split('/').at(-1));
    return done();
  }
  stop(409);
}

function fixture(t, { rehearsal = true, fail } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-github-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(bin, 'gh'), '#!' + process.execPath + '\n(' + fakeGh.toString() + ')();\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'agent-secret'), [
    '#!/bin/sh',
    'test "$1" = run && test "$3" = -- || exit 1',
    'name="$2"',
    'shift 3',
    'env "$name=value-for-$name" "$@"',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH, TEST_FAIL: fail ?? '',
    TEST_STATE: path.join(root, 'state.json'), TEST_REQUESTS: path.join(root, 'requests') };
  const from = { oldVariables: [{ name: 'MIVO_REVIEW_MODE', value: 'live' }, { name: 'MIVO_REVIEW_DAILY_CAP', value: '12' },
    { name: 'MIVO_REVIEW_WATCHDOG_ISSUE', value: '52' }, { name: 'UNRELATED', value: 'live' }],
  variables: [{ name: 'MIVO_REVIEW_MODE', value: 'live' }], secrets: [{ name: 'PRAISEBUILD_PRIVATE_KEY' }],
  environmentSecrets: [], labels: [], environment: null, branchPolicies: [] };
  fs.writeFileSync(env.TEST_STATE, JSON.stringify(from));
  const config = path.join(root, 'manifest.json');
  fs.writeFileSync(config, JSON.stringify({ ...manifest, rehearsal }));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { home, from, invoke, apply: (...args) => invoke('--manifest', config, '--apply', 'github', ...args),
    state: () => JSON.parse(fs.readFileSync(env.TEST_STATE, 'utf8')),
    writes: () => fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').filter((line) => !line.startsWith('GET ')) };
}

test('GitHub 只演示不写入；演练写入后预检通过，重跑零写入，回滚仅删除新建 secret', (t) => {
  const fixtureData = fixture(t);
  const preview = fixtureData.apply();
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(fixtureData.writes(), []);
  assert.deepEqual(fs.readdirSync(fixtureData.home), []);
  assert.match(preview.stdout, /MIVO_REVIEW_MODE："live" → "dry-run"/);
  assert.match(preview.stdout, /Mivo 新审查机巡检.*owner\/old.*owner\/new/);
  assert.match(preview.stdout, /产品规则伙伴 \/ 每日检查.*owner\/old.*owner\/new/);
  for (const [id, mandatory] of [
    ['6f20b2c0-0586-4e7a-bf3e-79910588099c', false],
    ['bd638516-90cd-4051-8036-a31e1342e1a2', false],
    ['0543eabd-4aea-45af-ba33-f2cf69bf19ec', false],
    ['16fa2277-2296-48b5-b200-4cdc7fde9dbb', true],
    ['b44bd5d2-0567-4e03-80cf-caac3f39b9f6', true],
    ['643282e4-d5c9-41b1-883b-1db8950a9a44', true],
  ]) {
    const line = preview.stdout.split('\n').find((entry) => entry.includes(id));
    assert.match(line, /原句「.*owner\/old.*」 → 新句「.*owner\/new.*」/);
    assert.equal(line.includes('[切换当天必改]'), mandatory);
  }
  assert.match(preview.stdout, /执行当天先核对原句仍在/);
  assert.match(preview.stdout, /产品规则伙伴 \/ 周报.*owner\/old.*owner\/new/);
  assert.match(preview.stdout, /skills\/pr-merge\/scripts\/build-request.mjs/);
  const result = fixtureData.apply('--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /换仓只读预检/);
  assert.match(result.stdout, /不适用\/人工/);
  assert.match(result.stdout, /PRAISEBUILD_PRIVATE_KEY.*已存在，人工确认/);
  assert.doesNotMatch(result.stdout + result.stderr, /CUTOVER_REHEARSAL_PLACEHOLDER/);
  assert.deepEqual(fixtureData.state().variables, [
    { name: 'MIVO_REVIEW_MODE', value: 'dry-run' }, { name: 'MIVO_REVIEW_DAILY_CAP', value: '12' },
    { name: 'MIVO_REVIEW_RUNNER_LABEL', value: 'fixture-runner' },
  ]);
  assert.deepEqual(fixtureData.state().branchPolicies, [{ id: 23, name: 'main', type: 'branch' }]);
  const writes = fixtureData.writes();
  const second = fixtureData.apply('--yes');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /0 步写入/);
  assert.deepEqual(fixtureData.writes(), writes);
  const directory = /^备份：(.+)$/m.exec(result.stdout)[1];
  const rollback = fixtureData.invoke('--rollback', directory);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.deepEqual(fixtureData.state(), fixtureData.from);
});

test('真实模式用 agent-secret 向 gh 的 stdin 注入；403 立即停止并留下可回滚的记录', (t) => {
  const fixtureData = fixture(t, { rehearsal: false, fail: 'environments/slack-inbound' });
  const result = fixtureData.apply('--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /slack-inbound.*HTTP 403.*后续未执行/);
  assert.match(result.stderr, /回滚：node .* --rollback /);
  assert.doesNotMatch(result.stdout + result.stderr, /value-for-|换仓只读预检/);
  assert.deepEqual(fixtureData.writes().slice(-3), [
    'SECRET LITELLM_CREDENTIALS_JSON', 'SECRET PRAISEREVIEW_PRIVATE_KEY', 'PUT repos/owner/new/environments/slack-inbound',
  ]);
  const rollback = fixtureData.invoke('--rollback', /^备份：(.+)$/m.exec(result.stdout)[1]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.deepEqual(fixtureData.state(), fixtureData.from);
});

test('跨组织含 Team 的规则集：生产预检拒绝；演练只跳过，不改 actor', () => {
  const body = { name: 'protected', target: 'branch', enforcement: 'active', rules: [{ type: 'deletion' }],
    bypass_actors: [{ actor_type: 'Team', actor_id: 23, bypass_mode: 'always' }] };
  const state = { oldRules: [{ name: 'protected', source_type: 'Repository', body }], newRules: [],
    oldVariables: [], newVariables: [], oldLabels: [], newLabels: [], secrets: [], environmentSecrets: [], branchPolicies: [] };
  const cross = { ...manifest, newRepo: 'another/new' };
  assert.throws(() => toGitHubPlan(cross, state), /跨组织不可移植.*protected/);
  const step = toGitHubPlan({ ...cross, rehearsal: true }, state).at(-1);
  assert.equal(step.skip, true);
  assert.equal(step.operation, null);
  assert.match(step.note, /不适用/);
  assert.deepEqual(step.before.bypass_actors, [{ actor_type: 'Team', actor_id: 23, bypass_mode: 'always' }]);
  assert.deepEqual(toGitHubPlan(manifest, state).at(-1).operation.body.bypass_actors,
    [{ actor_type: 'Team', actor_id: 23, bypass_mode: 'always' }]);
});

test('GitHub 省略禁用的审批撤销限制时不重写；启用的限制仍必须写入', () => {
  const rules = [{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }];
  const before = { name: 'pr', target: 'branch', enforcement: 'active', rules, bypass_actors: [] };
  const state = { oldRules: [], newRules: [{ name: 'pr', source_type: 'Repository', id: 11, body: before }],
    oldVariables: [], newVariables: [], oldLabels: [], newLabels: [], secrets: [], environmentSecrets: [], branchPolicies: [] };
  const source = (enabled) => ({ ...before, rules: [{ type: 'pull_request',
    parameters: { required_approving_review_count: 2, dismissal_restriction: { enabled, allowed_actors: [] } } }] });
  state.oldRules = [{ name: 'pr', source_type: 'Repository', body: source(false) }];
  assert.equal(toGitHubPlan(manifest, state).at(-1).skip, true);
  state.oldRules[0].body = source(true);
  assert.deepEqual(toGitHubPlan(manifest, state).at(-1).operation.body, source(true));
});
