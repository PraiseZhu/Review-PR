#!/usr/bin/env node
// signoff-hold.mjs — 维护者确认门的拦截动作:自动创建讨论 issue → 在 PR 上发评论告知作者
// (带 issue 链接)→ 打上维护者确认标签。**不再转 draft**(旧 draft 制已废除:draft 带来的
// hold↔ready 死循环、PAT 无 convertToDraft 权限、归属判定一整族复杂度随之消失;
// 真正挡合并的是流程内部的判定,标签只是 GitHub 后台的可筛性入口——
// 通过动作是维护者在 PR 上 Approve,摘标签不构成通过)。
//
// 移植自 lizi 上游 signoff-hold.mjs(makecindy/cindy-lizi-skills,2026-08-09),
// 适配点:全部依赖函数已在 mivo 侧 lib.mjs(signoff 统一段)补齐;--kind 只影响措辞,
// 触发判定由 context.mjs 按 mivo 扁平配置(securityReviewPaths / archGate / ruleFiles)
// 输出,本脚本只做动作 + 幂等。文案(issue 标题 / issue 正文 / PR 评论)由调用方
// (主 agent 按 SKILL 要求与语气规范拟)经 --payload-file 传 JSON 进来,脚本不生成
// 任何一句对外文字;缺文案时拒绝执行主动作(reason=missing-payload,标签照打)。
//
// 状态回帖(renotice):首次 hold 的评论只发一次,但门会**反复**亮起来 —— 维护者
// Request Changes → 标签摘掉、球给作者;作者改完推上来 → 门重新亮、标签挂回去。
// 这个「挂回去」以前是完全静默的;所以本脚本在「已经 hold 过 + 本轮发现标签不在」
// 时自动补一条回帖,按 head sha 去重。判据用的是**看到时标签不在**(不是「加标签成功」)。
// 这条文案是固定模板、由脚本自己出:它不含任何语义判断,而可靠性要求它不能依赖上层
// 每轮都记得传文案。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段,让 auto 轮转能继续下一候选。
//
// 跑:node <skill-root>/scripts/signoff-hold.mjs <PR> [--payload-file <path|->]
//     [--kind <product|arch|security|coldUpdate|rules|pluginBase>] [--labels-only] [--dry-run]
//     [--no-renotice]
//   --payload-file:JSON 文案来源,`-` = stdin(推荐,避开中文/引号问题)。结构:
//     { "issueTitle": "...", "issueBody": "...", "commentBody": "...{{ISSUE_URL}}..." }
//     commentBody 里的 {{ISSUE_URL}} 会被替换成新建 issue 的链接;没写占位符则自动在
//     末尾追加一行「讨论 issue:<url>」。已存在标记评论时 payload 可省(只补打标签)。
//   --kind:当前在拦的触发类别(context 的 signoff.triggers 命中),只影响措辞。
//   --labels-only:只确保维护者确认标签挂上(并摘掉旧门类子标签),不开 issue、不发首次
//     hold 评论。用于标签状态重同步。**状态回帖照发**(见上)。
//   --no-renotice:关掉状态回帖(只给测试/特殊场景用)。
//   --dry-run:只探测(是否已拦截过 / 将做什么),不写任何外部状态
//
// 正确调用(`-` 走 stdin):
//   node .../signoff-hold.mjs 123 --kind security --payload-file - <<'JSON'
//   { "issueTitle": "…", "issueBody": "…", "commentBody": "…{{ISSUE_URL}}…" }
//   JSON

import { readFileSync } from 'node:fs';
import { parseRepo, parsePR, gh, ghJson, print, fail, renderIssueUrl, PRODUCT_GATE_MARKER_PREFIX, SIGNOFF_RENOTICE_MARKER_PREFIX, parseSignoffRenotices, loadRules, syncSignoffLabel, SIGNOFF_LABEL_DEFAULT, removeLegacyGateLabels, issueNumberFromUrl, decideIssueReuse } from './lib.mjs';

// 隐藏去重标记:HTML 注释,GitHub 渲染不可见,但 API 返回的 body 里查得到。
// 前缀沿用 review-pr:product-gate(lib.mjs 常量,parseLastHoldMarker 共用)——存量被 hold
// 的 PR 用的就是它。kind=arch 兼容位:非 product 触发统一带 kind=arch(历史消费方只区分这两种)。
const MARKER_PREFIX = PRODUCT_GATE_MARKER_PREFIX;
const marker = (issueUrl, kind) =>
  kind === 'product' ? `${MARKER_PREFIX} issue=${issueUrl} -->` : `${MARKER_PREFIX} kind=arch issue=${issueUrl} -->`;

const KIND_TOPICS = {
  product: '产品 / UI 变更',
  arch: '技术架构调整',
  security: '安全敏感改动',
  coldUpdate: 'mobile 冷更(runtime fingerprint 变化)',
  rules: '审查规则文档变更',
  pluginBase: '插件基座改动(影响全部已装插件)',
};

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const kindIdx = process.argv.indexOf('--kind');
  const kind = kindIdx >= 0 && KIND_TOPICS[process.argv[kindIdx + 1]] ? process.argv[kindIdx + 1] : 'product';
  const labelsOnly = process.argv.includes('--labels-only');
  const kindGiven = kindIdx >= 0 && KIND_TOPICS[process.argv[kindIdx + 1]] != null;
  const noRenotice = process.argv.includes('--no-renotice');
  const SIGNOFF_LABEL = (loadRules().signoffGate?.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT;
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  let payload = null;
  if (payloadSrc) {
    payload = JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'));
  }
  const issueTitle = (payload?.issueTitle ?? '').trim();
  const issueBody = (payload?.issueBody ?? '').trim();
  const commentBody = (payload?.commentBody ?? '').trim();
  const payloadComplete = issueTitle !== '' && issueBody !== '' && commentBody !== '';

  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,state,mergedAt,author,url,comments,labels,headRefOid',
  ]);
  const author = meta.author?.login ?? '';
  const currentLabels = (meta.labels ?? []).map((l) => l.name);
  const headSha = String(meta.headRefOid ?? '').toLowerCase();
  // 挂维护者确认标签;顺手摘掉旧主标签与旧门类子标签(迁移遗留)
  const syncLabels = () => {
    const result = syncSignoffLabel({ owner, repo, pr, want: true, label: SIGNOFF_LABEL, current: currentLabels, ghFn: gh, dryRun });
    const legacy = removeLegacyGateLabels({ owner, repo, pr, current: currentLabels, ghFn: gh, dryRun });
    if (legacy.legacyRemoved.length) result.legacyRemoved = legacy.legacyRemoved;
    if (legacy.errors.length) result.errors = [...(result.errors ?? []), ...legacy.errors];
    if (result.errors.length && !result.warning) {
      result.warning = `维护者确认标签同步没完成:${result.errors[0]}`;
    }
    return result;
  };
  // 标签失败不静默:顶到输出最外层(labelWarning),SKILL 要求最终报告里照抄。
  // 少了标签 → GitHub 后台与待确认面板都筛不到该 PR,门的判定不受影响。
  const withLabelWarning = (out) => (out.labels?.warning ? { ...out, labelWarning: out.labels.warning } : out);
  const printOut = (out) => print(withLabelWarning(out));

  // 找既有标记评论,读出当时开的 issue 链接。取「最后一条带 issue= 的标记」为准。
  const markerComments = (meta.comments ?? []).filter((c) => (c.body ?? '').includes(MARKER_PREFIX));
  const alreadyHeld = markerComments.length > 0;
  const priorIssueUrl = markerComments
    .map((c) => c.body.match(/issue=(\S+?)\s*-->/)?.[1] ?? null)
    .filter(Boolean)
    .pop() ?? null;
  // ── 旧讨论 issue 复用/新开判定(decideIssueReuse,见 lib.mjs;signoff-policy.test.mjs 覆盖)──
  // 旧 issue 可能已被 close-product-issue.mjs --no-longer-required 收尾关闭,之后 gate
  // 再亮起来时不能把作者引到一个已关闭的讨论里 —— 视同没开过,凭 payload 新开当前讨论
  // issue(新标记评论盖过旧标记)。state 查询失败 fail-safe 复用旧链接:网络抖动不该制造
  // 重复 issue,下一轮查到 CLOSED 再开也不迟。
  let priorIssueState = null;
  let priorIssueStateError = null;
  if (priorIssueUrl != null) {
    const priorNum = issueNumberFromUrl(slug, priorIssueUrl);
    if (priorNum == null) {
      priorIssueStateError = 'issue-url-unparsable';
    } else {
      const r = gh(['issue', 'view', String(priorNum), '--repo', slug, '--json', 'state'], { allowFail: true });
      if (r.ok) {
        try {
          const s = String(JSON.parse(r.stdout || '{}').state ?? '').toUpperCase();
          priorIssueState = s === 'OPEN' || s === 'CLOSED' ? s : null;
        } catch { priorIssueStateError = 'state-parse-failed'; }
      } else {
        priorIssueStateError = (r.stderr || r.stdout || '').trim().split('\n')[0]?.slice(0, 200) || 'unknown';
      }
    }
  }
  const reuse = decideIssueReuse({ priorIssueUrl, issueState: priorIssueState });
  const needIssue = reuse.needNewIssue;
  // 输出透出旧 issue 状态;labels-only 模式不建 issue,旧 issue 已关闭时以 needsFreshHold
  // 提示调用方带 payload 重跑完整模式。
  const priorIssueInfo = priorIssueUrl == null ? {} : {
    priorIssueState,
    issueReuse: reuse.reason,
    ...(priorIssueStateError ? { priorIssueStateError } : {}),
    ...(reuse.needNewIssue ? { priorIssueClosed: true } : {}),
  };

  // ── 状态回帖 ──
  // 触发条件(全部满足):已经 hold 过(作者收过带 issue 链接的完整说明)+ 本轮看到时标签
  // **不在**(= 门刚从放行/等作者翻回等维护者,或标签被人摘了)+ 这版 head 还没回帖过。
  // 用「看到时标签不在」而不是「加标签成功」:标签写失败(权限类)时门照旧在拦,作者更该知道。
  // headSha 拿不到时**宁可不发**:去重键为空 → 标记写成 head= 解析不回来 → 每轮都重复回帖,
  // 那比漏一条更糟。这种情况在输出里如实写 no-head-sha。
  const labelWasAbsent = !currentLabels.includes(SIGNOFF_LABEL);
  const noticedHeads = parseSignoffRenotices(meta.comments ?? []);
  const renoticeDone = noticedHeads.has(headSha);
  // 回帖里的讨论链接用 reuse.reuseUrl:旧 issue 已关闭时不回帖 —— 不能把作者引进一个
  // 已关闭的讨论;完整模式新开 issue 时那条带标记的评论本身就是完整通知,不需要回帖叠加。
  const renoticeIssueUrl = reuse.reuseUrl;
  const renoticeWanted = !noRenotice && renoticeIssueUrl != null && labelWasAbsent && !renoticeDone && headSha !== '';
  // 文案固定模板。三条纪律:
  //   ① kind 没传就不硬说是哪一类 —— 默认值 product 在 --labels-only 时是猜的,猜错比不说更糟;
  //   ② 不写「你刚推了新代码」这类断言 —— 本分支也会在「首次 hold 时标签写失败、下一轮补挂」
  //      时走到,那时作者并没有推东西,说了就是错话;
  //   ③ 不写「不用你再管了」—— 门在拦的同时可能还有 review 意见 / CI 要作者修。
  const renoticeBody = () => {
    const scope = kindGiven ? `维护者确认门(${KIND_TOPICS[kind]})` : '维护者确认门';
    const hail = author ? `@${author} 👋 ` : '';
    return [
      `${hail}**这个 PR 现在在等维护者确认**,确认之前流程不会合并它 —— 不是卡住了,也不是在等你再改一版(你推的改动流程都读到了,判的就是最新一版代码)。`,
      '',
      `- 在拦的是:${scope}。`,
      `- 讨论 issue:<${renoticeIssueUrl}>`,
      '- 通过方式只有一个:维护者在本 PR 上 **Approve**。维护者觉得要改会直接 **Request Changes**,那时候球才回到你手里。',
      '- 这期间如果还有 review 意见没处理完、CI 没过,照常修就行,不影响这条等待。',
      '',
      '这条是流程自动发的状态提醒(同一版代码只发一次),不用回复。',
    ].join('\n');
  };
  const doRenotice = () => {
    if (!renoticeWanted) {
      return {
        renoticed: false,
        renoticeSkipped: noRenotice ? 'disabled'
          : priorIssueUrl == null ? 'never-held'
            : renoticeIssueUrl == null ? 'prior-issue-closed'
              : !labelWasAbsent ? 'label-already-on'
                : renoticeDone ? 'already-noticed-for-head'
                  : headSha === '' ? 'no-head-sha' : 'unknown',
      };
    }
    if (dryRun) return { renoticed: false, wouldRenotice: true };
    const r = gh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
      input: `${renoticeBody()}\n\n${SIGNOFF_RENOTICE_MARKER_PREFIX} head=${headSha} -->`,
      allowFail: true,
    });
    // 回帖失败不连坐标签、也不改变门的判定:头一行报错顶到输出里,下一轮凭「无 head 标记」自动重试。
    return r.ok
      ? { renoticed: true, renoticeHead: headSha }
      : { renoticed: false, renoticeError: (r.stderr || r.stdout || '').trim().split('\n')[0]?.slice(0, 200) ?? 'unknown' };
  };

  // 已合并 / 已关闭的 PR 不碰
  if (meta.state !== 'OPEN' || meta.mergedAt) {
    print({ ok: true, pr, author, held: false, reason: 'pr-not-open', state: meta.state });
  } else if (labelsOnly) {
    // 标签先挂回去,再回帖:回帖里说的「在等维护者确认」要和 GitHub 上的标签状态一致。
    // 旧 issue 已关闭 → needsFreshHold=true:labels-only 建不了 issue,调用方带 payload
    // 重跑完整模式新开当前讨论 issue。
    printOut({
      ok: true, pr, author, labelsOnly: true, alreadyHeld, ...priorIssueInfo,
      ...(priorIssueUrl != null && reuse.needNewIssue ? { needsFreshHold: true } : {}),
      labels: syncLabels(), ...doRenotice(),
    });
  } else {
    if (dryRun) {
      printOut({
        ok: true, pr, author, dryRun: true,
        alreadyHeld, priorIssueUrl, ...priorIssueInfo,
        wouldCreateIssue: needIssue && payloadComplete,
        wouldComment: needIssue && payloadComplete,
        missingPayload: needIssue && !payloadComplete,
        labels: syncLabels(),
        ...doRenotice(),
      });
    } else if (needIssue && !payloadComplete) {
      // 开 issue / 发评论必须有完整文案——光打标签会让作者一头雾水。标签照打:判定已经是
      // 「维护者确认门在拦」,GitHub 后台就该能筛到它。遇到本 reason 补 payload 重试,别排查脚本。
      printOut({
        ok: true, pr, author, held: false, reason: 'missing-payload', alreadyHeld, ...priorIssueInfo,
        labels: syncLabels(),
      });
    } else {
      // 1) 开讨论 issue(没有可复用 issue 时;失败则本轮不发评论,下轮自动重试)
      let issueUrl = reuse.reuseUrl;
      let issueCreated = false;
      let issueError = null;
      if (needIssue) {
        // footer 由代码追加,保证 issue 一定回链到 PR / 点名作者;保留「由 review-pr 流程
        // 自动创建」签名(close-product-issue.mjs 的定向关闭与 sweep 兜底依赖它)。
        const topic = KIND_TOPICS[kind];
        const footer = `\n\n---\n关联 PR:#${pr}(作者 @${author});本 issue 由 review-pr 流程自动创建,用于先讨论该 PR 涉及的${topic},维护者确认后 PR 会恢复推进。`;
        const r = gh(['issue', 'create', '--repo', slug, '--title', issueTitle, '--body-file', '-'], {
          input: issueBody + footer,
          allowFail: true,
        });
        const created = (r.stdout || '').trim().split('\n').pop()?.trim() ?? '';
        if (r.ok && /^https:\/\//.test(created)) {
          issueUrl = created;
          issueCreated = true;
        } else {
          issueError = (r.stderr || r.stdout || '').trim().slice(0, 300);
        }
      }

      // 2) 发评论(带隐藏标记;仅在本轮新开了 issue 时——评论的核心就是给 issue 链接)
      let commented = false;
      let commentError = null;
      if (issueCreated && issueUrl) {
        const rendered = commentBody.includes('{{ISSUE_URL}}')
          ? renderIssueUrl(commentBody, issueUrl)
          : `${commentBody}\n\n讨论 issue:<${issueUrl}>`;
        const r = gh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
          input: `${rendered}\n\n${marker(issueUrl, kind)}`,
          allowFail: true,
        });
        if (r.ok) commented = true;
        else commentError = (r.stderr || '').trim().slice(0, 300);
      }

      // 3) 维护者确认标签(issue / 评论失败不连坐:GitHub 后台的可筛性独立生效)
      const labels = syncLabels();

      // 4) 状态回帖(只在「早就 hold 过、这轮门重新亮起来」时;本轮首次 hold 已经有 2) 的评论)
      const renotice = doRenotice();

      const held = priorIssueUrl != null || commented;
      printOut({
        ok: true, pr, author, kind, held, ...priorIssueInfo,
        issueUrl, issueCreated, issueError,
        commented, alreadyHeld, commentError,
        labels,
        ...renotice,
        url: meta.url,
      });
    }
  }
} catch (e) {
  fail(e);
}
