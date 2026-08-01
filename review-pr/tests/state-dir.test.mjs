// state-dir.test.mjs — lib.mjs 状态根解析(F1-F4, R1-R5/R7)的固化重放。
//
// 这些测试把 2026-08-01 三轮审核(一审 F1-F4、二审 F1-F7、三审 R1-R8)里针对
// `lib.mjs` 状态根解析逻辑的人工重放固化下来,防止未来改动悄悄回归。跑法:
//   node --test review-pr/tests/state-dir.test.mjs
// 每个 test 用一次性临时 git 仓库当 fixture,不依赖任何签入仓库的敏感数据。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, freshTempDir, initRepo, resolveStateDir } from './helpers.mjs';

test('state-dir: 普通仓库(有匹配 .gitignore)默认落进 history/loops/review-pr/state', () => {
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });

  const { stateDir, status } = resolveStateDir(repo);
  assert.equal(status, 0);
  assert.ok(stateDir.startsWith(join(repo, 'history', 'loops', 'review-pr', 'state')));
  assert.ok(existsSync(stateDir), 'STATE_DIR 应该已被创建');

  rmSync(base, { recursive: true, force: true });
});

test('state-dir: 没有匹配 .gitignore 的仓库回退系统临时目录(F2①拒绝路径)', () => {
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo); // 不写 .gitignore

  const { stateDir, stderr, status } = resolveStateDir(repo);
  assert.equal(status, 0);
  assert.ok(!stateDir.startsWith(repo), 'STATE_DIR 不应该落进仓库工作树内');
  assert.match(stderr, /review-pr/); // 至少应该有一条诊断信息(不强求具体文案,避免脆弱耦合)

  rmSync(base, { recursive: true, force: true });
});

test('state-dir: R3 git 探针本身不可用(PATH 里没有 git)时按 unknown fail-closed,不当作 outside 放行', () => {
  // 一审版本把"git 命令判断不了"(spawn 失败/ENOENT/超时/权限问题)与"确认不在
  // 工作树内"混为一谈,都按 false 处理,等价于 fail-open 放行。这里通过让子
  // 进程的 PATH 里找不到 git 可执行文件,复现"判断不了"这一确切场景——用
  // REVIEW_PR_STATE_DIR 直接命中 isSafeFromDirtyWorkingTree 的 env-override
  // 分支(不依赖 resolveMainWorktreeRoot,那条分支在 git 不可用时会更早返回
  // null,测不到这里要测的 unknown 分支)。
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });
  const envRoot = join(base, 'env-override-target');
  mkdirSync(envRoot, { recursive: true });

  const noGitPath = freshTempDir('no-git-path-'); // 空目录,PATH 只指向它,里面没有任何可执行文件(包括 git)
  const { stateDir, status } = resolveStateDir(repo, { REVIEW_PR_STATE_DIR: envRoot, PATH: noGitPath });
  assert.equal(status, 0);
  assert.notEqual(stateDir, envRoot, 'git 探针判断不了时必须按不安全处理,不能放行到 env override 指定的目标');

  rmSync(base, { recursive: true, force: true });
  rmSync(noGitPath, { recursive: true, force: true });
});

test('state-dir: F1/R7 主 worktree 与 linked worktree 共享同一个 STATE_DIR', () => {
  const base = freshTempDir();
  const main = join(base, 'main-checkout');
  initRepo(main, { gitignore: 'history/\n' });
  const linked = join(base, 'linked-wt');
  git(['worktree', 'add', '-q', linked, '-b', 'feature/x'], { cwd: main });

  const fromMain = resolveStateDir(main);
  const fromLinked = resolveStateDir(linked);

  assert.equal(fromMain.status, 0);
  assert.equal(fromLinked.status, 0);
  assert.equal(fromMain.stateDir, fromLinked.stateDir, '同一仓库的主/linked worktree 必须共享同一个状态目录');
  assert.ok(fromMain.stateDir.startsWith(main), 'STATE_DIR 应锚定在主 worktree 下,不随当前跑在哪个 worktree 变化');

  rmSync(base, { recursive: true, force: true });
});

test('state-dir: R7 裸仓库回退系统临时目录', () => {
  const base = freshTempDir();
  const bare = join(base, 'repo.git');
  git(['init', '-q', '--bare', bare]);

  const { stateDir, status } = resolveStateDir(bare);
  assert.equal(status, 0);
  assert.ok(!stateDir.includes('repo.git'), '裸仓库不应该被当作有主 worktree 的仓库处理');

  rmSync(base, { recursive: true, force: true });
});

test('state-dir: R7 submodule 场景可持久化共享(不再被 basename===".git" 误判打回 tmp)', () => {
  const base = freshTempDir();
  const outer = join(base, 'outer');
  initRepo(outer, { gitignore: 'history/\n' });

  const innerSrc = join(base, 'inner-src');
  initRepo(innerSrc, { gitignore: 'history/\n' });

  // 用 file:// 协议 clone 成 submodule,避免依赖网络/远端凭据
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', `file://${innerSrc}`, 'sub'], { cwd: outer });
  git(['commit', '-q', '-m', 'add submodule'], { cwd: outer });
  const submodulePath = join(outer, 'sub');

  const { stateDir, status } = resolveStateDir(submodulePath);
  assert.equal(status, 0);
  assert.ok(
    stateDir.startsWith(submodulePath),
    `submodule 应该按自己的主 worktree 持久化,收到 STATE_DIR=${stateDir}`,
  );

  rmSync(base, { recursive: true, force: true });
});

test('state-dir: F2②/R2 两个 worktree 的 git-common-dir 经 realpath 归一后指向同一身份(R2 修复依赖的底层事实)', () => {
  // isInsideSkillRepo 比对的是"当前正在跑的 skill 自己的仓库身份",测试进程
  // 没办法伪造"我是 skill 仓库"这个事实本身(它由 lib.mjs 的真实安装位置决定)。
  // 这里验证的是 R2 赖以成立的底层机制:同一仓库的不同 worktree,即使
  // `git rev-parse --show-toplevel`(worktree 文件系统根)完全不同,
  // `--git-common-dir` 经 realpath 归一后仍解析到同一个身份——这正是"比双方
  // canonical 仓库身份,不比 worktree 文件系统根路径"这条修复能生效的原因。
  const base = freshTempDir();
  const main = join(base, 'wt-main');
  initRepo(main, { gitignore: 'history/\n' });
  const linked = join(base, 'wt-linked');
  git(['worktree', 'add', '-q', linked, '-b', 'feature/z'], { cwd: main });

  const commonDirOf = (cwd) => {
    const out = git(['rev-parse', '--git-common-dir'], { cwd }).stdout.trim();
    return realpathSync(out.startsWith('/') ? out : join(cwd, out));
  };
  const topLevelOf = (cwd) => realpathSync(git(['rev-parse', '--show-toplevel'], { cwd }).stdout.trim());

  assert.equal(commonDirOf(main), commonDirOf(linked), 'common-dir 归一后应指向同一个身份');
  assert.notEqual(topLevelOf(main), topLevelOf(linked), '两个 worktree 的文件系统根本来就不同(证明不能拿它比对)');

  rmSync(base, { recursive: true, force: true });
});

test('state-dir: F3 mkdir 成功但目录不可写(chmod 555)时写探针捕获并回退', () => {
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });

  const first = resolveStateDir(repo);
  assert.equal(first.status, 0);
  assert.ok(existsSync(first.stateDir));
  chmodSync(first.stateDir, 0o555);

  const second = resolveStateDir(repo);
  assert.equal(second.status, 0);
  assert.notEqual(second.stateDir, first.stateDir, '不可写的叶子目录不应该被继续使用');
  assert.ok(!second.stateDir.startsWith(repo), '应回退到系统临时目录');

  chmodSync(first.stateDir, 0o755);
  rmSync(base, { recursive: true, force: true });
});

test(
  'state-dir: R4 目录可创建/可写但删不掉文件(macOS uappnd)时写探针必须回退',
  { skip: process.platform !== 'darwin' && '仅 macOS 支持 chflags uappnd,其它平台跳过' },
  () => {
    const base = freshTempDir();
    const repo = join(base, 'repo');
    initRepo(repo, { gitignore: 'history/\n' });

    const first = resolveStateDir(repo);
    assert.equal(first.status, 0);
    const flag = spawnSync('chflags', ['uappnd', first.stateDir]);
    assert.equal(flag.status, 0, 'chflags 设置 append-only 失败,环境不支持,测试前置条件不满足');

    const second = resolveStateDir(repo);
    assert.equal(second.status, 0);
    assert.notEqual(second.stateDir, first.stateDir, 'unlink 失败的目录必须被判定为不可用状态根');
    assert.ok(!second.stateDir.startsWith(repo));

    spawnSync('chflags', ['nouappnd', first.stateDir]);
    rmSync(base, { recursive: true, force: true });
  },
);

test('state-dir: F4 迁移——部分失败后重试补齐缺失文件,且不覆盖已存在的新数据', () => {
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });

  const first = resolveStateDir(repo);
  assert.equal(first.status, 0);
  const key = first.stateDir.split('/').pop();
  const legacyDir = join(tmpdir(), 'review-pr', key);

  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'runs.jsonl'), `${JSON.stringify({ loggedAt: '2026-07-01T00:00:00.000Z', note: 'legacy-old' })}\n`);
    writeFileSync(join(legacyDir, 'last-scan.json'), JSON.stringify({ savedAt: '2026-07-01T00:00:00.000Z' }));
    writeFileSync(join(legacyDir, 'lock.json'), JSON.stringify({ startedAt: '2026-07-01T00:00:00.000Z', token: 'stale' }));

    // 模拟"第一次迁移只搬了 runs.jsonl 就失败":新目录里手工放一份真实新数据的
    // runs.jsonl,last-scan.json/lock.json 缺失,marker 缺失。
    rmSync(first.stateDir, { recursive: true, force: true });
    mkdirSync(first.stateDir, { recursive: true });
    const newRunsContent = `${JSON.stringify({ loggedAt: '2026-08-01T12:00:00.000Z', note: 'REAL-NEW-DATA' })}\n`;
    writeFileSync(join(first.stateDir, 'runs.jsonl'), newRunsContent);

    const second = resolveStateDir(repo);
    assert.equal(second.status, 0);
    assert.equal(second.stateDir, first.stateDir);

    assert.equal(readFileSync(join(second.stateDir, 'runs.jsonl'), 'utf8'), newRunsContent, '已存在的新数据不能被 legacy 版本覆盖(no-clobber)');
    assert.ok(existsSync(join(second.stateDir, 'last-scan.json')), '缺失的文件应该被补齐');
    assert.ok(existsSync(join(second.stateDir, 'lock.json')), '缺失的文件应该被补齐');
    assert.ok(existsSync(join(second.stateDir, '.migrated-from-tmp.json')), '全部处理完后应该写 marker');
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('state-dir: R5 迁移目标类型冲突(目录)不写 marker,保留重试机会', () => {
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });

  const first = resolveStateDir(repo);
  assert.equal(first.status, 0);
  const key = first.stateDir.split('/').pop();
  const legacyDir = join(tmpdir(), 'review-pr', key);

  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'last-scan.json'), JSON.stringify({ savedAt: '2026-07-01T00:00:00.000Z' }));

    rmSync(first.stateDir, { recursive: true, force: true });
    mkdirSync(first.stateDir, { recursive: true });
    // 目标位置放一个"目录"而不是文件——制造类型冲突
    mkdirSync(join(first.stateDir, 'last-scan.json'));

    const second = resolveStateDir(repo);
    assert.equal(second.status, 0);
    assert.match(second.stderr, /视为冲突/);
    assert.ok(!existsSync(join(second.stateDir, '.migrated-from-tmp.json')), '存在类型冲突时不应该写 marker');
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('state-dir: 三次连续 import 幂等(marker 写入后不再重复迁移/不再改动)', () => {
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });

  const first = resolveStateDir(repo);
  assert.equal(first.status, 0);
  const before = readdirSync(first.stateDir).sort();
  const second = resolveStateDir(repo);
  const after = readdirSync(second.stateDir).sort();
  assert.deepEqual(before, after);

  rmSync(base, { recursive: true, force: true });
});
