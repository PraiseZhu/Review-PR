#!/usr/bin/env node
// pre-merge-check.mjs — 合并前确定性 gate(只读,对应 skill 3A「合并前状态复核」)
//
// 复核两件事:(1)GitHub 自身的可合并状态(state / mergeable / mergeStateStatus);
// (2)所有 review thread 是否都已 resolve(对应 1.6.5 通过标准第 1 条,双保险——
// GitHub 分支保护不一定开了 require-conversation-resolution,不复核就会漏)。
// 新增:(3)区分 BLOCKED 原因——awaiting-approval / ci-failed / ci-pending / structural-check
// (reviewDecision + workflow run 分类 + ruleset 探测,与 context.mjs 同口径)。
//   - structural-check:review+已跑 CI 都过、仍 BLOCKED,卡在永不上报的必需检查门
//     (code_scanning/code_quality 等)。canMerge 仍判 false(普通 merge 过不了),但带出
//     structuralBypassAvailable / canBypass,供 3A 决定是否走 admin bypass 合(见 SKILL 3A)。
// 新增(2026-08-04):(4)CI 总门——**CI 全绿才可合并,required 与非 required 一视同仁**。
// 无条件读双源(statusCheckRollup 全覆盖 + actions/runs 兜底,判定在 lib.mjs
// evaluateCiStatus),独立于 mergeStateStatus 押 blocker。堵三个洞:① 非 required 的红 CI
// 只给 UNSTABLE 不给 BLOCKED,旧逻辑完全不设防;② selfMerge(--admin)在 awaiting-approval
// 分支提前定类,CI 分类永远不执行,admin 合并会把挂着的 required CI 一起绕掉;③ 非 Actions
// 的外部 required check 失败会被误判成 structural-check 进而被 bypass。CI 状态读不到
// (ci.status=unknown)同样不得视为通过。CI 没过时调用方必须把 ci.failed/ci.reason
// 名单如实提示用户,不合并。
//
// 退出码:0 = canMerge;2 = 有 blocker;1 = 脚本自身出错。
// 跑:node <skill-root>/scripts/pre-merge-check.mjs <PR> --expected-head <sha>
//     --expected-authority-digest <digest>
// 所有作者都必须传已审查 head SHA 与 authority digest;任一缺失/变化时所有 merge route 都不可用。

import { parseRepo, parsePR, ghJson, ghGraphql, gh, classifyHeadChecks, fetchCiRollup, fetchCheckRunsWithApps, classifyRollupContexts, evaluateCiStatus, fetchStaleRebase, probeBranchProtection, loadRules, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, evaluateApprovalExemption, evaluateMaintainerReview, isApprovalPendingReviewDecision, evaluateNormalMergeAvailable, evaluateApprovalExemptAdminMerge, evaluateAdminBranchRules, fetchAllReviewThreads, latestSubstantiveReviews, print, fail, evaluateBotSettleSinceReady, toHeadPushedAt, botCheckActivity, matchPathPatterns, SIGNOFF_LABEL_DEFAULT, LEGACY_GATE_LABELS } from './lib.mjs';
import { REVIEW_CHANGES_REQUESTED_BLOCKER } from './merge-retry.mjs';
import { filterIgnoredCiContexts, ciMergeStateIgnoring } from './lib.mjs'; // [MIVO-PATCH ci-ignore]

const META_QUERY = `
  query($owner:String!,$repo:String!,$num:Int!){
    viewer{ login }
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        author{ login }
        commits(last:1){ nodes{ commit{ committedDate } } }
      }
    }
  }`;

function fetchRestPages(endpoint) {
  const result = gh([
    'api', '--method', 'GET', '--paginate', '--slurp', endpoint, '-f', 'per_page=100',
  ], { allowFail: true, timeoutMs: 20_000 });
  if (!result.ok) {
    return { items: [], verified: false, error: (result.stderr || result.stdout || '').trim().slice(0, 300) || 'REST 读取失败' };
  }
  try {
    const pages = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      return { items: [], verified: false, error: 'REST 分页结果形状异常' };
    }
    return { items: pages.flat(), verified: true, error: null };
  } catch (error) {
    return { items: [], verified: false, error: `REST 分页 JSON 解析失败:${error.message}` };
  }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const rules = loadRules();
  const expectedHeadIndex = process.argv.indexOf('--expected-head');
  const expectedHead = expectedHeadIndex >= 0 ? String(process.argv[expectedHeadIndex + 1] ?? '').trim() : '';
  const baseIndex = process.argv.indexOf('--expected-base');
  const expectedBase = baseIndex >= 0 ? String(process.argv[baseIndex + 1] ?? '').trim() : '';
  const baseRefIndex = process.argv.indexOf('--expected-base-ref');
  const expectedBaseRef = baseRefIndex >= 0 ? String(process.argv[baseRefIndex + 1] ?? '').trim() : '';
  const expectedAuthorityIndex = process.argv.indexOf('--expected-authority-digest');
  const expectedAuthorityDigest = expectedAuthorityIndex >= 0
    ? String(process.argv[expectedAuthorityIndex + 1] ?? '').trim()
    : '';

  const slug = `${owner}/${repo}`;
  const m = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,baseRefOid,labels,files',
  ]);
  const headVerified = expectedHead !== '' && expectedHead.toLowerCase() === String(m.headRefOid ?? '').toLowerCase();
  const baseVerified = (!expectedBase || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedBase) &&
    expectedBase.toLowerCase() === String(m.baseRefOid ?? '').toLowerCase()) &&
    (!expectedBaseRef || expectedBaseRef === m.baseRefName);
  // reviewDecision 作判 BLOCKED 原因的权威信号(比 some(state===CHANGES_REQUESTED) 准:它按
  // 每个 reviewer 的「最新」review 算 —— approve-reviewed-pr 覆盖掉自己旧的 CHANGES_REQUESTED 后会变
  // APPROVED,不会被历史那条残留 CR 误判成「仍有未解决 CR」而反复拦死)。

  const data = ghGraphql(META_QUERY, { owner, repo, num: pr });
  const viewerLogin = data?.data?.viewer?.login ?? '';
  const prNode = data?.data?.repository?.pullRequest;
  const prAuthor = prNode?.author?.login ?? '';
  const headCommittedDate = prNode?.commits?.nodes?.[0]?.commit?.committedDate ?? '';

  let maintainerAuthority = null;
  let authorityError = null;
  try {
    maintainerAuthority = fetchMaintainerAuthority({ owner, repo });
    if (!expectedAuthorityDigest) {
      authorityError = '缺少 --expected-authority-digest';
    } else if (maintainerAuthority.digest !== expectedAuthorityDigest) {
      authorityError = `维护者权限已变化:${expectedAuthorityDigest} → ${maintainerAuthority.digest}`;
    }
  } catch (error) {
    authorityError = String(error?.message ?? error);
  }
  const approvalPolicy = evaluateMaintainerApprovalPolicy({
    authorLogin: prAuthor,
    viewerLogin,
    authority: maintainerAuthority,
  });
  const approvalExemption = evaluateApprovalExemption({
    authorLogin: prAuthor,
    authority: maintainerAuthority,
  });
  const reviewActivity = fetchRestPages(`repos/${slug}/pulls/${pr}/reviews`);
  const reviewSnapshot = { verified: reviewActivity.verified, latest: reviewActivity.verified
    ? latestSubstantiveReviews(reviewActivity.items).map((review) => ({ reviewId: String(review.id),
      reviewer: review.user?.login ?? '', state: review.state, head: review.commit_id ?? '' })) : [] };
  const maintainerReviewState = maintainerAuthority && reviewActivity.verified
    ? evaluateMaintainerReview({
      reviews: reviewActivity.items.map((review) => ({
        login: review.user?.login ?? '',
        state: review.state,
        at: review.submitted_at ?? '',
      })),
      maintainers: maintainerAuthority.members,
      latestCommitDate: headCommittedDate,
      authorLogin: prAuthor,
    })
    : null;
  const effectiveMaintainerApproval = maintainerReviewState?.released?.via === 'github-approve'
    ? maintainerReviewState.released
    : null;
  const threadResult = fetchAllReviewThreads(owner, repo, pr);
  const threads = threadResult.threads;
  const unresolved = threads
    .filter((t) => !t.isResolved)
    .map((t) => {
      const cs = t.comments?.nodes ?? [];
      const first = cs[0];
      const last = cs[cs.length - 1];
      return {
        path: t.path,
        author: first?.author?.login ?? '(unknown)',
        isBot: first?.author?.__typename === 'Bot' || /\[bot\]$/i.test(first?.author?.login ?? ''),
        isOutdated: t.isOutdated,
        lastComment: (last?.body ?? '').slice(0, 300),
      };
    });

  const blockers = [];
  let blockClass = 'none';
  let structuralBlock = null; // {requiredCheckRules, canBypass, rulesetIds} | null
  if (!baseVerified) {
    blockers.push('base 分支或 SHA 已变化，必须重新核验 diff 后审查');
    blockClass = 'base-changed';
  }
  if (!headVerified) {
    blockers.push(expectedHead
      ? `当前 head 未与已审查 SHA 对齐:${expectedHead} → ${m.headRefOid ?? '(empty)'}`
      : '缺少 --expected-head，无法绑定已审查代码');
    blockClass = 'head-changed';
  }
  if (authorityError) {
    blockers.push(`维护者权限未验证:${authorityError}`);
    blockClass = authorityError.includes('已变化') ? 'authority-changed' : 'authority-unverified';
  } else if (approvalPolicy.approvalRequired) {
    if (!reviewActivity.verified) {
      blockers.push(`维护者 review 未完整读取:${reviewActivity.error}`);
      blockClass = 'maintainer-reviews-unknown';
    } else if (!effectiveMaintainerApproval) {
      blockers.push('缺少另一位最终维护者集合成员的有效 Approve');
      blockClass = 'awaiting-team-approval';
    } else if (isApprovalPendingReviewDecision(m.reviewDecision)) {
      blockers.push('维护者曾 Approve，但 GitHub 当前仍要求 reviewer approval；需最终维护者集合成员重新 Approve');
      blockClass = 'awaiting-team-approval';
    }
  }
  // ── CI 总门数据(2026-08-04):无条件读双源,不再只在 BLOCKED 时查。
  // rollup(statusCheckRollup)覆盖全部 CI 来源(Actions / 外部 check-run / commit status,
  // required 与非 required 一视同仁);actions/runs 是 rollup 403 时的兜底 + awaiting 探测。
  // 判定单一真相源在 lib.mjs evaluateCiStatus(单测 ci-status.test.mjs)。
  const rollupContexts = fetchCiRollup(slug, pr);
  // [MIVO-PATCH ci-ignore] 只从 CI 总判里去掉本流程自己的 check;必需检查核对仍用原始数据。
  const rollup = rollupContexts ? classifyRollupContexts(filterIgnoredCiContexts(rollupContexts, rules)) : null;
  const checkRunsWithApps = fetchCheckRunsWithApps(slug, m.headRefOid);
  const { ciRuns } = classifyHeadChecks(slug, m.headRefOid);
  const ci = evaluateCiStatus({ rollup, ciRuns, mergeStateStatus: ciMergeStateIgnoring(m.mergeStateStatus, rollupContexts, rules) });
  if (m.state !== 'OPEN') blockers.push(`PR state=${m.state}(非 OPEN)`);
  if (m.mergeable === 'CONFLICTING') blockers.push('mergeable=CONFLICTING(有冲突)');
  if (m.mergeStateStatus === 'DIRTY') {
    blockers.push('mergeStateStatus=DIRTY(有冲突)');
    blockClass = 'conflict';
  } else if (m.mergeStateStatus === 'BLOCKED') {
    if (m.reviewDecision === 'CHANGES_REQUESTED') {
      blockers.push(REVIEW_CHANGES_REQUESTED_BLOCKER);
      blockClass = 'review-changes-requested';
    } else if (isApprovalPendingReviewDecision(m.reviewDecision)) {
      // 缺 approval(含空 reviewDecision、刚 approve-reviewed-pr 完 GitHub 还在重算 mergeStateStatus)→ 不视为硬 blocker,
      // 提交 / 覆盖成 APPROVE 后状态会变 CLEAN;重算窗口由 mergeableUnknown 兜住(canMerge 要求非 UNKNOWN)。
      // ⚠️ 此分支不代表 CI 没问题 —— CI 由下面的 CI 总门独立押,别在这里提前放行。
      if (blockClass === 'none') blockClass = 'awaiting-approval';
    } else if (unresolved.length > 0) {
      // reviewDecision=APPROVED 但仍有 thread 没 resolve → BLOCKED 多半来自 required_review_thread_resolution。
      // blocker 由下面 unresolved 统一押,这里只定 class。
      blockClass = 'threads-unresolved';
    } else if (ci.status === 'failed') {
      blockers.push(`mergeStateStatus=BLOCKED(${ci.reason})`);
      blockClass = 'ci-failed';
    } else if (ci.status === 'pending') {
      blockers.push(`mergeStateStatus=BLOCKED(${ci.reason},等跑完即可)`);
      blockClass = 'ci-pending';
    } else if (ci.status === 'awaiting') {
      blockers.push(`mergeStateStatus=BLOCKED(${ci.reason};批准后等 CI 跑绿再合)`);
      blockClass = 'workflow-awaiting';
    } else if (ci.status === 'unknown') {
      // CI 状态读取不完整时不得往 structural-check 推 —— 那条路通向 admin bypass。
      blockers.push(`mergeStateStatus=BLOCKED 且 ${ci.reason}`);
      blockClass = 'ci-unknown';
    } else {
      // APPROVED + 线程已 resolve + CI 全绿(双源确认)仍 BLOCKED → 永不上报结果的必需检查门
      // (code_scanning/code_quality 等)→ 普通 merge 过不了,但 canBypass 时可走 admin bypass
      // (由 3A 决定;auto 模式仅在 internal-gates 安全条件全满足时)。
      blockClass = 'structural-check';
      structuralBlock = probeBranchProtection(slug, m.baseRefName);
      const ruleHint = structuralBlock?.requiredCheckRules?.length
        ? structuralBlock.requiredCheckRules.join(' / ')
        : 'code_scanning / code_quality 等';
      const bypassHint = structuralBlock?.canBypass && structuralBlock.canBypass !== 'never'
        ? `当前账号可 bypass(${structuralBlock.canBypass})`
        : 'bypass 权限未知';
      blockers.push(`mergeStateStatus=BLOCKED(必需检查门「${ruleHint}」未上报结果;review 与 CI(双源)均无问题——需 admin bypass 合或修该门;${bypassHint})`);
    }
  }
  // ── CI 总门(权威,独立于 mergeStateStatus):CI 全绿才可合并。──
  // BLOCKED 分支可能因 reviewDecision 提前定类(awaiting-approval / review-changes-requested
  // 等)而没把 CI 亮出来;UNSTABLE(非 required check 失败/在跑)根本不进 BLOCKED。
  // 这里统一兜住:ci.status 非 pass 一律押 blocker,CI 失败的名单必须报给用户/作者。
  const CI_CLASSES = new Set(['ci-failed', 'ci-pending', 'workflow-awaiting', 'ci-unknown']);
  if (ci.status !== 'pass' && !CI_CLASSES.has(blockClass)) {
    blockers.push(`CI 未全过:${ci.reason}`);
    if (blockClass === 'none' || blockClass === 'awaiting-approval') {
      blockClass = ci.status === 'failed' ? 'ci-failed'
        : ci.status === 'pending' ? 'ci-pending'
          : ci.status === 'awaiting' ? 'workflow-awaiting'
            : 'ci-unknown';
    }
  }
  if (unresolved.length) blockers.push(`${unresolved.length} 条 conversation 未 resolve`);
  if (!threadResult.verified) {
    blockers.push(`review thread 状态未完整读取:${threadResult.errors.join(' / ')}`);
    if (blockClass === 'none' || blockClass === 'awaiting-approval') blockClass = 'threads-unknown';
  }

  // ── 维护者确认门防线(defense-in-depth):新标签或旧标签还挂着 = 现在仍需维护者确认。──
  // 每轮主流程先按 context.mjs 的 signoff.labels.desired 同步；这里故意只认标签，
  // 让合并、GitHub 后台和待确认面板共享同一个外部依据。Approve / Request Changes 后
  // 都应摘标；作者新提交且仍命中触发时再挂回。标签写失败会在主流程异常汇总里点名。
  const signoffLabel = (rules.signoffGate?.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT;
  const currentLabelNames = (m.labels ?? []).map((l) => l.name);
  const pendingSignoffLabels = currentLabelNames.filter(
    (name) => name === signoffLabel || LEGACY_GATE_LABELS.includes(name),
  );
  const hasSignoffLabel = pendingSignoffLabels.length > 0;
  if (hasSignoffLabel) {
    blockers.push(`维护者确认标签 ${pendingSignoffLabels.join(' / ')} 还挂着(当前仍需维护者确认;先按 context 的 labels.desired 同步标签再合)`);
    if (blockClass === 'none') blockClass = 'signoff-pending';
  }

  // ── 机器人静默期(见 lib.mjs evaluateBotSettle):合并不能跑在外部 review 机器人前面 ──
  // 判据用「当前 head commit 之后有没有发言」,所以把 review 与 thread 评论都算进 activity。
  const commentActivity = fetchRestPages(`repos/${slug}/pulls/${pr}/comments`);
  const botActivityVerified = reviewActivity.verified && commentActivity.verified;
  const botActivity = [
    ...reviewActivity.items.map((review) => ({ author: review.user?.login ?? '', at: review.submitted_at ?? '' })),
    ...commentActivity.items.map((comment) => ({ author: comment.user?.login ?? '', at: comment.created_at ?? '' })),
    ...botCheckActivity(rollupContexts, rules.botReviewSettle ?? {}), // [MIVO-PATCH bot-check-settle]
  ].filter((activity) => activity.author && activity.at);
  // [MIVO-PATCH bot-settle-ready] 与 context.mjs 同口径:超时从 max(提交, 推送, 转 Ready) 起算,推送时间用 head 上最早的检查开始时间估。
  const botSettle = evaluateBotSettleSinceReady({
    headCommittedDate,
    headPushedAt: toHeadPushedAt(rollupContexts),
    nowIso: new Date().toISOString(),
    activity: botActivity,
    cfg: rules.botReviewSettle ?? {},
  }, () => {
    const events = fetchRestPages(`repos/${slug}/issues/${pr}/events`);
    if (!events.verified) throw new Error(events.error);
    return events.items;
  });
  const botSettleVerified = botSettle.enabled === false || (Boolean(headCommittedDate) && botActivityVerified);
  if (!botSettleVerified) {
    const errors = [reviewActivity.error, commentActivity.error].filter(Boolean).join(' / ');
    blockers.push(`机器人静默期输入未完整验证:${!headCommittedDate ? 'head commit 时间为空' : errors}`);
    if (blockClass === 'none' || blockClass === 'awaiting-approval') blockClass = 'bot-settle-unknown';
  }
  if (!botSettle.settled) {
    blockers.push(`机器人静默期未过:${botSettle.reason}`);
    if (blockClass === 'none') blockClass = 'awaiting-bot-review';
  }

  // ── stale-rebase(合并前最终复核):behind_by > 0 + merge base 距今超过阈值 ──
  const staleRebase = fetchStaleRebase({ slug, baseRef: m.baseRefOid || m.baseRefName,
    headSha: m.headRefOid, cfg: rules.staleRebase ?? {} });
  const compareVerified = staleRebase.verified;
  const staleRebaseChecked = staleRebase.verified;
  const behindBy = staleRebase.behindBy;
  if (!staleRebaseChecked) {
    blockers.push(staleRebase.reason);
    if (blockClass === 'none' || blockClass === 'awaiting-approval') blockClass = 'stale-rebase-unknown';
  }
  if (staleRebase.blocking) {
    blockers.push(`需要 rebase:${staleRebase.reason}`);
    if (blockClass === 'none' || blockClass === 'awaiting-approval') blockClass = 'needs-rebase';
  }

  // ── 受保护路径(.github/** 等,pr-rules.json protectedPaths.paths):合并前第二道防线 ──
  // 命中即不合并,交人工处理。这里独立复核:即使 context 的 skip 被绕过 / 合并路径走了
  // admin bypass,只要改到受保护路径就一律 block。
  const changedFiles = fetchRestPages(`repos/${slug}/pulls/${pr}/files`);
  if (!changedFiles.verified) blockers.push(`改动文件未完整读取:${changedFiles.error}`);
  const protectedFiles = matchPathPatterns(
    changedFiles.items.map((f) => f.filename),
    (rules.protectedPaths?.paths) ?? [],
  );
  if (protectedFiles.length > 0) {
    const hit = protectedFiles.slice(0, 5).join(' / ');
    const more = protectedFiles.length > 5 ? ' 等' : '';
    blockers.push(`改动受保护路径 ${hit}${more}(共 ${protectedFiles.length} 个)——自动流程不合并,交人工处理`);
    blockClass = 'protected-path';
  }

  const mergeableUnknown = m.mergeable === 'UNKNOWN';
  const canMerge = blockers.length === 0 && !mergeableUnknown;
  // 普通 merge 过不了、但「结构性门 + 当前账号可 bypass」时,3A 可走 admin bypass 合(交互模式经用户确认)。
  const approvalSatisfied = Boolean(effectiveMaintainerApproval) &&
    !isApprovalPendingReviewDecision(m.reviewDecision);
  const structuralBypassAvailable =
    !authorityError &&
    headVerified && baseVerified &&
    approvalSatisfied &&
    blockClass === 'structural-check' &&
    blockers.length === 1 && threadResult.verified && unresolved.length === 0 &&
    ci.status === 'pass' && botSettleVerified && botSettle.settled &&
    !hasSignoffLabel && staleRebaseChecked && !staleRebase.blocking &&
    m.state === 'OPEN' && m.mergeable === 'MERGEABLE' &&
    !!structuralBlock?.canBypass &&
    structuralBlock.canBypass !== 'never';

  // 旧版维护者作者 approval-exempt admin route 保留只读输出兼容，但现行策略的
  // approvalExemption.exempt 恒为 false，因此缺 Approve 不能再靠 --admin 绕过。
  const approvalBranchProbe = approvalExemption.exempt
    ? (structuralBlock ?? probeBranchProtection(slug, m.baseRefName))
    : null;
  const approvalBranchRules = evaluateAdminBranchRules({
    probe: approvalBranchProbe,
    rollupContexts,
    checkRunsWithApps,
    behindBy: compareVerified ? behindBy : null,
  });
  const approvalExemptAdminMerge = evaluateApprovalExemptAdminMerge({
    approvalExempt: approvalExemption.exempt,
    headVerified,
    state: m.state,
    mergeable: m.mergeable,
    mergeStateStatus: m.mergeStateStatus,
    reviewDecision: m.reviewDecision,
    blockClass,
    blockerCount: blockers.length,
    unresolvedCount: unresolved.length,
    threadsVerified: threadResult.verified,
    botSettled: botSettle.settled,
    botSettleVerified,
    hasSignoffLabel,
    staleRebaseBlocking: Boolean(staleRebase?.blocking),
    staleRebaseChecked,
    protectedFileCount: protectedFiles.length,
    branchRulesVerified: approvalBranchRules.verified,
    ciStatus: ci.status,
  });
  const approvalExemptAdminMergeAvailable = approvalExemptAdminMerge.available;
  const normalMergeAvailable = baseVerified && evaluateNormalMergeAvailable({
    canMerge,
    blockClass,
    approvalExempt: approvalExemption.exempt,
    headVerified,
    staleRebaseChecked,
  });
  const authorityVerified = !authorityError && Boolean(maintainerAuthority);
  const finalCanMerge = authorityVerified && headVerified && baseVerified && (approvalExemption.exempt
    ? normalMergeAvailable || approvalExemptAdminMergeAvailable
    : canMerge);

  print({
    ok: true,
    pr,
    state: m.state,
    mergeable: m.mergeable,
    mergeStateStatus: m.mergeStateStatus,
    reviewDecision: m.reviewDecision,
    expectedHead: expectedHead || null,
    actualHead: m.headRefOid,
    headVerified,
    expectedBase: expectedBase || null,
    actualBase: m.baseRefOid,
    baseRefName: m.baseRefName,
    expectedBaseRef: expectedBaseRef || null,
    baseVerified,
    blockClass,
    structuralBlock,
    structuralBypassAvailable,
    ci,
    ciRuns,
    blockedAwaitingApproval: blockClass === 'awaiting-approval' || blockClass === 'awaiting-team-approval',
    maintainerAuthority: maintainerAuthority ? {
      verified: authorityVerified,
      teamHandle: maintainerAuthority.codeowners.teamHandle,
      memberCount: maintainerAuthority.memberCount,
      digest: maintainerAuthority.digest,
      fetchedAt: maintainerAuthority.fetchedAt,
    } : { verified: false, error: authorityError },
    expectedAuthorityDigest: expectedAuthorityDigest || null,
    authorityVerified,
    approvalPolicy,
    approvalExemption,
    maintainerReviewState,
    reviewSnapshot,
    effectiveMaintainerApproval,
    normalMergeAvailable,
    approvalExemptAdminMergeAvailable,
    approvalExemptAdminMerge,
    approvalBranchRules,
    approvalBranchProbe,
    mergeableUnknown,
    unresolvedThreads: unresolved,
    threadsVerified: threadResult.verified,
    threadReadErrors: threadResult.errors,
    headCommittedDate,
    botSettle,
    botSettleVerified,
    pendingSignoffLabels,
    protectedFiles,
    staleRebase,
    staleRebaseChecked,
    compareVerified,
    blockers,
    canMerge: finalCanMerge,
    note: '所有作者都必须先由另一位最终维护者集合成员通过 approve-reviewed-pr.mjs 提交 Approve，再重跑本脚本；维护者作者不再走 approval-exempt admin route。所有 merge route 都必须绑定 expectedHead 与 expectedAuthorityDigest。authority 读取失败/变化、head 变化、维护者 Approve 缺失、CI 非 pass、thread 未 resolve、机器人静默期未过、stale rebase、受保护路径或 branch rules 未验证都不得 bypass。selfFixAuthors 只影响代修,不提供 self-merge 权限。',
  });
  process.exit(finalCanMerge ? 0 : 2);
} catch (e) {
  fail(e);
}
