// pre-check.mjs --probe-only 的只读性测试(SC-D,2026-08-04 #469 复盘 + 复审修订)。
// 背景:pre-check 自称 precheck,实际有三类副作用——skillRepoPull(动 skill 仓工作区)、
// notify-merge-backfill(可能对外发消息)、本地状态写(且 lib.mjs **模块加载期**就有
// 写探针/mkdir/legacy 迁移三类写)。"验证调度时只跑 pre-check"这句话此前本身就会重演
// 副作用。
//
// 复审教训(上一版的假验收):只对最终文件做摘要抓不到"写后删"的探针,也抓不到 mkdir;
// 且 fixture 里 pull / backfill / migration 三条路径根本不可达——把守卫删了测试照样绿。
// 本版每条断言都配**对照组**:同一 fixture 不带 --probe-only 时,pull 真的推进 HEAD、
// backfill 真的发起 gh 调用、migration 真的把 legacy 文件搬进状态目录——证明三条路径
// 可达;probe 组断言它们全部没发生,且状态根目录**根本不被创建**(比逐字节一致更强,
// 连 mkdir/写后删探针都锁死)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deriveHazardId, deriveHazardFingerprint } from '../scripts/lib.escaped-hazards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'pre-check.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    // 显式禁签名:继承全局 commit.gpgsign 时,并发跑 temp-git 用例会撞 gpg
    // 「Cannot allocate memory」而随机红(核验席实测 409/414)。测试仓不需要签名。
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
};

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'probe-only-test-'));
  // 目标仓库
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  // skill 仓 fixture:origin 领先 clone 一个 commit → 正常轮 pull 会推进 HEAD,probe 不会
  const skillSrc = join(work, 'skill-src');
  mkdirSync(skillSrc);
  git(['init', '-q', '-b', 'main'], skillSrc);
  writeFileSync(join(skillSrc, 'a.txt'), '1\n');
  git(['add', '.'], skillSrc);
  git(['commit', '-q', '-m', 'c1'], skillSrc);
  const skillClone = join(work, 'skill-clone');
  git(['clone', '-q', skillSrc, skillClone], work);
  writeFileSync(join(skillSrc, 'a.txt'), '2\n');
  git(['add', '.'], skillSrc);
  git(['commit', '-q', '-m', 'c2'], skillSrc);
  const cloneHead = git(['rev-parse', 'HEAD'], skillClone);
  const srcHead = git(['rev-parse', 'HEAD'], skillSrc);
  assert.notEqual(cloneHead, srcHead, 'fixture 自检:origin 必须领先 clone,否则 pull 断言是真空');
  // legacy 状态:按 lib 同一套 key 算法把一份 runs.jsonl 放进系统临时目录的 legacy 位置
  const anchor = realpathSync(resolve(repo, git(['rev-parse', '--git-common-dir'], repo)));
  const key = createHash('sha256').update(anchor).digest('hex').slice(0, 20);
  const legacyDir = join(tmpdir(), 'review-pr', key);
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'runs.jsonl'), '{"legacy":true}\n');
  // rules:配置 mergeAckNotify.notifyModule,让 backfill 走到它的第一条 gh 调用(否则
  // backfill 早退,"不 spawn backfill"的断言是真空——复审抓出的假验收)
  const rulesFile = join(work, 'pr-rules.json');
  writeFileSync(rulesFile, JSON.stringify({
    admins: ['PraiseZhu'],
    loopPrExclusion: { titlePrefixes: ['loop:'], mergeAckNotify: { notifyModule: 'scripts/notify.mjs' } },
  }));
  const fixtures = join(work, 'fixtures');
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, 'pr-list.json'), JSON.stringify([{ number: 483, isDraft: false }]));
  const log = join(work, 'gh-calls.jsonl');
  chmodSync(join(FAKE_GH_DIR, 'gh'), 0o755);
  const stateRoot = join(work, 'state-root'); // 故意不创建:probe 组断言它保持不存在
  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAKE_GH_FIXTURE_DIR: fixtures,
    FAKE_GH_LOG: log,
    REVIEW_PR_STATE_DIR: stateRoot,
    REVIEW_PR_RULES_FILE: rulesFile,
    REVIEW_PR_SKILL_ROOT_OVERRIDE: skillClone,
  };
  delete env.REVIEW_PR_LIB_READONLY; // 防外部环境污染
  return { work, repo, skillSrc, skillClone, cloneHead, srcHead, legacyDir, key, stateRoot, log, env };
}

const ghCalls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('--probe-only:状态根不被创建、skill 仓不 pull、backfill 不发起、legacy 不迁移、恰一条只读 gh 调用', () => {
  const f = setup();
  const r = spawnSync('node', [SCRIPT, '--repo-root', f.repo, '--probe-only'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.decision, 'run');
  assert.equal(out.probeOnly, true);
  // SC-R7 第 3 轮核验:轮次开始的 hazard 重放属"有副作用",probe-only 必须不跑
  assert.equal(out.hazardReplay, undefined, 'probe-only 不得触发 hazard 激活重放(它会写 canonical / push)');
  assert.equal(out.candidateCount, 1);
  // ① 状态根目录根本不存在——锁死 import 层的 mkdir/写探针/迁移(比"逐字节一致"更强:
  //    写后删的探针在最终态摘要里不可见,"目录未被创建"则连这一类也排除)
  assert.equal(existsSync(f.stateRoot), false, 'probe-only 不得创建状态根(import 层零写)');
  // ② skill 仓未被 pull(对照组证明同 fixture 下 pull 是真的会发生的)
  assert.equal(git(['rev-parse', 'HEAD'], f.skillClone), f.cloneHead, 'probe-only 不得 pull skill 仓');
  // ③ legacy 未被迁移(legacy 文件原地不动,且新状态根不存在自然无副本)
  assert.equal(readFileSync(join(f.legacyDir, 'runs.jsonl'), 'utf8'), '{"legacy":true}\n');
  // ④ 恰一条 gh 调用(pre-check 自己的 open pr list),零写调用,无 backfill 的 merged 扫描
  const calls = ghCalls(f.log);
  assert.equal(calls.filter((c) => c.isWrite).length, 0);
  assert.equal(calls.length, 1, `probe-only 只应有一次 gh pr list 只读调用,got: ${JSON.stringify(calls.map((c) => c.args.slice(0, 5)))}`);
  assert.ok(!calls.some((c) => c.args.includes('merged')), 'probe-only 不得发起 backfill 的 merged 扫描');
});

test('--probe-only 故障出口:异常时同样输出带 probeOnly:true 的 decision JSON(不是只剩 stderr)', () => {
  const f = setup();
  const repoNoRemote = join(f.work, 'repo-no-remote'); // 无 origin → parseRepo 抛错进 catch
  mkdirSync(repoNoRemote);
  git(['init', '-q'], repoNoRemote);
  const r = spawnSync('node', [SCRIPT, '--repo-root', repoNoRemote, '--probe-only'], { cwd: repoNoRemote, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.decision, 'run');
  assert.equal(out.reason, 'fallback-run');
  assert.equal(out.probeOnly, true, '手动验证者在故障场景也必须拿到承诺的 decision JSON');
});

test('对照组(不带 --probe-only):同一 fixture 下 pull 推进 HEAD、backfill 发起 gh 调用、legacy 被迁移——证明 probe 组守住的三条路径真实可达', () => {
  const f = setup();
  // 第 4 轮复审 P2:故意让父环境残留 readonly 标记——生产代码在非 probe 模式必须显式清除
  // (delete process.env.REVIEW_PR_LIB_READONLY),否则本组的 pull/backfill/迁移断言全会
  // 因误入只读初始化而失败。删掉那行 delete,本测试即红。
  f.env.REVIEW_PR_LIB_READONLY = '1';
  const r = spawnSync('node', [SCRIPT, '--repo-root', f.repo], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.decision, 'run');
  assert.equal(out.probeOnly, undefined);
  // SC-R7 第 3 轮核验:正常轮次开始必须**真的**跑一次 pending 重放——此前激活只挂在合并
  // 出口上,那一次失败后若没有新合并,inbox 就再也没有自动重放的时机。
  assert.ok(out.hazardReplay, `正常轮必须带 hazardReplay:${JSON.stringify(out)}`);
  // pull 真的发生:clone HEAD 追平 origin
  assert.equal(git(['rev-parse', 'HEAD'], f.skillClone), f.srcHead, '正常轮应 ff-pull skill 仓——否则 probe 组的"不 pull"断言是真空');
  // backfill 真的发起(fake gh 记录到 merged 扫描调用)
  const calls = ghCalls(f.log);
  assert.ok(calls.some((c) => c.args.includes('merged')), `正常轮应发起 backfill 的 merged 扫描,got: ${JSON.stringify(calls.map((c) => c.args.slice(0, 5)))}`);
  // legacy 真的迁移进新状态根
  assert.equal(readFileSync(join(f.stateRoot, f.key, 'runs.jsonl'), 'utf8'), '{"legacy":true}\n', '正常轮应执行一次性 legacy 迁移');
  assert.ok(readdirSync(join(f.stateRoot, f.key)).includes('.migrated-from-tmp.json'));
});

test('R7 第 4 轮核验 BLOCKER:open PR=0(no-candidates skip)时 pending hazard 重放仍必须跑', () => {
  // 真实事故窗口:fix merge 后 activation/push 失败,随后 open PR 归零——重放若只挂在
  // decision:'run' 出口,这个窗口里每轮 exit 2,inbox 永远饿死。
  const f = setup();
  writeFileSync(join(f.env.FAKE_GH_FIXTURE_DIR, 'pr-list.json'), '[]'); // 一个 open PR 都没有
  // 第 5/6 轮核验 BLOCKER:此前条目用编造串 'hz2-prod'——不等于 deriveHazardId(seed) 的
  // 复算值,validateHazardShape 在 verifyActivation **之前**就把它判"inbox 条目不合法",
  // probe 根本没跑;lastActivationCheck 只证明坏条目被摸到,证不了合法 pending 被重放。
  // (第 5 轮修过一次但被变异脚本的 git checkout 洗掉、未进 commit——第 6 轮核验席用
  // `git diff 483a066..HEAD 为空`抓实。本次重落并在下方加了"reason 不得来自 shape 校验"
  // 的断言,这条断言在伪造 id 的旧写法下必红,防止同一手滑第三次发生。)
  const seed = { repo: 'xindong/mivo-canvas', originPr: 400, originHead: 'b'.repeat(40), fixPr: 469, fixHead: 'c'.repeat(40) };
  const inboxItem = {
    hazardId: deriveHazardId(seed), fingerprint: deriveHazardFingerprint(seed), repo: seed.repo,
    originPr: seed.originPr, originHead: seed.originHead, fixPr: seed.fixPr, fixHead: seed.fixHead,
    pattern: 'p', evidence: '依据', paths: ['a/**'],
    activationStatus: 'pending-fix-merge', promotionStatus: 'pending', promotionTarget: null,
  };
  const stateSub = join(f.stateRoot, f.key);
  mkdirSync(stateSub, { recursive: true });
  writeFileSync(join(stateSub, 'escaped-hazards-inbox.json'), JSON.stringify({ version: 1, items: [inboxItem] }));
  // fixPr(469)的 pr view 探测返回 OPEN(未合并)→ verifyActivation 在**探测阶段**拒绝
  writeFileSync(join(f.env.FAKE_GH_FIXTURE_DIR, 'pr-view.json'), JSON.stringify({ state: 'OPEN', headRefOid: seed.fixHead }));
  const r = spawnSync('node', [SCRIPT, '--repo-root', f.repo], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 2, `no-candidates 应 skip(exit 2):${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, 'no-candidates');
  assert.ok(out.hazardReplay, `skip 出口也必须带 hazardReplay(重放先于持久 skip):${r.stdout}`);
  assert.equal(out.hazardReplay.pendingCount, 1, '合法 pending 必须真的被处理过(核验不过 → 留 inbox 计入 pendingCount)');
  const box = JSON.parse(readFileSync(join(stateSub, 'escaped-hazards-inbox.json'), 'utf8'));
  assert.equal(box.items.length, 1, '核验没过的条目必须留在 inbox 下轮重放');
  assert.ok(box.items[0].lastActivationCheck, '必须记下这轮为什么没激活');
  // reason 必须来自 verifyActivation 的**探测**结论,不是 validateHazardShape 的"不合法"
  assert.doesNotMatch(box.items[0].lastActivationCheck, /不合法/, 'reason 不得来自 shape 校验——必须证明真的走到了 probe 探测');
  assert.match(box.items[0].lastActivationCheck, /未合并|state=OPEN/, `reason 应来自探测结论:${box.items[0].lastActivationCheck}`);
  // 并直接断言生产 probe 真的对 fixPr 发起了 gh pr view 调用(不靠字段内容侧面推断)
  const calls = ghCalls(f.log);
  assert.ok(calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('469')),
    `重放必须真的对 fixPr(469)发起过 pr view 探测,got: ${JSON.stringify(calls.map((c) => c.args))}`);
});

test('R7 第 4 轮核验:--probe-only + open PR=0 → 仍零副作用(不跑重放,inbox 原样)', () => {
  const f = setup();
  writeFileSync(join(f.env.FAKE_GH_FIXTURE_DIR, 'pr-list.json'), '[]');
  const r = spawnSync('node', [SCRIPT, '--repo-root', f.repo, '--probe-only'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.decision, 'skip');
  assert.equal(out.hazardReplay, undefined, 'probe-only 不得触发重放(它会写 canonical / push)');
  assert.equal(existsSync(f.stateRoot), false, 'probe-only 不得创建状态根');
});
