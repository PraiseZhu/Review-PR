// 阶段二审查回执并发安全回归测试(P1-2 三审修复)—— 真实多进程并发,不是同进程内
// async 模拟。Node 的同步 fs 调用(writeFileSync/renameSync)在单进程内本就不会触发
// OS 级竞态(事件循环单线程,同步调用之间不会交错),必须真正起多个独立进程、让它们的
// 系统调用在内核层面交错,才能验证"整份读改写"的旧 bug 与"per-PR 文件 + atomic
// rename"的新设计之间的真实差异。
//
// 旧实现(单文件 review-receipts.json,读改写整份覆盖)在审核方实测中 40 并发只有约
// 12 个 PR 的回执存活;更危险的是,某 PR 刚写入的新 dirty 状态可能被另一个仍持有旧
// 整份快照的进程写自己的 PR 时一并覆盖,复活该 PR 更早的 clean 状态。
//
// 新实现每个 PR 一个独立文件(review-receipt-<pr>.json),PR 之间物理隔离,写入走
// "唯一临时文件 + renameSync"。本文件验证:① 40 个不同 PR 真实并发写,一个不丢;
// ② 某 PR 已有最新 dirty 时,其它 PR 的并发写不能把它的旧 clean 复活。
//
// 跑:node --test review-pr/tests/lib.review-receipt-concurrency.test.mjs
// 注:会真实 spawn 多个 node 子进程,比其余纯函数单测慢(数百 ms ~ 数秒),这是"真实
// 多进程并发"这一要求本身决定的,不是测试写法问题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_PATH = fileURLToPath(new URL('../scripts/lib.mjs', import.meta.url));

/** spawn 一个真实 node 子进程执行给定 ESM 代码,env 用于注入 REVIEW_PR_STATE_DIR。 */
function spawnNode(code, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (exitCode) => {
      if (exitCode === 0) resolvePromise(stdout);
      else reject(new Error(`子进程退出码 ${exitCode}: ${stderr || '(无 stderr)'}`));
    });
    child.on('error', reject);
  });
}

function spawnWrite(stateDir, { pr, headRefOid, verdict, p0p1Count }) {
  const code = `
    import { writeReviewReceipt } from ${JSON.stringify(LIB_PATH)};
    // SC-R1b:clean 必带五项绑定(本测试只关心并发写不丢,绑定用固定测试值;dirty 也带,无害)
    const B = { source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'oh1-t', snapshotHash: 'snap1-t', ledgerHash: 'lh1-t' };
    writeReviewReceipt({ pr: ${pr}, headRefOid: ${JSON.stringify(headRefOid)}, verdict: ${JSON.stringify(verdict)}, p0p1Count: ${p0p1Count}, bindings: B });
  `;
  return spawnNode(code, { REVIEW_PR_STATE_DIR: stateDir });
}

/** 用一个独立子进程批量读回一组 PR 的回执,避免复用本测试进程自己的(不同 STATE_DIR)lib.mjs 实例。 */
async function readAllViaChild(stateDir, prs) {
  const code = `
    import { readReviewReceipt } from ${JSON.stringify(LIB_PATH)};
    const prs = ${JSON.stringify(prs)};
    const result = {};
    for (const pr of prs) result[pr] = readReviewReceipt(pr);
    process.stdout.write(JSON.stringify(result));
  `;
  const stdout = await spawnNode(code, { REVIEW_PR_STATE_DIR: stateDir });
  return JSON.parse(stdout);
}

test('P1-2 核心场景 1/2:40 个不同 PR 真实多进程并发写入,一个不丢(旧实现 40 并发只活 12)', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'review-pr-concurrency-'));
  try {
    const N = 40;
    const writes = Array.from({ length: N }, (_, i) => ({
      pr: 920000 + i,
      headRefOid: `sha-${i}`,
      verdict: 'clean',
      p0p1Count: 0,
    }));
    const settled = await Promise.allSettled(writes.map((w) => spawnWrite(stateDir, w)));
    const failed = settled.filter((s) => s.status === 'rejected');
    if (failed.length > 0) {
      t.diagnostic(`写入阶段失败 ${failed.length}/${N}: ${failed.map((f) => f.reason?.message).join(' | ')}`);
    }
    assert.equal(failed.length, 0, `所有 ${N} 个并发写入子进程本身都应成功退出`);

    const prs = writes.map((w) => w.pr);
    const receipts = await readAllViaChild(stateDir, prs);
    const missing = writes.filter((w) => !receipts[w.pr]);
    const wrong = writes.filter((w) => receipts[w.pr] && receipts[w.pr].headRefOid !== w.headRefOid);
    if (missing.length > 0) t.diagnostic(`丢失的 PR: ${missing.map((w) => w.pr).join(',')}`);
    if (wrong.length > 0) t.diagnostic(`内容错误的 PR: ${wrong.map((w) => w.pr).join(',')}`);
    assert.equal(missing.length, 0, `${N} 个并发写入的 PR 回执一个都不能丢失(per-PR 文件物理隔离,不再有共享文件覆盖)`);
    assert.equal(wrong.length, 0, '每个 PR 读回的 headRefOid 必须与该 PR 自己写入的值一致,不能被别的 PR 的写入污染');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('P1-2 核心场景 2/2:某 PR 已有最新 dirty 回执时,其它 PR 的并发写入不能让它的旧 clean 复活', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'review-pr-concurrency-'));
  try {
    const TARGET_PR = 930000;
    // 1) 先落一份"更早的" clean 回执(模拟这个 PR 曾经被判定过 clean)。
    await spawnWrite(stateDir, { pr: TARGET_PR, headRefOid: 'sha-old-clean', verdict: 'clean', p0p1Count: 0 });

    // 2) 目标 PR 的最新 dirty 回执,与一大批"其它 PR"的并发写入同时发生(同一批 auto
    //    审查里,多个 PR 几乎同时落回执是常态)。旧的单文件共享 RMW 设计下,任何一个
    //    仍持有"目标 PR 还是 clean"这份旧整份快照的其它 PR 写入,回写时都可能把目标 PR
    //    的键覆盖回旧 clean——这正是审核方指出的"旧 clean 复活"。
    const otherWrites = Array.from({ length: 20 }, (_, i) => ({
      pr: 930001 + i,
      headRefOid: `sha-other-${i}`,
      verdict: 'clean',
      p0p1Count: 0,
    }));
    const targetDirtyWrite = spawnWrite(stateDir, {
      pr: TARGET_PR, headRefOid: 'sha-new-dirty', verdict: 'dirty', p0p1Count: 3,
    });
    const settled = await Promise.allSettled([
      targetDirtyWrite,
      ...otherWrites.map((w) => spawnWrite(stateDir, w)),
    ]);
    const failed = settled.filter((s) => s.status === 'rejected');
    if (failed.length > 0) {
      t.diagnostic(`写入阶段失败 ${failed.length}: ${failed.map((f) => f.reason?.message).join(' | ')}`);
    }
    assert.equal(failed.length, 0, '所有并发写入子进程本身都应成功退出');

    const receipts = await readAllViaChild(stateDir, [TARGET_PR, ...otherWrites.map((w) => w.pr)]);
    assert.equal(
      receipts[TARGET_PR]?.verdict,
      'dirty',
      `目标 PR 最新的 dirty 回执不能被其它 20 个 PR 的并发写入复活成旧 clean(实际读到: ${JSON.stringify(receipts[TARGET_PR])})`,
    );
    assert.equal(receipts[TARGET_PR]?.headRefOid, 'sha-new-dirty');
    for (const w of otherWrites) {
      assert.equal(receipts[w.pr]?.headRefOid, w.headRefOid, `其它 PR ${w.pr} 自己的写入也必须正确落地,不能互相覆盖`);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
