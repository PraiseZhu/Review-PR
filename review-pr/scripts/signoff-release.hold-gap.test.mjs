import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./signoff-release.mjs', import.meta.url)), 'utf8');

// #71 的性质是「评论只读一次、hold 标记只解析一次」,不留读与写之间的二次读取空档。
// 评论来源从 gh pr view 换成带作者类型的 REST(gh pr view 对 bot 只给裸 login,认不出 praisebuild[bot] 写的标记),
// 性质不变:仍是一次读取、一次解析、只认审查身份集合;下面直接断言「恰好一次读取」而不是「来自哪条命令」。
test('#71 已堵 hold 标记重读空档:评论只读一次、只解析一次,且只认审查身份集合', () => {
  assert.equal([...src.matchAll(/parseLastHoldMarker\(commentObjs/g)].length, 1);
  assert.match(src, /parseLastHoldMarker\(commentObjs, \{ viewerLogin: reviewerIdentity \}\)/);
  assert.equal([...src.matchAll(/fetchPrCommentsWithAuthorType\(/g)].length, 1, '评论只能读一次');
  assert.match(src, /const commentObjs = fetchPrCommentsWithAuthorType\(slug, pr\)\.map\(/);
  assert.doesNotMatch(src, /meta\.comments/, '不能再从 pr view 读评论,也不能有第二份评论来源');
});
