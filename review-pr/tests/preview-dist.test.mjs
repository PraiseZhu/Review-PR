// preview-dist.test.mjs — preview 第二受限构建版本验收(供 submit-pr 三审第③席 push 前预审)
// 本文件同时充当 preview freshness 无条件门:任何一次 `node --test` 都会核验仓内
// preview-dist/ 与当前源一致。与 build-dist.test.mjs 同风格。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildDist, checkDist, productTreeHash } from '../scripts/build-dist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const MANIFEST = join(SRC, 'scripts', 'preview-dist.manifest.json');
const REPO_PREVIEW = resolve(SRC, '..', 'preview-dist');

// SC-3 A 类 5 个 + SC-4 B 类 8 个 = 13 个剥离脚本
const STRIPPED_SCRIPTS = [
  // A 类:合并/批准/修代码
  'merge-pr.mjs', 'self-approve.mjs', 'approve-workflows.mjs',
  'fix-session-state.mjs', 'fix-worktree-cleanup.mjs',
  // B 类:普通对外传播
  'notify-author-resolve.mjs', 'notify-merge-ack.mjs', 'notify-merge-backfill.mjs',
  'notify-summary.mjs', 'notify-sync-alert.mjs', 'remind-stale-author.mjs',
  'resolve-author-feishu.mjs', 'audit-merged-loop-prs.mjs',
];
// SC-2 保留脚本(存在 + 语法过)
const KEPT_SCRIPTS = ['evolution-note.mjs', 'product-hold.mjs', 'product-release.mjs', 'close-product-issue.mjs'];

const assertStrippedAbsent = (root) => {
  const found = STRIPPED_SCRIPTS.filter((f) => existsSync(join(root, 'scripts', f)));
  assert.deepEqual(found, [], `preview 产物不应含剥离脚本: ${found.join(', ')}`);
};

test('[preview 门] 仓内 preview-dist/ 必须与当前源 fresh(无条件跑,过期即红)', () => {
  const res = checkDist({ sourceDir: SRC, manifestPath: MANIFEST, distDir: REPO_PREVIEW });
  assert.equal(res.fresh, true, `preview-dist 过期,先跑:\nnode scripts/build-dist.mjs --manifest scripts/preview-dist.manifest.json --out ../preview-dist\n${res.problems.join('\n')}`);
});

test('[SC-1] 幂等:两次构建 product_tree_hash 与逐字节一致', () => {
  const o1 = mkdtempSync(join(tmpdir(), 'preview-a-'));
  const o2 = mkdtempSync(join(tmpdir(), 'preview-b-'));
  try {
    const m1 = buildDist({ sourceDir: SRC, manifestPath: MANIFEST, outDir: o1 });
    const m2 = buildDist({ sourceDir: SRC, manifestPath: MANIFEST, outDir: o2 });
    assert.equal(m1.product_tree_hash, m2.product_tree_hash);
    assert.equal(productTreeHash(o1), productTreeHash(o2));
  } finally { rmSync(o1, { recursive: true, force: true }); rmSync(o2, { recursive: true, force: true }); }
});

test('[SC-3/SC-4] 剥离断言:13 个危险脚本 absent', () => {
  assertStrippedAbsent(REPO_PREVIEW);
  assert.equal(existsSync(join(REPO_PREVIEW, 'scripts', 'build-dist.mjs')), false);
  assert.equal(existsSync(join(REPO_PREVIEW, 'tests')), false);
});

test('[SC-2] 保留断言:审查链/自进化/维护者分流脚本存在且 node --check 过', async () => {
  for (const f of KEPT_SCRIPTS) {
    const p = join(REPO_PREVIEW, 'scripts', f);
    assert.equal(existsSync(p), true, `preview 应保留 ${f}`);
    execFileSync(process.execPath, ['--check', p]);
  }
  // SC-2 ②:账本数据保留(不 neutralize)
  assert.equal(existsSync(join(REPO_PREVIEW, 'EVOLUTION.md')), true, 'EVOLUTION.md 应保留');
  assert.equal(existsSync(join(REPO_PREVIEW, 'evolution', 'ledger.json')), true, 'ledger.json 应保留');
  const rules = JSON.parse(readFileSync(join(REPO_PREVIEW, 'config', 'pr-rules.json'), 'utf8'));
  assert.ok(Array.isArray(rules.productWhitelist) && rules.productWhitelist.length > 0, 'pr-rules.json 不应被 neutralize');
  // SC-2 ③:product-hold 用的模板 D 在
  const skill = readFileSync(join(REPO_PREVIEW, 'SKILL.md'), 'utf8');
  assert.match(skill, /### 模板 D：产品\/架构门告知（人格关闭）/, '模板 D 应保留(product-hold 要用)');
});

test('[SC-3] SKILL 文本断言:5.1/5.2/5.4/5.5/5.6 动作指令不在,替代说明在', () => {
  const skill = readFileSync(join(REPO_PREVIEW, 'SKILL.md'), 'utf8');
  // 5.1/5.2/5.4/5.5/5.6 动作指令(标题+正文首行组合,替代说明标题带 preview 后缀故不误伤)不在
  for (const absent of [
    '### 5.1 通过：批准并合并\n\n只有同时满足以下条件才进入 3A',
    '### 5.2 不通过：请求修改\n\n存在任一 P0/P1',
    '### 5.4 自动跟进修复（fix-handoff）：自有 PR 卡住时开跟进会话修到能合并\n\n下方「投递消息模板」',
    '### 5.5 冲突代合并（主干侧解决，不推作者分支）\n\n当前账号没有向他人 PR 分支推送的权限',
    '### 5.6 代修合并（merge-then-fix，仅交互模式）\n\n帮别人合并时审查发现 P0/P1',
    'gh pr review <N> --approve',
    '--request-changes',
    'node "<SKILL_ROOT>/scripts/fix-session-state.mjs"',
    'node "<SKILL_ROOT>/scripts/fix-worktree-cleanup.mjs"',
  ]) {
    assert.equal(skill.includes(absent), false, `SKILL.md 不应含: ${absent}`);
  }
  // 替代说明在(5 节各一处)
  const notes = (skill.match(/preview 版：本节能力已剥离/g) || []).length;
  assert.equal(notes, 5, `应恰有 5 处节替代说明,实际 ${notes}`);
  // 模板 A/B/C/E/F 已剥离、模板 D 在(上一条已查)
  for (const tpl of ['### 模板 A：PR 打回评论', '### 模板 B：停滞催办私聊', '### 模板 C：催 resolve', '### 模板 E：合并致谢播报', '### 模板 F：给 owner 的每轮汇总']) {
    assert.equal(skill.includes(tpl), false, `SKILL.md 不应含: ${tpl}`);
  }
});

test('[SC-2] 第 8 章自进化保留 + [SC-5] 回推收口', async () => {
  const skill = readFileSync(join(REPO_PREVIEW, 'SKILL.md'), 'utf8');
  assert.match(skill, /## 8\. 自进化复盘（self-evolution）/, '第 8 章应保留');
  assert.match(skill, /8\.1 根因三分类/, '8.1 应保留');
  assert.match(skill, /preview 版不回推/, '8.3 第 6 步应为 preview 不回推版');
  assert.match(skill, /纯落盘不回推/, '8.2 自动回推应替换为纯落盘');
  // stub 生效
  const lib = await import(join(REPO_PREVIEW, 'scripts', 'lib.mjs'));
  assert.deepEqual(lib.skillRepoCommitPush({ message: 'should-not-write' }), { ok: true, committed: false, pushed: false, skipped: 'dist-readonly' });
  // evolution-note 写盘路径纯落盘:syncLedger 走 stub → skipped(经 CLI 冒烟,写临时台账目录)
  // 状态目录必须隔离(README 要求);SKILL_ROOT 由脚本自身位置推导,整树复制 scripts+台账到隔离目录
  const evoOut = mkdtempSync(join(tmpdir(), 'preview-evo-'));
  const stateDir = join(evoOut, 'state');
  try {
    cpSync(join(REPO_PREVIEW, 'evolution'), join(evoOut, 'evolution'), { recursive: true });
    cpSync(join(REPO_PREVIEW, 'EVOLUTION.md'), join(evoOut, 'EVOLUTION.md'));
    const before = readFileSync(join(evoOut, 'evolution', 'ledger.json'), 'utf8');
    cpSync(join(REPO_PREVIEW, 'scripts'), join(evoOut, 'scripts'), { recursive: true });
    const out = execFileSync(process.execPath, [join(evoOut, 'scripts', 'evolution-note.mjs'), 'add',
      '--fingerprint', 'preview-test-fp-01', '--tier', 'by-design', '--title', 'preview 冒烟'],
      { encoding: 'utf8', env: { ...process.env, REVIEW_PR_STATE_DIR: stateDir } });
    const r = JSON.parse(out);
    assert.equal(r.ok, true);
    assert.equal(r.sync.skipped, 'dist-readonly', 'preview 版 evolution-note 写盘后 sync 必须为 dist-readonly(纯落盘)');
    assert.equal(r.sync.committed, false);
    assert.equal(r.sync.pushed, false);
    // 台账确实本地写盘
    const after = JSON.parse(readFileSync(join(evoOut, 'evolution', 'ledger.json'), 'utf8'));
    assert.ok(after.entries.some((e) => e.fingerprint === 'preview-test-fp-01'), '台账应本地落盘');
    assert.notEqual(after, before);
  } finally { rmSync(evoOut, { recursive: true, force: true }); }
});

test('[SC-5] sync-skill-repo push 恒 skipped(复用 dist stub 模式)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'preview-state-'));
  try {
    const out = execFileSync(process.execPath, [join(REPO_PREVIEW, 'scripts', 'sync-skill-repo.mjs'), 'push', '--message', 'should-not-write'],
      { encoding: 'utf8', env: { ...process.env, REVIEW_PR_STATE_DIR: stateDir } });
    const r = JSON.parse(out);
    assert.equal(r.skipped, 'dist-readonly');
    assert.equal(r.pushed, false);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('[SC-6] preview 专属 README 注入', () => {
  const readme = readFileSync(join(REPO_PREVIEW, 'README.md'), 'utf8');
  assert.match(readme, /submit-pr 三审的第③席/, 'README 应写明用途');
  assert.match(readme, /REVIEW_PR_STATE_DIR/, 'README 应要求状态目录隔离');
  assert.match(readme, /一次性隔离目录/, 'README 应要求一次性隔离');
  assert.match(readme, /对外写白名单/, 'README 应列写白名单');
  assert.match(readme, /模板 D/, 'README 应提及模板 D 保留');
  assert.match(readme, /合并\/批准\/修代码/, 'README 应列 A 类剥离');
  assert.match(readme, /普通对外传播/, 'README 应列 B 类剥离');
});

test('[SC-7⑤ 反向变异] manifest 去掉任一 exclude 项 → 构建产物 absent 断言必须红', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const target = STRIPPED_SCRIPTS[0]; // scripts/merge-pr.mjs
  assert.ok(m.exclude.includes(`scripts/${target}`), '测试前提:manifest 应含该 exclude');
  const mutated = JSON.parse(JSON.stringify(m));
  mutated.exclude = mutated.exclude.filter((x) => x !== `scripts/${target}`);
  mutated.absent = mutated.absent.filter((x) => x !== `scripts/${target}`);
  const mutatedManifestPath = join(mkdtempSync(join(tmpdir(), 'preview-mut-')), 'manifest.json');
  const outDir = join(tmpdir(), `preview-mut-out-${process.pid}`);
  try {
    mkdirSync(join(mutatedManifestPath, '..'), { recursive: true });
    writeFileSync(mutatedManifestPath, JSON.stringify(mutated, null, 2));
    // 变异后构建成功(产物中会出现 merge-pr.mjs)
    buildDist({ sourceDir: SRC, manifestPath: mutatedManifestPath, outDir });
    // 正式 absent 断言对变异产物必须红(证明断言真实生效)
    const found = STRIPPED_SCRIPTS.filter((f) => existsSync(join(outDir, 'scripts', f)));
    assert.ok(found.includes(target), `反向变异失败:exclude 去掉 ${target} 后产物应出现该文件(absent 断言会红)`);
  } finally {
    rmSync(mutatedManifestPath, { force: true });
    rmSync(join(mutatedManifestPath, '..'), { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// [D-2026-08-10] manifest 自身正确性门:exclude 每个条目在源树中必须存在(防失效路径)。
// 与 build-dist.test.mjs 同理由:exclude 引用失效路径时 checkDist 校验不到(fail-silent)。
test('[D-2026-08-10] preview manifest exclude 每条目在源树中必须存在', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const missing = (m.exclude ?? []).filter((e) => !existsSync(join(SRC, e)));
  assert.equal(
    missing.length, 0,
    `preview manifest exclude 引用不存在的路径:\n${missing.join('\n')}`,
  );
});

// [D-2026-08-10] sc-preview-rebuild:evolution-note 台账写入成功后联动重建 preview-dist
// 背景:preview 产物含台账副本(freshnessIgnore 为空),台账一变产物即真过期(长期假性红)。
// 台账唯一写入口写盘成功后必须联动重建,preview 门才保持绿。
// 隔离树自包含:tmp 里拷主仓(排除 .git/history),跑 evolution-note add --no-sync,
// 断言 ①联动产物生成 ②与含新台账的源 fresh ③幂等(台账未变重复重建逐字节一致)
// ④重建失败不回滚台账写入、以显式 warning 报出。变异(去掉联动)时本测试必须红。
test('[sc-preview-rebuild] evolution-note 写盘后联动重建 preview-dist(门保持绿)', () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-rebuild-'));
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    const srcCopy = join(root, 'review-pr');
    cpSync(SRC, srcCopy, {
      recursive: true,
      filter: (p) => !p.split(sep).includes('.git') && basename(p) !== 'history',
    });
    // ① 台账写入 → 联动重建
    const out = execFileSync(process.execPath,
      [join(srcCopy, 'scripts', 'evolution-note.mjs'), 'add',
        '--fingerprint', 'preview-rebuild-fp-01', '--tier', 'by-design',
        '--title', '联动重建冒烟', '--no-sync'],
      { encoding: 'utf8', env: { ...process.env, REVIEW_PR_STATE_DIR: join(root, 'state') } });
    const r = JSON.parse(out);
    assert.equal(r.ok, true);
    assert.equal(r.rebuild.ok, true, `联动重建应成功: ${JSON.stringify(r.rebuild)}`);
    const ledger = JSON.parse(readFileSync(join(srcCopy, 'evolution', 'ledger.json'), 'utf8'));
    assert.ok(ledger.entries.some((e) => e.fingerprint === 'preview-rebuild-fp-01'), '台账应本地落盘');
    // ② 联动产物与含新台账的源 fresh(preview 门保持绿的核心)
    const distDir = join(root, 'preview-dist');
    assert.equal(existsSync(join(distDir, 'dist_manifest.json')), true, '联动产物应生成');
    const res = checkDist({ sourceDir: srcCopy, manifestPath: join(srcCopy, 'scripts', 'preview-dist.manifest.json'), distDir });
    assert.equal(res.fresh, true, `联动产物应 fresh: ${res.problems.join('\n')}`);
    // ③ 幂等:台账未变时重复重建 → 产物逐字节一致
    const hash1 = productTreeHash(distDir);
    execFileSync(process.execPath,
      [join(srcCopy, 'scripts', 'build-dist.mjs'), '--manifest', join(srcCopy, 'scripts', 'preview-dist.manifest.json'), '--out', distDir],
      { encoding: 'utf8' });
    assert.equal(productTreeHash(distDir), hash1, '台账未变时重复重建应逐字节一致');
    // ④ 重建失败不回滚台账写入、显式 warning 报出:弄坏 manifest 后写第二条
    writeFileSync(join(srcCopy, 'scripts', 'preview-dist.manifest.json'), '{ broken json');
    const out2 = execFileSync(process.execPath,
      [join(srcCopy, 'scripts', 'evolution-note.mjs'), 'add',
        '--fingerprint', 'preview-rebuild-fp-02', '--tier', 'by-design',
        '--title', '失败不回滚冒烟', '--no-sync'],
      { encoding: 'utf8', env: { ...process.env, REVIEW_PR_STATE_DIR: join(root, 'state') } });
    const r2 = JSON.parse(out2);
    assert.equal(r2.ok, true, '台账写入应仍成功(重建失败不回滚)');
    assert.equal(r2.rebuild.ok, false, '重建失败应显式报出');
    assert.ok(r2.rebuild.error, `重建失败应有 error 信息: ${JSON.stringify(r2.rebuild)}`);
    const ledger2 = JSON.parse(readFileSync(join(srcCopy, 'evolution', 'ledger.json'), 'utf8'));
    assert.ok(ledger2.entries.some((e) => e.fingerprint === 'preview-rebuild-fp-02'), '重建失败后台账条目应仍在');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// [D-2026-08-10] sc-preview-rebuild:机器级自重建防护(不依赖 manifest exclude 配置巧合)
// 背景:preview 副本跳过重建的保障是「exclude 里没有 build-dist.mjs」——纯配置依赖。
// 一旦 exclude 漏掉构建器(实测:整树被清空、刚写的台账一并丢失、重建 ENOENT),
// 副本自身的 evolution-note 会重建到 outDir === 自身根目录,先把运行中的树 rm 掉。
// 防护:outDir 与 SKILL_ROOT 位置重合时一律 skipped:'self-rebuild'。
// 变异(去掉该守卫)时本测试必须红。
test('[sc-preview-rebuild] 副本位于 preview-dist 时联动重建自我跳过(树不被清空)', () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-selfrebuild-'));
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    const copy = join(root, 'preview-dist'); // 副本目录名 = 产物目录名(exclude 失效场景)
    cpSync(SRC, copy, {
      recursive: true,
      filter: (p) => !p.split(sep).includes('.git') && basename(p) !== 'history',
    });
    const out = execFileSync(process.execPath,
      [join(copy, 'scripts', 'evolution-note.mjs'), 'add',
        '--fingerprint', 'preview-selfrebuild-fp', '--tier', 'by-design',
        '--title', '自重建防护冒烟', '--no-sync'],
      { encoding: 'utf8', env: { ...process.env, REVIEW_PR_STATE_DIR: join(root, 'state') } });
    const r = JSON.parse(out);
    assert.equal(r.ok, true);
    assert.equal(r.rebuild.skipped, 'self-rebuild', `应跳过自重建: ${JSON.stringify(r.rebuild)}`);
    assert.equal(existsSync(join(copy, 'scripts', 'build-dist.mjs')), true, '副本树必须保持完整(未被重建 rm 掉)');
    assert.equal(existsSync(join(copy, 'SKILL.md')), true, 'SKILL.md 必须仍在(整树未被清空)');
    const ledger = JSON.parse(readFileSync(join(copy, 'evolution', 'ledger.json'), 'utf8'));
    assert.ok(ledger.entries.some((e) => e.fingerprint === 'preview-selfrebuild-fp'), '台账条目应保留在副本内');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
