#!/usr/bin/env node
// status-labels.test.mjs — 展示标签(status:* / touches:*)判定与同步的回归。
//
// 为什么要这个测试:这组标签是给人看的「现在卡在谁身上」。挂错的代价不是流程出错
// (它不参与任何判定),而是维护者按标签筛出来的列表说谎 —— 比没有标签更糟。
// 所以三件事必须钉住:
//   ① status 组永远最多一个,且优先级固定(先「要作者动」再「机器在忙」);
//   ② 维护者确认门在拦时 status 组一个都不挂(那条状态由 awaiting-discussion 表达,
//      两个标签同时说「在等人」会让列表出现重复状态);
//   ③ syncDisplayLabels 只碰受管标签 —— 人工手挂的、维护者确认标签一律不动。
// 跑:node scripts/status-labels.test.mjs   退出码 0 = 全过。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDisplayLabels, syncDisplayLabels, loadDisplayLabelConfig, ensureDisplayLabelsExist,
  DISPLAY_LABELS, SIGNOFF_LABEL_COLOR,
} from './lib.mjs';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

// ── ① status 组:互斥 + 优先级 ──
const STATUS_CASES = [
  ['门在拦时不挂状态', { signoffLabelDesired: true, blockClass: 'ci-failed', formatPass: false }, null],
  ['跟进会话在修', { fixSessionActive: true, blockClass: 'conflict' }, 'status:auto-fixing'],
  ['跟进会话在修但卡点不在作者侧 → 不算 auto-fixing', { fixSessionActive: true, blockClass: 'ci-pending' }, 'status:ci-running'],
  ['跟进会话已交回给人 → 要人工', { fixSessionActive: true, blockClass: 'conflict', fixNeedsHuman: true }, 'status:needs-human'],
  ['跟进会话已超看门狗窗口 → 不再挂 auto-fixing', { fixSessionActive: true, blockClass: 'conflict', fixWatchdogExpired: true }, 'status:conflict'],
  ['凭证硬命中 → 等作者', { securityHardHit: true, blockClass: 'ci-pending' }, 'status:awaiting-author'],
  ['格式不合规 → 等作者', { formatPass: false }, 'status:awaiting-author'],
  ['打回后作者未动 → 等作者', { hasStalePushback: true }, 'status:awaiting-author'],
  ['自己的旧 CR(self-resolvable)不算等作者', { hasStalePushback: true, blockClass: 'self-resolvable' }, null],
  ['reviewer 要求修改 → 等作者', { blockClass: 'review-changes-requested' }, 'status:awaiting-author'],
  ['冲突', { blockClass: 'conflict' }, 'status:conflict'],
  ['CI 失败', { blockClass: 'ci-failed' }, 'status:ci-failed'],
  ['未 resolve 讨论', { blockClass: 'threads-unresolved' }, 'status:threads-open'],
  ['等 retarget', { needsRetarget: true }, 'status:blocked-by-pr'],
  ['等被依赖的 PR', { basePrOpen: true }, 'status:blocked-by-pr'],
  ['结构门无 bypass → 要人工', { autoAction: 'skip-structural-block' }, 'status:needs-human'],
  ['改了 CI 配置要人工批', { autoAction: 'skip-workflow-ci-change' }, 'status:needs-human'],
  ['机器人静默期未过', { botSettled: false }, 'status:awaiting-bot-review'],
  ['CI 还在跑', { blockClass: 'ci-pending' }, 'status:ci-running'],
  ['fork workflow 待批(本轮自动放行)', { blockClass: 'workflow-awaiting', autoAction: 'approve-workflows' }, 'status:ci-running'],
  ['门全过 → 不挂', {}, null],
];
for (const [name, input, want] of STATUS_CASES) {
  const r = computeDisplayLabels(input);
  eq(`status/${name}`, r.status, want);
  check(`status/${name} 只挂一个`, r.desired.filter((n) => n.startsWith('status:')).length <= 1, JSON.stringify(r.desired));
}

// 优先级不能被 touches 或别的信号翻转:作者侧卡点压过机器侧
eq(
  'status/优先级:等作者压过等机器人',
  computeDisplayLabels({ formatPass: false, botSettled: false, blockClass: 'ci-pending' }).status,
  'status:awaiting-author',
);
eq(
  'status/优先级:冲突压过 CI 在跑',
  computeDisplayLabels({ blockClass: 'conflict', botSettled: false }).status,
  'status:conflict',
);

// ── ② touches 组:diff 事实,与门是否在拦无关 ──
const touchAll = computeDisplayLabels({
  signoffLabelDesired: true, // 门在拦也照样挂 touches
  triggerKinds: ['security', 'pluginBase', 'coldUpdate', 'rules', 'product', 'arch'],
  newDependency: true, redline: true, docOnly: true,
  totalDiffLines: 1200, largeDiffLines: 800,
});
eq('touches/全命中', touchAll.touches, [
  'touches:security', 'touches:plugin-base', 'touches:cold-update', 'touches:redline',
  'touches:core', 'touches:product-ui', 'touches:rules', 'touches:new-dependency',
  'touches:docs-only', 'touches:large-diff',
]);
eq('touches/门在拦时 desired 只有 touches', touchAll.desired, touchAll.touches);
eq('touches/无信号时为空', computeDisplayLabels({}).touches, []);
eq(
  'touches/large-diff 卡在阈值上(>= 才挂)',
  [computeDisplayLabels({ totalDiffLines: 799, largeDiffLines: 800 }).touches,
    computeDisplayLabels({ totalDiffLines: 800, largeDiffLines: 800 }).touches],
  [[], ['touches:large-diff']],
);
// 配置关掉某个标签 → 不再要求它(managed 是唯一开关入口)
const narrowed = Object.keys(DISPLAY_LABELS).filter((n) => n !== 'touches:security' && n !== 'status:conflict');
const off = computeDisplayLabels({ triggerKinds: ['security'], blockClass: 'conflict', managed: narrowed });
eq('config/关掉的 touches 不出现', off.touches, []);
eq('config/关掉的 status 不出现', off.status, null);

// ── ③ syncDisplayLabels:只碰受管标签 ──
const MANAGED = Object.keys(DISPLAY_LABELS);
const calls = [];
const fakeGh = (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '', status: 0 }; };

calls.length = 0;
const r1 = syncDisplayLabels({
  owner: 'o', repo: 'r', pr: 1, ghFn: fakeGh, managed: MANAGED,
  current: ['awaiting-discussion', 'bug', 'status:ci-running'],
  desired: ['status:awaiting-author', 'touches:core'],
});
eq('sync/加了该加的', r1.added, ['status:awaiting-author', 'touches:core']);
eq('sync/摘了该摘的', r1.removed, ['status:ci-running']);
check('sync/不碰维护者确认标签与人工标签',
  !JSON.stringify(calls).includes('awaiting-discussion') && !JSON.stringify(calls).includes('"bug"'),
  JSON.stringify(calls));
check('sync/加标只发一次 POST', calls.filter((a) => a.includes('POST')).length === 1, JSON.stringify(calls));

const r2 = syncDisplayLabels({
  owner: 'o', repo: 'r', pr: 1, ghFn: fakeGh, managed: MANAGED,
  current: ['status:conflict', 'touches:core'],
  desired: ['status:conflict', 'touches:core'],
});
eq('sync/状态一致时零请求', [r2.changed, r2.added, r2.removed], [false, [], []]);

const r3 = syncDisplayLabels({
  owner: 'o', repo: 'r', pr: 1, ghFn: fakeGh, managed: MANAGED,
  current: ['status:conflict'], desired: ['status:not-in-registry'],
});
eq('sync/不认注册表外的名字', [r3.added, r3.removed], [[], ['status:conflict']]);

// 失败要带原文第一行,且不抛
const failGh = () => ({ ok: false, stdout: '', stderr: 'HTTP 403: Resource not accessible by personal access token\n第二行', status: 1 });
const r4 = syncDisplayLabels({
  owner: 'o', repo: 'r', pr: 1, ghFn: failGh, managed: MANAGED,
  current: [], desired: ['status:conflict'],
});
check('sync/失败不抛且带原文第一行',
  r4.errors.length === 1 && r4.errors[0].includes('HTTP 403') && !r4.errors[0].includes('第二行') && String(r4.warning).includes('展示标签'),
  JSON.stringify(r4));

// ── ④ 配置加载:颜色可覆盖、可单独关掉 ──
const cfg = loadDisplayLabelConfig({
  statusLabels: { largeDiffLines: 300, labels: { 'status:conflict': { color: '#ABCDEF' }, 'touches:docs-only': { enabled: false } } },
});
eq('config/阈值覆盖', cfg.largeDiffLines, 300);
eq('config/颜色覆盖去掉井号', cfg.registry['status:conflict'].color, 'ABCDEF');
check('config/关掉的标签不进 managed', !cfg.managed.includes('touches:docs-only'), JSON.stringify(cfg.disabled));
eq('config/缺省开启', loadDisplayLabelConfig({}).enabled, true);
eq('config/可整组关闭', loadDisplayLabelConfig({ statusLabels: { enabled: false } }).enabled, false);

// ── ⑤ ensureDisplayLabelsExist:缺了要建,颜色 / 描述漂了要纠 ──
// 为什么要钉住纠色:`gh label create` 撞名即失败、不会改色,所以「改了 DISPLAY_LABELS 的
// hex」对已建好的标签是零效果的。这条断言就是防止有人把 edit 分支删掉,导致以后改配色
// 线上不动,又被误当成凭证问题去查。
const REG = {
  'status:conflict': { group: 'status', color: 'BF8700', description: '冲突' },
  'touches:core': { group: 'touches', color: '6E7781', description: '核心' },
  'touches:redline': { group: 'touches', color: '0E7490', description: '红线' },
};
function fakeEnsureGh(listRows) {
  const seen = [];
  const fn = (args) => {
    seen.push(args.join(' '));
    if (args[0] === 'label' && args[1] === 'list') return { ok: true, stdout: JSON.stringify(listRows), stderr: '', status: 0 };
    return { ok: true, stdout: '', stderr: '', status: 0 };
  };
  return { fn, seen };
}
// 缓存落到临时文件:单测不许写真实状态目录(会让下一次真跑白多花一次 label list)
const ENSURE_CACHE = join(mkdtempSync(join(tmpdir(), 'review-pr-test-')), 'ensured.json');
const g1 = fakeEnsureGh([
  { name: 'status:conflict', color: 'D93F0B', description: '冲突' },        // 颜色漂了 → 要 edit
  { name: 'touches:core', color: '6E7781', description: '核心' },           // 完全一致 → 不动
  { name: 'bug', color: 'FF0000', description: '人工标签' },                 // 不受管 → 不动
]);
const e1 = ensureDisplayLabelsExist({ owner: 'o', repo: 'r', registry: REG, ghFn: g1.fn, force: true, cacheFile: ENSURE_CACHE });
eq('ensure/漂了的颜色被纠', e1.recolored, ['status:conflict']);
eq('ensure/缺的被建出来', e1.created, ['touches:redline']);
check('ensure/一致的不发请求',
  !g1.seen.some((c) => c.startsWith('label edit touches:core')), g1.seen.join(' | '));
check('ensure/不碰人工标签', !g1.seen.some((c) => c.includes('bug')), g1.seen.join(' | '));
check('ensure/纠色带上新颜色',
  g1.seen.some((c) => c === 'label edit status:conflict --repo o/r --color BF8700 --description 冲突'),
  g1.seen.join(' | '));
check('ensure/要读到 color 才能比', g1.seen.some((c) => c.includes('--json name,color,description')), g1.seen.join(' | '));

// 描述改了也算漂(颜色一样但文案不同 → 仍要 edit)
const g2 = fakeEnsureGh([{ name: 'touches:core', color: '6e7781', description: '老文案' }]);
const e2 = ensureDisplayLabelsExist({ owner: 'o', repo: 'r', registry: { 'touches:core': REG['touches:core'] }, ghFn: g2.fn, force: true, cacheFile: ENSURE_CACHE });
eq('ensure/只有描述漂了也纠', e2.recolored, ['touches:core']);
const g3 = fakeEnsureGh([{ name: 'touches:core', color: '6E7781', description: '核心' }]);
const e3 = ensureDisplayLabelsExist({ owner: 'o', repo: 'r', registry: { 'touches:core': REG['touches:core'] }, ghFn: g3.fn, force: true, cacheFile: ENSURE_CACHE });
eq('ensure/大小写不同不算漂', [e3.recolored, e3.created], [[], []]);

// ── ⑥ 配色本身:三条规矩,少一条列表就难看 ──
// 这一组是 2026-08-01 那轮返工的产物(维护者原话:「除了 awaiting-discussion 其他都有点丑」),
// 每条断言背后都有一个踩过的坑,别删:
//   ① 感知亮度落在 0.12~0.60。GitHub 深色模式的文字色 = 把该 hex 的亮度补到「感知亮度 0.6」,
//      本来就浅的(> 0.6)一点都不提亮 → 在深色底上灰扑扑一坨(旧值 8ED6E0 / E4E669 /
//      FEF2C0 就是这么糊的);太深的(< 0.12)会被提成粉白,同样失真。
//   ② touches 十个色的感知亮度要彼此拉齐(±0.03)。不齐的话蓝紫被提得很淡、黄绿几乎不动,
//      十个色一眼就散;拉齐了才像一套板,而且浅色模式下会拿到同一种文字色。
//   ③ 任何「可能并排出现」的两个色,不许既色相接近又亮度接近 —— 必须两个一起看:深红
//      D1242F 与亮玫红 E24D78 色相只差 13° 但亮度差 0.15,实测不会混;而 status 绿 1A7F37
//      (色相 142)与 touches:product-ui(色相 152)色相差 10° 且亮度相同,当场就糊 ——
//      那一对就是这条断言的由来。status 组内部不比(同一时间只挂一个,不会并排)。
const perceived = (hex) => (parseInt(hex.slice(0, 2), 16) * 0.2126
  + parseInt(hex.slice(2, 4), 16) * 0.7152
  + parseInt(hex.slice(4, 6), 16) * 0.0722) / 255;
const hueOf = (hex) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return null; // 无彩度(灰):没有色相可比
  const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return h < 0 ? h + 360 : h;
};
const hueGap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 360 - d); };

for (const [name, def] of Object.entries(DISPLAY_LABELS)) {
  const pl = perceived(def.color);
  check(`palette/${name} 感知亮度落在 0.12~0.60(深色模式不会糊)`, pl >= 0.12 && pl <= 0.60, `${def.color} → ${pl.toFixed(3)}`);
}
const touchPls = Object.values(DISPLAY_LABELS).filter((d) => d.group === 'touches').map((d) => perceived(d.color));
check('palette/touches 十个色的感知亮度彼此拉齐(±0.03)',
  Math.max(...touchPls) - Math.min(...touchPls) <= 0.03,
  `跨度 ${(Math.max(...touchPls) - Math.min(...touchPls)).toFixed(3)}`);

// 会并排出现的颜色全集 = 全部展示标签 + 维护者确认标签(它和 touches:* 会同时挂在一行)
const COEXIST = [
  ...Object.entries(DISPLAY_LABELS).map(([n, d]) => [n, d.color, d.group]),
  ['awaiting-discussion', SIGNOFF_LABEL_COLOR, 'signoff'],
];
let clashChecked = 0;
for (let i = 0; i < COEXIST.length; i++) {
  for (let j = i + 1; j < COEXIST.length; j++) {
    const [nA, cA, gA] = COEXIST[i];
    const [nB, cB, gB] = COEXIST[j];
    if (cA === cB) continue;                          // 故意同色(status 分桶)
    if (gA === 'status' && gB === 'status') continue; // status 一次只挂一个,不会并排
    const [hA, hB] = [hueOf(cA), hueOf(cB)];
    if (hA === null || hB === null) continue;
    const gap = hueGap(hA, hB);
    const dPl = Math.abs(perceived(cA) - perceived(cB));
    clashChecked += 1;
    check(`palette/${nA} 与 ${nB} 不会看混`, !(gap < 20 && dPl < 0.08),
      `色相差 ${gap.toFixed(1)}° / 亮度差 ${dPl.toFixed(3)} — ${cA} vs ${cB}`);
  }
}
check('palette/看混检查真的跑到了(不是空循环)', clashChecked >= 100, `只比了 ${clashChecked} 对`);

if (failed) {
  console.error(`\n${failed} 项未通过`);
  process.exit(1);
}
console.log(`OK — status/touches 展示标签判定与同步全部通过(${STATUS_CASES.length} 个状态用例 + touches / sync / config / ensure 纠色 / 配色三规矩断言)`);
