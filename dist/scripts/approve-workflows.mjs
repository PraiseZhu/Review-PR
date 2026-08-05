#!/usr/bin/env node
// approve-workflows.mjs — 放行 fork PR / 首次贡献者「等待批准才能跑」的 GitHub Actions workflow。
//
// 背景:对来自 public fork / 首次贡献者的 PR,GitHub 默认不自动跑 workflow(防恶意 PR
// 在 CI 里跑任意代码 / 薅 runner),需要有 write 权限的人手动点「Approve workflows to run」。
// 没人点 → required check 永远是 "Expected, waiting for status" → mergeStateStatus 永远 BLOCKED
// → review-pr 永远卡在前置门 / pre-merge,PR 推进不了。本脚本把那个按钮做成 API 调用:
//   找到该 PR head SHA 上 conclusion/status=action_required 的 workflow run,逐个
//   POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve(无 body,成功 201)。
//
// ⚠️ 安全边界写在代码里,不靠调用方记得检查(对齐 self-approve.mjs 的「机械前置自核验」):
//   approve fork workflow = 放行该 PR 的代码进 CI 跑。最高危场景是 PR 自己改了 CI 配置
//   (.github/workflows/** 等)——批准就等于直接执行被改过的 workflow。因此脚本默认
//   **拒绝**对「改了 CI 配置」的 PR 真批,必须显式传 --allow-ci-changes 覆盖(由 SKILL 在
//   用户/owner 明确确认后才加)。误调也不会在无人确认时跑被改过的 CI。
//
// 职责分界:脚本守「机械检测 + CI 配置安全门 + 调 approve API」;「这个 fork PR 该不该放行
// 进 CI」的语义/信任判断由调用方(SKILL 交互确认 / auto 模式策略)负责。
//
// 退出码:0 = 正常(已批 / 无待批 / dry-run);2 = 因改了 CI 配置被安全门拒绝(未加 --allow-ci-changes);
//        1 = 脚本自身出错。
// 跑:node <skill-root>/scripts/approve-workflows.mjs <PR> [--dry-run] [--allow-ci-changes]
//   --dry-run:只检测并打印待批 run / 是否改了 CI 配置,不真 approve(供 SKILL 探测 + 交互展示)。
//   --allow-ci-changes:覆盖安全门,允许对「改了 CI 配置」的 PR 真批(需上层已人工确认)。

import { parseRepo, parsePR, gh, ghJson, print, fail, loadRules } from './lib.mjs';

// CI 配置敏感路径(改了它们 = approve 会执行被改过的 CI):单一真相源在 pr-rules.json。
const prRules = loadRules();
const CI_SENSITIVE_RE = new RegExp((prRules.ciSensitivePaths ?? []).join('|'));

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const dryRun = process.argv.includes('--dry-run');
  const allowCiChanges = process.argv.includes('--allow-ci-changes');
  const slug = `${owner}/${repo}`;

  // PR 元数据:head SHA(定位 workflow run)+ 是否跨仓库(action_required 只对 fork 出现)+ 文件清单(算 CI 改动)
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'headRefOid,isCrossRepository,author,files',
  ]);
  const headSha = meta.headRefOid ?? '';
  const files = (meta.files ?? []).map((f) => f.path);
  const ciFiles = (prRules.ciSensitivePaths?.length ? files.filter((p) => CI_SENSITIVE_RE.test(p)) : []);
  const touchesCiFiles = ciFiles.length > 0;

  // 找该 head SHA 上「等待批准」的 workflow run:GitHub 把待批 run 记为 status/conclusion=action_required。
  // 用 head_sha 精确限定到本 PR 最新提交,避免误批同分支历史 SHA 的 run。
  // 权限/网络异常不应炸掉调用方:allowFail + 解析失败降级为「探测失败」。
  let awaitingRuns = [];
  let probeError = null;
  if (headSha) {
    const r = gh(
      ['api', `repos/${slug}/actions/runs?head_sha=${headSha}&per_page=100`],
      { allowFail: true },
    );
    if (r.ok) {
      const runs = (JSON.parse(r.stdout || '{}').workflow_runs ?? []);
      awaitingRuns = runs
        .filter((w) => w.status === 'action_required' || w.conclusion === 'action_required')
        .map((w) => ({ id: w.id, name: w.name, event: w.event, headBranch: w.head_branch }));
    } else {
      probeError = (r.stderr || '').trim().slice(0, 300) || `actions/runs 查询失败(status=${r.status})`;
    }
  }

  const detection = {
    ok: true,
    pr,
    repo: { owner, repo },
    headSha,
    isCrossRepository: !!meta.isCrossRepository,
    author: meta.author?.login ?? '',
    awaitingRuns,
    count: awaitingRuns.length,
    touchesCiFiles,
    ciFiles,
    probeError,
  };

  // ── dry-run:纯检测,不动 ──
  if (dryRun) {
    print({ ...detection, approved: [], refused: false, note: 'dry-run:仅检测,未 approve' });
    process.exit(0);
  }

  // ── 探测本身失败 → 不瞎批,如实回报 ──
  if (probeError) {
    print({ ...detection, approved: [], refused: false, note: `无法查询待批 workflow:${probeError}` });
    process.exit(0);
  }

  // ── 无待批 run → 无事可做 ──
  if (awaitingRuns.length === 0) {
    print({ ...detection, approved: [], refused: false, note: '无 action_required 的 workflow run,无需 approve' });
    process.exit(0);
  }

  // ── 安全门:改了 CI 配置且未显式放行 → 拒绝真批(退 2) ──
  if (touchesCiFiles && !allowCiChanges) {
    print({
      ...detection,
      approved: [],
      refused: true,
      reason: `PR 改动了 CI 配置文件(${ciFiles.join(' / ')})——approve 会执行被改过的 workflow,` +
        `已拒绝自动批准;需人工看过 CI 改动并确认后,加 --allow-ci-changes 重试。`,
    });
    process.exit(2);
  }

  // ── 逐个 approve(POST .../approve,无 body,成功 201)。单个失败不影响其余,如实汇总 ──
  const approved = [];
  const failed = [];
  for (const w of awaitingRuns) {
    const r = gh(['api', '-X', 'POST', `repos/${slug}/actions/runs/${w.id}/approve`], { allowFail: true });
    if (r.ok) {
      approved.push({ id: w.id, name: w.name });
    } else {
      const msg = (r.stderr || '').trim().slice(0, 300);
      failed.push({
        id: w.id,
        name: w.name,
        error: msg || `approve 失败(status=${r.status})`,
        // 403 多为 token 缺 Actions write 权限,给出明确指引
        hint: /403|forbidden|permission/i.test(msg) ? 'token 可能缺 Actions write 权限,或去网页手动点 Approve' : undefined,
      });
    }
  }

  print({
    ...detection,
    refused: false,
    ciChangesAllowed: touchesCiFiles && allowCiChanges,
    approved,
    failed,
    note: failed.length
      ? `已批 ${approved.length} 个,${failed.length} 个失败(见 failed)`
      : `已批准全部 ${approved.length} 个待批 workflow run`,
  });
  process.exit(0);
} catch (e) {
  fail(e);
}
