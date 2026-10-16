// 新审查机整组上线 / 整组回滚(修正方案 Step 5)。在 Pro 上跑,经 ssh 改 Mini、Air。
//
// tuple = Review-PR 提交(仓库变量 MIVO_REVIEW_SKILL_SHA、Mini ~/mivo-prereview/skill 检出、三台 trust 的 skillSha)
//       + Mivo main 上 review-pr.yml 的 sha256(三台 trust 的 workflowSha256 与 sourceManifest 同一项)。
//
// 用法:
//   node deploy-tuple.mjs --old-skill <sha> --new-skill <sha> --old-wf <sha256> --new-wf <sha256>
//        [--pr <Mivo PR 号> --pr-head <sha>] [--stop pause|hold] [--max-wait-min 180] [--preview]
//   --preview 只读核对并打印新旧 tuple,不写任何东西。
//   --stop pause:首次上线(线上旧代码不认 deploy-hold):写 pause.json 只抬高 until、保留其它字段,被旧进程改写就提回;
//                收尾时恢复成原内容与最近一次运行暂停里 until 最晚、还没到期的那份,都到期才删除。
//   --stop hold:之后的上线与回滚:写 deploy-hold.json,等新代码写出 lockReleased:true 的 quiesced.json 并退出。
//   --pr:到停点后用 Art Support 绕过合并这个 PR(维护者已授权),合并后 main 上 review-pr.yml 必须等于 --new-wf。
//   回滚:新旧参数对调,--stop hold,不带 --pr(workflow 另行 revert)。不带 --pr 时 main 上必须已经是 --new-wf;
//        workflow 先变、其余还没切的这段时间 tuple 不一致,要紧接着运行;这时切换失败,退回后整组仍不一致,保持停止。
// 不对还在跑的进程 bootout(SIGTERM 不走 finally,会留下 60 分钟的锁),也不删不知道归属的锁。
// 任一步失败:已切的部分按「先比对旧值再写」退回;tuple 不是整体一致(全旧或全新)就保持停止并提醒,不 bootstrap。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'xindong/mivo-canvas-plugin';
const SKILL_REPO = 'PraiseZhu/Review-PR';
const WF_PATH = '.github/workflows/review-pr.yml';
const LABEL = 'com.mivo.prereview.mivo';
const MINI = 'Praise-Mini';
const AIR = 'Praise-MacAir';
const TRUST_REL = '.claude/state/approve-exec/mivo-review-trust.json';
const STATE_REL = 'mivo-prereview/state/mivo/mivo';
const PAUSE_REL = `${STATE_REL}/pause.json`;
const HOLD_REL = `${STATE_REL}/deploy-hold.json`;
const QUIESCED_REL = `${STATE_REL}/quiesced.json`;
const MONITOR_PAUSE_REL = 'mivo-prereview/monitor/scripts/schedule-checks/pause-until.json';
const SKILL_REL = 'mivo-prereview/skill';
const MIN = 60_000;

// helpers
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const nowIso = () => new Date().toISOString();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const say = (line) => console.log(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`);
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}
function run(cmd, args, { input, timeoutMs = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: String(r.stderr || r.error || '').trim() };
}
function must(r, what) {
  if (!r.ok) throw new Error(`${what} 失败(exit ${r.status}):${r.stderr.slice(0, 300)}`);
  return r.stdout;
}
// ssh 到远端,在 $HOME 下跑 sh 脚本;断线(255)重试,只用于可重复执行的命令。
function remote(host, script, { input, retries = 3 } = {}) {
  let last;
  for (let n = 1; n <= retries; n += 1) {
    last = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, `cd "$HOME" || exit 9\n${script}`], { input });
    if (last.status !== 255) return last;
    say(`ssh ${host} 断线,10 秒后重试(${n}/${retries})`);
    sleep(10_000);
  }
  return last;
}
const q = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
// 读远端文件:{ exists, text }。
function readRemote(host, rel) {
  const r = remote(host, `if [ -e ${q(rel)} ]; then printf 'Y'; cat ${q(rel)}; else printf 'N'; fi`);
  if (!r.ok) throw new Error(`读 ${host}:${rel} 失败:${r.stderr.slice(0, 200)}`);
  return r.stdout.startsWith('Y') ? { exists: true, text: r.stdout.slice(1) } : { exists: false, text: null };
}
// 先比对旧值再写:远端当前内容的 sha256 必须等于 expected('none' 表示必须不存在)。next 为 null 表示删除。
function casRemote(host, rel, expected, next) {
  const body = next == null
    ? `rm -f "$f"`
    : `mkdir -p "$(dirname "$f")" && cat > "$f.deploy-tmp" && mv "$f.deploy-tmp" "$f"`;
  const script = [
    `f=${q(rel)}`,
    `if [ -e "$f" ]; then cur=$(shasum -a 256 < "$f" | cut -c1-64); else cur=none; fi`,
    `if [ "$cur" != ${q(expected)} ]; then echo "现在是 $cur" >&2; exit 3; fi`,
    body,
  ].join('\n');
  const r = remote(host, script, { input: next ?? '' });
  if (!r.ok) throw new Error(`改 ${host}:${rel} 失败(${r.status === 3 ? '内容已被别人改过' : `exit ${r.status}`}):${r.stderr.slice(0, 200)}`);
}
function readLocal(rel) {
  const file = path.join(os.homedir(), rel);
  return fs.existsSync(file) ? { exists: true, text: fs.readFileSync(file, 'utf8') } : { exists: false, text: null };
}
function casLocal(rel, expected, next) {
  const file = path.join(os.homedir(), rel);
  const cur = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : 'none';
  if (cur !== expected) throw new Error(`改本机 ${rel} 失败:内容已被别人改过(现在是 ${cur.slice(0, 12)})`);
  const tmp = `${file}.deploy-tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
}
const HOSTS = ['pro', MINI, AIR];
const readTrust = (host) => (host === 'pro' ? readLocal(TRUST_REL) : readRemote(host, TRUST_REL));
const casTrust = (host, expected, next) => (host === 'pro' ? casLocal(TRUST_REL, expected, next) : casRemote(host, TRUST_REL, expected, next));
// trust 只换 skillSha、workflowSha256、sourceManifest 里 review-pr.yml 那一项,其它字段原样。
function toTrustText(text, { skill, wf }) {
  const j = JSON.parse(text);
  j.skillSha = skill;
  j.workflowSha256 = wf;
  j.sourceManifest = { ...j.sourceManifest, [WF_PATH]: wf };
  return `${JSON.stringify(j, null, 2)}\n`;
}
function trustTuple(text) {
  const j = JSON.parse(text);
  return { skill: j.skillSha, wf: j.workflowSha256, manifest: j.sourceManifest?.[WF_PATH] };
}
function mainWorkflowSha(ref = 'main') {
  const raw = must(run('gh', ['api', `repos/${REPO}/contents/${WF_PATH}?ref=${ref}`, '--jq', '.content']), `读 ${ref} 上的 ${WF_PATH}`);
  return sha256(Buffer.from(raw.replace(/\s/g, ''), 'base64'));
}
const launchState = () => {
  const r = remote(MINI, `launchctl print gui/$(id -u)/${LABEL} 2>/dev/null | grep -m1 -E '^[[:space:]]*state = ' | sed 's/.*= //'`);
  if (!r.ok) return 'unknown';
  return r.stdout.trim() || 'absent';
};
// 不用通配符:Mini 的登录 shell 是 zsh,通配符没匹配到会直接报错,锁就永远像是在。
const lockHeld = () => {
  const r = remote(MINI, `find mivo-prereview/state/mivo -maxdepth 2 -name lock.json | head -1`);
  if (!r.ok) return null;
  return r.stdout.trim() || '';
};

// 自检:只在 Mini 的临时文件上演练读写与比对,不碰线上文件。
if (process.argv.includes('--selftest')) {
  const rel = 'mivo-prereview/_deploy-selftest.json';
  const results = [];
  const expectFail = (fn, what) => { try { fn(); results.push(`!! ${what} 应该失败却成功了`); } catch { results.push(`ok ${what} 按预期失败`); } };
  if (readRemote(MINI, rel).exists) throw new Error(`${rel} 已存在,先看清是什么`);
  casRemote(MINI, rel, 'none', '{"v":1}\n');
  const v1 = readRemote(MINI, rel);
  results.push(v1.text === '{"v":1}\n' ? 'ok 新建' : `!! 新建后内容是 ${JSON.stringify(v1.text)}`);
  expectFail(() => casRemote(MINI, rel, 'none', '{"v":9}\n'), '文件已存在时按「必须不存在」写');
  expectFail(() => casRemote(MINI, rel, sha256('别的内容'), '{"v":9}\n'), '旧值对不上时写');
  casRemote(MINI, rel, sha256(v1.text), '{"v":2}\n');
  results.push(readRemote(MINI, rel).text === '{"v":2}\n' ? 'ok 比对旧值后改写' : '!! 改写失败');
  expectFail(() => casRemote(MINI, rel, sha256(v1.text), null), '用过期旧值删除');
  casRemote(MINI, rel, sha256('{"v":2}\n'), null);
  results.push(!readRemote(MINI, rel).exists ? 'ok 删除' : '!! 删除后文件还在');
  results.push(`launchd state=${launchState()},锁=${JSON.stringify(lockHeld())}`);
  console.log(results.join('\n'));
  process.exit(results.some((r) => r.startsWith('!!')) ? 1 : 0);
}

// 部署记录
const NEW_SKILL = arg('new-skill');
const OLD_SKILL = arg('old-skill');
const NEW_WF = arg('new-wf');
const OLD_WF = arg('old-wf');
const PR = arg('pr');
const PR_HEAD = arg('pr-head');
const STOP = arg('stop', 'pause');
const MAX_WAIT_MS = Number(arg('max-wait-min', '180')) * MIN;
const PREVIEW = process.argv.includes('--preview');
for (const [name, value, re] of [['new-skill', NEW_SKILL, /^[0-9a-f]{40}$/], ['old-skill', OLD_SKILL, /^[0-9a-f]{40}$/],
  ['new-wf', NEW_WF, /^[0-9a-f]{64}$/], ['old-wf', OLD_WF, /^[0-9a-f]{64}$/]]) {
  if (!re.test(value ?? '')) throw new Error(`--${name} 格式不对:${value}`);
}
if (PR && !(/^\d+$/.test(PR) && /^[0-9a-f]{40}$/.test(PR_HEAD ?? ''))) throw new Error('--pr 要和 40 位的 --pr-head 一起给');
if (!['pause', 'hold'].includes(STOP)) throw new Error(`--stop 只能是 pause 或 hold:${STOP}`);
const RECORD_FILE = path.join(HERE, `deploy-${NEW_SKILL.slice(0, 7)}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.record.json`);
const record = { startedAt: nowIso(), argv: process.argv.slice(2), phases: [], originals: {}, switched: [] };
const save = () => { if (!PREVIEW) fs.writeFileSync(RECORD_FILE, `${JSON.stringify(record, null, 2)}\n`); };
const phase = (name, extra = {}) => { record.phases.push({ name, at: nowIso(), ...extra }); save(); say(name); };

// 1. 只读预检
function preflight() {
  const variable = must(run('gh', ['variable', 'get', 'MIVO_REVIEW_SKILL_SHA', '-R', REPO]), '读仓库变量').trim();
  if (variable !== OLD_SKILL) throw new Error(`仓库变量现在是 ${variable},不是预期的旧值 ${OLD_SKILL}`);
  must(run('gh', ['api', `repos/${SKILL_REPO}/commits/${NEW_SKILL}`, '--jq', '.sha']), `Review-PR 上找 ${NEW_SKILL}`);
  const onMain = must(run('gh', ['api', `repos/${SKILL_REPO}/compare/${NEW_SKILL}...main`, '--jq', '.status']), '比对 Review-PR main').trim();
  if (!['identical', 'ahead'].includes(onMain)) throw new Error(`${NEW_SKILL} 不在 Review-PR main 上(compare=${onMain})`);
  const head = remote(MINI, `git -C ${SKILL_REL} rev-parse HEAD`);
  if (head.stdout.trim() !== OLD_SKILL) throw new Error(`Mini 的 skill 检出是 ${head.stdout.trim() || head.stderr},不是 ${OLD_SKILL}`);
  must(remote(MINI, `git -C ${SKILL_REL} fetch --quiet origin ${NEW_SKILL} && git -C ${SKILL_REL} cat-file -e ${NEW_SKILL}^{commit}`), 'Mini 预取新提交');
  const mainWf = mainWorkflowSha();
  if (PR) {
    if (mainWf !== OLD_WF) throw new Error(`main 上 ${WF_PATH} 的 sha256 是 ${mainWf},不是旧值 ${OLD_WF}`);
    const pr = JSON.parse(must(run('gh', ['pr', 'view', PR, '-R', REPO, '--json', 'state,headRefOid,statusCheckRollup']), `读 PR #${PR}`));
    if (pr.state !== 'OPEN' || pr.headRefOid !== PR_HEAD) throw new Error(`PR #${PR} 状态 ${pr.state}、head ${pr.headRefOid},不是开着的 ${PR_HEAD}`);
    const checkName = (c) => c.name ?? c.context;
    const checkResult = (c) => c.conclusion || c.state || c.status;
    const bad = pr.statusCheckRollup.filter((c) => checkName(c) !== 'review-pr' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(checkResult(c)));
    if (bad.length) throw new Error(`PR #${PR} 还有没通过的检查:${bad.map((c) => `${checkName(c)}=${checkResult(c)}`).join(', ')}`);
    const prWf = mainWorkflowSha(PR_HEAD);
    if (prWf !== NEW_WF) throw new Error(`PR #${PR} 上 ${WF_PATH} 的 sha256 是 ${prWf},不是新值 ${NEW_WF}`);
  } else if (mainWf !== NEW_WF) {
    throw new Error(`不合 PR 时 main 上 ${WF_PATH} 必须已经是新值 ${NEW_WF},现在是 ${mainWf}`);
  }
  for (const host of HOSTS) {
    const t = readTrust(host);
    if (!t.exists) throw new Error(`${host} 上没有 trust 文件`);
    const cur = trustTuple(t.text);
    if (cur.skill !== OLD_SKILL || cur.wf !== OLD_WF || cur.manifest !== OLD_WF) {
      throw new Error(`${host} 的 trust 不是旧 tuple:skillSha=${cur.skill} workflowSha256=${cur.wf} manifest=${cur.manifest}`);
    }
    record.originals[`trust:${host}`] = { sha256: sha256(t.text) };
  }
  console.log([
    '新旧 tuple:',
    `  Review-PR    ${OLD_SKILL} → ${NEW_SKILL}`,
    `  review-pr.yml ${OLD_WF} → ${NEW_WF}${PR ? `(合并 #${PR} @ ${PR_HEAD.slice(0, 9)})` : ''}`,
    `  仓库变量、Mini 检出、三台 trust(skillSha/workflowSha256/sourceManifest)都是旧值;停点方式 ${STOP}`,
  ].join('\n'));
}

// 2. 停点
let deployUntil = null;
let lastRuntimePause = null;
let originalPause = null;
let monitorPauseText = null;
function holdPauseUp() {
  const cur = readRemote(MINI, PAUSE_REL);
  const parsed = cur.exists ? JSON.parse(cur.text) : null;
  if (parsed && Date.parse(parsed.until) >= Date.parse(deployUntil)) return;
  if (parsed) {
    lastRuntimePause = parsed;
    record.lastRuntimePause = parsed;
    say(`pause.json 被改写成 ${parsed.until}(${parsed.reason ?? '无原因'}),记下后提回 ${deployUntil}`);
  }
  const next = `${JSON.stringify({ ...(parsed ?? { reason: `整组上线 ${NEW_SKILL.slice(0, 7)}` }), until: deployUntil })}\n`;
  casRemote(MINI, PAUSE_REL, cur.exists ? sha256(cur.text) : 'none', next);
}
function stopPoint() {
  deployUntil = new Date(Date.now() + 4 * 60 * MIN).toISOString();
  const marker = readRemote(MINI, MONITOR_PAUSE_REL);
  if (marker.exists) throw new Error(`巡检已有维护标记 ${MONITOR_PAUSE_REL}(${marker.text.trim().slice(0, 200)}),先弄清是谁的`);
  monitorPauseText = `${JSON.stringify({ from: nowIso(), until: deployUntil, reason: `新审查机整组上线 ${NEW_SKILL.slice(0, 7)}` })}\n`;
  // 第一次写停点之前就落盘:远端已写成功但 ssh 回执丢了时,失败收尾也要先核对整组 tuple。
  record.stopStarted = true;
  save();
  casRemote(MINI, MONITOR_PAUSE_REL, 'none', monitorPauseText);
  record.monitorPause = true;
  if (STOP === 'pause') {
    const cur = readRemote(MINI, PAUSE_REL);
    originalPause = cur.exists ? JSON.parse(cur.text) : null;
    record.originals.pause = originalPause;
    save();
    // 只把 until 提高到部署设定的时间,其它字段保留;原来的暂停比部署更晚就不动它。
    if (originalPause && Date.parse(originalPause.until) >= Date.parse(deployUntil)) {
      deployUntil = originalPause.until;
    } else {
      const next = `${JSON.stringify({ ...(originalPause ?? { reason: `整组上线 ${NEW_SKILL.slice(0, 7)}` }), until: deployUntil })}\n`;
      casRemote(MINI, PAUSE_REL, cur.exists ? sha256(cur.text) : 'none', next);
    }
  } else {
    const hold = readRemote(MINI, HOLD_REL);
    if (hold.exists) throw new Error(`已有 ${HOLD_REL},先弄清是谁的`);
    must(remote(MINI, `rm -f ${q(QUIESCED_REL)}`), '删旧的 quiesced.json');
    casRemote(MINI, HOLD_REL, 'none', `${JSON.stringify({ at: nowIso(), reason: `整组上线 ${NEW_SKILL.slice(0, 7)}` })}\n`);
  }
  phase('停点:暂停已写,等前置审查退出');
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    if (STOP === 'pause') holdPauseUp();
    const state = launchState();
    const lock = lockHeld();
    let ready = state !== 'running' && state !== 'unknown' && lock === '';
    if (STOP === 'hold' && ready) {
      const quiesced = readRemote(MINI, QUIESCED_REL);
      ready = quiesced.exists && JSON.parse(quiesced.text).lockReleased === true;
    }
    if (ready) {
      if (state !== 'absent') must(remote(MINI, `launchctl bootout gui/$(id -u)/${LABEL}`), 'bootout');
      if (launchState() !== 'absent') throw new Error('bootout 之后 launchd 里还有这个任务');
      if (lockHeld() !== '') throw new Error('bootout 之后出现了锁文件');
      phase('停点:前置审查已退出、锁已释放,已 bootout');
      return;
    }
    if (Date.now() > deadline) throw new Error(`${MAX_WAIT_MS / MIN} 分钟没到停点(state=${state},锁=${lock || '无'})`);
    sleep(20_000);
  }
}

// 3. 合并 workflow PR
function mergePr() {
  const reason = [
    '**绕过合并说明**(Art Support 维护者 PraiseZhu 决定)',
    '',
    `- 为什么绕过:本 PR 只改 \`${WF_PATH}\`(受保护路径),作者是 PraiseZhu,服务器审查要等作者以外的维护者放行。按新审查机修正方案,这个改动必须和 Review-PR 新版本(模型预算按作业时间收缩、Mini 执行超过 170 分钟才取消)在同一个上线停点一起生效,所以由维护者决定绕过合并。`,
    '- 跳过的条件:必需检查 `review-pr`(受保护路径要作者以外的维护者放行)。其它必需检查都已通过。',
    '- 已做的审查:GPT 单审(gpt-6.1-sol)没有 P0/P1;`review_pr_workflow.node-test.mjs` 12/12 通过,变异测试确认把 160 改回 110 或删掉新环境变量会被拦住。',
    `- 合并的提交:\`${PR_HEAD}\`。`,
  ].join('\n');
  const draft = JSON.parse(must(run('gh', ['pr', 'view', PR, '-R', REPO, '--json', 'isDraft']), `读 #${PR}`)).isDraft;
  if (draft) must(run('gh', ['pr', 'ready', PR, '-R', REPO]), `#${PR} 转 Ready`);
  must(run('gh', ['pr', 'comment', PR, '-R', REPO, '--body', reason]), `#${PR} 写绕过原因`);
  must(run('gh', ['pr', 'merge', PR, '-R', REPO, '--squash', '--admin', '--match-head-commit', PR_HEAD]), `#${PR} 绕过合并`);
  for (let i = 0; i < 30; i += 1) {
    const pr = JSON.parse(must(run('gh', ['pr', 'view', PR, '-R', REPO, '--json', 'state,mergeCommit']), `读 #${PR}`));
    if (pr.state === 'MERGED') {
      record.merged = pr.mergeCommit?.oid;
      break;
    }
    sleep(5_000);
  }
  if (!record.merged) throw new Error(`#${PR} 没有变成 MERGED`);
  const wf = mainWorkflowSha();
  if (wf !== NEW_WF) throw new Error(`合并后 main 上 ${WF_PATH} 是 ${wf},不是 ${NEW_WF}`);
  phase(`已合并 #${PR}:${record.merged}`);
}

// 4. 切换 tuple(每一项先比对旧值再写,记下已切的部分)
function switchVariable(from, to) {
  const cur = must(run('gh', ['variable', 'get', 'MIVO_REVIEW_SKILL_SHA', '-R', REPO]), '读仓库变量').trim();
  if (cur !== from) throw new Error(`仓库变量现在是 ${cur},不是 ${from}`);
  must(run('gh', ['variable', 'set', 'MIVO_REVIEW_SKILL_SHA', '-R', REPO, '--body', to]), '写仓库变量');
  const after = must(run('gh', ['variable', 'get', 'MIVO_REVIEW_SKILL_SHA', '-R', REPO]), '读仓库变量').trim();
  if (after !== to) throw new Error(`仓库变量写完是 ${after},不是 ${to}`);
}
function switchCheckout(from, to) {
  must(remote(MINI, `test "$(git -C ${SKILL_REL} rev-parse HEAD)" = ${from} && git -C ${SKILL_REL} -c advice.detachedHead=false checkout --quiet --detach ${to} && test "$(git -C ${SKILL_REL} rev-parse HEAD)" = ${to}`), `Mini 检出 ${from.slice(0, 7)} → ${to.slice(0, 7)}`);
}
function switchTrust(host, from, to) {
  const t = readTrust(host);
  const cur = trustTuple(t.text);
  if (cur.skill !== from.skill || cur.wf !== from.wf || cur.manifest !== from.wf) throw new Error(`${host} 的 trust 不是预期的 ${from.skill.slice(0, 7)}/${from.wf.slice(0, 12)}`);
  casTrust(host, sha256(t.text), toTrustText(t.text, to));
  const after = trustTuple(readTrust(host).text);
  if (after.skill !== to.skill || after.wf !== to.wf || after.manifest !== to.wf) throw new Error(`${host} 的 trust 写完不对`);
}
const OLD = () => ({ skill: OLD_SKILL, wf: OLD_WF });
const NEW = () => ({ skill: NEW_SKILL, wf: NEW_WF });
const STEPS = [
  { name: 'variable', go: () => switchVariable(OLD_SKILL, NEW_SKILL), back: () => switchVariable(NEW_SKILL, OLD_SKILL) },
  { name: 'checkout', go: () => switchCheckout(OLD_SKILL, NEW_SKILL), back: () => switchCheckout(NEW_SKILL, OLD_SKILL) },
  ...HOSTS.map((host) => ({ name: `trust:${host}`, go: () => switchTrust(host, OLD(), NEW()), back: () => switchTrust(host, NEW(), OLD()) })),
];
function switchTuple() {
  for (const step of STEPS) {
    step.go();
    record.switched.push(step.name);
    save();
    say(`已切 ${step.name}`);
  }
  phase('tuple 已整组切到新值');
}
function revertSwitched() {
  const failed = [];
  for (const name of [...record.switched].reverse()) {
    try {
      STEPS.find((s) => s.name === name).back();
      record.switched = record.switched.filter((n) => n !== name);
      save();
      say(`已退回 ${name}`);
    } catch (error) {
      failed.push(`${name}:${error.message}`);
    }
  }
  return failed;
}
// 失败后撤销停点之前核对:main 上的 workflow、仓库变量、Mini 检出、三台 trust 必须整组都是旧值。
// 不带 --pr 跨 workflow 时 main 上已经是新 workflow,其余部分退回后整组并不一致;读不到也按不一致算。
function oldTupleMismatch() {
  const problems = [];
  try {
    const wf = mainWorkflowSha();
    if (wf !== OLD_WF) problems.push(`main 上 ${WF_PATH} 是 ${wf},不是旧值 ${OLD_WF}`);
    const variable = must(run('gh', ['variable', 'get', 'MIVO_REVIEW_SKILL_SHA', '-R', REPO]), '读仓库变量').trim();
    if (variable !== OLD_SKILL) problems.push(`仓库变量是 ${variable}`);
    const head = must(remote(MINI, `git -C ${SKILL_REL} rev-parse HEAD`), '读 Mini 检出').trim();
    if (head !== OLD_SKILL) problems.push(`Mini 检出是 ${head}`);
    for (const host of HOSTS) {
      const cur = trustTuple(readTrust(host).text);
      if (cur.skill !== OLD_SKILL || cur.wf !== OLD_WF || cur.manifest !== OLD_WF) problems.push(`${host} 的 trust 不是旧 tuple`);
    }
  } catch (error) {
    problems.push(`核对不了:${error.message}`);
  }
  return problems;
}

// 5. prerequisites(只读,approve-exec 原函数)
function prerequisites() {
  const dir = path.join(HERE, `trust-snap-${NEW_SKILL.slice(0, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = HOSTS.map((host) => {
    const file = path.join(dir, `${host === 'pro' ? 'pro' : host === MINI ? 'mini' : 'air'}.json`);
    fs.writeFileSync(file, readTrust(host).text);
    return file;
  });
  const r = run('node', [path.join(HERE, 'prereq-check.mjs'), ...files]);
  console.log(r.stdout.trim());
  if (!r.ok) throw new Error(`prerequisites 没全部通过:${r.stderr.slice(0, 300)}`);
  phase('prerequisites 三台全部通过');
}

// 6. 收尾:撤销暂停覆盖、删停点标记,再 bootstrap
function releaseStop() {
  if (STOP === 'pause' && deployUntil) {
    const cur = readRemote(MINI, PAUSE_REL);
    if (cur.exists) {
      const parsed = JSON.parse(cur.text);
      if (Date.parse(parsed.until) < Date.parse(deployUntil)) lastRuntimePause = parsed;
    }
    const keep = [originalPause, lastRuntimePause].filter((p) => p && Date.parse(p.until) > Date.now())
      .sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0];
    casRemote(MINI, PAUSE_REL, cur.exists ? sha256(cur.text) : 'none', keep ? `${JSON.stringify(keep)}\n` : null);
    say(keep ? `pause.json 恢复成到 ${keep.until} 的运行暂停` : '已删 pause.json');
  }
  if (STOP === 'hold') {
    must(remote(MINI, `rm -f ${q(HOLD_REL)} ${q(QUIESCED_REL)}`), '删 deploy-hold.json、quiesced.json');
  }
  if (record.monitorPause) {
    casRemote(MINI, MONITOR_PAUSE_REL, sha256(monitorPauseText), null);
    record.monitorPause = false;
  }
  save();
}
function bootstrap() {
  must(remote(MINI, `launchctl print gui/$(id -u)/${LABEL} >/dev/null 2>&1 || launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/${LABEL}.plist"`), 'bootstrap');
  sleep(15_000);
  say(`前置审查已重新加载,state=${launchState()}`);
}

// 主流程
try {
  preflight();
  if (PREVIEW) {
    say('只读预检通过(--preview,没有写任何东西)');
    process.exit(0);
  }
  phase('只读预检通过');
  stopPoint();
  if (PR) mergePr();
  try {
    switchTuple();
    prerequisites();
  } catch (error) {
    say(`切换或核对失败:${error.message}`);
    const failed = revertSwitched();
    record.error = error.message;
    record.revertFailed = failed;
    const mismatch = failed.length || record.merged ? [] : oldTupleMismatch();
    record.tupleMismatch = mismatch;
    save();
    if (failed.length || record.merged || mismatch.length) {
      say(`保持停止,没有 bootstrap。${failed.length ? `退回失败:${failed.join(' | ')}。` : ''}${record.merged ? `#${PR} 已合入 main(${record.merged}),现在 workflow 是新的、tuple 其余部分是旧的:要么 revert 这个合并,要么修好后重新切。` : ''}${mismatch.length ? `退回后整组 tuple 不一致:${mismatch.join(';')}。要么把 main 上的 workflow 改回旧值,要么修好后重新切。` : ''}部署记录:${RECORD_FILE}`);
      process.exit(2);
    }
    releaseStop();
    bootstrap();
    say(`已整组退回旧 tuple 并恢复前置审查。部署记录:${RECORD_FILE}`);
    process.exit(1);
  }
  releaseStop();
  bootstrap();
  phase('整组上线完成');
  say(`部署记录:${RECORD_FILE}`);
} catch (error) {
  record.error = error.message;
  save();
  say(`失败:${error.message}`);
  if (!PREVIEW && !record.switched.length && !record.merged) {
    // 什么都没切:撤销停点。已经 bootout 的重新 bootstrap 旧代码。开始写停点之后就先核对整组是旧值:
    // 不带 --pr 跨 workflow、或合并已生效却没读到 MERGED,main 上都已是新 workflow,这时保持停止。
    const mismatch = record.stopStarted ? oldTupleMismatch() : [];
    if (mismatch.length) {
      record.tupleMismatch = mismatch;
      save();
      say(`保持停止,不撤销可能已写的停点:整组 tuple 不一致:${mismatch.join(';')}。请人工核对 Mini 的 pause.json、deploy-hold.json、巡检维护标记和 launchd。部署记录:${RECORD_FILE}`);
      process.exit(2);
    }
    try {
      releaseStop();
      if (record.phases.some((p) => p.name.includes('已 bootout'))) bootstrap();
      say('什么都没切,已撤销停点');
    } catch (undo) {
      say(`撤销停点也失败了:${undo.message},请人工核对 Mini 的 pause.json、deploy-hold.json、维护标记和 launchd`);
    }
  }
  process.exit(1);
}
