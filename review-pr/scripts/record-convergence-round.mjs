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
//         "familyId":"F1","recurrenceOfKey":"某历史key"}, ...]
//     跨轮 join key 是 `invariantKey`(对 invariant 原文算 SHA-256,不截断,唯一
//     实现在 lib.review-output-shape.mjs,convergence-state.mjs 只 import,不是
//     本轮报告里的 family_id——family_id 只在单份报告内唯一,不跨轮,这里的
//     `familyId` 字段仅供回溯本轮报告,不参与匹配)。两级检测:一级由脚本自动对
//     invariant 算 key 并比对 state 历史,命中即判复发,不需要声明；二级是一级
//     未命中时,主 agent(T1)判断这是同一不变量换了说法,显式传 recurrenceOfKey
//     指向历史 key——本脚本只核验该 key 在 state 里确有早于当前 head 的记录,
//     不做语义判断。
//     --seed-existing-rounds 仅在该 PR 首次被记录时生效(D4 老 PR 保守 seed),
//     省略则不 seed(视为真正的新 PR)。
//     空数组 `[]` = 本轮 0 P0/P1,合法输入,代表收敛信号——**必须显式传**,空/纯
//     空白 stdin(接线漏传、忘了 pipe)不会被当成 `[]`,会直接报错退出且不落盘
//     (D2 阻断修正:此前 `JSON.parse(raw || '[]')` 会把漏传静默当成收敛信号)。
//
//   node <skill-root>/scripts/record-convergence-round.mjs <PR> --get
//     → 打印当前 state(含全部家族及其历史 occurrence,按 key 分组)。主 agent
//       在起草本轮 findings 前应先跑一次,取历史 invariant 原文清单供二级检测
//       语义比对,判断是否有既有 key 可以引用为 recurrenceOfKey。
//
//   node <skill-root>/scripts/record-convergence-round.mjs <PR> --mark-notified --reason <reason> --threshold <key> --head <sha>
//     → 止损播报(经 notify-summary.mjs 或等价播报出口)**确认投递成功后**回写
//       去重记录,避免同一 PR、同一触发源(reason)、同一阈值档位、同一 head 被
//       反复通知。**只在确认成功后才调这个**(D4 阻断修正:失败/`posted:false`
//       绝不能调,否则一次未送达 = 同一 head 永久静音;失败的重试不需要额外
//       机制,下一轮到了新的 head 会自然重新判定)。--reason 必填、无默认值——
//       通知投递层与触发源解耦(见 convergence-state.mjs 文件头「通知层的两层
//       拆分」),不能靠脚本自己猜是哪个触发源发的。本模块目前只有一种触发源,
//       round/new-family 场景传 `--reason round-nonconvergence`(即
//       `CONVERGENCE_NOTIFY_REASON_ROUND`)。--threshold 在 round 触发源场景下
//       就是 `CONVERGENCE_NOTIFY_THRESHOLD`(当前 10),但形式上是任意字符串
//       档位标识,不强制是数字(为未来的其它触发源留空间)。
//
//   node <skill-root>/scripts/record-convergence-round.mjs <PR> --record-attempt --reason <reason> --threshold <key> --head <sha>
//     → 无论投递成功与否,都记一次"尝试过"(D4:与 --mark-notified 完全独立、
//       互不影响,只负责运维可观测性的记账——投递失败了几次、上次什么时候试
//       的,不参与任何去重判定)。建议在**每次**决定要发通知时都调用一次(成功
//       失败都调),再按结果决定要不要额外调 --mark-notified。
//
// 退出码:0 = 成功;1 = 参数不合法 / recurrenceOfKey 引用核验失败 / stdin 为空
// 或纯空白(D2 阻断修正,见下)/ 写入失败。

import { readFileSync } from 'node:fs';
import { parsePR, print, fail } from './lib.mjs';
import {
  readConvergenceState, recordConvergenceRound, markNotified, recordNotificationAttempt,
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
    const reason = argAfter('--reason');
    if (!reason) throw new Error('--mark-notified 需要 --reason <触发源标识,如 round-nonconvergence>');
    const thresholdKey = argAfter('--threshold');
    if (!thresholdKey) throw new Error('--mark-notified 需要 --threshold <该触发源的档位标识>');
    const headRefOid = argAfter('--head');
    if (!headRefOid) throw new Error('--mark-notified 需要 --head <sha>');
    const notifiedHeads = markNotified({ pr, reason, thresholdKey, headRefOid });
    print({ ok: true, pr, reason, thresholdKey, headRefOid, notifiedHeads });
    process.exit(0);
  }

  if (process.argv.includes('--record-attempt')) {
    const reason = argAfter('--reason');
    if (!reason) throw new Error('--record-attempt 需要 --reason <触发源标识,如 round-nonconvergence>');
    const thresholdKey = argAfter('--threshold');
    if (!thresholdKey) throw new Error('--record-attempt 需要 --threshold <该触发源的档位标识>');
    const headRefOid = argAfter('--head');
    if (!headRefOid) throw new Error('--record-attempt 需要 --head <sha>');
    const attempt = recordNotificationAttempt({ pr, reason, thresholdKey, headRefOid });
    print({ ok: true, pr, reason, thresholdKey, headRefOid, attempt });
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
      /* stdin 不可读——按空处理,下面统一走「空/纯空白必须显式传 JSON」的报错 */
    }
  }
  // D2 阻断修正:此前 `JSON.parse(raw || '[]')` 会把"stdin 空/纯空白"(接线
  // 漏传 pipe、忘了传参)静默当成显式的 `[]`,退出码 0、把接线故障伪装成收敛
  // 信号。现在空/纯空白必须先在这里就 throw,绝不进入 recordConvergenceRound
  // (state 文件字节不会被这次调用改动一个字节)——只有 stdin 里**确实写着**
  // `[]`(或任何合法 JSON)才算合法输入。
  if (raw.trim() === '') {
    throw new Error(
      '缺少 stdin 输入(空或纯空白)——必须显式传 findings JSON,0 个 P0/P1 请显式'
      + '传 "[]",不能什么都不传就当作收敛信号(这会把接线漏传误判成本轮已收敛)',
    );
  }
  let findings;
  try {
    findings = JSON.parse(raw);
  } catch {
    throw new Error('stdin 不是合法 JSON——请传 findings 数组(可为空数组 []),不要带 markdown 围栏');
  }

  const result = recordConvergenceRound({ pr, headRefOid, findings, seedRoundCount });
  print({ ok: true, ...result });
} catch (e) {
  fail(e);
}
