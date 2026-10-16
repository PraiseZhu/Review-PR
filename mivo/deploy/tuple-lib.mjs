// 换版本脚本共用的纯函数(deploy-tuple.mjs、auto-update.mjs 用,离线测试覆盖)。
//
// tuple = 本仓提交(Mivo 仓库变量 MIVO_REVIEW_SKILL_SHA、Mini ~/mivo-prereview/skill 检出、三台 trust 的 skillSha)
//       + Mivo main 上 review-pr.yml 的 sha256(三台 trust 的 workflowSha256 与 sourceManifest 同一项)。

export const WF_PATH = '.github/workflows/review-pr.yml';
// 三台机器在彼此 ~/.ssh/config 里用同一组别名。
export const HOSTS = { pro: 'Praise-MacBook', mini: 'Praise-Mini', air: 'Praise-MacAir' };
const RESULT_TEXT_MAX = 4000;
const short = (sha) => String(sha ?? '').slice(0, 7) || '(空)';

// 在哪台跑:脚本所在的机器(self)直接用 sh 执行,其它机器经 ssh;都先 cd 到 $HOME。返回 [命令, 参数]。
export function toHostCommand(host, self, script) {
  if (!Object.hasOwn(HOSTS, host)) throw new Error(`不认识的机器:${host}(只有 ${Object.keys(HOSTS).join('、')})`);
  const body = `cd "$HOME" || exit 9\n${script}`;
  return host === self
    ? ['sh', ['-c', body]]
    : ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOSTS[host], body]];
}

// trust 只换 skillSha、workflowSha256、sourceManifest 里 review-pr.yml 那一项,其它字段原样。
export function toTrustText(text, { skill, wf }) {
  const j = JSON.parse(text);
  j.skillSha = skill;
  j.workflowSha256 = wf;
  j.sourceManifest = { ...j.sourceManifest, [WF_PATH]: wf };
  return `${JSON.stringify(j, null, 2)}\n`;
}

export function trustTuple(text) {
  const j = JSON.parse(text);
  return { skill: j.skillSha, wf: j.workflowSha256, manifest: j.sourceManifest?.[WF_PATH] };
}

// 停点到没到。state 是 launchd 里前置任务的状态('running'、'not running'、'absent',读不到是 'unknown'),
// lock 是锁文件路径(没有是 '',读不到是 null),quiesced 是停机握手回执(没有是 null)。
// 进程不在跑、锁也不在才可能到。hold 模式有回执就要 lockReleased: true;没有回执说明前置在停点写入前
// 已经空闲退出,之后拉起的进程看到 deploy-hold.json 直接返回、不拿锁,同样算到。
export function toStopReady({ stop, state, lock, quiesced }) {
  if (state === 'running' || state === 'unknown') return { ready: false, reason: `前置还在跑或读不到状态(state=${state})` };
  if (lock !== '') return { ready: false, reason: lock == null ? '读不到锁文件' : `锁还在(${lock})` };
  if (stop !== 'hold' || quiesced == null) return { ready: true, via: 'idle' };
  if (quiesced.lockReleased === true) return { ready: true, via: 'handshake' };
  return { ready: false, reason: '停机握手回执写明锁没放掉' };
}

// 每天自动换版本要不要换。current 是仓库变量里的线上提交,checkout 是 Mini 的检出,target 是本仓 main,
// compare 是 GitHub compare current...target 的 status,checks 是 target 上的 check runs({ name, status, conclusion })。
// action:none(已是最新)、wait(CI 还没出结果,改天再看)、blocked(要人看)、update(换)。
export function toUpdateDecision({ current, checkout, target, compare, checks }) {
  if (checkout !== current) {
    return { action: 'blocked', reason: `Mini 检出 ${short(checkout)} 和仓库变量 ${short(current)} 不一致,线上 tuple 不整齐,先人工核对` };
  }
  if (target === current) return { action: 'none', reason: `已是最新(${short(current)})` };
  if (compare !== 'ahead') {
    return { action: 'blocked', reason: `main ${short(target)} 不是线上 ${short(current)} 的后续提交(compare=${compare}),不自动换` };
  }
  if (!checks.length) return { action: 'wait', reason: `main ${short(target)} 还没有 CI 结果` };
  const pending = checks.filter((c) => c.status !== 'completed');
  if (pending.length) return { action: 'wait', reason: `main ${short(target)} 的 CI 还没跑完:${pending.map((c) => c.name).join('、')}` };
  const failed = checks.filter((c) => !['success', 'skipped', 'neutral'].includes(c.conclusion));
  if (failed.length) {
    return { action: 'blocked', reason: `main ${short(target)} 的 CI 没过:${failed.map((c) => `${c.name}=${c.conclusion}`).join('、')}` };
  }
  return { action: 'update', reason: `${short(current)} → ${short(target)}` };
}

// 定时任务前置检查的退出码:没事做(已是最新、CI 还没出结果)跳过本轮;要换或要人看都放行,由执行那一轮报结果。
export function toCheckExit(decision) {
  return ['none', 'wait'].includes(decision.action) ? 2 : 0;
}

// 自动换版本只换本仓提交:review-pr.yml 不变,新旧 workflow 都是 main 上现在的 sha256。在 Mini 上跑,用 hold 停点。
export function toDeployArgs({ current, target, wf, recordDir, maxWaitMin }) {
  return ['--on', 'mini', '--old-skill', current, '--new-skill', target, '--old-wf', wf, '--new-wf', wf,
    '--stop', 'hold', '--max-wait-min', String(maxWaitMin), '--record-dir', recordDir];
}

// Cindy 定时任务「仅运行脚本」模式的收尾帧:stdout 只能有这一行。
export function toCompleteFrame(resultText) {
  return `${JSON.stringify({ protocol: 'cindy-script/1', type: 'complete', resultText: String(resultText).slice(0, RESULT_TEXT_MAX) })}\n`;
}
