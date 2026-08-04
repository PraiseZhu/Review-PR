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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'pre-check.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
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
  const r = spawnSync('node', [SCRIPT, '--repo-root', f.repo], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.decision, 'run');
  assert.equal(out.probeOnly, undefined);
  // pull 真的发生:clone HEAD 追平 origin
  assert.equal(git(['rev-parse', 'HEAD'], f.skillClone), f.srcHead, '正常轮应 ff-pull skill 仓——否则 probe 组的"不 pull"断言是真空');
  // backfill 真的发起(fake gh 记录到 merged 扫描调用)
  const calls = ghCalls(f.log);
  assert.ok(calls.some((c) => c.args.includes('merged')), `正常轮应发起 backfill 的 merged 扫描,got: ${JSON.stringify(calls.map((c) => c.args.slice(0, 5)))}`);
  // legacy 真的迁移进新状态根
  assert.equal(readFileSync(join(f.stateRoot, f.key, 'runs.jsonl'), 'utf8'), '{"legacy":true}\n', '正常轮应执行一次性 legacy 迁移');
  assert.ok(readdirSync(join(f.stateRoot, f.key)).includes('.migrated-from-tmp.json'));
});
