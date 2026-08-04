#!/usr/bin/env node
// pre-merge-check.mjs — 合并前确定性 gate(只读,对应 skill 3A「合并前状态复核」)
//
// 复核两件事:(1)GitHub 自身的可合并状态(state / mergeable / mergeStateStatus);
// (2)所有 review thread 是否都已 resolve(对应 1.6.5 通过标准第 1 条,双保险——
// GitHub 分支保护不一定开了 require-conversation-resolution,不复核就会漏)。
// 新增:(3)区分 BLOCKED 原因——awaiting-approval / ci-failed / ci-pending / structural-check
// (reviewDecision + workflow run 分类 + statusCheckRollup 全集补查 + ruleset 探测,
// 与 context.mjs 同口径,判定逻辑单一来源在 lib.mjs 的 classifyBlockedStatus)。
//   - structural-check:review+已跑 CI 都过、仍 BLOCKED,卡在永不上报的必需检查门
//     (code_scanning/code_quality 等)。canMerge 仍判 false(普通 merge 过不了),但带出
//     structuralBypassReady / canBypass,供 3A 决定是否走 admin bypass 合(见 SKILL 3A)。
// 新增(2026-08-01,三层分级合并策略,见 internal-gates.md「作者侧与仓库侧 gate」;
// 2026-08-02 追加 P1-1/P1-2/P1-3/P1-4/P1-5/P2-1/P2-2/P2-3 复审修复):
//   - structuralBypassReady(2026-08-02 由 structuralBypassAvailable 改名):要求
//     reviewDecision=APPROVED(basis='approved',立即可合)或作者在 admins 名单**且**
//     已有一条针对当前 head 的「审查回执」(basis='admin-trust',见
//     write-review-receipt.mjs / lib.mjs isReviewReceiptClean——脚本不验证代码好不好,
//     回执就是这半语义判断的凭证,回执 headRefOid 与当前 head 不一致或 verdict 不是
//     clean 都不算)——此前只看机械前提、完全不校验 reviewDecision/回执,是 PR #342/#366
//     曾在零 review 下被自动 admin 合入的 fail-open 口子;
//   - authorizedFastMergeAvailable:admins 名单成员发过 `/approve-merge`(晚于最后一次
//     **真实 push**,P2-1 改用 commit.pushedDate + HeadRefForcePushedEvent,不用可伪造的
//     committedDate;且该评论未被编辑过,P2-2)、无冲突、head 上 required 检查全绿(P1-3
//     完整性核验:与分支保护要求的 context 名单做差,未上报的必需检查按 pending 处理,
//     不因"contexts 里没出现"就当全绿)时为 true,可直接 gh pr merge --admin,不需要走过
//     阶段二独立审查——这是紧急通道,只有物理冲突与 required CI 两类不可绕过,未 resolve
//     thread / 非 required 检查失败不阻断(owner 拍板:管理员显式授权即自担责任,机器职责
//     从"拦"变成"留痕",authorizedFastMergeInfo.reportOnly 记录这些信号,调用方必须显著
//     写进汇总,不能悄悄吞掉);安全扫描(P1-1)现已对当前 head 真实重扫,不再恒传"无命中",
//     扫描失败时 fail-closed(不放行,要求重试),不当"无命中"处理;
//   - headRefOid(P1-2):随结论一并输出当前 head SHA,供调用方在所有自动 merge / admin
//     merge 命令里加 `--match-head-commit <sha>`,做"判定用的 head"与"真正执行合并时的
//     head"之间的原子护栏——判定与执行之间若有人又推了新 commit,GitHub 会拒绝合并而不是
//     静默合了一个没被复核过的版本。
//
// 退出码:0 = canMerge(含 selfMergeAvailable / authorizedFastMergeAvailable);2 = 有 blocker;1 = 脚本自身出错。
// 跑:node <skill-root>/scripts/pre-merge-check.mjs <PR>

import {
  parseRepo, parsePR, ghJson, ghGraphql, classifyHeadChecks, classifyStatusRollup, probeBranchProtection,
  loadRules, fetchHeadCheckContexts, fetchExpectedRequiredContexts, classifyRequiredChecks,
  findApproveMergeAuthorization, evaluateAuthorizedFastMerge, decideStructuralBypassRoute,
  classifyBlockedStatus, scanPrSensitiveContent, normalizeLoginList, evaluateApprovalBasis, resolveApprovedShortcut,
  readReviewReceipt, isReviewReceiptClean, print, fail,
} from './lib.mjs';

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
        comments(first:100){ nodes{ author{ login __typename } body createdAt updatedAt url } }
        latestReviews: reviews(last:100){
          pageInfo{ hasPreviousPage }
          nodes{ author{ login __typename } state submittedAt commit{ oid } }
        }
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
  // normalizeLoginList(P2-3,2026-08-02):非数组/混入非字符串等非法配置形态不抛
  // TypeError,返回能用的部分 + invalid 标记——非空时必须在报告里显著告警。
  const { logins: ADMIN_LOGINS, invalid: adminsConfigInvalid } = normalizeLoginList(rules.admins);
  const ADMINS = new Set(ADMIN_LOGINS);
  const configWarnings = adminsConfigInvalid
    ? ['pr-rules.json 的 admins 字段配置形态不合法(应为字符串数组),已按能用的部分处理(非法条目被过滤),请检查配置']
    : [];

  const slug = `${owner}/${repo}`;
  const m = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'title,body,state,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,statusCheckRollup',
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

  // ── 安全与隐私内容门(P1-1,2026-08-02):对当前 head 真实重扫,不再恒传"无命中"。
  // 此前本脚本假设 context.mjs 已经拦过一轮、命中的 PR 走 pushback-security 根本不会跑
  // 到这一步——但授权快速合并通道是**跳过阶段二独立审查**的紧急通道,合并前必须独立
  // 复核泄密硬门(TOCTOU:授权评论可能在 context.mjs scan 之后才发出,那时 scan 阶段的
  // 安全扫描结果早已是历史快照)。scanned=false(diff 拉取失败等)必须 fail-closed 当
  // "未证明无泄露"处理,绝不能当"无命中"放行——这是本次修复的核心边界。──
  const securityScan = scanPrSensitiveContent({
    owner, repo, pr, title: m.title ?? '', body: m.body ?? '', sensitiveRules: rules.sensitiveContent ?? {},
  });

  // ── 授权快速合并通道:合并前最后复核(TOCTOU 保护,与 context.mjs 同口径重新现场检测,
  // 不信任 scan 时缓存——授权评论可能在 scan 之后才发出,也可能因为 scan 之后又推了新
  // commit 而作废,见 lib.mjs findApproveMergeAuthorization 与 SKILL 5.1「授权快速合并
  // 通道」)。──
  const rawComments = data?.data?.repository?.pullRequest?.comments?.nodes ?? [];
  const mappedComments = rawComments.map((c) => ({
    author: c.author?.login ?? '(unknown)',
    isBot: isBotAuthor(c.author),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    url: c.url,
    body: c.body ?? '',
  }));
  // SC-A(2026-08-04):授权改 head SHA 绑定,不再算 latestPushDate(pushedDate 数据源已废,
  // 见 lib.mjs parseApproveMergeShaCommands 注释)。
  const approveMergeAuth = findApproveMergeAuthorization({ comments: mappedComments, admins: rules.admins, headRefOid: m.headRefOid });
  // SC-B(2026-08-04 #469 复盘):ApprovalBasis 单一真相源——approve 必须绑定当前 head 才算数,
  // own-account(与巡审同账号)的 approve 受 mergeAuthorization 配置约束。reviewDecision 仍用于
  // CHANGES_REQUESTED 打回语义,但不再作为 approved shortcut 的依据。
  const reviewNodes = data?.data?.repository?.pullRequest?.latestReviews?.nodes ?? [];
  const reviewsComplete = data?.data?.repository?.pullRequest?.latestReviews?.pageInfo?.hasPreviousPage !== true;
  const approvalBasis = evaluateApprovalBasis({
    reviews: reviewNodes.map((n) => ({
      author: n.author?.login ?? '',
      isBot: isBotAuthor(n.author),
      state: n.state,
      submittedAt: n.submittedAt,
      commitOid: n.commit?.oid ?? null,
    })),
    headRefOid: m.headRefOid,
    viewerLogin,
    reviewsComplete,
  });
  const ownAckRequired = rules.mergeAuthorization?.ownAccountApprovalRequiresAck === true;
  const approvedShortcut = resolveApprovedShortcut({
    approvalBasis, ownAckRequired, headBoundAuthorized: !!approveMergeAuth.authorized,
  });
  // 紧急通道机械前提收窄(2026-08-01 owner 拍板):只剩泄密硬门 / 物理不可合(冲突)/
  // required 检查全绿三类不可绕过,格式门 / 未 resolve thread / 非 required 检查失败改记
  // reportOnly,不阻断 available,但调用方必须把非空的 reportOnly 显著写进合并致谢,
  // 不能悄悄吞掉。
  let authorizedFastMergeAvailable = false;
  let authorizedFastMergeInfo = null;
  if (approveMergeAuth.authorized) {
    const physicallyConflicted = m.mergeable === 'CONFLICTING' || m.mergeStateStatus === 'DIRTY';
    const checkNodes = fetchHeadCheckContexts({ owner, repo, pr });
    // P1-3(2026-08-02)required 完整性:expectedRequired===null(ruleset 端点读取失败)
    // 时不能悄悄跳过完整性核验,直接判 requiredChecks=null(未证明全绿),fail-closed。
    const expectedRequired = checkNodes ? fetchExpectedRequiredContexts(slug, m.baseRefName) : null;
    const requiredChecks = (checkNodes && expectedRequired) ? classifyRequiredChecks(checkNodes, expectedRequired) : null;
    const evaluation = evaluateAuthorizedFastMerge({
      security: securityScan,
      mergeStateStatus: physicallyConflicted ? 'DIRTY' : m.mergeStateStatus,
      unresolvedThreadCount: unresolved.length,
      formatPass: true, // 格式门由更上游的 context.mjs 判定,这里只复核机械前提,不重判格式
      formatIssues: [],
      requiredChecks,
    });
    authorizedFastMergeAvailable = evaluation.eligible;
    authorizedFastMergeInfo = {
      admin: approveMergeAuth.authorized.author,
      commentUrl: approveMergeAuth.authorized.url,
      commentCreatedAt: approveMergeAuth.authorized.createdAt,
      blockedReason: evaluation.blockedReason,
      reportOnly: evaluation.reportOnly,
    };
  }
  // P2-2(2026-08-02):被拒绝的已编辑授权评论——非空时必须在报告里显著说明,不能让人以为
  // 授权凭空消失。
  const editedAuthComments = approveMergeAuth.edited;

  const blockers = [];
  let blockClass = 'none';
  let structuralBlock = null; // {requiredCheckRules, canBypass, rulesetIds} | null
  let structuralAllowlisted = false; // structuralBlock.requiredCheckRules 是否全部命中 STRUCTURAL_BYPASS_ALLOWLIST
  let ciRuns = null;
  let headRollup = null;
  if (m.state !== 'OPEN') blockers.push(`PR state=${m.state}(非 OPEN)`);
  if (m.mergeable === 'CONFLICTING') blockers.push('mergeable=CONFLICTING(有冲突)');
  if (m.mergeStateStatus === 'DIRTY') {
    blockers.push('mergeStateStatus=DIRTY(有冲突)');
    blockClass = 'conflict';
  } else if (m.mergeStateStatus === 'BLOCKED') {
    if (m.reviewDecision === 'CHANGES_REQUESTED') {
      blockers.push('mergeStateStatus=BLOCKED(reviewDecision=CHANGES_REQUESTED,仍有 reviewer 要求修改)');
      blockClass = 'review-changes-requested';
    } else {
      // P1-4(2026-08-02)第②层可达性修复:approval 维度不再决定"要不要往下探测
      // thread/CI/结构性门",只决定探测完之后怎么归类——见 lib.mjs classifyBlockedStatus
      // 的详细注释(此前 reviewDecision=REVIEW_REQUIRED/null 时直接短路判
      // awaiting-approval,在不要求 approve 的仓库里,结构性门 + admin-trust 这条分级
      // 合并路由永久不可达)。两步 CI 判据不变(与此前同口径):先查 actions/runs(ciRuns,
      // 只看得见 GitHub Actions workflow run),全绿才补查 statusCheckRollup 全集
      // (headRollup,含第三方 App check-run / commit status,5178e64 起的既有口径)。
      ({ ciRuns } = classifyHeadChecks(slug, m.headRefOid));
      if (ciRuns !== null && ciRuns.failed.length === 0 && ciRuns.pending.length === 0) {
        headRollup = classifyStatusRollup(m.statusCheckRollup);
      }
      const classified = classifyBlockedStatus({
        reviewDecision: m.reviewDecision,
        hasUnresolvedThreads: unresolved.length > 0,
        ciRuns,
        headRollup,
        probeStructuralBlock: () => probeBranchProtection(slug, m.baseRefName, {
          satisfiedContexts: headRollup?.ok ? new Set(headRollup.ok) : null,
        }),
      });
      blockClass = classified.blockClass;
      structuralBlock = classified.structuralBlock;
      if (blockClass === 'threads-unresolved') {
        // blocker 由下面统一的 unresolved.length 判断追加。
      } else if (blockClass === 'ci-unknown') {
        if (ciRuns === null) {
          blockers.push('mergeStateStatus=BLOCKED,但 CI 状态读取失败(权限/网络/解析问题)——CI 是否通过未知,不当结构性门处理、不可 bypass');
        } else if (headRollup === null) {
          blockers.push('mergeStateStatus=BLOCKED,但 statusCheckRollup 读取失败——第三方 App check-run / commit status 是否失败未知(classifyHeadChecks 只看得到 GitHub Actions),不当结构性门处理、不可 bypass,下轮再看');
        } else {
          blockers.push('mergeStateStatus=BLOCKED,分支保护规则读取失败(权限/网络)——无法判断是否存在结构性门,不当 awaiting-approval 或 structural-check 处理,不可 bypass,下轮再看');
        }
      } else if (blockClass === 'ci-failed') {
        if (ciRuns.failed.length > 0) {
          blockers.push(`mergeStateStatus=BLOCKED(CI 失败:${ciRuns.failed.join(' / ')})`);
        } else {
          blockers.push(`mergeStateStatus=BLOCKED(head 上已上报检查失败:${headRollup.failed.join(' / ')}——第三方 App check-run / commit status,classifyHeadChecks 看不到;修绿前不合并)`);
        }
      } else if (blockClass === 'ci-pending') {
        if (ciRuns.pending.length > 0) {
          blockers.push(`mergeStateStatus=BLOCKED(CI 还在跑:${ciRuns.pending.join(' / ')},等跑完即可)`);
        } else {
          blockers.push(`mergeStateStatus=BLOCKED(head 上已上报检查还在跑:${headRollup.pending.join(' / ')},等跑完即可)`);
        }
      } else if (blockClass === 'structural-check') {
        // 永不上报结果的必需检查门(code_scanning/code_quality 等)→ 普通 merge 过不了,
        // 但 canBypass 且命中类型在 structuralBypassAllowlist 内时可走 admin bypass
        // (由 3A 决定;bypass 条件见 internal-gates.md)。与 context.mjs 同口径:已被全绿
        // context 满足的 required_status_checks 规则不算结构性门(见 classifyBlockedStatus
        // 传入的 satisfiedContexts)。
        structuralAllowlisted = !!structuralBlock?.requiredCheckRules?.length &&
          structuralBlock.requiredCheckRules.every((r) => STRUCTURAL_BYPASS_ALLOWLIST.has(r));
        const ruleHint = structuralBlock?.requiredCheckRules?.length
          ? structuralBlock.requiredCheckRules.join(' / ')
          : 'code_scanning / code_quality 等';
        const bypassHint = structuralBlock?.canBypass && structuralBlock.canBypass !== 'never'
          ? `当前账号可 bypass(${structuralBlock.canBypass})${structuralAllowlisted ? '' : ',但命中的必需检查类型不在 structuralBypassAllowlist 里'}`
          : 'bypass 权限未知';
        blockers.push(`mergeStateStatus=BLOCKED(必需检查门「${ruleHint}」未上报结果;review 与已跑 CI 均无问题——需 admin bypass 合或修该门;${bypassHint})`);
      } else if (blockClass === 'blocked-unexplained') {
        blockers.push('mergeStateStatus=BLOCKED,但 review/thread/CI/结构性检查探测均无已知问题——根因未知,fail-closed 不动,下轮再看或人工排查');
      }
      // blockClass === 'awaiting-approval' → 不视硬 blocker,不 push,与此前行为一致。
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
  // admins 名单**且**已有一条针对当前 head 的清白审查回执(basis='admin-trust',P1-5,
  // 2026-08-02——此前只看机械前提就直接判 true,与 reviewDecision/回执无关,是本次修的
  // fail-open 口子)。
  const structuralCanBypass = blockClass === 'structural-check' && structuralAllowlisted &&
    !!structuralBlock?.canBypass && structuralBlock.canBypass !== 'never';
  const { route: structuralRoute, basis: structuralBypassBasis } = decideStructuralBypassRoute({
    structuralCanBypass, approvedShortcut: approvedShortcut.granted, isAdminAuthor: authorIsAdmin,
  });
  const reviewReceipt = structuralRoute === 'review-pending-admin-bypass' ? readReviewReceipt(pr) : null;
  const receiptClean = structuralRoute === 'review-pending-admin-bypass' &&
    isReviewReceiptClean({ receipt: reviewReceipt, headRefOid: m.headRefOid });
  // 字段改名(P1-5,2026-08-02):structuralBypassAvailable → structuralBypassReady——
  // "ready" 强调"这次真的可以合了",不是"机械前提凑够了"。basis='approved' 立即 ready
  // (真实 GitHub review 就是审计凭证,不需要额外核验);basis='admin-trust' 必须回执
  // headRefOid 与当前 head 一致且 verdict=clean 才 ready——无回执 / 回执针对旧 head /
  // 回执 verdict≠clean 都不算,调用方(agent)必须先跑完独立审查、调用
  // write-review-receipt.mjs 落一条回执,再来读这个字段。
  const structuralBypassReady =
    structuralRoute === 'bypass-structural-block' ||
    (structuralRoute === 'review-pending-admin-bypass' && receiptClean);

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
    // P1-2(2026-08-02):本次判定针对的 head SHA——所有自动 merge / admin merge 命令必须
    // 带上 `--match-head-commit <headRefOid>`,做判定与执行之间的原子护栏(判定之后若又
    // 推了新 commit,GitHub 会拒绝合并,不会静默合了一个没被复核过的版本)。
    headRefOid: m.headRefOid,
    configWarnings,
    security: {
      scanned: securityScan.scanned,
      ...(securityScan.error ? { error: securityScan.error } : {}),
      hardHitCount: securityScan.hardHitCount,
      softHitCount: securityScan.softHitCount,
    },
    state: m.state,
    mergeable: m.mergeable,
    mergeStateStatus: m.mergeStateStatus,
    reviewDecision: m.reviewDecision,
    approvalBasis: { basis: approvalBasis.basis, independentApprovers: approvalBasis.independentApprovers, ownAccountCurrentHead: approvalBasis.ownAccountCurrentHead, staleApprovers: approvalBasis.staleApprovers, reasons: approvalBasis.reasons, ownAckRequired },
    approvedShortcut,
    legacyBareApproveComments: approveMergeAuth.legacyBare,
    blockClass,
    structuralBlock,
    structuralAllowlisted,
    structuralBypassReady,
    structuralBypassBasis,
    authorIsAdmin,
    reviewReceipt,
    ciRuns,
    blockedAwaitingApproval: blockClass === 'awaiting-approval',
    selfMergeAvailable,
    authorizedFastMergeAvailable,
    authorizedFastMergeInfo,
    editedAuthComments,
    mergeableUnknown,
    unresolvedThreads: unresolved,
    blockers,
    canMerge: canMerge || selfMergeAvailable || authorizedFastMergeAvailable,
    note: 'headRefOid 是本次判定针对的 head——所有合并一律经唯一出口 scripts/merge-pr.mjs 执行(它强制 --match-head 并写 intent/result 审计,见 SC-C),不得绕开该出口。security.scanned=false(diff 拉取失败等)→ 未证明无泄露,fail-closed,不放行,需重试;security.hardHitCount>0 → 任何通道都不可压过。canMerge=true 才走普通 merge。selfMergeAvailable=true 时用 node <SKILL_ROOT>/scripts/merge-pr.mjs <PR> --strategy <s> --match-head <headRefOid> --basis self-merge --admin --delete-branch(selfFixAuthors 的自有 PR,审查通过但 GitHub 不允许自批准)。authorizedFastMergeAvailable=true 时同样经 merge-pr.mjs(--basis authorized-fast-merge --admin),且可跳过阶段二独立审查(admins 名单成员发过 /approve-merge,晚于最后一次真实 push,评论未被编辑过,无冲突、head 上 required 检查全绿——这是紧急通道,只有泄密硬门/物理冲突/required CI 三类硬指标不可绕过;未 resolve thread / 非 required 检查失败不阻断,authorizedFastMergeInfo.reportOnly 里非空的项必须写进合并致谢/汇总,不能悄悄吞掉;formatIssues 恒为空数组,格式门由 context.mjs 在更上游判过,本脚本不重判)。editedAuthComments 非空 → 有人编辑了本该是 /approve-merge 授权的评论,已按规则拒绝,需在报告里说明并要求重发新评论。canMerge=false 时看 blockClass:structural-check + structuralBypassReady=true(要求 canBypass=always/pull_requests **且** requiredCheckRules 全部命中 pr-rules.json 的 structuralBypassAllowlist **且**(reviewDecision=APPROVED 或(作者在 admins 名单 **且** reviewReceipt 针对当前 headRefOid 且 verdict=clean)))→ 可走 admin bypass 合(merge-pr.mjs --basis approved|admin-trust --admin)。structuralBypassBasis 说明凭什么担保:"approved"=真实 GitHub review,任何模式下都能直接合;"admin-trust"=作者在 admins 名单但缺 APPROVED——structuralBypassReady 已经核验过回执,为 true 时才能合,为 false 时(reviewReceipt=null 或 headRefOid 不匹配或 verdict≠clean)必须先跑完独立审查、调用 write-review-receipt.mjs 落回执再重跑本脚本,交互模式仍需用户确认。ci-unknown(CI 状态读不到,权限/网络/解析问题)/ci-failed/ci-pending/review-changes-requested/threads-unresolved/blocked-unexplained 一律别 bypass。',
  });
  process.exit((canMerge || selfMergeAvailable || authorizedFastMergeAvailable) ? 0 : 2);
} catch (e) {
  fail(e);
}
