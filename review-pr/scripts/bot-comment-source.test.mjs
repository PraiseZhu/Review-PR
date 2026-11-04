// [MIVO-PATCH reviewer-app] 判断「是不是 bot 写的」只能读带作者类型的来源(REST user.type / GraphQL __typename)。
// `gh ... --json ...comments` 对 bot 只给裸 login(没有 [bot]、没有类型),拿它的 author.login 认 bot 会认不出。
// 静态守卫按「身份消费」判断:调用返回的评论数据只读 body(如 close-product-issue 的 marker)不算违规。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPrCommentsWithAuthorType, isBotComment } from './lib.mjs';
import { normalizeReviewActor } from './reviewer-identity.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_DIRS = ['review-pr/scripts', 'mivo/lib', 'mivo/prereview', 'mivo/server'];

const stripComments = (text) => text.split('\n').map((line) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, ''))).join('\n');

/** 找出「gh --json 字段里含 comments,且其后 150 行内取评论作者」的位置。 */
export function findBareCommentAuthorUses(source) {
  const code = stripComments(source);
  const found = [];
  const re = /['"]--json['"]\s*,\s*['"`]([^'"`]*)['"`]/g;
  for (const match of code.matchAll(re)) {
    if (!/(?:^|,)\s*comments\s*(?:,|$)/.test(match[1])) continue;
    const after = code.slice(match.index).split('\n').slice(0, 150).join('\n');
    if (/\bauthor\b/.test(after)) found.push({ fields: match[1], index: match.index });
  }
  return found;
}

function listFiles(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(join(ROOT, full)).isDirectory()) return name === 'vendor' || name === 'fixtures' ? [] : listFiles(full);
    return /\.mjs$/.test(name) && !/\.test\.mjs$/.test(name) ? [full] : [];
  });
}

test('生产代码里没有「gh --json comments 的返回 + 取作者判身份」的用法', () => {
  const offenders = [];
  for (const file of SCAN_DIRS.flatMap(listFiles)) {
    const uses = findBareCommentAuthorUses(readFileSync(join(ROOT, file), 'utf8'));
    if (uses.length) offenders.push(`${relative('.', file)}: --json ${uses.map((u) => u.fields).join(' | ')}`);
  }
  assert.deepEqual(offenders, []);
});

test('守卫负例:植入危险用法(含 pr view / issue view、字段顺序不同)必须被抓到;只读 body 的不算', () => {
  const danger = (fields, user) => `const m = ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', '${fields}']);\nfor (const c of m.comments) { if (c.author.login === ${user}) hit(); }`;
  assert.equal(findBareCommentAuthorUses(danger('number,comments', "'praisebuild'")).length, 1);
  assert.equal(findBareCommentAuthorUses(danger('comments,updatedAt', "viewer")).length, 1);
  assert.equal(findBareCommentAuthorUses("const i = ghJson(['issue', 'view', '5', '--json', 'state,comments,updatedAt,title,body']);\nfor (const c of i.comments ?? []) { const login = c.author?.login ?? ''; }").length, 1);
  const bodyOnly = "const m = ghJson(['pr', 'view', '1', '--json', 'number,state,comments']);\nconst urls = (m.comments ?? []).filter((c) => (c.body ?? '').includes(MARKER)).map((c) => c.body);";
  assert.equal(findBareCommentAuthorUses(bodyOnly).length, 0);
  // 注释里的不算
  assert.equal(findBareCommentAuthorUses("// ['--json', 'comments'] then author\nconst a = 1;").length, 0);
  // 不含 comments 字段的不算
  assert.equal(findBareCommentAuthorUses("ghJson(['pr', 'view', '--json', 'author,title']); const x = author;").length, 0);
});

test('close-product-issue 只读 body marker 的两处 --json comments 不算违规(真实文件)', () => {
  const source = readFileSync(join(ROOT, 'review-pr/scripts/close-product-issue.mjs'), 'utf8');
  assert.ok((source.match(/'--json', 'number,state,mergedAt,url,comments'/g) ?? []).length >= 2, '这两处调用应仍存在');
  assert.deepEqual(findBareCommentAuthorUses(source), []);
});

test('context.readDiscussionIssue 不再用 gh issue view --json comments,评论改读带类型的分页 REST', () => {
  const context = readFileSync(join(ROOT, 'review-pr/scripts/context.mjs'), 'utf8');
  assert.equal(/'state,comments,updatedAt,title,body'/.test(context), false);
  assert.match(context, /'--json', 'state,updatedAt,title,body'/);
  assert.match(context, /fetchPrCommentsWithAuthorType\(slug, issueNum\)/);
});

test('裸 login 的 bot 评论:带类型的 REST 来源把它识别成 bot,gh --json 形态(无类型)识别不出', () => {
  const page = [{ body: 'x', created_at: '2026-11-04T00:00:00Z', html_url: 'u', user: { login: 'github-actions', type: 'Bot' } },
    { body: 'y', created_at: '2026-11-04T00:00:01Z', html_url: 'u', user: { login: 'praisebuild[bot]', type: 'Bot' } },
    { body: 'z', created_at: '2026-11-04T00:00:02Z', html_url: 'u', user: { login: 'praisebuild', type: 'User' } }];
  const ghFn = () => ({ ok: true, stdout: JSON.stringify([page]), stderr: '' });
  const comments = fetchPrCommentsWithAuthorType('o/r', 5, { ghFn });
  assert.deepEqual(comments.map((c) => isBotComment(c)), [true, true, false]);
  assert.equal(normalizeReviewActor(comments[0].author).isBot, true);
  // gh issue view --json comments 的形态:只有裸 login,认不出
  assert.equal(isBotComment({ author: { login: 'github-actions' } }), false);
  assert.equal(normalizeReviewActor('github-actions').isBot, false);
  assert.equal(comments[0].createdAt, '2026-11-04T00:00:00Z');
});
