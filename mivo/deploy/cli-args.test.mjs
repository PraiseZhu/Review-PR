// auto-update.mjs、deploy-tuple.mjs 的命令行参数校验(PraiseZhu/Review-PR#204):
// 不认识的参数(--help、拼错的选项)报错退出,不写 hold、部署锁、巡检暂停,也不碰 gh、ssh;--help 打印用法后退出 0。
// 2026-11-06 的事故:`auto-update.mjs --help` 被当成「没有参数」,直接开始真换版本,留下停点、锁和巡检暂停。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toCliArgs } from './tuple-lib.mjs';
import { setupFixture, WF_OLD, WF_NEW } from './deploy-tuple.fixture.mjs';

const AUTO_UPDATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'auto-update.mjs');
const SPEC = { flags: ['check', 'preview'], values: ['log-dir', 'on'] };

// helpers
// 递归列出目录下所有文件和子目录(相对路径,排序),用来断言「运行前后什么都没多出来」。
function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      out.push(path.relative(dir, full));
      if (fs.statSync(full).isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}
// auto-update 夹具:临时 HOME 里放一个假的 skill 检出;gh 替身每次被调用都记一行。
// 场景是「线上已是最新」:参数校验没生效时脚本也只会读 gh、报「今天不换」,不会真换版本。
function setupAutoUpdate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-cli-args-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const skill = path.join(home, 'mivo-prereview/skill');
  fs.mkdirSync(skill, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', skill, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(root, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
case "$*" in
  "variable get MIVO_REVIEW_SKILL_SHA -R xindong/mivo-canvas-plugin") echo ${head} ;;
  "api repos/PraiseZhu/Review-PR/commits/main --jq .sha") echo ${head} ;;
  *) echo "gh 替身没准备这个调用: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_LOG: ghLog };
  const before = listTree(home);
  return {
    run: (...args) => spawnSync(process.execPath, [AUTO_UPDATE, ...args], { encoding: 'utf8', env }),
    ghCalls: () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n') : []),
    untouched: () => assert.deepEqual(listTree(home), before, 'HOME 下不该多出任何文件或目录'),
  };
}

// parser
test('toCliArgs:认识的开关和带值选项被收下,第一次出现的值生效', () => {
  const r = toCliArgs(['--check', '--log-dir', '/x', '--on', 'mini', '--log-dir', '/y'], SPEC);
  assert.equal(r.error, null);
  assert.equal(r.help, false);
  assert.deepEqual([...r.flags], ['check']);
  assert.equal(r.values.get('log-dir'), '/x');
  assert.equal(r.values.get('on'), 'mini');
  assert.equal(toCliArgs([], SPEC).error, null);
});

test('toCliArgs:不认识的参数、位置参数、--name=值 写法、缺值都是错误', () => {
  for (const bad of [['--hlep'], ['--bogus'], ['stray'], ['--check', 'stray'], ['--log-dir=/x'], ['-x'], ['--']]) {
    assert.match(toCliArgs(bad, SPEC).error ?? '', /不认识的参数/, JSON.stringify(bad));
  }
  assert.match(toCliArgs(['--log-dir'], SPEC).error, /--log-dir 缺少值/);
  assert.match(toCliArgs(['--log-dir', '--check'], SPEC).error, /--log-dir 缺少值/);
  assert.match(toCliArgs(['--check', '--on'], SPEC).error, /--on 缺少值/);
});

test('toCliArgs:--help 和 -h 在任何位置都优先于其它参数', () => {
  for (const argv of [['--help'], ['-h'], ['--check', '--help'], ['--bogus', '--help'], ['--help', '--bogus']]) {
    const r = toCliArgs(argv, SPEC);
    assert.equal(r.help, true, JSON.stringify(argv));
    assert.equal(r.error, null, JSON.stringify(argv));
  }
});

// auto-update.mjs
test('auto-update --help:打印用法、退出 0,不读 gh、不写任何文件', (t) => {
  const f = setupAutoUpdate(t);
  for (const argv of [['--help'], ['-h'], ['--cindy-script', '--help']]) {
    const r = f.run(...argv);
    assert.equal(r.status, 0, `${argv}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /用法/);
    assert.match(r.stdout, /--check/);
    assert.match(r.stdout, /--cindy-script/);
    assert.match(r.stdout, /--log-dir/);
    assert.doesNotMatch(r.stdout, /"protocol"/, '用法是人读的文字,不是收尾帧');
  }
  assert.deepEqual(f.ghCalls(), [], '参数校验在读 gh 之前');
  f.untouched();
});

test('auto-update 不认识的参数:报错、非 0 退出,stdout 为空,不读 gh、不写任何文件', (t) => {
  const f = setupAutoUpdate(t);
  for (const argv of [['--hlep'], ['--bogus'], ['stray'], ['--check', '--bogus'], ['--cindy-script', '--bogus'], ['--log-dir'], ['--log-dir', '--check']]) {
    const r = f.run(...argv);
    assert.equal(r.status, 1, `${argv}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `${argv}: 报错只写 stderr,不能污染 --cindy-script 的 stdout`);
    assert.match(r.stderr, /不认识的参数|缺少值/);
    assert.match(r.stderr, /--help/, '报错里提示去看 --help');
  }
  assert.deepEqual(f.ghCalls(), []);
  f.untouched();
});

test('auto-update 合法参数不变:--check、--cindy-script、--log-dir 照常跑到读 gh 那一步', (t) => {
  const f = setupAutoUpdate(t);
  const check = f.run('--check');
  assert.equal(check.status, 2, check.stderr);
  assert.match(check.stdout, /^CINDY_PRECHECK_OK$/m);
  const exec = f.run('--cindy-script', '--log-dir', path.join(os.tmpdir(), 'mivo-cli-args-unused'));
  assert.equal(exec.status, 0, exec.stderr);
  assert.match(JSON.parse(exec.stdout).resultText, /今天不换/);
  assert.ok(f.ghCalls().length > 0);
});

// deploy-tuple.mjs
test('deploy-tuple --help:打印用法、退出 0,不碰 gh、ssh,不写任何文件', (t) => {
  const f = setupFixture(t);
  const before = listTree(f.home);
  for (const argv of [['--help'], ['-h'], ['--on', 'mini', '--help']]) {
    const r = f.run(...argv);
    assert.equal(r.status, 0, `${argv}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /用法/);
    for (const name of ['--on', '--old-skill', '--new-skill', '--old-wf', '--new-wf', '--pr-head', '--stop', '--max-wait-min', '--record-dir', '--preview', '--selftest']) {
      assert.match(r.stdout, new RegExp(name), `${argv}: 用法里要有 ${name}`);
    }
  }
  assert.equal(fs.existsSync(f.sshLog), false);
  assert.deepEqual(f.ghState().sets, []);
  assert.equal(fs.existsSync(f.recordDir), false);
  assert.deepEqual(listTree(f.home), before);
});

test('deploy-tuple 不认识的参数:报错、非 0 退出,不 ssh、不改仓库变量、不写 hold、锁、暂停、部署记录', (t) => {
  const f = setupFixture(t);
  const before = listTree(f.home);
  // 只读的 --preview 和正式切换都带上拼错的参数;--selftest 和只给一个坏参数的也要拦。
  const cases = [
    f.deploy({ extra: ['--preview', '--bogus'] }),
    f.deploy({ extra: ['--hlep'] }),
    f.deploy({ extra: ['stray'] }),
    f.run('--selftest', '--bogus'),
    f.run('--bogus'),
    f.run('--on', 'mini', '--max-wait-min'),
  ];
  for (const r of cases) {
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /不认识的参数|缺少值/);
    assert.match(r.stderr, /--help/);
    assert.equal(r.stdout, '', '报错不进 stdout');
  }
  assert.equal(fs.existsSync(f.sshLog), false);
  assert.deepEqual(f.ghState().sets, []);
  assert.equal(fs.existsSync(f.recordDir), false);
  assert.deepEqual(listTree(f.home), before, '没有 deploy-hold.json、deploy-tuple.lock、pause-until.json 等文件产生');
  assert.equal(f.exists('mivo-prereview/state'), false);
});

test('deploy-tuple 合法参数不变:--preview 带全部带值选项照常通过', (t) => {
  const f = setupFixture(t);
  const r = f.deploy({ oldWf: WF_OLD, newWf: WF_NEW, extra: ['--preview'] });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /只读预检通过/);
});
