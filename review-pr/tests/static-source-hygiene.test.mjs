// 文本卫生静态守卫(第 2 轮核验 R0 回归)。抓的是两类**真实发生过**的问题:
//   ① scripts/lib.review-consume.mjs 里写了两个真 NUL 字节当分隔符 → git 把整份文件判为
//      binary,正常 diff / review 能力直接消失(核验席实测)。分隔符必须写成源码转义。
//   ② vendored LICENSE.txt 是上游 CRLF,`git diff --check` 把 55 行全报 trailing whitespace。
//      修法是 .gitattributes 把 vendor/** 标成 -text -whitespace(保持 verbatim 字节),
//      而不是去改上游文件——所以这里正向断言那条规则在位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
