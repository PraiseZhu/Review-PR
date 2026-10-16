import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sweep, SWEEP_EVERY_MS } from './bypass-reason.mjs';
import { REMINDER_MARKER } from '../lib/bypass.mjs';

const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-10-17T10:00:00+08:00');
const REPO = 'o/target';
const sha = (n) => String(n).padStart(40, '0');
const suite = (n, { actor = 'PraiseZhu', at = '2026-10-17T09:30:00+08:00', result = 'bypass' } = {}) =>
  ({ actor_name: actor, after_sha: sha(n), pushed_at: at, result, ref: 'refs/heads/main' });
// 2026-10-17 从 #1018 取回的真实原因评论(节选开头一句,足够命中关键词)
const REAL_REASON = '**维护者 PraiseZhu 决定对本 PR 使用紧急强合口子(bypass),说明如下。**\n\n- **跳过哪一项**:只跳过必需检查 `review-pr`。';

// 假 gh:按路径回话,记下每次调用;posts 是发出的评论。
function makeGh({ suites = [], prs = {}, comments = {}, failOn = null, failPostAt = null } = {}) {
  const calls = [];
  const posts = [];
  const gh = (args, options = {}) => {
    calls.push([...args]);
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (failOn && failOn.test(path)) return { ok: false, stdout: '', stderr: 'HTTP 403: API rate limit exceeded' };
    if (path.includes('/rulesets/rule-suites')) return { ok: true, stdout: JSON.stringify(suites), stderr: '' };
    const pulls = /\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (pulls) return { ok: true, stdout: JSON.stringify(prs[pulls[1]] ? [{ number: prs[pulls[1]] }] : []), stderr: '' };
    const cm = /\/issues\/(\d+)\/comments$/.exec(path);
    if (cm && args.includes('-f')) {
      if (failPostAt !== null && posts.length === failPostAt) return { ok: false, stdout: '', stderr: 'HTTP 502' };
      const body = args.find((a) => a.startsWith('body='));
      posts.push({ pr: Number(cm[1]), body: body.slice(5), options });
      return { ok: true, stdout: JSON.stringify({ html_url: `https://github.com/o/target/pull/${cm[1]}#issuecomment-1` }), stderr: '' };
    }
    if (cm) return { ok: true, stdout: JSON.stringify([comments[Number(cm[1])] ?? []]), stderr: '' };
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls, posts };
}

function withState(fn, initial) {
  const dir = mkdtempSync(join(tmpdir(), 'bypass-reason-'));
  try {
    if (initial) {
      mkdirSync(join(dir, 'mivo'), { recursive: true });
      writeFileSync(join(dir, 'mivo', 'bypass-reminders.json'), JSON.stringify(initial));
    }
    const read = () => JSON.parse(readFileSync(join(dir, 'mivo', 'bypass-reminders.json'), 'utf8'));
    return fn(dir, read);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const live = { since: '2026-10-17T02:00:00+08:00', lastSweepAt: null, reminded: {} };

test('第一次运行只写 since 就退出:不读 GitHub、不发评论(旧 PR #927 #935 #941 #967 不会被自动提醒)', () => {
  withState((dir, read) => {
    const { gh, calls, posts } = makeGh({ suites: [suite(1)], prs: { [sha(1)]: 927 } });
    const result = sweep({ repo: REPO, stateDir: dir, gh, now: T0 });
    assert.equal(result.ok, true);
    assert.equal(result.initialized, true);
    assert.deepEqual([calls.length, posts.length], [0, 0]);
    assert.deepEqual(read(), { since: new Date(T0).toISOString(), lastSweepAt: null, reminded: {} });
  });
});

test('没有原因评论的绕过:发一条提醒(@ 绕过的人,带暗记),记账;再扫(满 1 小时后)不重复', () => {
  withState((dir, read) => {
    const world = makeGh({ suites: [suite(1, { actor: 'aj0928' })], prs: { [sha(1)]: 941 }, comments: { 941: [{ user: { login: 'x', type: 'User' }, body: '看了' }] } });
    const first = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.deepEqual([first.ok, first.reminded], [true, [941]]);
    assert.equal(world.posts.length, 1);
    assert.equal(world.posts[0].pr, 941);
    assert.ok(world.posts[0].body.startsWith('@aj0928 '));
    assert.ok(world.posts[0].body.endsWith(REMINDER_MARKER));
    const state = read();
    assert.equal(state.lastSweepAt, new Date(T0).toISOString());
    assert.match(state.reminded[941].commentUrl, /pull\/941#issuecomment/);
    // 满 1 小时后再扫:同一个 PR 不再提醒
    const again = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 + SWEEP_EVERY_MS + 1 });
    assert.deepEqual(again.reminded, []);
    assert.equal(world.posts.length, 1, '同一个 PR 只收一条提醒');
    assert.deepEqual(again.skipped, [], '已判定的记录第二轮不再进入判定');
    assert.deepEqual(Object.keys(read().checked), [sha(1)]);
  }, live);
});

test('已有人写了原因的 PR 不提醒', () => {
  withState((dir) => {
    const world = makeGh({ suites: [suite(1)], prs: { [sha(1)]: 1018 }, comments: { 1018: [{ user: { login: 'PraiseZhu', type: 'User' }, body: REAL_REASON }] } });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.deepEqual(result.reminded, []);
    assert.equal(world.posts.length, 0);
    assert.deepEqual(result.skipped.map((s) => s.why), ['has-reason']);
  }, live);
});

test('距上次扫描不到 1 小时:不扫(不读 GitHub、不写状态)', () => {
  const state = { ...live, lastSweepAt: new Date(T0 - 59 * 60_000).toISOString() };
  withState((dir, read) => {
    const world = makeGh({ suites: [suite(1)], prs: { [sha(1)]: 5 } });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.deepEqual(result, { ok: true, skipped: 'throttled', reminded: [] });
    assert.equal(world.calls.length, 0);
    assert.deepEqual(read(), state);
  }, state);
});

test('读 GitHub 失败:输出 ok:false 和原因、不发评论;但 lastSweepAt 已更新(出错也不会每轮重试)', () => {
  withState((dir, read) => {
    const world = makeGh({ failOn: /rule-suites/ });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.equal(result.ok, false);
    assert.match(result.error, /读规则集记录失败.*rate limit/);
    assert.equal(world.posts.length, 0);
    assert.equal(read().lastSweepAt, new Date(T0).toISOString());
    // 下一轮(没满 1 小时)被节流,不重试
    assert.equal(sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 + 3 * 60_000 }).skipped, 'throttled');
  }, live);
  withState((dir) => {
    const world = makeGh({ suites: [suite(1)], prs: { [sha(1)]: 5 }, failOn: /\/issues\/5\/comments/ });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.equal(result.ok, false);
    assert.equal(world.posts.length, 0);
  }, live);
});

test('单轮最多 5 条;发一条就立刻记账,中途发不出去时已记的不会重复、没发的下次再来', () => {
  const suites = Array.from({ length: 7 }, (_, i) => suite(10 + i, { at: `2026-10-17T09:0${i}:00+08:00` }));
  const prs = Object.fromEntries(suites.map((s, i) => [s.after_sha, 300 + i]));
  withState((dir, read) => {
    const world = makeGh({ suites, prs });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.deepEqual(result.reminded, [300, 301, 302, 303, 304]);
    assert.deepEqual(Object.keys(read().reminded).sort(), ['300', '301', '302', '303', '304']);
    const next = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 + 2 * HOUR });
    assert.deepEqual(next.reminded, [305, 306]);
  }, live);
  withState((dir, read) => {
    const world = makeGh({ suites, prs, failPostAt: 2 });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.reminded, [300, 301]);
    assert.deepEqual(Object.keys(read().reminded).sort(), ['300', '301'], '已发出的两条已记账');
    const retry = sweep({ repo: REPO, stateDir: dir, gh: makeGh({ suites, prs }).gh, now: T0 + 2 * HOUR });
    assert.deepEqual(retry.reminded, [302, 303, 304, 305, 306], '没发出去的下次补,已提醒的不再发');
  }, live);
});

// 21 条以上的记录:按 after_sha 记下已判定完的(已提醒、已有原因、找不到 PR),下一轮从没判定的接着查
const manySuites = (n) => Array.from({ length: n }, (_, i) => suite(1000 + i, { at: new Date(Date.parse('2026-10-17T09:00:00+08:00') + i * 1000).toISOString() }));
const lookups = (calls) => calls.filter((c) => /\/commits\/[0-9a-f]{40}\/pulls$/.test(c.find((a) => a.startsWith('repos/')) ?? '')).map((c) => c.find((a) => a.startsWith('repos/')).match(/commits\/(\d+)\/pulls/)[1] * 1);

test('21 条记录、前 20 条都已有原因:第一轮判定完前 20 条,第二轮轮到第 21 条并提醒(不再卡在前 20 条)', () => {
  const suites = manySuites(21);
  const prs = Object.fromEntries(suites.map((s, i) => [s.after_sha, 500 + i]));
  const comments = Object.fromEntries(suites.slice(0, 20).map((_, i) => [500 + i, [{ user: { login: 'PraiseZhu', type: 'User' }, body: REAL_REASON }]]));
  withState((dir, read) => {
    const world = makeGh({ suites, prs, comments });
    const first = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.deepEqual([first.ok, first.reminded], [true, []]);
    assert.equal(lookups(world.calls).length, 20, '一轮最多反查 20 条');
    assert.equal(Object.keys(read().checked).length, 20, '前 20 条已判定');
    const second = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 + SWEEP_EVERY_MS + 1 });
    assert.deepEqual(second.reminded, [520], '第 21 条这一轮被检查到并提醒');
    assert.equal(world.posts.length, 1);
    // 前 20 条整个过程只反查过一次;第 21 条只在第二轮查
    const all = lookups(world.calls);
    assert.equal(all.length, 21);
    assert.equal(new Set(all).size, 21, '已判定的记录不重复反查');
  }, live);
});

test('找不到 PR 的记录也算判定完:前 20 条没有 PR,第二轮只反查第 21 条', () => {
  const suites = manySuites(21);
  withState((dir, read) => {
    const world = makeGh({ suites, prs: { [suites[20].after_sha]: 777 } });
    sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.equal(Object.keys(read().checked).length, 20);
    const second = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 + SWEEP_EVERY_MS + 1 });
    assert.deepEqual(second.reminded, [777]);
    assert.equal(lookups(world.calls).length, 21, '前 20 条各只反查一次');
  }, live);
});

test('30 条都要提醒:单轮 5 条、反查 20 条的上限保留,连扫几轮后每个 PR 恰好收一条提醒', () => {
  const suites = manySuites(30);
  const prs = Object.fromEntries(suites.map((s, i) => [s.after_sha, 600 + i]));
  withState((dir, read) => {
    const world = makeGh({ suites, prs });
    const rounds = [];
    for (let i = 0; i < 8; i += 1) {
      const before = lookups(world.calls).length;
      const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 + i * (SWEEP_EVERY_MS + 1) });
      assert.ok(result.reminded.length <= 5, '单轮最多 5 条');
      assert.ok(lookups(world.calls).length - before <= 20, '单轮最多反查 20 条');
      rounds.push(result.reminded);
    }
    assert.deepEqual(rounds.flat().sort(), Array.from({ length: 30 }, (_, i) => 600 + i), '30 个 PR 各一条,没有漏也没有重复');
    assert.equal(world.posts.length, 30);
    assert.equal(Object.keys(read().checked).length, 30);
    // 单轮反查不超过 20 条
  }, live);
});

test('发评论中途失败:已发出的记入 checked,没发的不记(下一轮接着来)', () => {
  const suites = manySuites(4);
  const prs = Object.fromEntries(suites.map((s, i) => [s.after_sha, 700 + i]));
  withState((dir, read) => {
    const world = makeGh({ suites, prs, failPostAt: 2 });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0 });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(read().checked).sort(), [suites[0].after_sha, suites[1].after_sha].sort());
    const retry = sweep({ repo: REPO, stateDir: dir, gh: makeGh({ suites, prs }).gh, now: T0 + 2 * HOUR });
    assert.deepEqual(retry.reminded, [702, 703]);
  }, live);
});

test('checked 里超出一周窗口(留 8 天)的旧记录被清掉,窗口内的保留', () => {
  const day = 24 * HOUR;
  const state = { ...live, checked: { [sha(1)]: new Date(T0 - 9 * day).toISOString(), [sha(2)]: new Date(T0 - 1 * day).toISOString() } };
  withState((dir, read) => {
    sweep({ repo: REPO, stateDir: dir, gh: makeGh({ suites: [] }).gh, now: T0 });
    assert.deepEqual(Object.keys(read().checked), [sha(2)]);
  }, state);
});

test('读 GitHub 失败:checked 不变(已有的保留,没有新增)', () => {
  const state = { ...live, checked: { [sha(2)]: new Date(T0 - 3600_000).toISOString() } };
  withState((dir, read) => {
    const result = sweep({ repo: REPO, stateDir: dir, gh: makeGh({ failOn: /rule-suites/ }).gh, now: T0 });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(read().checked), [sha(2)]);
  }, state);
});

test('--dry-run:只读,不发评论,也不写状态文件(含第一次初始化)', () => {
  withState((dir) => {
    const world = makeGh({ suites: [suite(1)], prs: { [sha(1)]: 5 } });
    const result = sweep({ repo: REPO, stateDir: dir, gh: world.gh, now: T0, dryRun: true });
    assert.deepEqual(result.wouldRemind, [5]);
    assert.equal(world.posts.length, 0);
    assert.ok(world.calls.every((c) => !c.includes('-f')), '没有写接口调用');
  }, live);
  withState((dir) => {
    const result = sweep({ repo: REPO, stateDir: dir, gh: makeGh().gh, now: T0, dryRun: true });
    assert.equal(result.initialized, true);
    assert.equal(existsSync(join(dir, 'mivo', 'bypass-reminders.json')), false);
  });
});

test('命令行:缺参数退出码 2;干跑第一次输出一行 JSON', () => {
  const script = fileURLToPath(new URL('./bypass-reason.mjs', import.meta.url));
  const bad = spawnSync(process.execPath, [script, '--sweep'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const dir = mkdtempSync(join(tmpdir(), 'bypass-reason-cli-'));
  try {
    const ok = spawnSync(process.execPath, [script, '--sweep', '--repo', REPO, '--state-dir', dir, '--dry-run'], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    const lines = ok.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).initialized, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
