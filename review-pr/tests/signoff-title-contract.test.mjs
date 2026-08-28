#!/usr/bin/env node
// signoff-title-contract.test.mjs — 确认 issue 标题契约守门回归(2026-08-28 事故修复)。
//
// 事故:#330(PR #328)/ #353(PR #352)两轮 agent 生成的讨论 issue 标题偏离
// 「维护者确认 · PR #<n> <原标题>」公式,下游插件仓 merge-thanks 的 issue-announce
// 只通报带前缀的 issue → hold 照常落地、Slack 通报静默丢失,owner 两轮都看不到
// hold 通知、无从放行。根因是双层静默:skill 侧 signoff-hold 对标题零校验(什么
// 都往 GitHub 写),云端侧把违约当良性跳过(不给注解)。本文件钉死 skill 侧:
//
//   ① 正向:e2e 真实子进程 + stateful fake gh,合规前缀标题走原路径(held=true,
//      issue 真建出);② 负向:e2e 违约标题被拒(held=false + titleContractViolation,
//      零 issue create 调用,标签照打);③ 单元:issueTitleSatisfiesContract 边界
//      (前缀变体容忍空格 / 伪前缀 / 空串 / 全角井号);④ 嫌疑检测:疑似确认门
//      (标题含「PR #」数字引用)但违约的标题必须被嫌疑函数点名,防止二次静默。
//
// 跑:cd review-pr && node --test tests/signoff-title-contract.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAINTAINER_CONFIRM_TITLE_PREFIX,
  issueTitleSatisfiesContract,
  detectLikelyConfirmTitle,
} from '../scripts/signoff-hold.mjs';

const TESTS_DIR = new URL('.', import.meta.url).pathname;
const SCRIPTS_DIR = join(TESTS_DIR, '..', 'scripts');

// —— 与 signoff-policy.test.mjs 同源的 fixture(stateful fake gh + temp repo)——

const FAKE_GH_STATEFUL_SRC = `#!/usr/bin/env node
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const STATE = process.env.FAKE_GH_STATE;
const load = () => {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    return { issueSeq: 0, issues: {}, comments: [], labels: [], headOid: 'deadbeef', ...s };
  }
  catch { return { issueSeq: 0, issues: {}, comments: [], labels: [], headOid: 'deadbeef' }; }
};
const save = (s) => writeFileSync(STATE, JSON.stringify(s));
if (args[0] === 'pr' && args[1] === 'view') {
  const s = load();
  const num = Number(args[2]);
  process.stdout.write(JSON.stringify({
    number: num, state: 'OPEN', mergedAt: null,
    author: { login: 'tester' }, url: 'https://github.com/acme/app/pull/' + num,
    comments: s.comments.filter((c) => c.pr === num).map((c) => ({ body: c.body })),
    labels: s.labels.filter((l) => l.pr === num).map((l) => ({ name: l.name })),
    headRefOid: s.headOid,
  }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  const s = load();
  s.issueSeq += 1;
  s.issues[s.issueSeq] = { state: 'OPEN' };
  save(s);
  process.stdout.write('https://github.com/acme/app/issues/' + s.issueSeq + '\\n');
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'list') {
  const s = load();
  process.stdout.write(JSON.stringify(Object.entries(s.issues).map(([num]) => ({ number: Number(num) }))));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const s = load();
  const num = Number(args[2]);
  const st = s.issues[num] ? s.issues[num].state : (process.env.FAKE_GH_ISSUE_STATE || 'OPEN');
  process.stdout.write(JSON.stringify({ state: st }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const s = load();
  const bodyIdx = args.indexOf('--body');
  const body = bodyIdx >= 0 ? args[bodyIdx + 1] : readFileSync(0, 'utf8');
  s.comments.push({ pr: Number(args[2]), body });
  save(s);
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  const s = load();
  const bodyIdx = args.indexOf('--body');
  const body = bodyIdx >= 0 ? args[bodyIdx + 1] : readFileSync(0, 'utf8');
  s.comments.push({ pr: Number(args[2]), body });
  save(s);
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'create') { process.exit(0); }
if (args[0] === 'api' && args.includes('-X')) {
  const x = args.indexOf('-X');
  const method = args[x + 1];
  const m = (args[x + 2] || '').match(/issues\\/(\\d+)\\/labels(?:\\/([^/]+))?$/);
  if (!m) { process.stderr.write('unexpected api call: ' + args.join(' ')); process.exit(1); }
  const num = Number(m[1]);
  if (method === 'POST') {
    const s = load();
    const f = args[args.indexOf('-f') + 1] || '';
    const name = m[2] || f.replace(/^labels\\[\\]=/, '');
    s.labels.push({ pr: num, name });
    save(s);
    process.exit(0);
  }
  if (method === 'DELETE') {
    const s = load();
    s.labels = s.labels.filter((l) => !(l.pr === num && l.name === m[2]));
    save(s);
    process.exit(0);
  }
}
process.stderr.write('unexpected gh call: ' + args.join(' '));
process.exit(1);
`;

const LOCAL_DEPS = [
  'signoff-hold.mjs', 'lib.mjs', 'lib.escaped-hazards.mjs',
  'lib.review-profiles.mjs', 'lib.preflight-rules.mjs',
];

function makeStatefulShimDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-title-contract-'));
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, FAKE_GH_STATEFUL_SRC);
  chmodSync(ghPath, 0o755);
  return dir;
}

function makeTempRepoDir() {
  const dir = mkdtempSync(join(tmpdir(), 'title-contract-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: dir });
  mkdirSync(join(dir, 'agent-use', 'docs'), { recursive: true });
  writeFileSync(join(dir, 'agent-use', 'docs', 'pr-rules.json'), '{}');
  return dir;
}

function runSignoff({ args, repoDir, shimDir, logPath, statePath, extraEnv = {}, timeout = 15000 }) {
  const r = spawnSync('node', [join(SCRIPTS_DIR, 'signoff-hold.mjs'), ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      FAKE_GH_LOG: logPath,
      FAKE_GH_STATE: statePath,
      ...extraEnv,
    },
    timeout,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON,parsed 保持 null 交调用方判失败 */ }
  const calls = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, parsed };
}

const VALID_TITLE = '维护者确认 · PR #42 讨论测试专用 issue';
const VIOLATING_TITLE = 'PR #42 触发安全确认门(package.json)'; // #330 实际违约形态

function makeRun() {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'title-contract-lock-'));
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const payloadPath = join(repoDir, 'payload.json');
  return {
    shimDir, repoDir, lockDir, statePath, payloadPath,
    writePayload: (title) => writeFileSync(payloadPath, JSON.stringify({
      issueTitle: title,
      issueBody: '本 issue 由 signoff-title-contract.test.mjs 自动创建。',
      commentBody: '本 PR 待维护者确认,详情见关联 issue。',
    })),
    cleanup: () => {
      rmSync(shimDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

// ── ① 正向 e2e:合规标题走原路径 ──
test('标题契约-正向:合规前缀标题照常建 issue,held=true', () => {
  const fx = makeRun();
  try {
    fx.writePayload(VALID_TITLE);
    const r = runSignoff({
      args: ['42', '--payload-file', fx.payloadPath],
      repoDir: fx.repoDir, shimDir: fx.shimDir,
      logPath: join(fx.shimDir, 'ok.log'), statePath: fx.statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: fx.lockDir },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.parsed?.ok, true, `stdout=${r.stdout}`);
    assert.equal(r.parsed?.held, true, `合规标题必须照常 held stdout=${r.stdout}`);
    assert.equal(r.parsed?.issueCreated, true, '合规标题必须真的建出 issue');
    assert.ok(!('titleContractViolation' in (r.parsed ?? {})), '合规时不得出现违约字段');
    assert.equal(r.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 1, '恰好一次 issue create');
  } finally { fx.cleanup(); }
});

// ── ② 负向 e2e:违约标题被拒(把 #330 的实际违约标题钉死成探针)──
test('标题契约-负向:违约标题拒绝开 issue,held=false + titleContractViolation(标签照打)', () => {
  const fx = makeRun();
  try {
    fx.writePayload(VIOLATING_TITLE); // #330 实际违约形态「PR #328 触发安全确认门(…)」
    const r = runSignoff({
      args: ['42', '--payload-file', fx.payloadPath],
      repoDir: fx.repoDir, shimDir: fx.shimDir,
      logPath: join(fx.shimDir, 'bad.log'), statePath: fx.statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: fx.lockDir },
    });
    assert.equal(r.status, 0, `退出码仍 0(结果全在 JSON) stderr=${r.stderr}`);
    assert.equal(r.parsed?.ok, true, `stdout=${r.stdout}`);
    assert.equal(r.parsed?.reason, 'title-contract-violation', `stdout=${r.stdout}`);
    assert.equal(r.parsed?.held, false, '违约标题必须 held=false');
    assert.equal(r.parsed?.titleContractViolation, true, '必须点名违约字段');
    assert.equal(r.parsed?.requiredPrefix, MAINTAINER_CONFIRM_TITLE_PREFIX, '必须带 requiredPrefix 供改写重试');
    assert.equal(r.parsed?.givenTitle, VIOLATING_TITLE, '必须回带原标题便于定位');
    assert.equal(r.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 0,
      '违约时不得发起任何 issue create(不给链路埋第二颗静默雷)');
    assert.equal(r.calls.filter((c) => c[0] === 'pr' && c[1] === 'comment').length, 0,
      '违约时不得发首轮 hold 评论');
    const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
    assert.ok(state.labels.some((l) => l.pr === 42), '标签照打(门判定不受文案违约影响)');
  } finally { fx.cleanup(); }
});

// ── ②b 负向 e2e(gpt 单审 P1 mutation 探针):错号标题被拒 ──
// 处理 PR #42 却传「维护者确认 · PR #328 …」——守门若不校验 PR 号一致,会落地错误
// 标题并向维护者播报错误 PR。
test('标题契约-负向:错号标题(前缀对但 PR 号≠当前 PR)同样被拒(mutation 探针)', () => {
  const fx = makeRun();
  try {
    fx.writePayload('维护者确认 · PR #328 错号探针专用标题'); // 当前 PR 是 42,标题指向 328
    const r = runSignoff({
      args: ['42', '--payload-file', fx.payloadPath],
      repoDir: fx.repoDir, shimDir: fx.shimDir,
      logPath: join(fx.shimDir, 'wrong-pr.log'), statePath: fx.statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: fx.lockDir },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.parsed?.reason, 'title-contract-violation', `stdout=${r.stdout}`);
    assert.equal(r.parsed?.held, false, '错号标题必须 held=false');
    assert.equal(r.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 0,
      '错号标题不得落地 issue');
  } finally { fx.cleanup(); }
});

// ── ②c dry-run 探测口径(gpt 单审 P2):违约时 wouldCreateIssue/wouldComment 必须为 false ──
test('标题契约-dry-run:违约时 wouldCreateIssue/wouldComment 报 false + titleContractViolation', () => {
  const fx = makeRun();
  try {
    fx.writePayload(VIOLATING_TITLE);
    const r = runSignoff({
      args: ['42', '--payload-file', fx.payloadPath, '--dry-run'],
      repoDir: fx.repoDir, shimDir: fx.shimDir,
      logPath: join(fx.shimDir, 'dry.log'), statePath: fx.statePath,
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.parsed?.dryRun, true, '进入 dry-run 路径');
    assert.equal(r.parsed?.titleContractViolation, true, 'dry-run 也必须点名违约(不等真实执行才撞红线)');
    assert.equal(r.parsed?.wouldCreateIssue, false, '违约时 wouldCreateIssue 不得报 true(与真实行为矛盾)');
    assert.equal(r.parsed?.wouldComment, false, '违约时 wouldComment 不得报 true');
  } finally { fx.cleanup(); }
});

// ── ③ 单元:契约判定边界(gpt 单审 P1 收窄后:精确规范前缀 + PR 号必须等于当前 PR)──
test('标题契约-单元:issueTitleSatisfiesContract 边界', () => {
  assert.ok(issueTitleSatisfiesContract('维护者确认 · PR #42 标题', 42), '标准前缀 + 号匹配');
  assert.ok(issueTitleSatisfiesContract('维护者确认 · PR #42', 42), '无后续标题也通过(结尾即边界)');
  assert.ok(!issueTitleSatisfiesContract('维护者确认 · PR #328 标题', 42), '错号 P1:PR 号必须精确等于当前 PR');
  assert.ok(!issueTitleSatisfiesContract('维护者确认· PR #42 标题', 42), '空格变体 P1:下游 startsWith 不认,必须拒绝');
  assert.ok(!issueTitleSatisfiesContract('维护者确认 ·PR #42 标题', 42), '空格变体 P1:下游 startsWith 不认,必须拒绝');
  assert.ok(!issueTitleSatisfiesContract('维护者确认· PR #42 标题', 42), '点号前无空格不通过(规范前缀唯一)');
  assert.ok(!issueTitleSatisfiesContract('维护者确认 · PR#42 标题', 42), 'PR 与 # 之间必须有空白(规范前缀唯一)');
  assert.ok(!issueTitleSatisfiesContract('PR #42 触发安全确认门(package.json)', 42), '#330 实际违约形态');
  assert.ok(!issueTitleSatisfiesContract('产品讨论:PR #352 插件存图链路', 352), '#353 违约形态');
  assert.ok(!issueTitleSatisfiesContract('维护者确认 · PR #abc 标题', 42), '非数字 PR 号不通过');
  assert.ok(!issueTitleSatisfiesContract('维护者确认 · PR # 标题', 42), '缺 PR 号不通过');
  assert.ok(!issueTitleSatisfiesContract('', 42), '空串不通过');
  assert.ok(!issueTitleSatisfiesContract(null, 42), 'null 不通过');
  assert.ok(!issueTitleSatisfiesContract(undefined, 42), 'undefined 不通过');
  assert.ok(!issueTitleSatisfiesContract(123, 42), '非字符串不通过');
  assert.ok(!issueTitleSatisfiesContract('维护者确认 · PR #42 标题', undefined), '缺 pr 参数一律拒绝(fail-closed)');
  assert.equal(MAINTAINER_CONFIRM_TITLE_PREFIX, '维护者确认 · PR #', '前缀常量与云端 merge-thanks 合同一字不差');
});

// ── ④ 嫌疑检测:疑似确认门但违约 → 必须被点名(云端 ::error:: 的本地对应探针)──
test('标题契约-嫌疑:detectLikelyConfirmTitle 点名疑似确认门的违约标题', () => {
  assert.equal(detectLikelyConfirmTitle('PR #328 触发安全确认门(package.json)', 328), true, '#330 疑似形态');
  assert.equal(detectLikelyConfirmTitle('产品讨论:PR #352 插件存图链路', 352), true, '#353 疑似形态');
  assert.equal(detectLikelyConfirmTitle('维护者确认 · PR #328 标题', 328), false, '合规标题不算嫌疑');
  assert.equal(detectLikelyConfirmTitle('随便聊聊:今天天气不错', 328), false, '与 PR 无关的普通 issue 不算嫌疑');
  assert.equal(detectLikelyConfirmTitle(''), false, '空串不算嫌疑');
  assert.equal(detectLikelyConfirmTitle(null), false, 'null 不算嫌疑');
});
