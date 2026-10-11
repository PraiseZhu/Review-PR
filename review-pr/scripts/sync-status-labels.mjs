#!/usr/bin/env node
// sync-status-labels.mjs — 把「展示标签」(status:* / touches:*)同步到 context.mjs 算出的目标状态。
//
// 定位:**纯展示,不参与任何判定。** 合并前防线(pre-merge-check.mjs)只认维护者确认标签
// awaiting-discussion 与 LEGACY_GATE_LABELS;本脚本贴上 / 贴不上 / 贴错都不改变任何 PR 的
// 「能不能合并」。所以它的失败按低优先级处理:如实写一行进汇总即可,不进「⚠️ 异常」组
// (那一组留给真的会改变结论的异常,别被展示标签的噪音挤下去)。
//
// 判定不在这里:该挂什么全由 context.mjs 的 statusLabels.desired 给出(单一真相源,
// 判定纯函数在 lib.mjs computeDisplayLabels,单测在 status-labels.test.mjs)。
// 本脚本只做三件确定性的事:确保标签在仓库里存在且颜色 / 描述与注册表一致(不一致就
// gh label edit 纠过来 —— 改了配色不纠色的话线上永远是老颜色)、加该加的、摘该摘的。
//
// 只增删「受管标签」(lib.mjs DISPLAY_LABELS,pr-rules.json statusLabels.labels 可覆盖 /
// 单独关掉)。维护者确认标签、人工手挂的任何标签一概不碰。
//
// 用法:
//   node <skill-root>/scripts/sync-status-labels.mjs <PR> --desired "status:ci-running,touches:core"
//     → 同步到这份目标状态。desired 为空表示「一个都不该挂」,必须显式传 --desired ""。
//   node <skill-root>/scripts/sync-status-labels.mjs <PR> --clear-status
//     → 只摘 status:* (合并 / 关闭后用:PR 已经落地,再挂「等 CI」是误导),touches:* 留着。
//   可选:--current "a,b"  跳过读当前标签(调用方已有 context 的 statusLabels.current 时用,
//                         省一次 API;不传就自己读一次,更稳)
//         --dry-run       只算不写
//         --ensure        强制重跑「标签存在 + 颜色对不对」检查(平时每仓库每 24h 一次,
//                         结果缓存在状态目录;改了 DISPLAY_LABELS 的颜色会自动让缓存失效,
//                         只有想立刻纠色、不等下一条 PR 时才需要手动传)
//
// 输出:{ ok, pr, desired, added, removed, kept, ensure, errors, warning? }。恒 exit 0
// (脚本自身出错才 1)——展示标签不该有能力中断任何流程。

import { parseRepo, parsePR, gh, ghJson, print, fail, loadRules, loadDisplayLabelConfig, syncDisplayLabels, ensureDisplayLabelsExist } from './lib.mjs';

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}
function hasFlag(flag) {
  return process.argv.includes(flag);
}
function splitList(s) {
  return String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

try {
  const pr = parsePR(process.argv[2]);
  const { owner, repo } = parseRepo();
  const dryRun = hasFlag('--dry-run');
  const clearStatus = hasFlag('--clear-status');
  const cfg = loadDisplayLabelConfig(loadRules());

  if (!cfg.enabled) {
    print({ ok: true, pr, skipped: 'disabled', note: '展示标签已在 pr-rules.json statusLabels.enabled 关闭,不做任何标签操作' });
    process.exit(0);
  }
  if (!clearStatus && process.argv.indexOf('--desired') < 0) {
    throw new Error('需要 --desired "<逗号分隔>"(照抄 context.mjs 的 statusLabels.desired;一个都不该挂时显式传空串),或 --clear-status');
  }

  // 当前标签:调用方给了就用(省一次 API),否则自己读一次
  const current = process.argv.indexOf('--current') >= 0
    ? splitList(argAfter('--current'))
    : ((ghJson(['pr', 'view', String(pr), '--repo', `${owner}/${repo}`, '--json', 'labels'])?.labels ?? []).map((l) => l.name));

  // --clear-status:只摘 status:*,touches:* 原样留下(它是 diff 事实,合并后仍然成立)
  const desired = clearStatus
    ? current.filter((n) => cfg.registry[n]?.group === 'touches')
    : splitList(argAfter('--desired')).filter((n) => cfg.managed.includes(n));

  // 确保仓库里的标签定义存在且颜色 / 描述对得上。**不按「本轮是否新加标签」跳过**:
  // 改了 DISPLAY_LABELS 的配色后,如果这条 PR 恰好只摘不加,就永远轮不到纠色。
  // 真实成本被 ensure 内部的指纹缓存兜住了(每仓库每 24h 一次 label list,配色一改指纹
  // 就变、下一条 PR 立刻重跑),所以这里无条件调,只有 --dry-run 不发请求。
  const ensure = dryRun
    ? { ensured: true, created: [], recolored: [], existing: 0, errors: [], skipped: 'dry-run' }
    : ensureDisplayLabelsExist({ owner, repo, registry: cfg.registry, ghFn: gh, force: hasFlag('--ensure') });

  const result = syncDisplayLabels({
    owner, repo, pr, desired, managed: cfg.managed, current, ghFn: gh, dryRun,
  });

  const errors = [...(ensure.errors ?? []), ...result.errors];
  const out = {
    ok: true,
    pr,
    desired,
    added: result.added,
    removed: result.removed,
    kept: result.kept,
    changed: result.changed,
    dryRun, // 本次是不是只算不写(与 result.changed 无关,别用 result.dryRun —— 无变化时它不返回)
    ensure,
    errors,
    note: '展示标签只做展示:errors 非空 = 有标签没贴上 / 没摘掉,如实写一行进汇总即可,不进「⚠️ 异常」组、不改变任何门的判定。报错照抄原文第一行,别概括成「无权限」(见 SKILL 3.4 的排查纪律)',
  };
  print(errors.length ? { ...out, warning: `展示标签同步不完整:${errors[0]}` } : out);
} catch (e) {
  fail(e);
}
