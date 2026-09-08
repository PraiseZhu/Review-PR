#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { currentReviewIdentity, dispatchReview, assertReviewIdentity, assertReviewArtifactPaths } from './lib.review-identity.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
try {
  const taskFile = arg('--task');
  const out = arg('--out-task') || taskFile;
  const agent = arg('--agent');
  const provider = arg('--provider');
  const isolation = arg('--isolation');
  if (!taskFile || !out || !agent || !provider || !isolation) throw new Error('用法:dispatch-review.mjs --task TASK --out-task TASK --agent AGENT --provider PROVIDER --isolation worktree');
  const identity = currentReviewIdentity({ explicitRoot: arg('--repo-root') });
  assertReviewArtifactPaths(identity, [taskFile, out]);
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  const pr = Number(task.pr);
  if (!Number.isInteger(pr) || pr <= 0 || !task.snapshotHash) throw new Error('task 缺 pr 或 snapshotHash');
  assertReviewIdentity(task.executionIdentity, identity);
  const receipt = dispatchReview({ pr, snapshotHash: task.snapshotHash, identity, agent, provider, isolation });
  writeFileSync(out, `${JSON.stringify({ ...task, dispatchReceipt: receipt }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, receiptId: receipt.receiptId })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
