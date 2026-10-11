#!/usr/bin/env node
// Explicit mode prevents accidental merging from review-only or an approval-only invocation.
// node finish-reviewed-pr.mjs <PR> --mode auto|review-only --review-clean
//   --lock-token <token> --expected-head <SHA> --expected-authority-digest <digest>
//   --method squash|merge|rebase [--body-file path|-] [--allow-structural-bypass]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { finishReviewedPr } from './finish-flow.mjs';
import { parseApiJson, atomicWriteJson } from './runtime-io.mjs';
import { parsePR, assertActiveReviewLock, stateFile, print, fail } from './lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return '';
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return process.argv[i + 1];
};
try {
  if (!process.argv.includes('--review-clean')) throw new Error('缺少 --review-clean，必须先独立审查通过');
  const options = { pr: parsePR(process.argv[2]), mode: arg('--mode'), head: arg('--expected-head'),
    expectedBase: arg('--expected-base'),
    expectedBaseRef: arg('--expected-base-ref'),
    authorityDigest: arg('--expected-authority-digest'), lockToken: arg('--lock-token'),
    method: arg('--method'), bodyFile: arg('--body-file'), runId: arg('--run-id'),
    allowStructuralBypass: process.argv.includes('--allow-structural-bypass') };
  if (process.argv.includes('--review-only') && options.mode !== 'review-only') throw new Error('review-only 与 --mode 冲突');
  const input = options.bodyFile === '-' ? readFileSync(0, 'utf8') : undefined;
  const result = await finishReviewedPr(options, {
    checkpoint: (state) => atomicWriteJson(arg('--result-file') || stateFile(`finish-${options.pr}.json`), state),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: async (script, args) => {
      assertActiveReviewLock(options.lockToken);
      const r = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], {
        input: script === 'approve-reviewed-pr.mjs' ? input : undefined,
        encoding: 'utf8', windowsHide: true, timeout: script === 'merge-reviewed-pr.mjs' ? 480_000 : 240_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (r.error || r.signal) return { ok: false, error: `${script}:${r.error?.message || r.signal}` };
      const value = parseApiJson(r.stdout, script);
      // Exit 2 is a structured blocked gate; any other failure cannot masquerade as success.
      if (r.status !== 0 && r.status !== 2) return { ...value, ok: false, error: value.error || `${script}:exit ${r.status}` };
      return value;
    },
  });
  print(result);
  process.exit(result.ok === false ? 1 : 0);
} catch (error) { fail(error); }
