// issue-agent 放行版本哈希的同步(PraiseZhu/Review-PR#165):放行契约用本仓真的 lib.mjs 跑,配置写在临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as realLib from '../../review-pr/scripts/lib.mjs';
import {
  ISSUE_AGENT_MARKER, RUNTIME_NAMES, toSha256, toContractFailures, toConsumerPlan, toConsumerNote, toConsumerStepNote,
  syncIssueAgentConsumers,
} from './issue-agent-consumers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SCRIPT = path.join(HERE, 'issue-agent-consumers.mjs');
const OLD_CONTEXT = 'a'.repeat(64);
const OLD_LIB = 'b'.repeat(64);

// helpers
const hasConsentLine = (body) => String(body).split('\n').some((line) => line.trim() === '同意放行');
// 放行过滤被改坏的 lib:谁的评论有「同意放行」整行都算放行(不看 issue-agent 标记)。
const brokenFilterLib = {
  ...realLib,
  selectDiscussionIssueReleases: ({ issue }) => {
    const c = (issue.comments ?? []).find((x) => hasConsentLine(x.body));
    return { slackRelease: null, issueCommentRelease: c ? { by: 'praisezhu', at: c.createdAt, via: 'issue-comment', fingerprint: '1' } : null };
  },
};
// 放行路径失效的 lib:什么都不放行,带标记的用例「通过」只是因为没东西可放(契约空转)。
const neverReleaseLib = {
  ...realLib,
  selectDiscussionIssueReleases: () => ({ slackRelease: null, issueCommentRelease: null }),
};
const runtimeText = ({ contextPath, libPath, contextHash = OLD_CONTEXT, libHash = OLD_LIB, extra = {} }) => `${JSON.stringify({
  schemaVersion: 1,
  slack: { channelId: 'C0TEST' },
  reviewConsumers: [{ path: contextPath, hash: contextHash }, { path: libPath, hash: libHash }],
  budgets: { dailyRounds: 20 },
  ...extra,
}, null, 2)}\n`;
// 临时 issue-agent 目录:两份配置都指向 skillDir 里的 context.mjs / lib.mjs。
function setupAgentDir(t, skillDir, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-issue-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contextPath = path.join(skillDir, 'review-pr/scripts/context.mjs');
  const libPath = path.join(skillDir, 'review-pr/scripts/lib.mjs');
  for (const name of RUNTIME_NAMES) {
    fs.writeFileSync(path.join(dir, name), runtimeText({ contextPath, libPath, ...over }), { mode: 0o600 });
  }
  return { dir, contextPath, libPath };
}
// 临时审查机检出:只放两个被钉住的文件,内容随意。
function setupSkillDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-skill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'review-pr/scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'review-pr/scripts/context.mjs'), '// context v2\n');
  fs.writeFileSync(path.join(root, 'review-pr/scripts/lib.mjs'), '// lib v2\n');
  return root;
}
const readAll = (dir) => RUNTIME_NAMES.map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));

test('SC1 放行契约:本仓 main 的 lib.mjs 通过(带 issue-agent 标记不放行,去掉标记的对照放行)', () => {
  assert.deepEqual(toContractFailures(realLib), []);
});

test('SC1 放行契约:用的是 issue-agent 真实的首行标记格式', () => {
  assert.match(ISSUE_AGENT_MARKER, /^<!-- mivo-issue-assessment:v1 repo=[\w.-]+\/[\w.-]+ issue=[1-9]\d* input=[a-f0-9]{64} round=[1-9]\d* report=[a-f0-9]{64} -->$/);
});

test('SC1 放行契约:过滤被改坏(带标记的评论也算放行)时不通过', () => {
  const failures = toContractFailures(brokenFilterLib);
  assert.ok(failures.some((f) => f.includes('带 issue-agent 标记的维护者评论被当成了确认 issue 放行')), failures.join('\n'));
  assert.ok(failures.some((f) => f.includes('受保护路径放行')), failures.join('\n'));
});

test('SC1 放行契约:对照没放行(放行路径失效、契约空转)时不通过', () => {
  const failures = toContractFailures(neverReleaseLib);
  assert.ok(failures.some((f) => f.startsWith('对照没放行')), failures.join('\n'));
});

test('SC1 放行契约:缺函数、函数抛错都算不通过', () => {
  assert.deepEqual(toContractFailures({}), ['lib.mjs 缺少 selectDiscussionIssueReleases、latestIssueRelease、evaluateProtectedPathRelease']);
  const throwing = { ...realLib, selectDiscussionIssueReleases: () => { throw new Error('boom'); } };
  assert.deepEqual(toContractFailures(throwing), ['跑契约时出错:boom']);
});

test('SC1 计划:只改两处哈希,其余字节原样;哈希本来一致时什么都不改', (t) => {
  const skill = setupSkillDir(t);
  const { dir, contextPath, libPath } = setupAgentDir(t, skill);
  const configs = RUNTIME_NAMES.map((name) => ({ file: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), 'utf8') }));
  const hashOf = (file) => toSha256(fs.readFileSync(file));
  const plan = toConsumerPlan({ configs, skillDir: skill, hashOf });
  assert.equal(plan.error, undefined);
  assert.equal(plan.changes.length, 4);
  assert.deepEqual(plan.changes.map((c) => [path.basename(c.path), c.from]),
    [['context.mjs', OLD_CONTEXT], ['lib.mjs', OLD_LIB], ['context.mjs', OLD_CONTEXT], ['lib.mjs', OLD_LIB]]);
  for (const [i, { text }] of plan.next.entries()) {
    const back = text.replace(hashOf(contextPath), OLD_CONTEXT).replace(hashOf(libPath), OLD_LIB);
    assert.equal(back, configs[i].text);
  }
  const fresh = configs.map(({ file }) => ({ file, text: runtimeText({ contextPath, libPath, contextHash: hashOf(contextPath), libHash: hashOf(libPath) }) }));
  assert.deepEqual(toConsumerPlan({ configs: fresh, skillDir: skill, hashOf }), { changes: [], next: [] });
});

test('SC1 计划:配置不对就不改(指向检出之外、旧哈希出现不止一次、不是 JSON、没有 reviewConsumers)', (t) => {
  const skill = setupSkillDir(t);
  const contextPath = path.join(skill, 'review-pr/scripts/context.mjs');
  const libPath = path.join(skill, 'review-pr/scripts/lib.mjs');
  const hashOf = (file) => toSha256(fs.readFileSync(file));
  const plan = (text) => toConsumerPlan({ configs: [{ file: 'runtime-primary.json', text }], skillDir: skill, hashOf });
  const outside = path.join(skill, 'other/lib.mjs');
  assert.match(plan(runtimeText({ contextPath, libPath: outside })).error, /指向检出之外的文件/);
  assert.match(plan(runtimeText({ contextPath, libPath: path.join(skill, 'review-pr/scripts/../../x.mjs') })).error, /指向检出之外的文件/);
  assert.match(plan(runtimeText({ contextPath, libPath, extra: { note: OLD_LIB } })).error, /出现不止一次/);
  assert.match(plan('{').error, /不是合法 JSON/);
  assert.match(plan('{"reviewConsumers":[]}').error, /没有 reviewConsumers/);
});

test('SC1 同步:契约通过就写两份配置,保留权限;再跑一次什么都不改', async (t) => {
  const skill = setupSkillDir(t);
  const { dir, contextPath, libPath } = setupAgentDir(t, skill);
  const out = await syncIssueAgentConsumers({ skillDir: skill, issueAgentDir: dir, importLib: async () => realLib });
  assert.equal(out.error, undefined);
  assert.equal(out.changes.length, 4);
  for (const name of RUNTIME_NAMES) {
    const file = path.join(dir, name);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(json.reviewConsumers.map((c) => c.hash), [toSha256(fs.readFileSync(contextPath)), toSha256(fs.readFileSync(libPath))]);
    assert.deepEqual(json.budgets, { dailyRounds: 20 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), [...RUNTIME_NAMES].sort());
  const again = await syncIssueAgentConsumers({ skillDir: skill, issueAgentDir: dir, importLib: async () => realLib });
  assert.deepEqual(again.changes, []);
  assert.equal(toConsumerNote(again), '');
});

test('SC1 同步:契约不通过、dry-run、配置缺一份,都不写任何文件', async (t) => {
  const skill = setupSkillDir(t);
  const { dir } = setupAgentDir(t, skill);
  const before = readAll(dir);
  const blocked = await syncIssueAgentConsumers({ skillDir: skill, issueAgentDir: dir, importLib: async () => brokenFilterLib });
  assert.ok(blocked.failures.length > 0);
  assert.deepEqual(readAll(dir), before);
  const dry = await syncIssueAgentConsumers({ skillDir: skill, issueAgentDir: dir, dryRun: true, importLib: async () => realLib });
  assert.equal(dry.changes.length, 4);
  assert.deepEqual(readAll(dir), before);
  const failedImport = await syncIssueAgentConsumers({ skillDir: skill, issueAgentDir: dir, importLib: async () => { throw new Error('no such file'); } });
  assert.deepEqual(failedImport.failures, ['加载 lib.mjs 失败:no such file']);
  fs.rmSync(path.join(dir, RUNTIME_NAMES[1]));
  const missing = await syncIssueAgentConsumers({ skillDir: skill, issueAgentDir: dir, importLib: async () => realLib });
  assert.match(missing.error, /读不了 issue-agent 配置/);
  assert.equal(fs.readFileSync(path.join(dir, RUNTIME_NAMES[0]), 'utf8'), before[0]);
});

test('SC2 换版结果:被拦写明原因和处理办法,更新成功写明文件,本来一致不多写', () => {
  const blocked = toConsumerNote({ failures: ['带 issue-agent 标记的维护者评论被当成了确认 issue 放行'] });
  assert.match(blocked, /^issue 评估的发布被拦:新版审查机没通过放行契约\(带 issue-agent 标记.*\),issue-agent 配置里的哈希没改。处理:/);
  assert.match(toConsumerNote({ error: '读不了 issue-agent 配置:ENOENT' }), /^issue 评估的发布被拦:.*没更新成\(读不了 issue-agent 配置:ENOENT\)。处理:.*issue-agent-consumers\.mjs/);
  const changes = ['runtime-primary.json', 'runtime-fallback.json'].flatMap((file) => ['context.mjs', 'lib.mjs'].map((f) => ({ file: `/x/${file}`, path: `/s/review-pr/scripts/${f}` })));
  assert.equal(toConsumerNote({ changes }), 'issue-agent 的放行版本哈希已随换版更新(context.mjs、lib.mjs;runtime-primary.json、runtime-fallback.json),放行契约通过。');
  assert.equal(toConsumerNote({ changes: [] }), '');
});

test('SC2 换版结果:同步脚本退出码与输出转成收尾那一句', () => {
  assert.equal(toConsumerStepNote({ status: 0, stdout: '' }), '');
  assert.equal(toConsumerStepNote({ status: 0, stdout: 'issue-agent 的放行版本哈希已随换版更新(lib.mjs;runtime-primary.json),放行契约通过。\n' }),
    'issue-agent 的放行版本哈希已随换版更新(lib.mjs;runtime-primary.json),放行契约通过。');
  assert.equal(toConsumerStepNote({ status: 1, stdout: 'issue 评估的发布被拦:x\n' }), 'issue 评估的发布被拦:x');
  assert.match(toConsumerStepNote({ status: 1, stdout: '', stderr: 'SyntaxError: bad' }), /^issue 评估的发布可能被拦:同步放行版本哈希的脚本退出码 1\(SyntaxError: bad\)/);
  assert.match(toConsumerStepNote({ error: new Error('spawn ETIMEDOUT') }), /^issue 评估的发布可能被拦:同步放行版本哈希的脚本没跑起来\(spawn ETIMEDOUT\)/);
});

test('SC1 命令行:以本仓为审查机检出端到端跑一遍(真 lib.mjs),写好两份配置', (t) => {
  const { dir, contextPath, libPath } = setupAgentDir(t, REPO);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const dry = run('--skill-dir', REPO, '--issue-agent-dir', dir, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^\[dry-run,没写文件\] issue-agent 的放行版本哈希已随换版更新/);
  assert.match(readAll(dir)[0], new RegExp(OLD_LIB));
  const real = run('--skill-dir', REPO, '--issue-agent-dir', dir);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /^issue-agent 的放行版本哈希已随换版更新\(context\.mjs、lib\.mjs;runtime-primary\.json、runtime-fallback\.json\),放行契约通过。\n$/);
  for (const text of readAll(dir)) {
    assert.deepEqual(JSON.parse(text).reviewConsumers.map((c) => c.hash), [toSha256(fs.readFileSync(contextPath)), toSha256(fs.readFileSync(libPath))]);
  }
  assert.equal(run('--skill-dir', REPO, '--issue-agent-dir', dir).stdout, '');
  assert.equal(run('--help').status, 0);
  const bad = run('--nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /不认识的参数:--nope/);
});
