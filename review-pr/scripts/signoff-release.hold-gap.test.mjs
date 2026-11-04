import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./signoff-release.mjs', import.meta.url)), 'utf8');
// 取源码里所有 `'--json', '<字段列表>'` 的字段列表(gh pr view / issue view 的 --json 参数)。
const prViewJsonFields = (source) => [...source.matchAll(/'--json',\s*'([^']+)'/g)].map((m) => m[1]);

// #71 的性质是「评论只读一次、hold 标记只解析一次」,不留读与写之间的二次读取空档。
// 评论来源从 gh pr view 换成带作者类型的 REST(gh pr view 对 bot 只给裸 login,认不出 praisebuild[bot] 写的标记),
// 性质不变:仍是一次读取、一次解析、只认审查身份集合;下面直接断言「恰好一次读取」而不是「来自哪条命令」。
test('#71 已堵 hold 标记重读空档:评论只读一次、只解析一次,且只认审查身份集合', () => {
  assert.equal([...src.matchAll(/parseLastHoldMarker\(commentObjs/g)].length, 1);
  assert.match(src, /parseLastHoldMarker\(commentObjs, \{ viewerLogin: reviewerIdentity \}\)/);
  assert.equal([...src.matchAll(/fetchPrCommentsWithAuthorType\(/g)].length, 1, '评论只能读一次');
  assert.match(src, /const commentObjs = fetchPrCommentsWithAuthorType\(slug, pr\)\.map\(/);
  assert.doesNotMatch(src, /meta\.comments/, '不能再从 pr view 读评论,也不能有第二份评论来源');
  assert.deepEqual(prViewJsonFields(src).filter((fields) => fields.split(',').includes('comments')), [],
    'gh pr view --json 的字段里不能再要 comments,否则评论实际被读两次');
});

// signoff-hold 同理:评论只来自一次 REST 读取。
test('#71 signoff-hold:gh pr view 不再要 comments,评论只读一次', () => {
  const hold = readFileSync(fileURLToPath(new URL('./signoff-hold.mjs', import.meta.url)), 'utf8');
  assert.equal([...hold.matchAll(/fetchPrCommentsWithAuthorType\(/g)].length, 1, '评论只能读一次');
  assert.doesNotMatch(hold, /meta\.comments/);
  assert.deepEqual(prViewJsonFields(hold).filter((fields) => fields.split(',').includes('comments')), []);
});
