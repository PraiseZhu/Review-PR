#!/usr/bin/env node
// signoff-release.mjs — 维护者确认门的手动通过兜底,与 signoff-hold 互为镜像:
//   1) 在 PR 上发一条带隐藏通过标记的评论,把「哪些触发类别已被谁确认」写成确定性记忆
//      (`<!-- review-pr:signoff-release gates=security,rules by=dashhuang -->`,
//      context.mjs 每轮验证评论作者、by 与最终维护者集合后重建状态;作者后续 push 不使标记失效,
//      但确认人同时离开 Team 与补充白名单后标记立即失效);
//   2) 摘掉维护者确认标签(顺带摘掉旧标签)。
// **不再操作 draft**(旧机制已废除)。
//
// 主路径是维护者在 PR 上 GitHub Approve(context.mjs 确定性判定,无需本脚本)。本脚本的
// authorizing 模式只在当前 viewer 本人明确指示手动放行时写标记；Approve / Request Changes
// 后的标签同步一律走 --labels-only,不额外制造 marker。安全边界:
//   - 只处理「被本流程 hold 过」的 PR(必须有 signoff-hold 的隐藏标记评论),从未 hold 过
//     的 PR 没有手动通过动作(reason=not-held-by-flow)——那种场景直接按 fallback 继续即可;
//   - 幂等:请求的 gates 全部已有可信且确认人仍在最终维护者集合的标记时不重复发评论。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段。
//
// 跑:node <skill-root>/scripts/signoff-release.mjs <PR> --lock-token <prepare.lock.token>
//     --gates <kind,kind> --by <当前 viewer> --expected-authority-digest <digest>
//     [--payload-file <path|->] [--close-issue] [--dry-run]
//   或:... <PR> --lock-token <token> --labels-only [--close-issue] [--dry-run]
//   --labels-only:只摘新旧确认标签,不写通过标记(Request Changes / Approve 后的状态同步);
//   --close-issue:摘标同时关闭当初 signoff-hold 开的讨论 issue(仅在 Approve 放行时使用;
//     Request Changes 不关——讨论暂停不是结束);
//   --gates:本次确认通过的触发类别(逗号分隔,取值 product/arch/security/coldUpdate/rules/pluginBase),
//     只传维护者明确指示通过 / Approve 已通过待固化的类别;
//   --by:确认人的 GitHub login(写进标记与缺省文案,可溯源);
//   --payload-file:可选 JSON 文案 { "commentBody": "..." }(告知作者的通过说明,
//     {{ISSUE_URL}} 会替换成当初的讨论 issue 链接);缺省用一句朴素说明。

import { readFileSync } from 'node:fs';
import { createPrWriteGuard } from './pr-write-guard.mjs';
import { parseRepo, parsePR, gh, ghJson, print, fail, parseLastHoldMarker, parseSignoffReleaseEvents, selectTrustedSignoffReleases, renderIssueUrl, SIGNOFF_RELEASE_MARKER_PREFIX, loadRules, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, assertActiveReviewLock, syncSignoffLabel, SIGNOFF_LABEL_DEFAULT, removeLegacyGateLabels, issueNumberFromUrl, closeDiscussIssue, toDiscussIssueCloseBody } from './lib.mjs';

const VALID_KINDS = new Set(['product', 'arch', 'security', 'coldUpdate', 'rules', 'pluginBase']);

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const labelsOnly = process.argv.includes('--labels-only');
  const lockTokenIndex = process.argv.indexOf('--lock-token');
  const lockToken = lockTokenIndex >= 0 ? String(process.argv[lockTokenIndex + 1] ?? '').trim() : '';
  assertActiveReviewLock(lockToken);
  const gatesIdx = process.argv.indexOf('--gates');
  const gates = gatesIdx >= 0
    ? (process.argv[gatesIdx + 1] ?? '').split(',').map((s) => s.trim()).filter((k) => VALID_KINDS.has(k))
    : [];
  const byIdx = process.argv.indexOf('--by');
  const by = byIdx >= 0 ? (process.argv[byIdx + 1] ?? '').trim() : '';
  const authorityIdx = process.argv.indexOf('--expected-authority-digest');
  const expectedAuthorityDigest = authorityIdx >= 0
    ? (process.argv[authorityIdx + 1] ?? '').trim()
    : '';
  const headIdx = process.argv.indexOf('--expected-head');
  const expectedHead = headIdx >= 0 ? process.argv[headIdx + 1] : '';
  const writeGh = expectedHead ? createPrWriteGuard({ owner, repo, pr, lockToken, expectedHead, expectedAuthorityDigest }) : gh;
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  const payloadJson = payloadSrc ? JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8')) : null;
  const commentBody = (payloadJson?.commentBody ?? '').trim();
  // [MIVO-PATCH protected-author-release] 关 issue 时的说明文案(自动放行关存量 protected issue 用);缺省沿用原文。
  const closeCommentBody = (payloadJson?.closeCommentBody ?? '').trim();
  const closeIssue = process.argv.includes('--close-issue');
  const SIGNOFF_LABEL = (loadRules().signoffGate?.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT;

  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,state,mergedAt,author,url,comments,labels',
  ]);
  const viewerLogin = String(gh(['api', 'user', '--jq', '.login']).stdout ?? '').trim();
  const confirmedBy = viewerLogin;
  const author = meta.author?.login ?? '';
  const currentLabels = (meta.labels ?? []).map((l) => l.name);
  const commentObjs = (meta.comments ?? []).map((c) => ({
    body: c.body,
    createdAt: c.createdAt,
    author: c.author,
  }));
  const holdMarker = parseLastHoldMarker(commentObjs, { viewerLogin });
  const releaseEvents = parseSignoffReleaseEvents(commentObjs);
  const already = new Map();
  let newGates = gates.slice();

  // 摘维护者确认标签 + 旧标签(幂等)
  const clearLabels = () => {
    assertActiveReviewLock(lockToken);
    const result = syncSignoffLabel({ owner, repo, pr, want: false, label: SIGNOFF_LABEL, current: currentLabels, ghFn: writeGh, dryRun });
    const legacy = removeLegacyGateLabels({ owner, repo, pr, current: currentLabels, ghFn: writeGh, dryRun });
    if (legacy.legacyRemoved.length) result.legacyRemoved = legacy.legacyRemoved;
    if (legacy.errors.length) result.errors = [...(result.errors ?? []), ...legacy.errors];
    if (result.errors.length && !result.warning) {
      result.warning = `维护者确认标签同步没完成:${result.errors[0]}`;
    }
    return result;
  };
  // 标签失败不静默(同 signoff-hold):摘不掉 = 已通过的 PR 还挂在待确认面板上
  const printOut = (out) => print(out.labels?.warning ? { ...out, labelWarning: out.labels.warning } : out);

  let authority = null;
  let authorityFailure = null;
  let confirmerPolicy = null;
  if (!labelsOnly && gates.length > 0) {
    try {
      authority = fetchMaintainerAuthority({ owner, repo });
      confirmerPolicy = evaluateMaintainerApprovalPolicy({ authorLogin: confirmedBy, authority });
      const selected = selectTrustedSignoffReleases(releaseEvents, authority.members);
      for (const [kind, marker] of selected.trusted) already.set(kind, marker);
      newGates = gates.filter((kind) => !already.has(kind));
      if (!expectedAuthorityDigest) authorityFailure = '缺少 --expected-authority-digest';
      else if (authority.digest !== expectedAuthorityDigest) {
        authorityFailure = `维护者权限已变化:${expectedAuthorityDigest} → ${authority.digest}`;
      } else if (!confirmedBy) authorityFailure = '无法读取当前 GitHub viewer';
      else if (by && by.toLowerCase() !== confirmedBy.toLowerCase()) {
        authorityFailure = `--by=${by} 与当前 GitHub viewer ${confirmedBy} 不一致`;
      } else if (!confirmerPolicy.authorIsMaintainer) authorityFailure = `${confirmedBy} 不在当前最终维护者集合中`;
    } catch (error) {
      authorityFailure = String(error?.message ?? error);
    }
  }

  // 关闭讨论 issue(仅在 --close-issue 且 issue 还开着时;失败不连坐标签 / 判定)
  const tryCloseIssue = () => {
    if (!closeIssue) return { issueClosed: false, issueCloseSkipped: 'flag-not-set' };
    if (!holdMarker?.issueUrl) return { issueClosed: false, issueCloseSkipped: 'no-issue-url' };
    const issueNumber = issueNumberFromUrl(slug, holdMarker.issueUrl);
    if (issueNumber == null) return { issueClosed: false, issueCloseSkipped: 'issue-url-unparsable', issueUrl: holdMarker.issueUrl };
    const issue = ghJson(['issue', 'view', String(issueNumber), '--repo', slug, '--json', 'state,url']);
    if (!issue || issue.state !== 'OPEN') return { issueClosed: false, issueAlreadyClosed: true, issueNumber };
    const body = toDiscussIssueCloseBody({ pr, url: meta.url, closeCommentBody });
    return {
      issueClosed: false, // 下面填充
      ...closeDiscussIssue({ slug, issueNumber, commentBody: body, dryRun, ghFn: writeGh }),
      issueNumber,
    };
  };

  if (meta.state !== 'OPEN' || meta.mergedAt) {
    print({ ok: true, pr, author, released: false, reason: 'pr-not-open', state: meta.state });
  } else if (labelsOnly) {
    // 只把外部标签同步成「当前不等维护者确认」,绝不写通过标记。
    // Approve 与 Request Changes 都走这里；真正通过仍由 context 按最终维护者集合的 review 历史判定。
    // --close-issue:Approve 放行时顺手把讨论 issue 关了(Request Changes 不传此标记)。
    const labels = clearLabels();
    const issueClose = tryCloseIssue();
    printOut({ ok: true, pr, author, labelsOnly: true, released: false, labels, ...issueClose });
  } else if (gates.length === 0) {
    print({ ok: false, pr, author, released: false, reason: 'no-gates', hint: '--gates 必填,取值 product/arch/security/coldUpdate/rules/pluginBase(逗号分隔),只传维护者明确确认通过 / Approve 已通过待固化的类别' });
  } else if (authorityFailure) {
    print({
      ok: false,
      pr,
      author,
      released: false,
      reason: 'maintainer-authority-unverified',
      error: authorityFailure,
      expectedAuthorityDigest: expectedAuthorityDigest || null,
      authority: authority ? {
        teamHandle: authority.codeowners.teamHandle,
        digest: authority.digest,
        memberCount: authority.memberCount,
      } : null,
      confirmerPolicy,
    });
  } else if (!holdMarker) {
    // 从未被 hold 过 = 没有手动通过动作:确认判定本来就在 context 每轮重算,直接按 fallback 继续。
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
    assertActiveReviewLock(lockToken);
    const freshAuthority = fetchMaintainerAuthority({ owner, repo });
    const freshConfirmer = evaluateMaintainerApprovalPolicy({ authorLogin: confirmedBy, authority: freshAuthority });
    if (freshAuthority.digest !== expectedAuthorityDigest || !freshConfirmer.authorIsMaintainer) {
      print({
        ok: false,
        pr,
        author,
        released: false,
        reason: 'maintainer-authority-changed-before-write',
        error: freshAuthority.digest !== expectedAuthorityDigest
          ? `写操作前维护者权限已变化:${expectedAuthorityDigest} → ${freshAuthority.digest}`
          : `写操作前 ${confirmedBy} 已不在最终维护者集合中`,
        confirmerPolicy: freshConfirmer,
      });
      process.exit(0);
    }
    // 1) 通过标记评论(只为尚未通过的类别发;标记是 context 重建状态的确定性记忆)
    let commented = false;
    let commentError = null;
    if (newGates.length > 0) {
      const markerLine = `${SIGNOFF_RELEASE_MARKER_PREFIX} gates=${newGates.join(',')} by=${confirmedBy} -->`;
      const bodyText = commentBody !== ''
        ? (commentBody.includes('{{ISSUE_URL}}') ? renderIssueUrl(commentBody, holdMarker.issueUrl) : commentBody)
        : `维护者确认已通过(${newGates.join(' / ')},由 ${confirmedBy} 确认),PR 恢复正常推进。`;
      assertActiveReviewLock(lockToken);
      const r = writeGh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
        input: `${bodyText}\n\n${markerLine}`,
        allowFail: true,
        noCredFallback: true,
      });
      if (r.ok) commented = true;
      else commentError = (r.stderr || '').trim().slice(0, 300);
    }

    // 2) 摘标签(评论失败不连坐;若还有别的触发在拦,下一轮 signoff-hold --labels-only 会重挂)
    const labels = clearLabels();

    // 3) 关闭讨论 issue(--close-issue 时)
    const issueClose = tryCloseIssue();

    printOut({
      ok: true, pr, author,
      gates,
      newGates,
      alreadyReleased: gates.filter((k) => already.has(k)),
      released: commented || newGates.length === 0,
      commented, commentError,
      issueUrl: holdMarker.issueUrl,
      labels,
      ...issueClose,
      note: '通过标记持久有效:作者再 push 后,context.mjs 不再重新亮门。讨论 issue 在 Approve 放行时一并关闭。',
    });
  }
} catch (e) {
  fail(e);
}
