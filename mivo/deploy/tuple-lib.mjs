// 换版本脚本共用的纯函数(deploy-tuple.mjs、auto-update.mjs 用,离线测试覆盖)。
//
// tuple = 本仓提交(Mivo 仓库变量 MIVO_REVIEW_SKILL_SHA、Mini ~/mivo-prereview/skill 检出、三台 trust 的 skillSha)
//       + Mivo main 上 review-pr.yml 的 sha256(三台 trust 的 workflowSha256 与 sourceManifest 同一项)。

export const WF_PATH = '.github/workflows/review-pr.yml';
// 三台机器在彼此 ~/.ssh/config 里用同一组别名。
export const HOSTS = { pro: 'Praise-MacBook', mini: 'Praise-Mini', air: 'Praise-MacAir' };
// Mini 上的换版本互斥锁:普通文件,不是目录,也不叫 lock.json(避免被前置 lockHeld 误认)。
// 先把完整内容写进同目录临时文件,再 ln 硬链接到这个名字;目标已存在就失败。
export const DEPLOY_LOCK_REL = 'mivo-prereview/state/mivo/mivo/deploy-tuple.lock';
export const DEPLOY_LOCK_PATH = `~/${DEPLOY_LOCK_REL}`;
// 锁过期时间 = 开始时间 + --max-wait-min + 这段余量,避免合法等待被当成残锁。过期也不自动顶替。
export const DEPLOY_LOCK_SLACK_MS = 90 * 60 * 1000;
const shQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
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

// Mini 上的 deploy-hold.json 是不是本次写的:按内容认,不按回执认。hold 是 readRemote 的结果({ exists, text }),
// holdText 是本次写之前记下的内容。写成功但 ssh 回执丢了也算本次写的;不存在、内容不同(别人的)都不算。
// round.mjs 只读不改这个文件,所以内容一直是写进去的样子。
export function isOwnHold(hold, holdText) {
  return Boolean(holdText) && hold.exists === true && hold.text === holdText;
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

// tuple 已整组切到新版本之后,撤停点或 bootstrap 失败:新版本已上,不能再报成「线上仍是旧版」。
// switchedCount === stepCount 才算整组已切;没切或只切了一部分仍按旧口径(由调用方决定退回还是保持停止)。
export function toFinalizeFailure({ switchedCount, stepCount }) {
  if (switchedCount === stepCount && stepCount > 0) {
    return { code: 2, message: '新版本已上、前置审查停止、要人工处理' };
  }
  return { code: 1, message: '线上仍是旧版、前置照常' };
}

// 自动换版本根据 deploy-tuple 退出码写给维护者的那句话。exit 2 不再写「线上仍是旧版、前置照常」。
export function toAutoUpdateFinish(status, { reason, current, log, tail }) {
  if (status === 0) return { code: 0, text: `已整组换上 ${reason}。日志 ${log}` };
  if (status === 2) {
    return { code: 2, text: `换版本 ${reason} 失败,前置审查保持停止,要人工处理。日志 ${log}\n${tail}` };
  }
  return { code: 1, text: `换版本 ${reason} 没换成,线上仍是 ${short(current)},前置照常。日志 ${log}\n${tail}` };
}

export function toDeployLockText({ owner, pid, host, at, target, expiresAt }) {
  return `${JSON.stringify({ owner, pid, host, at, target, expiresAt })}\n`;
}

export function toLockExpiresAt(startMs, maxWaitMs, slackMs = DEPLOY_LOCK_SLACK_MS) {
  return new Date(startMs + maxWaitMs + slackMs).toISOString();
}

function parseDeployLock(text) {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j.owner !== 'string' || j.pid == null || typeof j.at !== 'string') return null;
    return j;
  } catch {
    return null;
  }
}

// 开始改 Mini / 线上之前拿锁。existing 是 Mini 上锁文件的 { exists, text }。
// 无人占用 acquire;文件已在(含过期)一律 blocked,不顶替。
export function toLockAcquire({ existing, now }) {
  if (!existing.exists) return { action: 'acquire' };
  const holder = parseDeployLock(existing.text);
  const exp = Date.parse(holder?.expiresAt);
  const expired = Boolean(holder && Number.isFinite(exp) && now > exp);
  const who = holder ? `${holder.owner}(pid ${holder.pid})` : '无法解析的占用者';
  const when = holder?.at ? `,at ${holder.at}` : '';
  const until = holder?.expiresAt ? `,expiresAt ${holder.expiresAt}` : '';
  return { action: 'blocked', reason: `部署锁被 ${who} 占用${when}${until}`, holder, expired };
}

export function isOwnLock(lock, lockText) {
  return Boolean(lockText) && lock.exists === true && lock.text === lockText;
}

// ln 成功,或回执丢失但锁内容与本次逐字相同:认回自己的锁。其它情况都不拿。
export function toLockKeep({ createdOk, existing, lockText }) {
  if (createdOk || isOwnLock(existing, lockText)) return { action: 'keep' };
  return { action: 'blocked' };
}

function lockHost(holder) {
  if (holder?.host) return holder.host;
  const m = String(holder?.owner ?? '').match(/:([^:]+)$/);
  return m ? m[1] : holder?.owner;
}

// ln 失败后的退出说明:谁、何时、expiresAt;过期也不顶替,只写人工删除办法。
export function toLockBlockedText(decision, { lockPath = DEPLOY_LOCK_PATH } = {}) {
  let text = `${decision.reason},不动 Mini 和线上状态`;
  if (decision.expired && decision.holder) {
    text += `。锁已过期，先在 ${lockHost(decision.holder)} 上按 pid ${decision.holder.pid} 确认原进程已结束，再删 ${lockPath} 后重跑`;
  }
  return text;
}

// Mini 上一条 ln:先写同目录临时文件(已有完整内容),再硬链接到锁文件名。目标已存在则失败。
export function toLinkLockScript(rel) {
  return [
    `f=${shQuote(rel)}`,
    `mkdir -p "$(dirname "$f")"`,
    `tmp="$f.tmp.$$.$RANDOM"`,
    `cat > "$tmp" || { rm -f "$tmp"; exit 2; }`,
    `if ln "$tmp" "$f"; then`,
    `  rm -f "$tmp"`,
    `  exit 0`,
    `fi`,
    `rm -f "$tmp"`,
    `exit 1`,
  ].join('\n');
}

// 释放:读锁内容,与 stdin 逐字相同才 rm;不同就不删、只告警。
export function toReleaseLockScript(rel) {
  return [
    `f=${shQuote(rel)}`,
    `if [ ! -e "$f" ]; then exit 0; fi`,
    `if cmp -s "$f" -; then rm -f "$f" || exit 3; exit 0; fi`,
    `echo "部署锁已不是本次的,不删" >&2`,
    `exit 0`,
  ].join('\n');
}

// 释放只发一次:ssh 断线(255)时远端命令可能还活着、已 cmp 完还没 rm,重发会和它重叠,
// 让它在下一位拿锁后删掉别人的锁。不重发就没有这个窗口:它要么删掉自己的锁,要么锁留着等人工处理。
export const RELEASE_LOCK_RETRIES = 1;

export function toReleaseLockResult({ status, stderr }) {
  const text = String(stderr ?? '').trim();
  if (status === 0) return { ok: true, message: text };
  if (status === 3) return { ok: false, message: `释放失败，锁文件还在 ${DEPLOY_LOCK_PATH}` };
  if (status === 255) {
    return { ok: false, message: `释放部署锁结果未知(ssh 断线,不重发):到 Mini 看 ${DEPLOY_LOCK_PATH},内容还是本次的就删掉` };
  }
  return { ok: false, message: `释放部署锁失败(exit ${status}):${text.slice(0, 200)}` };
}

// save 抛错也要释放自己的锁:两个动作各自包起来,互不影响。
export function finalizeDeployError({ save, release }) {
  let saveError = null;
  let releaseError = null;
  try {
    release();
  } catch (error) {
    releaseError = error;
  }
  try {
    save();
  } catch (error) {
    saveError = error;
  }
  return { saveError, releaseError };
}

export function shouldTakeDeployLock({ preview, check }) {
  return !preview && !check;
}

// 收尾要不要 bootstrap:开始前 launchd 已是 absent(维护者停用)就保持停用;运行中或空闲的才重新加载。
export function shouldResumePrereview(stateAtStart) {
  if (stateAtStart === 'absent') return { resume: false, message: '开始前前置已停用,未重新加载' };
  return { resume: true };
}

// --preview 全程只读:新提交不在 Mini 检出里时只报告,不去 fetch。
export function toNewCommitCheck({ preview, hasCommit }) {
  if (hasCommit) return { action: 'ok' };
  if (preview) return { action: 'missing', message: 'Mini 尚未取到该提交' };
  return { action: 'fetch' };
}

// 目标落后 main 时只提示、不拒绝(拒绝会妨碍回滚)。messages 是 compare 接口里每个提交消息的第一行,按时间从旧到新。
// PR 号取两种写法:合并提交「Merge pull request #N」和 squash 提交标题末尾的「(#N)」;同一个 PR 只列一次。
// 其余提交只报个数:已合并 PR 分支上自带的提交也在里面,所以这个数偏多,提示里写明。
const prNumberOf = (message) => {
  const text = String(message ?? '');
  const found = /^Merge pull request #(\d+)/.exec(text)?.[1] ?? /\(#(\d+)\)\s*$/.exec(text)?.[1];
  return found ? Number(found) : null;
};

export function toMergedPrNumbers(messages) {
  const seen = new Set();
  for (const message of messages ?? []) {
    const pr = prNumberOf(message);
    if (pr !== null) seen.add(pr);
  }
  return [...seen];
}

// compare 接口一次最多返回 250 个提交(aheadBy 是真实总数):messages 比 aheadBy 少时,只有最早那部分被列出来。
export function toBehindMainNote({ status, aheadBy, messages }) {
  if (status !== 'ahead') return null;
  const listed = messages ?? [];
  const prs = toMergedPrNumbers(listed);
  const others = listed.filter((message) => prNumberOf(message) === null).length;
  const merged = prs.length ? `，没包含：${prs.map((n) => `#${n}`).join(' ')}` : '';
  const direct = others > 0 ? `${prs.length ? '；' : '，'}其中 ${others} 个不是合并提交（含已合并 PR 分支上自带的提交）` : '';
  const truncated = listed.length < aheadBy ? `；接口最多返回 250 个提交，只列出最早 ${listed.length} 个提交里的 PR，更新的没列全` : '';
  return `目标比 main 落后 ${aheadBy} 个提交${merged}${direct}${truncated}`;
}
