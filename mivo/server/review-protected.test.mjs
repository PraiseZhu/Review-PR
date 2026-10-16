// 受保护路径的人工放行:服务器写 review-pr check(标题写明谁、用什么方式放行),不写 issue;
// 服务器复核没认到放行时回 protected + retry,Mini 补上前置提醒回执后整轮汇总不会抛错。gh 用 PATH 上的替身记录调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectRoundResults } from '../../review-pr/scripts/review-round.mjs';
import { withProtectedAuthorNotice } from '../lib/gates.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SHA = 'a'.repeat(40);

function fakeGh(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
process.stdout.write(JSON.stringify({ id: 5 }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

function setup({ mode, phase = 'prepared', protectedApproval = null, early = null }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-protected-'));
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 971, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode, action: 'protected-approve', skillSha: SHA, runId: '42', runUrl: '' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase, warnings: [], errors: [],
    context: { url: 'https://github.com/o/r/pull/971', evidence: { head: SHA, base: SHA, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', protectedFiles: true },
    ...(protectedApproval ? { protectedApproval } : {}), ...(early ? { early } : {}) }));
  return work;
}

function publish(work, gh) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${gh.bin}${delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [REVIEW, 'publish'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
}

const planFor = (result) => ({ runId: result.runId, mode: 'review-only', repo: 'o/r', groups: [{ prs: [{ pr: 971, head: SHA }] }], skipped: [],
  manifest: { snapshot: [{ number: 971, head: SHA, isDraft: false }], candidates: [{ number: 971 }], skipped: [] } });

test('live:review-pr 写 success,标题写明谁、用什么方式放行;不写任何 issue;汇总能收下', () => {
  const cases = [
    ['kirozeng', 'slack-release', 'Slack「同意放行」'],
    ['aj0928', 'issue-comment', '确认 issue 评论「同意放行」'],
    ['kirozeng', 'github-approve', 'GitHub Approve'],
  ];
  for (const [by, via, text] of cases) {
    const work = setup({ mode: 'live', protectedApproval: { by, via, at: '2026-10-16T01:00:00Z', fingerprint: `${via}:${by}:fp` } });
    const gh = fakeGh(work);
    try {
      const result = publish(work, gh);
      assert.equal(result.outcome, 'protected');
      assert.equal(result.reason, `受保护路径:由 ${by} 人工审核放行(${text})`);
      assert.equal(result.authorNotice.fingerprint, `manual:${via}:${by}:fp`);
      const calls = gh.calls();
      const check = calls.find((c) => c.args.includes('repos/o/r/check-runs'));
      assert.ok(check?.args.includes('POST'), '新建 check run');
      const body = JSON.parse(check.input);
      assert.equal(body.name, 'review-pr');
      assert.equal(body.conclusion, 'success');
      assert.equal(body.output.title, `受保护路径:由 ${by} 人工审核放行(${text})`);
      assert.match(body.output.summary, /批一次一直有效/);
      assert.ok(!calls.some((c) => c.args[0] === 'issue' || c.args.some((a) => /\/issues\//.test(String(a)))), '服务器不写 issue');
      const payload = collectRoundResults(planFor(result), [{ ...result, reason: result.reason }]);
      assert.equal(payload.processed[0].outcome, 'protected');
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});

test('dry-run:不写 check,也不写 issue', () => {
  const work = setup({ mode: 'dry-run', protectedApproval: { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'github-approve:kirozeng:' } });
  const gh = fakeGh(work);
  try {
    const result = publish(work, gh);
    assert.equal(result.outcome, 'protected');
    assert.deepEqual(gh.calls().filter((c) => c.args.includes('POST') || c.args.includes('PATCH') || c.args[0] === 'issue'), []);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('服务器复核没认到放行:回 protected + retry,不写 check;Mini 补上前置提醒回执后整轮汇总不抛错', () => {
  const work = setup({ mode: 'live', phase: 'done-early', early: { outcome: 'protected', retry: true,
    reason: '受保护路径:服务器复核没认到作者之外的维护者放行(Approve、Slack 或确认 issue「同意放行」)' } });
  const gh = fakeGh(work);
  try {
    const result = publish(work, gh);
    assert.equal(result.outcome, 'protected');
    assert.equal(result.retry, true);
    assert.equal(result.authorNotice, undefined, '服务器不带提醒回执');
    assert.deepEqual(gh.calls().filter((c) => c.args.includes('check-runs')), [], '没认到放行就不写 check');
    // 不补回执:整轮汇总抛错(旧行为)
    assert.throws(() => collectRoundResults(planFor(result), [{ ...result, reason: result.reason }]), /受保护路径作者提醒尚无有效终态/);
    // 沿用前置判门这一轮的回执
    const gateNotice = { kind: 'protected-path', status: 'posted', head: SHA, reason: 'posted', fingerprint: 'f'.repeat(64) };
    const filled = withProtectedAuthorNotice(result, { gateResult: { authorNotice: gateNotice }, head: SHA });
    assert.deepEqual(filled.authorNotice, gateNotice);
    assert.equal(collectRoundResults(planFor(result), [filled]).processed[0].outcome, 'protected');
    // 回执丢了(中断恢复):记失败并重试,汇总同样能收下
    const lost = withProtectedAuthorNotice(result, { gateResult: null, head: SHA });
    assert.equal(lost.authorNotice.status, 'failed');
    assert.equal(lost.retry, true);
    assert.equal(collectRoundResults(planFor(result), [lost]).processed[0].outcome, 'protected');
    // 已有回执、非 protected 结果都不动
    assert.equal(withProtectedAuthorNotice({ ...result, authorNotice: gateNotice }, { gateResult: null, head: SHA }).authorNotice, gateNotice);
    assert.equal(withProtectedAuthorNotice({ outcome: 'error' }, { head: SHA }).authorNotice, undefined);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('接线:服务器复核读自己重跑的 context.protectedPath,不再查绑定 head 的 Approve,也不写 issue', () => {
  const source = readFileSync(REVIEW, 'utf8');
  assert.match(source, /const release = ctx\.protectedPath\?\.released;/);
  assert.match(source, /ctx\.protectedPath\?\.waitingForAuthor \|\| !release\?\.by/);
  assert.doesNotMatch(source, /findHeadApproval/);
  assert.doesNotMatch(source, /signoff-release\.mjs/, '关 issue 由 Mini 做');
});
