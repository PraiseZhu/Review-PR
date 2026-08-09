#!/usr/bin/env node
// signoff-release.mjs — 维护者确认门的手动通过兜底,与 signoff-hold 互为镜像:
//   1) 在 PR 上发一条带隐藏通过标记的评论,把「哪些触发类别已被谁确认」写成确定性记忆
//      (`<!-- review-pr:signoff-release gates=security,rules by=dashhuang -->`,
//      编排层每轮读它重建状态;只对标记之后的当前 head 有效);
//   2) 摘掉维护者确认标签(顺带摘掉旧标签)。
// **不再操作 draft**(旧 draft 制已废除)。
//
// 移植自 lizi 上游 signoff-release.mjs(2026-08-09),适配点同 signoff-hold.mjs。
//
// 主路径是维护者在 PR 上 GitHub Approve(编排层确定性判定,无需本脚本);本脚本只在两种
// 场景用:① 维护者明确指示通过(如当面/群里拍板)时固化成标记;② 标签状态重同步
// (labels.stale)时摘标签并把 Approve 结果固化。安全边界:
//   - 只处理「被本流程 hold 过」的 PR(必须有 signoff-hold 的隐藏标记评论),从未 hold 过
//     的 PR 没有手动通过动作(reason=not-held-by-flow);
//   - 幂等:请求的 gates 全部已有当前 head 的通过标记时不重复发评论(alreadyReleased)。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段。
//
// 跑:node <skill-root>/scripts/signoff-release.mjs <PR> --gates <kind,kind> [--by <login>]
//     [--payload-file <path|->] [--labels-only] [--dry-run]
//   --labels-only:只摘新旧确认标签,不写通过标记(Approve / Request Changes 后的状态同步);
//   --gates:本次确认通过的触发类别(逗号分隔,取值 product/arch/security/coldUpdate/rules/pluginBase),
//     只传维护者明确指示通过 / Approve 已通过待固化的类别;
//   --by:确认人的 GitHub login(写进标记与缺省文案,可溯源);
//   --payload-file:可选 JSON 文案 { "commentBody": "..." }(告知作者的通过说明,
//     {{ISSUE_URL}} 会替换成当初的讨论 issue 链接);缺省用一句朴素说明。

import { readFileSync } from 'node:fs';
import { parseRepo, parsePR, gh, ghJson, print, fail, parseLastHoldMarker, parseSignoffReleases, renderIssueUrl, SIGNOFF_RELEASE_MARKER_PREFIX, loadRules, syncSignoffLabel, SIGNOFF_LABEL_DEFAULT, removeLegacyGateLabels } from './lib.mjs';

const VALID_KINDS = new Set(['product', 'arch', 'security', 'coldUpdate', 'rules', 'pluginBase']);

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const labelsOnly = process.argv.includes('--labels-only');
  const gatesIdx = process.argv.indexOf('--gates');
  const gates = gatesIdx >= 0
    ? (process.argv[gatesIdx + 1] ?? '').split(',').map((s) => s.trim()).filter((k) => VALID_KINDS.has(k))
    : [];
  const byIdx = process.argv.indexOf('--by');
  const by = byIdx >= 0 ? (process.argv[byIdx + 1] ?? '').trim() : '';
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  const commentBody = payloadSrc
    ? (JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'))?.commentBody ?? '').trim()
    : '';
  const SIGNOFF_LABEL = (loadRules().signoffGate?.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT;

  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,state,mergedAt,author,url,comments,labels',
  ]);
  const author = meta.author?.login ?? '';
  const currentLabels = (meta.labels ?? []).map((l) => l.name);
  const commentObjs = (meta.comments ?? []).map((c) => ({ body: c.body, createdAt: c.createdAt }));
  const holdMarker = parseLastHoldMarker(commentObjs);
  const already = parseSignoffReleases(commentObjs);
  const newGates = gates.filter((k) => !already.has(k));

  // 摘维护者确认标签 + 旧标签(幂等)
  const clearLabels = () => {
    const result = syncSignoffLabel({ owner, repo, pr, want: false, label: SIGNOFF_LABEL, current: currentLabels, ghFn: gh, dryRun });
    const legacy = removeLegacyGateLabels({ owner, repo, pr, current: currentLabels, ghFn: gh, dryRun });
    if (legacy.legacyRemoved.length) result.legacyRemoved = legacy.legacyRemoved;
    if (legacy.errors.length) result.errors = [...(result.errors ?? []), ...legacy.errors];
    if (result.errors.length && !result.warning) {
      result.warning = `维护者确认标签同步没完成:${result.errors[0]}`;
    }
    return result;
  };
  // 标签失败不静默(同 signoff-hold):摘不掉 = 已通过的 PR 还挂在待确认面板上
  const printOut = (out) => print(out.labels?.warning ? { ...out, labelWarning: out.labels.warning } : out);

  if (meta.state !== 'OPEN' || meta.mergedAt) {
    print({ ok: true, pr, author, released: false, reason: 'pr-not-open', state: meta.state });
  } else if (labelsOnly) {
    // 只把外部标签同步成「当前不等维护者确认」,绝不写通过标记。
    // Approve 与 Request Changes 都走这里;真正通过仍由编排的当前 head 判定。
    printOut({ ok: true, pr, author, labelsOnly: true, released: false, labels: clearLabels() });
  } else if (gates.length === 0) {
    print({ ok: false, pr, author, released: false, reason: 'no-gates', hint: '--gates 必填,取值 product/arch/security/coldUpdate/rules/pluginBase(逗号分隔),只传维护者明确确认通过 / Approve 已通过待固化的类别' });
  } else if (!holdMarker) {
    // 从未被 hold 过 = 没有手动通过动作:确认判定本来就在编排每轮重算,直接按 fallback 继续。
    // 但标签可能因历史原因挂着 —— 顺手摘掉。
    printOut({ ok: true, pr, author, released: false, reason: 'not-held-by-flow', labels: clearLabels() });
  } else if (dryRun) {
    printOut({
      ok: true, pr, author, dryRun: true,
      gates, newGates, alreadyReleased: gates.filter((k) => already.has(k)),
      issueUrl: holdMarker.issueUrl,
      wouldComment: newGates.length > 0,
      labels: clearLabels(),
    });
  } else {
    // 1) 通过标记评论(只为尚未通过的类别发;标记是编排重建状态的确定性记忆)
    let commented = false;
    let commentError = null;
    if (newGates.length > 0) {
      const markerLine = `${SIGNOFF_RELEASE_MARKER_PREFIX} gates=${newGates.join(',')}${by ? ` by=${by}` : ''} -->`;
      const bodyText = commentBody !== ''
        ? (commentBody.includes('{{ISSUE_URL}}') ? renderIssueUrl(commentBody, holdMarker.issueUrl) : commentBody)
        : `维护者确认已通过(${newGates.join(' / ')}${by ? `,由 ${by} 确认` : ''}),PR 恢复正常推进。`;
      const r = gh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
        input: `${bodyText}\n\n${markerLine}`,
        allowFail: true,
      });
      if (r.ok) commented = true;
      else commentError = (r.stderr || '').trim().slice(0, 300);
    }

    // 2) 摘标签(评论失败不连坐;若还有别的触发在拦,下一轮 signoff-hold --labels-only 会重挂)
    const labels = clearLabels();

    printOut({
      ok: true, pr, author,
      gates,
      newGates,
      alreadyReleased: gates.filter((k) => already.has(k)),
      released: commented || newGates.length === 0,
      commented, commentError,
      issueUrl: holdMarker.issueUrl,
      labels,
      url: meta.url,
      note: '通过标记只对它之后的当前 head 有效:作者再 push 后,编排会重新判断并在仍触发时重挂标签',
    });
  }
} catch (e) {
  fail(e);
}
