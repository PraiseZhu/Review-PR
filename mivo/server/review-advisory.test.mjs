// 只缺界面证据 / 只剩机器人 thread 时,代码照审;没有 P0/P1 也只以评论发报告,不 Approve、不挂 merge-ready,
// review-pr check 留在进行中(2026-10-15:#926/#927/#935 因这两道门零审查被强合)。gh 用 PATH 上的替身记录调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectRoundResults } from '../../review-pr/scripts/review-round.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SHA = 'a'.repeat(40);
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1。'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');

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
if (args.includes('--paginate')) { process.stdout.write('[[]]'); process.exit(0); }
if (args.includes('DELETE')) { process.stderr.write('HTTP 404 Label does not exist'); process.exit(1); }
process.stdout.write(JSON.stringify({ id: 5 }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

function setup({ mode, pendingGates, findings = [] }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-advisory-'));
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode, action: 'review', skillSha: SHA, runId: '42', runUrl: '' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
      evidence: { head: SHA, base: SHA, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates,
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] } }));
  writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: findings.length ? REPORT.replace('pass —— 没有 P0/P1。', 'changes-requested —— 1 条 P0/P1') : REPORT, findings }));
  return work;
}

function publish(work, gh) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${gh.bin}${delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [REVIEW, 'publish'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
}

test('缺界面证据但代码干净:评论发报告、不 Approve、check 留在进行中', () => {
  const work = setup({ mode: 'live', pendingGates: ['ui-evidence'] });
  const gh = fakeGh(work);
  try {
    const result = publish(work, gh);
    assert.equal(result.outcome, 'format');
    assert.equal(result.reviewed, true);
    assert.equal(result.reviewClean, false, 'Mini 不能把这个 head 记成审查通过');
    assert.equal(result.approval.code, 'gates-pending');
    assert.deepEqual(result.mivo.advisory.pendingGates, ['ui-evidence']);
    assert.match(result.reason, /代码审查没有 P0\/P1,但还不能放行:PR 描述里还缺改动后的界面证据/);
    const calls = gh.calls();
    const review = calls.find((c) => c.args.includes('repos/o/r/pulls/7/reviews') && c.args.includes('POST'));
    const body = JSON.parse(review.input);
    assert.equal(body.event, 'COMMENT');
    assert.match(body.body, /^> \*\*代码审查没有发现 P0\/P1,但这个 PR 还不能放行\*\*/);
    assert.match(body.body, new RegExp(`<!-- mivo-review:advisory head=${SHA} -->$`));
    assert.doesNotMatch(body.body, /mivo-review:report/, '不带干净报告标记,盯梢不会当成放行');
    assert.ok(!calls.some((c) => c.args.some((a) => /finish-reviewed-pr|APPROVE/.test(a)) || c.input.includes('"APPROVE"')));
    assert.ok(!calls.some((c) => c.args.includes('labels[]=review:merge-ready')), '不挂 merge-ready');
    const check = calls.find((c) => c.args.includes('repos/o/r/check-runs/99'));
    const checkBody = JSON.parse(check.input);
    assert.equal(checkBody.status, 'in_progress');
    assert.equal(checkBody.conclusion, undefined);
    assert.match(checkBody.output.title, /代码审查没有 P0\/P1\(standard\),等补齐后放行/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('只剩机器人 thread 时 outcome 是 merge-blocked;有 P0/P1 照常打回', () => {
  const clean = setup({ mode: 'dry-run', pendingGates: ['bot-threads'] });
  const dirty = setup({ mode: 'dry-run', pendingGates: ['bot-threads'], findings: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: '[P1] 事实 / 影响 / 建议修复 / 验证方式', deferredTo: null }] });
  try {
    const a = publish(clean, fakeGh(clean));
    assert.equal(a.outcome, 'merge-blocked');
    assert.match(a.reason, /机器人.*没有 resolve.*dry-run/);
    const b = publish(dirty, fakeGh(dirty));
    assert.equal(b.outcome, 'findings');
  } finally { rmSync(clean, { recursive: true, force: true }); rmSync(dirty, { recursive: true, force: true }); }
});

// 轮次汇总(finalize)要能收下这两种结果:进了审查、没放行、不是「前置门没过」的结论。
test('送审不放行的结果能通过轮次汇总的校验', () => {
  for (const pendingGates of [['ui-evidence'], ['bot-threads'], ['ui-evidence', 'bot-threads']]) {
    const work = setup({ mode: 'dry-run', pendingGates });
    try {
      const result = publish(work, fakeGh(work));
      const plan = { runId: result.runId, mode: 'review-only', repo: 'o/r', groups: [{ prs: [{ pr: 7, head: SHA }] }], skipped: [],
        manifest: { snapshot: [{ number: 7, head: SHA, isDraft: false }], candidates: [{ number: 7 }], skipped: [] } };
      const payload = collectRoundResults(plan, [{ ...result, reason: result.reason || result.outcome }]);
      assert.equal(payload.processed[0].outcome, result.outcome, JSON.stringify(pendingGates));
      assert.equal(payload.processed[0].enteredReview, true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});
