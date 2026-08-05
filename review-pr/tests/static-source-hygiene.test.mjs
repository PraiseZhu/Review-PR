// 文本卫生静态守卫(第 2 轮核验 R0 回归)。抓的是两类**真实发生过**的问题:
//   ① scripts/lib.review-consume.mjs 里写了两个真 NUL 字节当分隔符 → git 把整份文件判为
//      binary,正常 diff / review 能力直接消失(核验席实测)。分隔符必须写成源码转义。
//   ② vendored LICENSE.txt 是上游 CRLF,`git diff --check` 把 55 行全报 trailing whitespace。
//      修法是 .gitattributes 把 vendor/** 标成 -text -whitespace(保持 verbatim 字节),
//      而不是去改上游文件——所以这里正向断言那条规则在位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const tracked = () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.split('\u0000').filter(Boolean);
};

// vendor/ 是上游 verbatim 字节,按 .gitattributes 豁免;二进制资产也不参与文本检查
const isCheckedText = (p) => !p.startsWith('vendor/')
  && /\.(mjs|js|cjs|ts|tsx|json|md|ya?ml)$/i.test(p);

/** 剥掉块注释与行注释(`https://` 里的 `//` 不当行注释)。静态守卫必须扫**代码**,
 *  否则"删掉实现只留注释"就能骗过守卫(第 4 轮核验点名)。 */
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('R0 卫生:tracked 文本文件不得含真 NUL 字节(否则 git 判 binary,丢 diff/review 能力)', () => {
  const files = tracked();
  if (files === null) return; // 非 git 环境(打包分发)跳过
  const bad = [];
  for (const p of files.filter(isCheckedText)) {
    const buf = readFileSync(join(ROOT, p));
    if (buf.includes(0)) bad.push(p);
  }
  assert.deepEqual(bad, [], `含真 NUL 的文件(应改用 \\u0000 源码转义):${bad.join(', ')}`);
});

test('R0 卫生:tracked 文本文件不得有 CRLF 或行尾空白(git diff --check 会红)', () => {
  const files = tracked();
  if (files === null) return;
  const bad = [];
  for (const p of files.filter(isCheckedText)) {
    const text = readFileSync(join(ROOT, p), 'utf8');
    if (text.includes('\r')) bad.push(`${p}(CRLF)`);
    else if (/[ \t]+\n/.test(text)) bad.push(`${p}(行尾空白)`);
  }
  assert.deepEqual(bad, [], bad.join(', '));
});

test('R0 卫生:.gitattributes 把 vendor/** 标为 -text -whitespace(vendored 字节 verbatim + 不参与 whitespace 检查)', () => {
  const f = join(ROOT, '.gitattributes');
  assert.ok(existsSync(f), '缺 .gitattributes——vendored LICENSE 的上游 CRLF 会让 git diff --check 全红');
  const text = readFileSync(f, 'utf8');
  const line = text.split('\n').find((l) => l.trim().startsWith('vendor/'));
  assert.ok(line, '缺 vendor/ 规则行');
  assert.match(line, /-text/);
  assert.match(line, /-whitespace/);
});

test('R0 可移植性:任何**创建 git 提交**的测试文件都必须显式禁签名', () => {
  // 核验席环境里全局 commit.gpgsign=true,并发跑 temp-git 用例会撞 gpg「Cannot allocate
  // memory」而随机红(实跑 409/414)。本机 gpg 可用所以复现不到 —— 那正是必须用**静态守卫**
  // 而不是靠"我这儿是绿的"的原因:新加建仓 helper 时漏掉这条,只有别人的机器会红。
  // 只针对**建提交**的文件(init / remote add / ls-files 不签名,不在此列)。
  const dir = join(ROOT, 'tests');
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const createsCommits = /\bgit\(\s*\[\s*'commit'/.test(text)
      || /spawnSync\(\s*'git'[\s\S]{0,200}?'commit'/.test(text)
      || /'commit',\s*'-q'/.test(text);
    // 只认真正的**关闭形态**:`-c commit.gpgsign=false` 或 `git config commit.gpgsign false`。
    // 第 4 轮核验:上一版直接扫原始文本,于是注释里提一句 `commit.gpgsign=false` 就能骗过
    // 守卫——与本注释自己的声明矛盾。先剥掉注释再匹配。
    const code = stripComments(text);
    const hasSeam = code.includes('commit.gpgsign=false')
      || /'commit\.gpgsign',\s*'false'/.test(code);
    if (createsCommits && !hasSeam) bad.push(f);
  }
  assert.deepEqual(bad, [], `这些会建提交的测试文件没显式禁签名:${bad.join(', ')}`);
});

test('R0 隔离:在本进程内写持久状态的测试文件必须先 import 私有 STATE_DIR helper', () => {
  // 第 4 轮核验 R0:两份默认全量测试并发跑时,共享真实 STATE_DIR + 固定 PR 号会让彼此的
  // resetPr() 互删状态(实测 431/432)。helper 给每个测试进程一个私有目录,但它**必须**排在
  // lib.mjs / convergence-state.mjs 的静态导入之前(STATE_DIR 在模块加载期即定死)。
  const dir = join(ROOT, 'tests');
  const HELPER = './helpers.isolated-state-dir.mjs';
  const WRITERS = /\b(writeReviewReceipt|recordConvergenceRound|markNotified|recordNotificationAttempt)\b/;
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.mjs'))) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    // 只看**静态导入清单里真的带写函数**的文件(仅在注释/子进程 env 里提到不算)
    const stateImports = [...lines.join('\n').matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/scripts\/(?:lib|convergence-state)\.mjs'/g)];
    if (!stateImports.some((m) => WRITERS.test(m[1]))) continue;
    // 多行 import 的 `from` 行永远晚于语句起点,所以拿 `from` 行当锚点是安全的下界
    const libLine = lines.findIndex((l) => /from '\.\.\/scripts\/(?:lib|convergence-state)\.mjs'/.test(l));
    const helperLine = lines.findIndex((l) => l.includes(HELPER));
    if (helperLine < 0) bad.push(`${f}(未 import ${HELPER})`);
    else if (helperLine > libLine) bad.push(`${f}(helper 在第 ${helperLine + 1} 行,晚于 scripts 导入的第 ${libLine + 1} 行——env 改晚了没用)`);
  }
  assert.deepEqual(bad, [], bad.join('; '));
});
