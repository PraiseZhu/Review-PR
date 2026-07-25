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
//
// 退出码:0 = canMerge;2 = 有 blocker;1 = 脚本自身出错。
// 跑:node <skill-root>/scripts/pre-merge-check.mjs <PR>

import { parseRepo, parsePR, ghJson, ghGraphql, classifyHeadChecks, probeBranchProtection, loadRules, print, fail } from './lib.mjs';

const THREADS_QUERY = `
  query($owner:String!,$repo:String!,$num:Int!){
    viewer{ login }
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        author{ login }
        reviewThreads(first:100){ nodes{
          isResolved isOutdated path
          comments(first:50){ nodes{ author{ login __typename } body createdAt } }
        }}
      }
    }
  }`;

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);

  const slug = `${owner}/${repo}`;
  const m = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName',
  ]);
  // reviewDecision 作判 BLOCKED 原因的权威信号(比 some(state===CHANGES_REQUESTED) 准:它按
  // 每个 reviewer 的「最新」review 算 —— self-approve 覆盖掉自己旧的 CHANGES_REQUESTED 后会变
  // APPROVED,不会被历史那条残留 CR 误判成「仍有未解决 CR」而反复拦死)。

  const data = ghGraphql(THREADS_QUERY, { owner, repo, num: pr });
  const viewerLogin = data?.data?.viewer?.login ?? '';
  const prAuthor = data?.data?.repository?.pullRequest?.author?.login ?? '';
  const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
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
  let ciRuns = null;
  if (m.state !== 'OPEN') blockers.push(`PR state=${m.state}(非 OPEN)`);
  if (m.mergeable === 'CONFLICTING') blockers.push('mergeable=CONFLICTING(有冲突)');
  if (m.mergeStateStatus === 'DIRTY') {
    blockers.push('mergeStateStatus=DIRTY(有冲突)');
    blockClass = 'conflict';
  } else if (m.mergeStateStatus === 'BLOCKED') {
    if (m.reviewDecision === 'CHANGES_REQUESTED') {
      blockers.push('mergeStateStatus=BLOCKED(reviewDecision=CHANGES_REQUESTED,仍有 reviewer 要求修改)');
      blockClass = 'review-changes-requested';
    } else if (m.reviewDecision === 'REVIEW_REQUIRED' || m.reviewDecision == null) {
      // 缺 approval(含刚 self-approve 完 GitHub 还在重算 mergeStateStatus)→ 不视为硬 blocker,
      // 提交 / 覆盖成 APPROVE 后状态会变 CLEAN;重算窗口由 mergeableUnknown 兜住(canMerge 要求非 UNKNOWN)
      blockClass = 'awaiting-approval';
    } else if (unresolved.length > 0) {
      // reviewDecision=APPROVED 但仍有 thread 没 resolve → BLOCKED 多半来自 required_review_thread_resolution。
      // blocker 由下面 unresolved 统一押,这里只定 class。
      blockClass = 'threads-unresolved';
    } else {
      // APPROVED + 线程已 resolve 但仍 BLOCKED → 细分 CI 失败 / 还在跑 / 结构性门(与 context.mjs 同口径)
      ({ ciRuns } = classifyHeadChecks(slug, m.headRefOid));
      const ciFailed = ciRuns ? ciRuns.failed : [];
      const ciPending = ciRuns ? ciRuns.pending : [];
      if (ciFailed.length > 0) {
        blockers.push(`mergeStateStatus=BLOCKED(CI 失败:${ciFailed.join(' / ')})`);
        blockClass = 'ci-failed';
      } else if (ciPending.length > 0) {
        blockers.push(`mergeStateStatus=BLOCKED(CI 还在跑:${ciPending.join(' / ')},等跑完即可)`);
        blockClass = 'ci-pending';
      } else {
        // 永不上报结果的必需检查门(code_scanning/code_quality 等)→ 普通 merge 过不了,
        // 但 canBypass 时可走 admin bypass(由 3A 决定;auto 模式绝不自动 bypass)。
        blockClass = 'structural-check';
        structuralBlock = probeBranchProtection(slug, m.baseRefName);
        const ruleHint = structuralBlock?.requiredCheckRules?.length
          ? structuralBlock.requiredCheckRules.join(' / ')
          : 'code_scanning / code_quality 等';
        const bypassHint = structuralBlock?.canBypass && structuralBlock.canBypass !== 'never'
          ? `当前账号可 bypass(${structuralBlock.canBypass})`
          : 'bypass 权限未知';
        blockers.push(`mergeStateStatus=BLOCKED(必需检查门「${ruleHint}」未上报结果;review 与已跑 CI 均无问题——需 admin bypass 合或修该门;${bypassHint})`);
      }
    }
  }
  if (unresolved.length) blockers.push(`${unresolved.length} 条 conversation 未 resolve`);

  const mergeableUnknown = m.mergeable === 'UNKNOWN';
  const canMerge = blockers.length === 0 && !mergeableUnknown;
  // 普通 merge 过不了、但「结构性门 + 当前账号可 bypass」时,3A 可走 admin bypass 合(交互模式经用户确认)。
  const structuralBypassAvailable =
    blockClass === 'structural-check' && !!structuralBlock?.canBypass && structuralBlock.canBypass !== 'never';

  // selfFixAuthors 自己的 PR:GitHub 不允许同账号 approve 自己的 PR,
  // 审查通过后使用 --admin 合并。触发条件宽松:只要不是冲突/CI 失败/thread 未 resolve
  // 就允许(mergeableUnknown 是 GitHub 异步重算的暂态,admin merge 不受影响)。
  let selfMergeAvailable = false;
  if (viewerLogin && prAuthor) {
    const rules = loadRules();
    const selfFixAuthors = (rules.selfFixAuthors ?? []).map((a) => a.toLowerCase());
    const isSelfPr = viewerLogin.toLowerCase() === prAuthor.toLowerCase();
    const isSelfFixAuthor = selfFixAuthors.includes(prAuthor.toLowerCase());
    const noHardBlockers = m.mergeable !== 'CONFLICTING' && m.mergeStateStatus !== 'DIRTY';
    const noContentBlockers = blockClass === 'awaiting-approval' || blockClass === 'none';
    if (isSelfPr && isSelfFixAuthor && noHardBlockers && noContentBlockers && unresolved.length === 0) {
      selfMergeAvailable = true;
    }
  }

  print({
    ok: true,
    pr,
    state: m.state,
    mergeable: m.mergeable,
    mergeStateStatus: m.mergeStateStatus,
    reviewDecision: m.reviewDecision,
    blockClass,
    structuralBlock,
    structuralBypassAvailable,
    ciRuns,
    blockedAwaitingApproval: blockClass === 'awaiting-approval',
    selfMergeAvailable,
    mergeableUnknown,
    unresolvedThreads: unresolved,
    blockers,
    canMerge: canMerge || selfMergeAvailable,
    note: 'canMerge=true 才走普通 merge。selfMergeAvailable=true 时用 gh pr merge --admin(selfFixAuthors 的自有 PR,审查通过但 GitHub 不允许自批准)。canMerge=false 时看 blockClass:structural-check + structuralBypassAvailable=true → 交互模式可经用户确认走 admin bypass 合(gh pr merge --admin);ci-failed/ci-pending/review-changes-requested/threads-unresolved 一律别 bypass(分别是真失败/还在跑/要作者改/要 resolve)。',
  });
  process.exit((canMerge || selfMergeAvailable) ? 0 : 2);
} catch (e) {
  fail(e);
}
