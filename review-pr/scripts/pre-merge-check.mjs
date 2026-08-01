#!/usr/bin/env node
// pre-merge-check.mjs — 合并前确定性 gate(只读,对应 skill 3A「合并前状态复核」)
//
// 复核两件事:(1)GitHub 自身的可合并状态(state / mergeable / mergeStateStatus);
// (2)所有 review thread 是否都已 resolve(对应 1.6.5 通过标准第 1 条,双保险——
// GitHub 分支保护不一定开了 require-conversation-resolution,不复核就会漏)。
// 新增:(3)区分 BLOCKED 原因——awaiting-approval / ci-failed / ci-pending / structural-check
// (reviewDecision + workflow run 分类 + statusCheckRollup 全集补查 + ruleset 探测,
// 与 context.mjs 同口径;rollup 补查对齐 5178e64——classifyHeadChecks 走 actions/runs
// 看不到第三方 App check-run / commit status,落 structural-check 前必须查 rollup 全集)。
//   - structural-check:review+已跑 CI 都过、仍 BLOCKED,卡在永不上报的必需检查门
//     (code_scanning/code_quality 等)。canMerge 仍判 false(普通 merge 过不了),但带出
//     structuralBypassAvailable / canBypass,供 3A 决定是否走 admin bypass 合(见 SKILL 3A)。
// 新增(2026-08-01,三层分级合并策略,见 internal-gates.md「作者侧与仓库侧 gate」):
//   - structuralBypassAvailable 现在还要求 reviewDecision=APPROVED 或作者在 admins
//     名单(structuralBypassBasis 区分是哪一种)——此前机械前提满足就直接判 true,与
//     reviewDecision 无关,是本次修的 fail-open 口子(PR #342/#366 曾在零 review 下被
//     自动 admin 合入)。admin-trust 路径要求调用方已在本轮确认独立审查零 P0/P1,脚本
//     本身不验证这一半,只守机械前提;
//   - authorizedFastMergeAvailable:admins 名单成员发过 `/approve-merge`(晚于最后一次
//     push)且无冲突、0 未 resolve thread、head 上 required 检查全绿时为 true,可直接
//     gh pr merge --admin,不需要走过阶段二独立审查。
//
// 退出码:0 = canMerge(含 selfMergeAvailable / authorizedFastMergeAvailable);2 = 有 blocker;1 = 脚本自身出错。
// 跑:node <skill-root>/scripts/pre-merge-check.mjs <PR>

import { parseRepo, parsePR, ghJson, ghGraphql, classifyHeadChecks, classifyStatusRollup, probeBranchProtection, loadRules, fetchHeadCheckContexts, classifyRequiredChecks, findApproveMergeAuthorization, decideStructuralBypassRoute, print, fail } from './lib.mjs';

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
        comments(first:100){ nodes{ author{ login __typename } body createdAt url } }
        commits(last:100){ nodes{ commit{ committedDate } } }
      }
    }
  }`;

const isBotAuthor = (a) => a?.__typename === 'Bot' || /\[bot\]$/i.test(a?.login ?? '');

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const rules = loadRules();
  // 结构性 BLOCKED 自动 admin bypass 的必需检查类型 allowlist——与 context.mjs 同一份配置键
  // (pr-rules.json 的 structuralBypassAllowlist),防两处判据漂移。配置缺失时用这两个默认值。
  const STRUCTURAL_BYPASS_ALLOWLIST = new Set(rules.structuralBypassAllowlist ?? ['code_scanning', 'code_quality']);
  // admins 名单——与 context.mjs 同一份配置键(pr-rules.json 的 admins),防两处判据漂移。
  // 缺失/为空 = fail-closed,下面的 authorIsAdmin 恒 false。
  const ADMINS = new Set((rules.admins ?? []).map((a) => a.toLowerCase()));

  const slug = `${owner}/${repo}`;
  const m = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup',
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

  const authorIsAdmin = ADMINS.size > 0 && ADMINS.has(prAuthor.toLowerCase());

  // ── 授权快速合并通道:合并前最后复核(TOCTOU 保护,与 context.mjs 同口径重新现场检测,
  // 不信任 scan 时缓存——授权评论可能在 scan 之后才发出,也可能因为 scan 之后又推了新
  // commit 而作废,见 lib.mjs findApproveMergeAuthorization 与 SKILL 5.1「授权快速合并
  // 通道」)。──
  const rawComments = data?.data?.repository?.pullRequest?.comments?.nodes ?? [];
  const mappedComments = rawComments.map((c) => ({
    author: c.author?.login ?? '(unknown)',
    isBot: isBotAuthor(c.author),
    createdAt: c.createdAt,
    url: c.url,
    body: c.body ?? '',
  }));
  const commitDates = (data?.data?.repository?.pullRequest?.commits?.nodes ?? [])
    .map((n) => n.commit?.committedDate)
    .filter(Boolean);
  const latestCommitDate = commitDates.reduce((mx, d) => (d > mx ? d : mx), '');
  const approveMergeAuth = findApproveMergeAuthorization({ comments: mappedComments, admins: rules.admins, latestCommitDate });
  // 安全与隐私门(security.hardHits)在更上游的 context.mjs 已经拦过一轮——命中的 PR 走
  // pushback-security,auto 流程根本不会跑到这一步调用 pre-merge-check.mjs;这里不重复扫描,
  // 只复核「机械前提」这一半(无冲突 + 0 未 resolve thread + head 上 required 检查全绿)。
  let authorizedFastMergeAvailable = false;
  let authorizedFastMergeInfo = null;
  if (approveMergeAuth.authorized) {
    const noHardBlockers = m.mergeable !== 'CONFLICTING' && m.mergeStateStatus !== 'DIRTY';
    if (noHardBlockers && unresolved.length === 0) {
      const checkNodes = fetchHeadCheckContexts({ owner, repo, pr });
      const required = checkNodes ? classifyRequiredChecks(checkNodes) : null;
      if (required && required.requiredFailed.length === 0 && required.requiredPending.length === 0) {
        authorizedFastMergeAvailable = true;
        authorizedFastMergeInfo = {
          admin: approveMergeAuth.authorized.author,
          commentUrl: approveMergeAuth.authorized.url,
          commentCreatedAt: approveMergeAuth.authorized.createdAt,
          nonRequiredFailures: required.nonRequiredFailed,
        };
      }
    }
  }

  const blockers = [];
  let blockClass = 'none';
  let structuralBlock = null; // {requiredCheckRules, canBypass, rulesetIds} | null
  let structuralAllowlisted = false; // structuralBlock.requiredCheckRules 是否全部命中 STRUCTURAL_BYPASS_ALLOWLIST
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
      if (ciRuns === null) {
        // CI 状态读不到(权限/网络/解析失败)——不知道过没过,绝不能落进下面的 structural-check
        // 分支被当作"结构性门"再走 admin bypass 合并未知 CI 状态的 PR(与 context.mjs 同口径)。
        blockers.push('mergeStateStatus=BLOCKED,但 CI 状态读取失败(权限/网络/解析问题)——CI 是否通过未知,不当结构性门处理、不可 bypass');
        blockClass = 'ci-unknown';
      } else if (ciFailed.length > 0) {
        blockers.push(`mergeStateStatus=BLOCKED(CI 失败:${ciFailed.join(' / ')})`);
        blockClass = 'ci-failed';
      } else if (ciPending.length > 0) {
        blockers.push(`mergeStateStatus=BLOCKED(CI 还在跑:${ciPending.join(' / ')},等跑完即可)`);
        blockClass = 'ci-pending';
      } else {
        // Actions 全绿 → 落 structural-check 前补查 statusCheckRollup 全集(第三方 App
        // check-run / commit status,classifyHeadChecks 走 actions/runs 一条都看不到)。
        // 与 context.mjs 5178e64 同口径:这道门是 scan 之后、合并之前的最后复核,恰恰要防
        // 「scan 时第三方检查还没上报、合并前它报了 FAILURE」的窗口——不查 rollup 就会把
        // 带着失败第三方检查的 PR 误判成结构性门再被 admin bypass 合掉(实测 #318 形状)。
        const headRollup = classifyStatusRollup(m.statusCheckRollup);
        if (headRollup === null) {
          blockers.push('mergeStateStatus=BLOCKED,但 statusCheckRollup 读取失败——第三方 App check-run / commit status 是否失败未知(classifyHeadChecks 只看得到 GitHub Actions),不当结构性门处理、不可 bypass,下轮再看');
          blockClass = 'ci-unknown';
        } else if (headRollup.failed.length > 0) {
          blockers.push(`mergeStateStatus=BLOCKED(head 上已上报检查失败:${headRollup.failed.join(' / ')}——第三方 App check-run / commit status,classifyHeadChecks 看不到;修绿前不合并)`);
          blockClass = 'ci-failed';
        } else if (headRollup.pending.length > 0) {
          blockers.push(`mergeStateStatus=BLOCKED(head 上已上报检查还在跑:${headRollup.pending.join(' / ')},等跑完即可)`);
          blockClass = 'ci-pending';
        } else {
          // 永不上报结果的必需检查门(code_scanning/code_quality 等)→ 普通 merge 过不了,
          // 但 canBypass 且命中类型在 structuralBypassAllowlist 内时可走 admin bypass
          // (由 3A 决定;bypass 条件见 internal-gates.md)。
          blockClass = 'structural-check';
          // 与 context.mjs 同口径:已被全绿 context 满足的 required_status_checks 规则不算结构性门
          const rollupOk = headRollup.ok;
          structuralBlock = probeBranchProtection(slug, m.baseRefName, {
            satisfiedContexts: rollupOk ? new Set(rollupOk) : null,
          });
          structuralAllowlisted = !!structuralBlock?.requiredCheckRules?.length &&
            structuralBlock.requiredCheckRules.every((r) => STRUCTURAL_BYPASS_ALLOWLIST.has(r));
          const ruleHint = structuralBlock?.requiredCheckRules?.length
            ? structuralBlock.requiredCheckRules.join(' / ')
            : 'code_scanning / code_quality 等';
          const bypassHint = structuralBlock?.canBypass && structuralBlock.canBypass !== 'never'
            ? `当前账号可 bypass(${structuralBlock.canBypass})${structuralAllowlisted ? '' : ',但命中的必需检查类型不在 structuralBypassAllowlist 里'}`
            : 'bypass 权限未知';
          blockers.push(`mergeStateStatus=BLOCKED(必需检查门「${ruleHint}」未上报结果;review 与已跑 CI 均无问题——需 admin bypass 合或修该门;${bypassHint})`);
        }
      }
    }
  } else if (m.mergeStateStatus === 'UNSTABLE') {
    // UNSTABLE = 可合并但有非 required 检查失败/未完成。GitHub 不拦,本 gate 必须拦
    // (与 context.mjs 同口径):PG smoke / bench / Greptile 这类没升门的检查失败都落在
    // 这个状态。用 statusCheckRollup(全集,含第三方 App check-run),不用 actions/runs。
    const rollup = classifyStatusRollup(m.statusCheckRollup);
    if (rollup === null) {
      blockers.push('mergeStateStatus=UNSTABLE,但 statusCheckRollup 读取失败——哪些检查失败未知,不合并,下轮再看');
      blockClass = 'ci-unknown';
    } else if (rollup.failed.length > 0) {
      blockers.push(`mergeStateStatus=UNSTABLE(非 required 检查失败:${rollup.failed.join(' / ')}——GitHub 不拦但本 gate 拦,修绿前不合并)`);
      blockClass = 'ci-failed';
    } else if (rollup.pending.length > 0) {
      blockers.push(`mergeStateStatus=UNSTABLE(非 required 检查还在跑:${rollup.pending.join(' / ')},等跑完即可)`);
      blockClass = 'ci-pending';
    } else {
      blockers.push('mergeStateStatus=UNSTABLE 但 rollup 无失败/未完成项——状态暂态不一致,不合并,下轮再看');
      blockClass = 'ci-unknown';
    }
  }
  if (unresolved.length) blockers.push(`${unresolved.length} 条 conversation 未 resolve`);

  const mergeableUnknown = m.mergeable === 'UNKNOWN';
  const canMerge = blockers.length === 0 && !mergeableUnknown;
  // 普通 merge 过不了、但「结构性门 + 当前账号可 bypass + 命中类型在 allowlist 内」时,
  // 3A 可走 admin bypass 合(交互模式经用户确认)。谁来担保"没有真实 APPROVED review 也能
  // 合"按两条路径(与 context.mjs 的三层分级同口径,见 internal-gates.md「作者侧与仓库侧
  // gate」):reviewDecision=APPROVED(真实 GitHub review,basis='approved')或作者在
  // admins 名单(basis='admin-trust')。**admin-trust 路径不是机械上就能放行**——调用方
  // (agent)必须已经在本轮独立审查里确认零 P0/P1 才能消费本字段去合并,脚本本身无法验证
  // "审查是否跑过 / 是否干净"这个语义判断,只守机械前置的一半(与 selfMergeAvailable 同一
  // 套"脚本守机械半、调用方守语义半"的分工,见 self-approve.mjs 文件头注释)。
  const structuralCanBypass = blockClass === 'structural-check' && structuralAllowlisted &&
    !!structuralBlock?.canBypass && structuralBlock.canBypass !== 'never';
  const { route: structuralRoute, basis: structuralBypassBasis } = decideStructuralBypassRoute({
    structuralCanBypass, reviewDecision: m.reviewDecision, isAdminAuthor: authorIsAdmin,
  });
  const structuralBypassAvailable = structuralRoute === 'bypass-structural-block' || structuralRoute === 'review-pending-admin-bypass';

  // selfFixAuthors 自己的 PR:GitHub 不允许同账号 approve 自己的 PR,
  // 审查通过后使用 --admin 合并。条件:非冲突、thread 全 resolve、且 head 上所有已上报
  // 检查(rollup 全集,含第三方 App check-run)无失败/无进行中
  // (mergeableUnknown 是 GitHub 异步重算的暂态,admin merge 不受影响)。
  let selfMergeAvailable = false;
  if (viewerLogin && prAuthor) {
    const selfFixAuthors = (rules.selfFixAuthors ?? []).map((a) => a.toLowerCase());
    const isSelfPr = viewerLogin.toLowerCase() === prAuthor.toLowerCase();
    const isSelfFixAuthor = selfFixAuthors.includes(prAuthor.toLowerCase());
    const noHardBlockers = m.mergeable !== 'CONFLICTING' && m.mergeStateStatus !== 'DIRTY';
    const noContentBlockers = blockClass === 'awaiting-approval' || blockClass === 'none';
    // awaiting-approval 是在 reviewDecision 层短路得出的,上面的 BLOCKED 细分从未查过
    // rollup——而 self-merge 走 --admin 会一并绕过还没跑完/已失败的检查(含 actions/runs
    // 看不见的第三方 App check-run)。这里独立补查全集,fail-closed:rollup 读不到、有
    // 失败、或还在跑,都不 self-merge,等下一轮(与 BLOCKED/UNSTABLE 分支同口径)。
    const selfRollup = classifyStatusRollup(m.statusCheckRollup);
    const rollupClean = selfRollup !== null && selfRollup.failed.length === 0 && selfRollup.pending.length === 0;
    if (isSelfPr && isSelfFixAuthor && noHardBlockers && noContentBlockers && unresolved.length === 0 && rollupClean) {
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
    structuralAllowlisted,
    structuralBypassAvailable,
    structuralBypassBasis,
    authorIsAdmin,
    ciRuns,
    blockedAwaitingApproval: blockClass === 'awaiting-approval',
    selfMergeAvailable,
    authorizedFastMergeAvailable,
    authorizedFastMergeInfo,
    mergeableUnknown,
    unresolvedThreads: unresolved,
    blockers,
    canMerge: canMerge || selfMergeAvailable || authorizedFastMergeAvailable,
    note: 'canMerge=true 才走普通 merge。selfMergeAvailable=true 时用 gh pr merge --admin(selfFixAuthors 的自有 PR,审查通过但 GitHub 不允许自批准)。authorizedFastMergeAvailable=true 时同样用 gh pr merge --admin,且可跳过阶段二独立审查(admins 名单成员发过 /approve-merge,晚于最后一次 push,无冲突、0 未 resolve thread、head 上 required 检查全绿;authorizedFastMergeInfo.nonRequiredFailures 非空时把这些非 required 失败写进合并致谢/汇总,不阻断)。canMerge=false 时看 blockClass:structural-check + structuralBypassAvailable=true(要求 canBypass=always/pull_requests **且** requiredCheckRules 全部命中 pr-rules.json 的 structuralBypassAllowlist **且**(reviewDecision=APPROVED 或作者在 admins 名单))→ 可走 admin bypass 合(gh pr merge --admin)。structuralBypassBasis 说明凭什么担保:"approved"=真实 GitHub review,任何模式下都能直接合;"admin-trust"=作者在 admins 名单但缺 APPROVED——**调用方必须先在本轮独立审查里确认零 P0/P1 才能消费这个字段**,脚本只验证机械前提(canBypass/allowlist/作者身份),不知道审查是否跑过或结论如何,交互模式仍需用户确认,auto 模式的确认责任落在"先跑完审查再调用本脚本"这个调用顺序上。ci-unknown(CI 状态读不到,权限/网络/解析问题)/ci-failed/ci-pending/review-changes-requested/threads-unresolved 一律别 bypass(分别是未知/真失败/还在跑/要作者改/要 resolve)。',
  });
  process.exit((canMerge || selfMergeAvailable || authorizedFastMergeAvailable) ? 0 : 2);
} catch (e) {
  fail(e);
}
