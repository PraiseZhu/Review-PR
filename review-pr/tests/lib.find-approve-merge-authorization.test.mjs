// findApproveMergeAuthorization 单测 —— 授权快速合并通道的授权检测(decision 1+2+6 +
// 2026-08-02 复审裁决 P1-6/P2-1/P2-2:admins 名单成员、非机器人、`/approve-merge` 精确
// 独占一行(不放宽到句中/行内追加说明,且剔除 fenced code block 与 blockquote)、须晚于
// 最后一次**真实 push**(latestPushDate,不是 latestCommitDate)、已编辑的评论一律拒绝、
// admins 缺失/为空/非法形态 fail-closed)。纯函数,零网络依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findApproveMergeAuthorization, hasApproveMergeCommand } from '../scripts/lib.mjs';

const ADMINS = ['PraiseZhu', 'kirozeng', 'aj0928'];

test('decision 6:admins 为空时 fail-closed,即使评论完全合规也不算授权', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'PraiseZhu', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body: '/approve-merge' }],
    admins: [],
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.adminsConfigured, false);
  assert.equal(r.authorized, null);
});

test('decision 1:非 admins 名单成员发 /approve-merge 不算授权', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'random-contributor', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body: '/approve-merge' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('decision 1:机器人发的评论不算授权,即使 login 命中 admins', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'PraiseZhu', isBot: true, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body: '/approve-merge' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('decision 2/P2-1:评论早于最后一次真实 push 视为 stale,不算有效授权', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T08:00:00Z', updatedAt: '2026-08-01T08:00:00Z', body: '/approve-merge' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].author, 'kirozeng');
});

test('decision 1+2:admins 成员在最后一次真实 push 之后发 /approve-merge 有效', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', url: 'https://x/comment/1', body: '/approve-merge' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized?.author, 'kirozeng');
  assert.equal(r.authorized?.url, 'https://x/comment/1');
});

// ── P1-6(2026-08-02 owner 裁决收紧,推翻此前"允许行内追加说明"的裁决)──

test('P1-6:命令必须独占一行,精确等于 /approve-merge(允许命令前后有其它行,但命令行本身不能有追加文字)', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body: '看过了,没问题\n/approve-merge\n谢谢' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized?.author, 'kirozeng', '命令单独占一行时,前后有说明文字的其它行不影响命中');
});

test('P1-6 推翻裁决:命令行带行内追加说明("/approve-merge 已确认可以合")不再算命令(此前允许,现改为拒绝)', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body: '/approve-merge 已确认 CI 绿,可以合' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null, '行内追加说明会把"讨论这条命令"误判成"下达这条命令",owner 2026-08-02 拍板收紧');
});

test('P1-6 负例 1/2(审核方给出的反例):代码块里展示命令用法不算下达命令', () => {
  const body = '用法说明:\n```\n/approve-merge\n```\n以上仅为示例,我还没决定是否发';
  assert.equal(hasApproveMergeCommand(body), false, 'fenced code block 内的内容是"展示",不是"下达"');
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('P1-6 负例 2/2(审核方给出的反例):blockquote 引用别人说过的命令不算下达命令', () => {
  const body = '> /approve-merge\n\n引用上面那条(不是我发的),我不同意直接合';
  assert.equal(hasApproveMergeCommand(body), false, 'blockquote 是"引用",不是"下达"');
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('讨论命令而非下达命令不应误判 —— 命令词出现在句中提及场景', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body: '我觉得可以发 /approve-merge 了,但让我再看一眼 diff' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('命令必须精确匹配,大小写敏感,句中子串不应误命中', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', body: '请不要 /approve-mergexyz 这个词误命中' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

// ── P2-2(2026-08-02):已编辑的授权评论一律拒绝 ──

test('P2-2:updatedAt !== createdAt(评论被编辑过)→ 拒绝,计入 edited,要求重发新评论', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:05:00Z', url: 'https://x/comment/2', body: '/approve-merge' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null, '已编辑的评论不能算有效授权,即使内容看起来完全合规');
  assert.equal(r.edited.length, 1);
  assert.equal(r.edited[0].author, 'kirozeng');
});

test('P2-2:updatedAt 缺失(调用方没查询该字段)时保守按未编辑处理,不误杀', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', url: 'https://x/comment/3', body: '/approve-merge' }],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized?.author, 'kirozeng');
  assert.equal(r.edited.length, 0);
});

// ── P2-1(三审修复):fence 状态机 —— 未闭合围栏 + 缩进代码块 + 围栏类型/长度匹配 ──

test('P2-1:未闭合到文末的 fenced code block(缺闭合标记)里的命令仍不算下达', () => {
  const body = '用法说明,还没写完:\n```\n/approve-merge\n这段代码示例还没写完,忘了写闭合标记';
  assert.equal(hasApproveMergeCommand(body), false, '此前的正则要求闭合标记才生效,未闭合到文末会漏判成真命令(fail-open)');
});

test('P2-1:4 空格缩进的 Markdown 代码块里的命令不算下达', () => {
  const body = '示例:\n\n    /approve-merge\n\n以上是缩进代码块展示,不是我真的在发这个命令';
  assert.equal(hasApproveMergeCommand(body), false);
});

test('P2-1:tab 缩进的 Markdown 代码块里的命令不算下达', () => {
  const body = '示例:\n\n\t/approve-merge\n\n同上,tab 缩进也算代码块';
  assert.equal(hasApproveMergeCommand(body), false);
});

test('P2-1 安全回归:反引号围栏内混入一行波浪号,不构成闭合(类型不匹配),围栏内命令仍不算下达', () => {
  // 若旧实现"任意围栏符号都能互相闭合",这行 ~~~ 会被误判成闭合标记,导致后面的
  // /approve-merge 提前"暴露"成围栏外的真命令——这是本次状态机重写要堵住的 fail-open。
  const body = '```\nsome code\n~~~\n/approve-merge\n```';
  assert.equal(hasApproveMergeCommand(body), false, '反引号围栏只能被反引号闭合,中途出现的 ~~~ 不构成闭合');
});

test('P2-1 安全回归:闭合标记长度不足开启标记长度,不构成闭合(与 CommonMark 一致)', () => {
  // 用 4 个反引号开启,中途出现一行 3 个反引号(长度不足)不应闭合围栏。
  const body = '````\nsome code\n```\n/approve-merge\n````';
  assert.equal(hasApproveMergeCommand(body), false, '闭合标记长度必须 >= 开启标记长度,3 个不能闭合 4 个开启的围栏');
});

test('P2-1 回归:正常闭合的 fenced code block 与之前行为一致,仍判不算下达', () => {
  const body = '```\n/approve-merge\n```';
  assert.equal(hasApproveMergeCommand(body), false);
});

test('P2-1 回归:真正独占一行下达的命令(无围栏无缩进)不受状态机重写影响,仍判定为命令', () => {
  assert.equal(hasApproveMergeCommand('/approve-merge'), true);
  assert.equal(hasApproveMergeCommand('看过了\n/approve-merge\n谢谢'), true);
});

// ── P2-1 四审顺手修:闭合标记后必须只跟空白(与 CommonMark 一致)──
// 三审的状态机只查了闭合标记的类型与长度,没查标记之后是否只跟空白,审核方实测反例:
// ```not-a-close 这种"反引号后紧跟非空白文字"的行会被误判成有效闭合,导致原本还在
// 围栏内部的命令提前"暴露"成候选命令行。

test('P2-1 四审:```not-a-close(反引号后紧跟非空白文字)不构成闭合,围栏内命令仍不暴露(审核方实测反例)', () => {
  // 围栏由第 1 行开启,第 3 行 ```not-a-close 因为标记后跟了非空白文字,不构成闭合,
  // 围栏应持续到第 5 行真正的闭合标记为止,/approve-merge(第 4 行)全程都在围栏内部。
  const body = '```\nsome code\n```not-a-close\n/approve-merge\n```';
  assert.equal(
    hasApproveMergeCommand(body),
    false,
    '```not-a-close 后紧跟非空白文字,不是有效闭合;若误判成闭合,第 4 行会被错误地暴露成候选命令',
  );
});

test('P2-1 四审回归:闭合标记后跟空格/tab(合法闭合)仍正常构成闭合', () => {
  const body = '```\n/approve-merge\n```  \n后面还有别的内容';
  assert.equal(hasApproveMergeCommand(body), false, '闭合标记后只跟空白字符,是合法闭合,围栏内命令仍不暴露');
});

test('多条有效授权取最新一条(createdAt 最大)', () => {
  const r = findApproveMergeAuthorization({
    comments: [
      { author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', url: 'u1', body: '/approve-merge' },
      { author: 'aj0928', isBot: false, createdAt: '2026-08-01T11:00:00Z', updatedAt: '2026-08-01T11:00:00Z', url: 'u2', body: '/approve-merge' },
    ],
    admins: ADMINS,
    latestPushDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized?.author, 'aj0928');
});
