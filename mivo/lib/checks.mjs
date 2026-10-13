// checks.mjs — `review-pr` 检查写到哪里。
// 生产(live 且审查对象是本仓):服务器 run 用 GITHUB_TOKEN 直接写。
// 沙箱(sandbox 且审查对象是沙箱仓):GITHUB_TOKEN 只对本仓有效,改为派发沙箱仓的检查镜像 workflow
// (沙箱仓 .github/workflows/review-pr.yml),由沙箱自己的 GITHUB_TOKEN 写同名检查(方案第 22 节 T0)。
// dry-run:不写。

export const MIRROR_WORKFLOW = 'review-pr.yml';
const TITLE_MAX = 200;
const SUMMARY_MAX = 4000;

/** 'direct' | 'sandbox-mirror' | 'none' */
export function checkTarget(input) {
  if (input.mode === 'live' && input.targetRepo === input.workflowRepo) return 'direct';
  if (input.mode === 'sandbox' && input.targetRepo !== input.workflowRepo) return 'sandbox-mirror';
  return 'none';
}

/** 派发沙箱检查镜像的 gh 参数。conclusion 为空表示「审查中」。 */
export function toMirrorDispatchArgs(input, { conclusion = '', title, summary = '' }) {
  const fields = {
    head_sha: input.head,
    status: conclusion ? 'completed' : 'in_progress',
    conclusion: conclusion || '',
    title: String(title ?? '').slice(0, TITLE_MAX),
    summary: String(summary ?? '').slice(0, SUMMARY_MAX),
    source_run_url: input.runUrl || '',
  };
  const args = ['workflow', 'run', MIRROR_WORKFLOW, '-R', input.targetRepo, '--ref', 'main'];
  for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
  return args;
}
