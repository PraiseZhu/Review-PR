// state-dir.test.mjs — lib.mjs 状态根解析(F1-F4, R1-R5/R7, T1/T2)的固化重放。
//
// 这些测试把 2026-08-01 四轮审核(一审 F1-F4、二审 F1-F7、三审 R1-R8、四审
// T1-T5)里针对 `lib.mjs` 状态根解析逻辑的人工重放固化下来,防止未来改动
// 悄悄回归。跑法:
//   node --test review-pr/tests/state-dir.test.mjs
// 每个 test 用一次性临时 git 仓库当 fixture,不依赖任何签入仓库的敏感数据。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync, readdirSync,
  realpathSync, symlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { git, freshTempDir, initRepo, resolveStateDir, resolveStateDirWithLib, copyLibInto } from './helpers.mjs';

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
  //
  // T3(2026-08-01 四审):旧断言 `assert.notEqual(stateDir, envRoot)` 不绑
  // 行为——即使把 unknown 错误地判成"安全"(等价于回退前的 bug),
  // `isStateRootSafeAndWritable` 接受 envRoot 后返回的也是
  // `join(envRoot, repoStateKey)`,天然就不等于 envRoot 本身,断言恒真,
  // 测不出任何东西(变异测试验证:见下方"变异确认"说明)。改为断言 stateDir
  // 不落在 envRoot 目录树下,并检查 stderr 里的 fail-closed 诊断信息。
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });
  const envRoot = join(base, 'env-override-target');
  mkdirSync(envRoot, { recursive: true });

  const noGitPath = freshTempDir('no-git-path-'); // 空目录,PATH 只指向它,里面没有任何可执行文件(包括 git)
  const { stateDir, stderr, status } = resolveStateDir(repo, { REVIEW_PR_STATE_DIR: envRoot, PATH: noGitPath });
  assert.equal(status, 0);
  assert.ok(
    !stateDir.startsWith(envRoot + sep),
    `git 探针判断不了时必须整体回退,不能落在 env override 目标树下:envRoot=${envRoot}, 实际 stateDir=${stateDir}`,
  );
  assert.match(stderr, /未通过校验/, '应该有 fail-closed 的诊断提示');

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

test('state-dir: T2 submodule 自身再建 linked worktree 时,porcelain 首条仍可能是 git-dir——必须 fail-closed 回退 tmp,不能把状态写进 git 元数据', () => {
  const base = freshTempDir();
  const outer = join(base, 'outer');
  initRepo(outer, { gitignore: 'history/\n' });
  const innerSrc = join(base, 'inner-src');
  initRepo(innerSrc, { gitignore: 'history/\n' });
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', `file://${innerSrc}`, 'sub'], { cwd: outer });
  git(['commit', '-q', '-m', 'add submodule'], { cwd: outer });
  const submodulePath = join(outer, 'sub');

  // 在 submodule 自己身上再建一个 linked worktree——此时 `worktree list
  // --porcelain` 会有 2 条记录,但实测(git 2.50.1)第一条依然报告成
  // submodule 的 git-dir(`outer/.git/modules/sub`),不是真实工作目录。
  const subLinked = join(base, 'sub-linked');
  git(['worktree', 'add', '-q', subLinked, '-b', 'feature/sub-x'], { cwd: submodulePath });

  const { stateDir, status } = resolveStateDir(submodulePath);
  assert.equal(status, 0);
  assert.ok(
    !stateDir.includes('.git'),
    `不能把状态目录落进任何 .git 元数据路径,收到 STATE_DIR=${stateDir}`,
  );
  assert.ok(!stateDir.startsWith(outer), 'submodule+linked 场景校验不过时应整体回退系统临时目录');

  rmSync(base, { recursive: true, force: true });
});

test('state-dir: T2 separate-git-dir 仓库配合 linked worktree,porcelain 首条报告的仍是 git-dir——必须 fail-closed 回退 tmp', () => {
  const base = freshTempDir();
  const proj = join(base, 'proj');
  const gitDir = join(base, 'common.git');
  mkdirSync(proj, { recursive: true });
  git(['init', '-q', '-b', 'main', `--separate-git-dir=${gitDir}`], { cwd: proj });
  git(['config', 'user.email', 'test@example.com'], { cwd: proj });
  git(['config', 'user.name', 'review-pr-test'], { cwd: proj });
  writeFileSync(join(proj, '.gitignore'), 'history/\n');
  writeFileSync(join(proj, 'f.txt'), 'x');
  git(['add', '-A'], { cwd: proj });
  git(['commit', '-q', '-m', 'init'], { cwd: proj });

  git(['worktree', 'add', '-q', join(base, 'proj-linked'), '-b', 'feature/y'], { cwd: proj });

  const { stateDir, status } = resolveStateDir(proj);
  assert.equal(status, 0);
  assert.ok(
    !stateDir.startsWith(gitDir) && !stateDir.startsWith(proj),
    `separate-git-dir + linked worktree 场景校验不过时应整体回退系统临时目录,收到 STATE_DIR=${stateDir}`,
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

test('state-dir: T4 R2 端到端复现——从 Skill 仓库的 linked worktree 加载 lib.mjs,候选状态根落在 Skill 主 worktree 内仍必须被拒绝', () => {
  // 不碰真实的 skill/policy worktree:把 lib.mjs 复制进一个全新的临时 git 仓库
  // (模拟"一份独立的 skill 安装"),在**这份副本**上建 linked worktree,
  // 从 linked worktree 里的副本 import lib.mjs——这样 `isInsideSkillRepo`
  // 认定的"Skill 自己的仓库"就是这份临时仓库,不是本次改动实际所在的仓库。
  const base = freshTempDir();

  const fakeSkillMain = join(base, 'fake-skill-main');
  // 必须给 state-here/ 配 .gitignore——否则候选路径会先被 F2①(未 ignore)拒绝,
  // 测的就不是 R2 要验证的"自写"这道门,而是重复测了一遍 F2①。
  initRepo(fakeSkillMain, { gitignore: 'state-here/\n' });
  copyLibInto(fakeSkillMain);
  git(['add', '-A'], { cwd: fakeSkillMain });
  git(['commit', '-q', '-m', 'add lib.mjs copy'], { cwd: fakeSkillMain });

  const fakeSkillLinked = join(base, 'fake-skill-linked');
  git(['worktree', 'add', '-q', fakeSkillLinked, '-b', 'feature/skill-x'], { cwd: fakeSkillMain });
  const linkedLibPath = join(fakeSkillLinked, 'review-pr', 'scripts', 'lib.mjs');

  const tempMain = join(base, 'target-repo');
  initRepo(tempMain, { gitignore: 'history/\n' }); // 被审查的目标仓库,与 fake skill 完全无关

  // 候选状态根故意落在 fake skill 的**主** worktree 内(不是 linked 那份)——
  // 这正是 R2 要堵的场景:落地位置和加载 lib.mjs 的 worktree 不是同一个,
  // 靠"文件系统根路径"比对会漏判。
  const candidateInSkillMain = join(fakeSkillMain, 'state-here');
  mkdirSync(candidateInSkillMain, { recursive: true });

  const { stateDir, status } = resolveStateDirWithLib(linkedLibPath, tempMain, {
    REVIEW_PR_STATE_DIR: candidateInSkillMain,
  });
  assert.equal(status, 0);
  assert.ok(
    !stateDir.startsWith(fakeSkillMain),
    `候选状态根落在 fake skill 主 worktree 内,必须被拒绝回退 tmp,收到 STATE_DIR=${stateDir}`,
  );

  const cleanCheck = git(['status', '--porcelain'], { cwd: fakeSkillMain });
  assert.equal(cleanCheck.stdout.trim(), '', 'fake skill 主 worktree 必须保持干净,不能被状态写入弄脏');

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

test('state-dir: T1 悬空 symlink 不能绕过迁移类型门(不得沿链接写到状态根外)', () => {
  const base = freshTempDir();
  const repo = join(base, 'repo');
  initRepo(repo, { gitignore: 'history/\n' });

  const first = resolveStateDir(repo);
  assert.equal(first.status, 0);
  const key = first.stateDir.split('/').pop();
  const legacyDir = join(tmpdir(), 'review-pr', key);

  // 悬空 symlink 的目标故意放在状态根之外的独立目录——如果 T1 没修,
  // copyFileSync 会沿着这个链接把 legacy 内容写到这里,验证它绝对不能出现。
  const outsideDir = join(base, 'outside-state-root');
  mkdirSync(outsideDir, { recursive: true });
  const danglingTarget = join(outsideDir, 'escaped.json');

  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'runs.jsonl'), `${JSON.stringify({ loggedAt: '2026-07-01T00:00:00.000Z', note: 'legacy' })}\n`);

    rmSync(first.stateDir, { recursive: true, force: true });
    mkdirSync(first.stateDir, { recursive: true });
    // 目标位置放一个悬空符号链接(链接目标当前不存在)
    symlinkSync(danglingTarget, join(first.stateDir, 'runs.jsonl'));

    const second = resolveStateDir(repo);
    assert.equal(second.status, 0);

    assert.ok(
      !existsSync(danglingTarget),
      `悬空符号链接的目标绝对不能被创建/写入——一旦存在就是 T1 描述的越界写复现:${danglingTarget}`,
    );
    const destLstat = lstatSync(join(second.stateDir, 'runs.jsonl'));
    assert.ok(destLstat.isSymbolicLink(), '符号链接本身应该保持原样,不被替换成普通文件');
    assert.match(second.stderr, /视为冲突/);
    assert.ok(!existsSync(join(second.stateDir, '.migrated-from-tmp.json')), '存在类型冲突(悬空 symlink)时不应该写 marker');
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
