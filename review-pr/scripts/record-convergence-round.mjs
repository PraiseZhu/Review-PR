#!/usr/bin/env node
// record-convergence-round.mjs — SC-C2/SC-C3 收敛状态的 CLI 入口(阶段二独立审查
// 结束、主 agent 完成对 findings 的复核之后调用;与 write-review-receipt.mjs 是
// 并行、互不替代的两次落盘——receipt 判"这个 head 干不干净"，本脚本记"这个 PR
// 跨轮收敛得怎么样")。
//
// 用法:
//   <findings JSON 数组> | node <skill-root>/scripts/record-convergence-round.mjs <PR> --head <sha> [--seed-existing-rounds <N>]
//     findings 走 stdin,形如:
//       [{"invariant":"缺少空值校验","severity":"P1","description":"...",
//         "recurrenceOfFamily":"fam-abcd1234"}, ...]
//     recurrenceOfFamily 省略 = 新家族;非空 = 主 agent(T1)认定与某历史家族同源,
//     本脚本只核验该家族在 state 里确有早于当前 head 的记录,不做语义判断。
//     --seed-existing-rounds 仅在该 PR 首次被记录时生效(D4 老 PR 保守 seed),
//     省略则不 seed(视为真正的新 PR)。
//     空数组 `[]` = 本轮 0 P0/P1,合法输入,代表收敛信号。
//
//   node <skill-root>/scripts/record-convergence-round.mjs <PR> --get
//     → 打印当前 state(含全部家族及其历史 occurrence)。主 agent 在起草本轮
//       findings 前应先跑一次,判断是否有既有家族可以引用为 recurrenceOfFamily。
//
//   node <skill-root>/scripts/record-convergence-round.mjs <PR> --mark-notified --threshold <N> --head <sha>
//     → 止损播报(经 notify-summary.mjs 或等价播报出口)发出后回写去重记录,
//       避免同一 PR、同一阈值、同一 head 被反复通知。
//
// 退出码:0 = 成功;1 = 参数不合法 / recurrenceOfFamily 引用核验失败 / 写入失败。

import { readFileSync } from 'node:fs';
import { parsePR, print, fail } from './lib.mjs';
import {
  readConvergenceState, recordConvergenceRound, markThresholdNotified,
} from './convergence-state.mjs';

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

try {
  const pr = parsePR(process.argv[2]);

  if (process.argv.includes('--get')) {
    const { status, state, error } = readConvergenceState(pr);
    print({ ok: true, pr, status, state, error });
    process.exit(0);
  }

  if (process.argv.includes('--mark-notified')) {
    const threshold = Number(argAfter('--threshold'));
    if (!Number.isInteger(threshold) || threshold <= 0) throw new Error('--mark-notified 需要 --threshold <正整数>');
    const headRefOid = argAfter('--head');
    if (!headRefOid) throw new Error('--mark-notified 需要 --head <sha>');
    const notifiedHeads = markThresholdNotified({ pr, threshold, headRefOid });
    print({ ok: true, pr, threshold, headRefOid, notifiedHeads });
    process.exit(0);
  }

  const headRefOid = argAfter('--head');
  if (!headRefOid) throw new Error('缺 --head <sha>');

  const seedArg = argAfter('--seed-existing-rounds');
  const seedRoundCount = seedArg === '' ? undefined : Number(seedArg);
  if (seedArg !== '' && (!Number.isInteger(seedRoundCount) || seedRoundCount < 0)) {
    throw new Error('--seed-existing-rounds 必须是非负整数');
  }

  let raw = '';
  if (!process.stdin.isTTY) {
    try {
      raw = readFileSync(0, 'utf8');
    } catch {
      /* stdin 不可读——按未提供 findings 处理,下面的 JSON.parse('') 会报出清晰错误 */
    }
  }
  let findings;
  try {
    findings = JSON.parse(raw || '[]');
  } catch {
    throw new Error('stdin 不是合法 JSON——请传 findings 数组(可为空数组 []),不要带 markdown 围栏');
  }

  const result = recordConvergenceRound({ pr, headRefOid, findings, seedRoundCount });
  print({ ok: true, ...result });
} catch (e) {
  fail(e);
}
