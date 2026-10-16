// gates.mjs — 前置审查的判门顺序(纯函数,无 I/O)。
// 顺序照搬 review-pr-auto/references/pr-worker.md:维护者确认门 → 未解决 thread → 凭证 / 格式 /
// 受保护路径 / CI / 冲突 / 他人 CR / bot 静默期 / rebase → 送审。唯一调整:凭证硬命中排在最前,
// 与 context.mjs 的 auto 分流和 review-pr SKILL「凭证与隐私门最先执行」一致(泄露越早打回越早轮换)。
// 输入是 context.mjs 的完整输出;输出是「下一步动作」,真正的 GitHub 写入由调用方用 Cindy 脚本执行。

export const KIND_TOPICS = {
  product: '产品 / UI 变更',
  arch: '技术架构调整',
  security: '安全敏感改动',
  coldUpdate: 'mobile 冷更(runtime fingerprint 变化)',
  rules: '审查规则文档变更',
  pluginBase: '插件基座改动(影响全部已装插件)',
  // 括号里不放逗号:Mivo parseSignoffIssue 用「涉及的…,维护者确认后」截取主题。
  protected: '受保护路径改动(.github / CODEOWNERS)',
};

// 与 review-pr/scripts/context.mjs 的 KIND_PRIORITY 同序:通知 issue 的主题取最先的那一类。
const SIGNOFF_KIND_PRIORITY = ['product', 'security', 'pluginBase', 'rules', 'coldUpdate', 'arch'];

/**
 * 服务器复核没认到放行(Approve 被撤销、评论被删、名单变化)时只回 outcome=protected、不带作者提醒回执;
 * 轮次汇总(collectRoundResults)要求受保护路径的结果有提醒终态,缺了会让整轮 finalize 抛错。
 * 这里补上:沿用前置判门这一轮的回执(Mini 已经发过提醒),丢了就记失败并重试。纯函数,不改入参。
 */
export function withProtectedAuthorNotice(result, { gateResult = null, head = '' } = {}) {
  if (result?.outcome !== 'protected' || result.authorNotice) return result;
  const authorNotice = gateResult?.authorNotice
    ?? { kind: 'protected-path', status: 'failed', head, reason: '服务器复核没认到放行,前置提醒回执已丢失(中断恢复)' };
  return { ...result, authorNotice, ...(authorNotice.status === 'failed' ? { retry: true } : {}) };
}

/** 改了受保护路径(.github 等)?context 的 protectedPath 为准;旧 context 退回 auto 分流。 */
export function isProtectedPathHit(ctx) {
  if (ctx?.protectedPath?.files?.length > 0) return true;
  const auto = ctx?.auto ?? {};
  return (auto.action === 'signoff-gate' ? auto.fallback?.action : auto.action) === 'skip-protected-path';
}

/**
 * 受保护路径放行后要不要派服务器写 review-pr check。纯函数,round.mjs 用它决定派发还是补关 issue:
 * 只有判门结果是 protected、人工放行成立、当前 head 没有维护者 Request Changes 时才考虑;
 * review-pr 已是 success(checkDone)就不再派,改为补关确认 issue(服务器关失败的兜底)。
 */
export function toProtectedDispatch({ decision, protectedPath, checkDone = false } = {}) {
  const eligible = decision?.stage === 'protected' && decision?.outcome === 'protected' &&
    Boolean(protectedPath?.released) && protectedPath?.waitingForAuthor !== true;
  return { dispatch: eligible && !checkDone, closeIssue: eligible && checkDone };
}

/**
 * @returns {{
 *   stage: 'signoff'|'threads'|'security'|'protected'|'format'|'ci'|'gate'|'review',
 *   outcome: string|null,      // pr-worker OUTCOMES;review 时为 null
 *   reason: string,
 *   actions: Array<{script:string, kind?:string, mode?:string}>,  // 需要执行的 Cindy 写脚本
 *   tier?: string,
 * }}
 */
export function decideGate(ctx) {
  if (!ctx?.ok) return { stage: 'error', outcome: 'error', reason: ctx?.error || 'context 读取失败', actions: [] };
  const signoff = ctx.signoff ?? {};
  const gate = ctx.gate ?? {};
  const auto = ctx.auto ?? {};
  const security = ctx.security ?? {};
  const labels = signoff.labels ?? {};
  const triggers = signoff.triggers ?? [];

  // 0. 凭证硬命中:最先打回(context 不让维护者门包裹它)。
  if ((security.hardHitCount ?? 0) > 0) {
    const stale = auto.action === 'skip-stale-pushback';
    return {
      stage: 'security', outcome: 'security',
      reason: stale
        ? `凭证/密钥硬命中 ${security.hardHitCount} 处,上次已打回且作者未提交新 commit`
        : `凭证/密钥硬命中 ${security.hardHitCount} 处,打回要求移除并轮换`,
      actions: stale ? [] : [{ script: 'request-changes', gateKind: 'security' }],
    };
  }

  // 1. 维护者确认门
  const exempt = signoff.authorExempt === true || ctx.approvalPolicy?.authorIsMaintainer === true;
  const signoffActions = [];
  const protectedHit = isProtectedPathHit(ctx);
  if (protectedHit) {
    // 受保护路径(任何作者,含豁免名单):前置审查开确认 issue 转人工审核,放行前审查机不写绿。
    // 放行信号(维护者 Approve / issue 上的 Slack 或 GitHub「同意放行」)统一由 context 的 protectedPath 算好。
    // 它的确认门触发(如 .github/workflows 同时命中 security)并入这一个 issue,不再另开普通 hold。
    const protectedPath = ctx.protectedPath ?? {};
    if (protectedPath.waitingForAuthor) {
      if (labels.hasAnyLabel) signoffActions.push({ script: 'signoff-release', mode: 'labels-only' });
      return {
        stage: 'signoff', outcome: 'changes-requested',
        reason: '维护者在当前 head 上 Request Changes,等待作者修改',
        actions: signoffActions,
      };
    }
    if (!protectedPath.released) {
      // 已有确认 issue 且仍可复用(不是通知 issue、没关闭)只补标签;否则开完整的新 issue。
      const heldIssue = signoff.heldIssue ?? null;
      const reusable = Boolean(signoff.held) && heldIssue?.mode !== 'notice' && heldIssue?.state !== 'CLOSED';
      signoffActions.push({ script: 'signoff-hold', mode: reusable ? 'labels-only' : 'full', kind: 'protected', issueMode: 'protected' });
    } else if (labels.hasAnyLabel) {
      // 放行后只摘标签。确认 issue 等服务器把 review-pr 写成功后再关(round 的 toProtectedDispatch)。
      signoffActions.push({ script: 'signoff-release', mode: 'labels-only' });
    }
  } else if (exempt) {
    // 豁免名单作者碰到确认门:不拦,但开一个通知 issue 让维护者看见(每个 PR 一次,创建后即关闭、不挂标签)。
    if (triggers.length > 0 && !signoff.held) {
      const kind = SIGNOFF_KIND_PRIORITY.find((k) => triggers.some((t) => t.kind === k)) ?? triggers[0].kind;
      signoffActions.push({ script: 'signoff-hold', mode: 'full', kind, issueMode: 'notice' });
    }
    if (labels.hasAnyLabel) signoffActions.push({ script: 'signoff-release', mode: 'labels-only' });
  } else {
    const blocking = triggers.filter((t) => t.blocking);
    const waiting = triggers.some((t) => t.waitingForAuthor);
    const released = triggers.length > 0 && triggers.every((t) => !t.blocking && t.released);
    if (blocking.length > 0) {
      const kind = signoff.currentBlocker?.kind ?? blocking[0].kind;
      signoffActions.push(signoff.held
        ? { script: 'signoff-hold', mode: 'labels-only', kind }
        : { script: 'signoff-hold', mode: 'full', kind });
      return {
        stage: 'signoff', outcome: 'maintainer-signoff',
        reason: `维护者确认门在拦:${blocking.map((t) => `${t.kind}(${t.detail})`).join('、')}`,
        actions: signoffActions, kind,
      };
    }
    if (waiting) {
      if (labels.hasAnyLabel) signoffActions.push({ script: 'signoff-release', mode: 'labels-only' });
      return {
        stage: 'signoff', outcome: 'changes-requested',
        reason: '维护者在当前 head 上 Request Changes,等待作者修改',
        actions: signoffActions,
      };
    }
    if (released && labels.hasAnyLabel) signoffActions.push({ script: 'signoff-release', mode: 'labels-only-close-issue' });
    if (triggers.length === 0) {
      // 触发全部消失:收掉旧讨论 issue(脚本自己核对 issue 仍 OPEN)并摘掉残留标签。
      if (signoff.held) signoffActions.push({ script: 'close-product-issue', mode: 'no-longer-required' });
      if (labels.hasAnyLabel) signoffActions.push({ script: 'signoff-release', mode: 'labels-only' });
    }
  }

  // 2. 未解决 thread。只剩机器人(Greptile 等)留的 thread 时照样送审,但不放行(2026-10-15 #927:
  //    3 条 Greptile thread 没关,审查机一次没审,PR 被强合)。合并仍由组织规则要求 thread 全部 resolve。
  const unresolved = gate.unresolvedThreads?.length ?? gate.unresolvedThreadCount ?? 0;
  const threadsResult = { stage: 'threads', outcome: 'threads-unresolved', reason: `${unresolved} 条 conversation 未 resolve`, actions: signoffActions };
  const botThreadsOnly = isBotThreadsOnly(gate, unresolved);
  if (unresolved > 0 && !botThreadsOnly) return threadsResult;
  const pendingGates = botThreadsOnly ? ['bot-threads'] : [];

  // 3. 受保护路径 / 格式 / CI / 其他前置门(沿用 context.auto 的确定性分流)
  const withSignoff = (decision) => ({ ...decision, actions: [...signoffActions, ...(decision.actions ?? [])] });
  const action = auto.action === 'signoff-gate' ? auto.fallback?.action : auto.action;
  const reason = auto.action === 'signoff-gate' ? auto.fallback?.reason : auto.reason;
  // 只缺界面证据、其他前置门都过时:照样打回要证据,同时送审代码(2026-10-15 #926/#935 因缺截图零审查被强合)。
  // 审查没有 P0/P1 也不 Approve,等证据补上后重审放行。
  const evidenceOnly = ['pushback-format', 'skip-stale-pushback'].includes(action) && isEvidenceOnly(ctx) && otherGatesClear(gate, botThreadsOnly);
  if (evidenceOnly) {
    const evidenceUntold = action === 'pushback-format' || ctx.meta?.reviewDecision !== 'CHANGES_REQUESTED';
    return withSignoff({ stage: 'review', outcome: null, reason: `${formatReason(ctx)};代码照审,补齐前不放行`,
      actions: evidenceUntold ? [{ script: 'request-changes', gateKind: 'format' }] : [],
      tier: ctx.review?.tier ?? 'standard', pendingGates: ['ui-evidence', ...pendingGates] });
  }
  if (botThreadsOnly && action !== 'review') return threadsResult;
  switch (action) {
    case 'skip-protected-path':
      return withSignoff({ stage: 'protected', outcome: 'protected', reason, actions: [{ script: 'notify-protected' }] });
    case 'pushback-format':
      return withSignoff({ stage: 'format', outcome: 'format', reason: formatReason(ctx), actions: [{ script: 'request-changes', gateKind: 'format' }] });
    case 'skip-stale-pushback': {
      // 「已打回过」也算上了评论形式的弱打回(如旧的维护者确认提醒)。缺界面证据时若 PR 上没有生效的
      // Request Changes,作者从没收到过补证据的要求:打回一次;打回后 reviewDecision 变成 CHANGES_REQUESTED,不会重复。
      const evidenceUntold = ctx.format?.formatPass === false && ctx.format?.uiEvidenceRequired === true &&
        ctx.meta?.reviewDecision !== 'CHANGES_REQUESTED';
      if (evidenceUntold) {
        return withSignoff({ stage: 'format', outcome: 'format', reason: formatReason(ctx), actions: [{ script: 'request-changes', gateKind: 'format' }] });
      }
      return withSignoff({ stage: 'format', outcome: ctx.format?.formatPass === false ? 'format' : 'changes-requested', reason, actions: [] });
    }
    case 'approve-workflows':
      return withSignoff({ stage: 'ci', outcome: 'ci-pending', reason, actions: [{ script: 'approve-workflows' }] });
    case 'skip-workflow-ci-change':
      return withSignoff({ stage: 'ci', outcome: 'ci-pending', reason, actions: [] });
    case 'skip-stale-rebase':
      return withSignoff({ stage: 'gate', outcome: 'rebase', reason, actions: [{ script: 'notify-rebase' }] });
    case 'skip-gate':
    case 'skip-structural-block':
    case 'bypass-structural-block':
      return withSignoff(classifyGateBlock(ctx, reason));
    case 'review':
      return withSignoff({ stage: 'review', outcome: null, actions: [], tier: ctx.review?.tier ?? 'standard',
        ...(pendingGates.length
          ? { reason: `只剩 ${unresolved} 条机器人留的 conversation 未 resolve;代码照审,resolve 前不放行`, pendingGates }
          : { reason: '前置门全部通过,送服务器审查' }) });
    default:
      return withSignoff({ stage: 'error', outcome: 'error', reason: `未知的 auto.action:${action ?? '(empty)'}`, actions: [] });
  }
}

// 未 resolve 的 thread 全是机器人发起的(context.mjs 的 isBot 判首条评论作者)。读不到明细时按有人的算。
function isBotThreadsOnly(gate, unresolved) {
  const threads = gate.unresolvedThreads;
  return unresolved > 0 && Array.isArray(threads) && threads.length === unresolved && threads.every((t) => t?.isBot === true);
}

// 格式门唯一的问题是缺界面证据(与 buildGatePushback 的 evidenceOnly 同口径)。
function isEvidenceOnly(ctx) {
  return ctx.format?.formatPass === false && ctx.format?.uiEvidenceRequired === true && (ctx.format?.formatIssues ?? []).length === 1;
}

// 格式门之外的前置门(冲突、CI、他人 CR、bot 静默期、rebase 等)都过了;只剩机器人 thread 的不算卡。
const THREAD_BLOCKER_RE = /条 conversation 未 resolve/;
function otherGatesClear(gate, botThreadsOnly) {
  if (gate.gatePass === true) return true;
  const blockers = gate.blockers ?? [];
  return botThreadsOnly && blockers.length > 0 && blockers.every((b) => THREAD_BLOCKER_RE.test(String(b)));
}

/** 送审但不能放行的前置门 → 给作者看的说明。 */
export const PENDING_GATE_TEXT = {
  'ui-evidence': 'PR 描述里还缺改动后的界面证据(截图/录屏或 HTML)',
  'bot-threads': '还有机器人(如 Greptile)留的讨论没有 resolve',
};

function formatReason(ctx) {
  const issues = ctx.format?.formatIssues ?? [];
  return issues.length ? `格式门未通过:${issues.join(';')}` : '格式门未通过';
}

/** skip-gate 的具体卡点 → pr-worker OUTCOMES。优先级:冲突 → 他人 CR → CI → bot → retarget → 其他。 */
export function classifyGateBlock(ctx, reason) {
  const gate = ctx.gate ?? {};
  const blockClass = gate.blockClass ?? 'none';
  const ciStatus = gate.ci?.status;
  if (blockClass === 'conflict' || ctx.meta?.mergeStateStatus === 'DIRTY') return { stage: 'gate', outcome: 'conflict', reason, actions: [] };
  if (blockClass === 'review-changes-requested') return { stage: 'gate', outcome: 'changes-requested', reason, actions: [] };
  if (ciStatus === 'failed' || blockClass === 'ci-failed') return { stage: 'ci', outcome: 'ci-failed', reason, actions: [{ script: 'retry-ci' }] };
  if (ciStatus === 'pending' || ciStatus === 'awaiting' || blockClass === 'ci-pending' || blockClass === 'workflow-awaiting') {
    return { stage: 'ci', outcome: 'ci-pending', reason, actions: [] };
  }
  if (ciStatus === 'unknown' || blockClass === 'ci-unknown') return { stage: 'ci', outcome: 'ci-unknown', reason, actions: [] };
  if (gate.botSettle && gate.botSettle.settled === false) return { stage: 'gate', outcome: 'bot-pending', reason, actions: [] };
  if (ctx.meta?.needsRetarget) return { stage: 'gate', outcome: 'retarget', reason, actions: [] };
  if ((gate.reviewerPushbacks ?? []).some((p) => p.signal === 'strong' && !p.hasNewerCommit)) {
    return { stage: 'gate', outcome: 'changes-requested', reason, actions: [] };
  }
  if (blockClass === 'stale-rebase-unknown') return { stage: 'gate', outcome: 'error', reason, actions: [], retry: true };
  return { stage: 'gate', outcome: 'merge-blocked', reason, actions: [] };
}

/**
 * 确认 issue / PR 首评文案(Mivo 现有固定模板,见方案附录 A)。不调用模型。
 * mode:normal = 普通确认门;protected = 受保护路径(转人工审核);notice = 豁免作者的通知。
 * 三种模式的 issue 骨架一致(标题前缀「维护者确认 · PR #」+ 三段 ### ),Mivo parseSignoffIssue 靠它解析;
 * 正文里不能出现「关联 PR:#」(footer 由 signoff-hold 追加,解析取最后一处)。
 */
export function buildSignoffPayload(ctx, kind, mode = 'normal') {
  const pr = ctx.pr;
  const title = ctx.meta?.title ?? '';
  const author = ctx.meta?.author ?? '';
  const isProtected = mode === 'protected';
  const trigger = isProtected
    ? { detail: `改动受保护路径 ${(ctx.protectedPath?.files ?? []).slice(0, 5).join(' / ')}(转人工审核)`, files: ctx.protectedPath?.files ?? [] }
    : (ctx.signoff?.triggers ?? []).find((t) => t.kind === kind) ?? ctx.signoff?.currentBlocker ?? {};
  const blockingKinds = (ctx.signoff?.triggers ?? []).filter((t) => t.blocking).map((t) => t.kind);
  const files = [...(ctx.files ?? [])]
    .map((f) => ({ path: f.path, lines: (f.additions ?? 0) + (f.deletions ?? 0) }))
    .sort((a, b) => b.lines - a.lines);
  const triggerFiles = new Set([
    ...(trigger.uiFiles ?? []), ...(trigger.files ?? []), ...(trigger.pathFiles ?? []), ...(trigger.coreFilePaths ?? []),
  ]);
  const ranked = triggerFiles.size ? files.filter((f) => triggerFiles.has(f.path)) : files;
  const top = (ranked.length ? ranked : files).slice(0, 5);
  const changedSummary = top.length
    ? ['涉及文件(前 5 个,按改动行数):', ...top.map((f) => `- \`${f.path}\`(${f.lines} 行)`)].join('\n')
    : '';
  const confirmSection = mode === 'notice'
    ? ['- 本 issue 只是通知：作者在豁免名单内，维护者确认门不拦，PR 照常进入自动审查，不需要回复。']
    : [
      '- **通过**：在相关 Slack 会话留言「同意放行」、在本 issue 下评论「同意放行」，或直接在 PR 上 Approve；批一次一直有效',
      '- **需要修改**：Request Changes，作者改完后重新同意或重新 Approve 即放行',
      ...(isProtected ? ['- 本 PR 改了受保护路径，自动审查不审这类改动；放行后审查机把 `review-pr` 检查写为通过'] : []),
    ];
  const issueBody = [
    '### 触发原因',
    '',
    `**${kind}** — ${trigger.detail ?? ''}`,
    '',
    changedSummary,
    '',
    '### PR',
    ctx.meta?.url ?? '',
    '',
    '### 确认方式',
    '',
    ...confirmSection,
  ].join('\n');
  const topicList = isProtected
    ? KIND_TOPICS.protected
    : (blockingKinds.length ? blockingKinds : [kind]).map((k) => KIND_TOPICS[k] ?? k).join('、');
  const commentBody = mode === 'notice'
    ? [
      `本 PR 命中维护者确认门（触发类别：${KIND_TOPICS[kind] ?? kind}）。作者在豁免名单内，确认门不拦，PR 照常进入自动审查；已开通知 issue 告知维护者：{{ISSUE_URL}}`,
    ].join('\n')
    : isProtected
      ? [
        `本 PR 改了受保护路径（${(ctx.protectedPath?.files ?? []).slice(0, 5).join(' / ')}），自动审查不审这类改动，**已转人工审核**。`,
        '',
        '维护者在确认 issue 下评论「同意放行」、在 Slack 讨论串回复「同意放行」，或直接在 PR 上 Approve 后，审查机会把 review-pr 写成通过；批一次之后再推新提交不用重批。',
        '',
        '确认 issue：{{ISSUE_URL}}',
      ].join('\n')
      : [
        `本 PR 需要**维护者确认**（触发类别：${topicList}）。`,
        '',
        '请维护者审阅后**直接在 PR 上 Approve** 表示确认，或在 Slack 讨论串、讨论 issue 下回复「同意放行」；如需作者修改，请 Request Changes 并写明要求。',
        '',
        '讨论 issue：{{ISSUE_URL}}',
      ].join('\n');
  return { issueTitle: `维护者确认 · PR #${pr} ${title}`.trim(), issueBody, commentBody, author };
}

/** 格式门 / 凭证门的打回正文(Cindy 口径:凭证只写文件/行号/类型,不引用原文)。 */
export function buildGatePushback(ctx, gateKind) {
  const author = ctx.meta?.author ? `@${ctx.meta.author} ` : '';
  if (gateKind === 'security') {
    const hits = ctx.security?.hardHits ?? [];
    const lines = hits.map((h) => `- \`${h.file}\` 第 ${h.line} 行:${h.kind}`);
    return {
      body: [
        `${author}这个 PR 的改动里有疑似真实凭证/密钥(${hits.length} 处),自动审查先打回,不进入代码审查。`,
        '',
        ...lines,
        '',
        '请移除这些内容并清理分支历史(凭证一旦推到远端就应视为已泄露,请同时轮换)。改完推送后,下一轮 auto-review 会自动重新审查这个 PR。',
      ].join('\n'),
      comments: hits.filter((h) => h.file && !/^PR (title|body)$/.test(h.file) && Number.isInteger(h.line) && h.line > 0)
        .map((h) => ({ path: h.file, line: h.line, side: 'RIGHT', body: `[P0] 疑似真实凭证(${h.kind})。请移除并轮换,不要只在后续 commit 里删掉。` })),
    };
  }
  const issues = ctx.format?.formatIssues ?? [];
  // 缺界面证据是唯一问题时,说清楚只要补截图或 HTML(改界面不需要维护者确认)。
  const evidenceOnly = ctx.format?.uiEvidenceRequired === true && issues.length === 1;
  return {
    body: [
      evidenceOnly
        ? `${author}这个 PR 改了界面,描述里还没有改动后的界面证据,自动审查先打回,不进入代码审查。`
        : `${author}这个 PR 的标题或描述不符合仓库的 PR 格式要求,自动审查先打回,不进入代码审查。`,
      '',
      ...issues.map((i) => `- ${i}`),
      '',
      evidenceOnly
        ? '改界面不需要等维护者确认,只要在描述里补上截图/录屏或 HTML 界面;这次改动看不出界面变化的,在「效果展示」第一行写「不涉及」也可以。改完描述后,下一轮 auto-review 会自动重新审查这个 PR。'
        : '请按 PR 模板补齐(标题 `<type>(<scope>): <描述>`;描述包含「这次改了什么 / 怎么验证的 / 风险」三段)。改完后,下一轮 auto-review 会自动重新审查这个 PR。',
    ].join('\n'),
    comments: [],
  };
}
