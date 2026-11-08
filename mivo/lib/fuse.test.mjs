// fuse.test.mjs — 审查熔断的纯函数(PraiseZhu/Review-PR#209):版本计数口径、熔断判定、「继续审」解析、熔断 issue 正文、配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUSE_ISSUE_PREFIX, FUSE_MARKER_RE, loadFuseConfig, toFuseConfig, toVersionFingerprint, toFindingCounts, selectFuseVersions,
  withFuseVersion, toFuseCount, toFuseDecision, shouldWakeForFuse, findResumeComment, toFuseIssue, toFuseResumeComment,
  isLatestVersionClean, toFuseTripWake, toFuseStaleComment,
} from './fuse.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const at = (minute) => `2026-11-07T10:${String(minute).padStart(2, '0')}:00.000Z`;
const server = (head, hashes) => ({ head, mivo: { filePatchHashesV2: hashes } });

test('指纹:按 PR 自身改动算,文件顺序无关;v2 优先,没有就 v1,都没有就用 head', () => {
  const a = toVersionFingerprint(server('h1', { 'a.ts': 'x', 'b.ts': 'y' }));
  const b = toVersionFingerprint(server('h2', { 'b.ts': 'y', 'a.ts': 'x' }));
  assert.equal(a, b, '只合了 main 的新 head,PR 自身改动相同 → 同一指纹');
  assert.notEqual(a, toVersionFingerprint(server('h3', { 'a.ts': 'x', 'b.ts': 'z' })));
  assert.equal(toVersionFingerprint({ head: 'h4', mivo: { filePatchHashes: { 'a.ts': '1' } } }),
    toVersionFingerprint({ head: 'h5', mivo: { filePatchHashes: { 'a.ts': '1' } } }));
  assert.equal(toVersionFingerprint({ head: 'h6', mivo: {} }), 'head:h6');
  assert.equal(toVersionFingerprint({ head: 'h7', mivo: { filePatchHashesV2: {} } }), 'head:h7');
});

test('SC1 计数:12 次审查覆盖 9 个 head,其中 2 个只合 main、3 次同 head 重复审 → 7 版,不熔断', () => {
  const fp = (n) => `patch:${n}`;
  // 9 个 head:h1..h9;h4 是合 main(与 h3 同指纹),h8 是合 main(与 h7 同指纹);h2、h5、h9 各被重复审一次
  const reviews = [
    ['h1', fp(1)], ['h2', fp(2)], ['h2', fp(2)], ['h3', fp(3)], ['h4', fp(3)], ['h5', fp(5)], ['h5', fp(5)],
    ['h6', fp(6)], ['h7', fp(7)], ['h8', fp(7)], ['h9', fp(9)], ['h9', fp(9)],
  ];
  assert.equal(reviews.length, 12);
  assert.equal(new Set(reviews.map(([head]) => head)).size, 9);
  const versions = reviews.map(([head, f], i) => ({ fp: f, head, at: at(i) }));
  assert.equal(toFuseCount({ versions }), 7);
  assert.equal(toFuseDecision({ record: { fuse: { versions } }, head: 'h10', maxVersions: 10 }).tripped, false);
});

test('SC2 第 10 个计数版本仍没放行 → 熔断;第 10 版是审查通过的 head → 不熔断;第 9 版不熔断', () => {
  const versions = Array.from({ length: 10 }, (_, i) => ({ fp: `patch:${i}`, head: `h${i}`, at: at(i) }));
  assert.deepEqual(toFuseDecision({ record: { fuse: { versions } }, head: 'h9', maxVersions: 10 }), { tripped: true, count: 10, trip: null });
  assert.equal(toFuseDecision({ record: { fuse: { versions }, cleanHead: 'h9' }, head: 'h9', maxVersions: 10 }).tripped, false);
  assert.equal(toFuseDecision({ record: { fuse: { versions: versions.slice(0, 9) } }, head: 'h9', maxVersions: 10 }).tripped, false);
  // 第 11 个新提交还没审:照样停
  assert.equal(toFuseDecision({ record: { fuse: { versions } }, head: 'h10', maxVersions: 10 }).tripped, true);
});

test('已经熔断:不管版本数一直停到「继续审」;继续审后只数之后出现的新指纹', () => {
  const versions = Array.from({ length: 10 }, (_, i) => ({ fp: `patch:${i}`, head: `h${i}`, at: at(i) }));
  const trip = { issue: 77, at: at(20), count: 10, head: 'h9' };
  // 熔断前最近审完的一版没通过(审查通过的是更早的 h5):照旧一直停
  assert.equal(toFuseDecision({ record: { fuse: { versions, trip }, cleanHead: 'h5' }, head: 'h9', maxVersions: 10 }).tripped, true);
  const resumed = { versions: [...versions, { fp: 'patch:9', head: 'h9', at: at(31) }, { fp: 'patch:0', head: 'h0b', at: at(32) }], resumedAt: at(30) };
  assert.equal(toFuseCount(resumed), 0, '恢复后重审同一版、或改回旧版本,都不算新版本');
  const more = { ...resumed, versions: [...resumed.versions, ...Array.from({ length: 10 }, (_, i) => ({ fp: `patch:new${i}`, head: `n${i}`, at: at(40 + i) }))] };
  assert.equal(toFuseCount(more), 10);
  assert.equal(toFuseDecision({ record: { fuse: more }, head: 'n9', maxVersions: 10 }).tripped, true, '再满 10 版会再停');
});

test('上线前的历史:没有 fuse 记录时按 completedRuns 的 head 补,每个 head 算一版;记新版本时保留补上的历史', () => {
  const record = { completedRuns: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`old${i}`, 2])) };
  assert.equal(selectFuseVersions(record).length, 9);
  assert.equal(toFuseCount({ versions: selectFuseVersions(record) }), 9);
  const fuse = withFuseVersion(record, { fp: 'patch:a', head: 'new', at: at(1), findings: { P0: 0, P1: 1, P2: 2 } });
  assert.equal(fuse.versions.length, 10);
  assert.deepEqual(fuse.lastFindings, { P0: 0, P1: 1, P2: 2 });
  assert.equal(shouldWakeForFuse({ record: { ...record, fuse }, reviewClean: false, maxVersions: 10 }), true);
  assert.equal(shouldWakeForFuse({ record: { ...record, fuse }, reviewClean: true, maxVersions: 10 }), false);
  assert.equal(shouldWakeForFuse({ record: { ...record, fuse: { ...fuse, trip: { issue: 1 } } }, reviewClean: false, maxVersions: 10 }), false, '已熔断不再唤醒');
  // 补上的历史没有时间,视为在任何「继续审」之前
  assert.equal(toFuseCount({ versions: fuse.versions, resumedAt: at(0) }), 1);
});

test('只数 P0/P1/P2', () => {
  assert.deepEqual(toFindingCounts({ mivo: { findings: [{ severity: 'P0' }, { severity: 'P2' }, { severity: 'P2' }, { severity: 'P3' }, {}] } }), { P0: 1, P1: 0, P2: 2 });
  assert.deepEqual(toFindingCounts({ mivo: { findings: 3 } }), { P0: 0, P1: 0, P2: 0 });
});

const base = { maintainers: ['praisezhu', 'kirozeng'], author: 'someone', resumeLine: '继续审', since: at(10) };
const comment = (login, body, minute, extra = {}) => ({ author: { login }, body, createdAt: at(minute), databaseId: minute, isMinimized: false, ...extra });

test('SC5「继续审」:维护者或 PR 作者回一整行才算(允许行尾标点),取最早一条', () => {
  assert.deepEqual(findResumeComment({ ...base, comments: [comment('KiroZeng', '看过了\n继续审。', 12)] }), { login: 'KiroZeng', at: at(12), id: 12 });
  assert.equal(findResumeComment({ ...base, comments: [comment('someone', '继续审', 15), comment('PraiseZhu', '继续审', 11)] }).login, 'PraiseZhu');
  assert.equal(findResumeComment({ ...base, comments: [comment('someone', '继续审!', 13)] }).login, 'someone');
});

test('SC5「继续审」不算的情况:否定、被折叠、流程评论、路人、熔断前、不是一整行', () => {
  const rejects = [
    comment('praisezhu', '先别继续审\n继续审', 12),
    comment('praisezhu', '不要继续审', 12),
    comment('praisezhu', '继续审', 12, { isMinimized: true }),
    comment('praisezhu', '继续审\n<!-- mivo-watcher-receipt -->', 12),
    comment('stranger', '继续审', 12),
    comment('praisezhu', '继续审', 9),
    comment('praisezhu', '可以继续审了', 12),
    comment('praisezhu', '别继续审\n继续审', 12),
    comment('praisezhu', '不建议继续审\n继续审', 12),
    comment('praisezhu', '继续审\n继续审', 12),
    comment('', '继续审', 12),
  ];
  for (const c of rejects) assert.equal(findResumeComment({ ...base, comments: [c] }), null, JSON.stringify(c));
});

test('SC4 熔断 issue:标题前缀、首行标记、版本数、未解决问题数和处理办法;没有问题计数时也能写', () => {
  const issue = toFuseIssue({ pr: 1704, title: '对话出图判定', url: 'https://github.com/o/r/pull/1704', author: 'aj0928', count: 10, maxVersions: 10,
    findings: { P0: 0, P1: 1, P2: 5 }, resumeLine: '继续审' });
  assert.ok(issue.title.startsWith(`${FUSE_ISSUE_PREFIX}1704`));
  assert.equal(issue.body.split('\n')[0].match(FUSE_MARKER_RE)?.[1], '1704');
  for (const text of ['审过 10 个代码版本', 'P0 0 条、P1 1 条、P2 5 条', '不会写成通过', '一整行「继续审」', '维护者裁定不改', '审查问题转 issue 跟进', '关闭这个 PR', 'agent 不得代写', '@aj0928']) {
    assert.ok(issue.body.includes(text), text);
  }
  assert.ok(toFuseIssue({ pr: 2, count: 10, maxVersions: 10, resumeLine: '继续审' }).body.includes('最近一版还没有放行'));
  assert.equal(toFuseResumeComment({ login: 'kirozeng', resumeLine: '继续审' }), '收到 @kirozeng 的「继续审」，恢复自动送审，版本数从 0 重新算。');
});

test('配置:没配或 enabled 不是 true 时关闭;配错直接报错;两份规则文件都开着、门槛 10', () => {
  assert.equal(toFuseConfig({}).enabled, false);
  assert.equal(toFuseConfig({ convergeFuse: { enabled: false, maxVersions: 10, resumeLine: '继续审' } }).enabled, false);
  assert.throws(() => toFuseConfig({ convergeFuse: { enabled: true, maxVersions: 0, resumeLine: '继续审' } }), /maxVersions/);
  assert.throws(() => toFuseConfig({ convergeFuse: { enabled: true, maxVersions: 10, resumeLine: ' ' } }), /resumeLine/);
  for (const file of ['review-pr/config/pr-rules.json', 'mivo/config/sandbox-pr-rules.json']) {
    const config = loadFuseConfig(join(REPO_ROOT, file));
    assert.deepEqual([config.enabled, config.maxVersions, config.resumeLine], [true, 10, '继续审'], file);
    assert.ok(config.maintainers.includes('praisezhu'), file);
  }
  const dir = mkdtempSync(join(tmpdir(), 'fuse-config-'));
  try {
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ maintainerAllowlist: ['A'], convergeFuse: { enabled: true, maxVersions: 3, resumeLine: '继续审' } }));
    assert.deepEqual(loadFuseConfig(join(dir, 'rules.json')), { enabled: true, maxVersions: 3, resumeLine: '继续审', maintainers: ['a'], notify: { enabled: false } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#225 SC1 最近审完的一版审查通过后只合了 main / 推了新提交还没审:满 10 版也不熔断;最近一版没通过照旧熔断', () => {
  const versions = Array.from({ length: 10 }, (_, i) => ({ fp: `patch:${i}`, head: `h${i}`, at: at(i) }));
  // #1836 现场:第 11 版 5aaba671 审查通过,作者合 main 得到 3cafffc3,旧规则只比 head 就熔断
  assert.equal(isLatestVersionClean({ fuse: { versions }, cleanHead: 'h9' }), true);
  assert.deepEqual(toFuseDecision({ record: { fuse: { versions }, cleanHead: 'h9' }, head: 'merge-main', maxVersions: 10 }), { tripped: false, count: 10, trip: null });
  assert.equal(toFuseDecision({ record: { fuse: { versions }, cleanHead: 'h5' }, head: 'merge-main', maxVersions: 10 }).tripped, true, '审查通过的是更早的版本,之后又审过没通过的版本');
  assert.equal(toFuseDecision({ record: { fuse: { versions } }, head: 'merge-main', maxVersions: 10 }).tripped, true, '从没通过过');
  // 上线前补的历史(completedRuns 的 head 顺序)同样适用
  const seeded = { completedRuns: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`old${i}`, 2])), cleanHead: 'old10' };
  assert.equal(toFuseDecision({ record: seeded, head: 'merge-main', maxVersions: 10 }).tripped, false);
  assert.equal(toFuseDecision({ record: { ...seeded, cleanHead: 'old3' }, head: 'merge-main', maxVersions: 10 }).tripped, true);
  assert.equal(isLatestVersionClean({ fuse: { versions: [] }, cleanHead: 'h9' }), false, '没有版本历史不算');
});

test('#225 SC2 已有熔断记录、最近审完的一版其实已通过:标 stale,不再拦;关 issue 的说明点名误熔断、不要求回「继续审」', () => {
  const versions = Array.from({ length: 11 }, (_, i) => ({ fp: `patch:${i}`, head: `h${i}`, at: at(i) }));
  const trip = { issue: 1963, at: at(30), count: 11, head: 'merge-main' };
  assert.deepEqual(toFuseDecision({ record: { fuse: { versions, trip }, cleanHead: 'h10' }, head: 'merge-main', maxVersions: 10 }),
    { tripped: false, count: 11, trip, stale: true });
  const text = toFuseStaleComment({ cleanHead: '5aaba671e606c9819654c284597cd54e915ad479' });
  assert.match(text, /误熔断/);
  assert.match(text, /`5aaba671e606`/);
  assert.match(text, /不需要回「继续审」/);
});

test('#225 SC4 上线一次性唤醒:只给本机有 fuse.trip 的行标 retry;已标 retry、编号不合法的不动;done 后不再唤醒', () => {
  const roundState = { version: 1, prs: { 1704: { outcome: 'maintainer-signoff' }, 1805: { outcome: 'maintainer-signoff', retry: true },
    1836: { outcome: 'maintainer-signoff' }, 1920: { outcome: 'findings' }, x: { outcome: 'maintainer-signoff' } } };
  const records = { 1704: { fuse: { trip: { issue: 1951 } } }, 1805: { fuse: { trip: { issue: 1953 } } }, 1836: { fuse: { trip: { issue: 1963 } } },
    1920: { fuse: { trip: null, resumedAt: at(1) } }, x: { fuse: { trip: { issue: 1 } } } };
  const first = toFuseTripWake({ roundState, records });
  assert.deepEqual(first.wake, [1704, 1836]);
  assert.equal(first.next.prs[1704].retry, true);
  assert.equal(first.next.prs[1920].retry, undefined);
  assert.equal(first.next.version, 1);
  assert.equal(roundState.prs[1704].retry, undefined, '不改入参');
  assert.deepEqual(toFuseTripWake({ roundState, records, alreadyDone: true }), { done: true, wake: [], next: roundState });
  assert.deepEqual(toFuseTripWake({ roundState: null, records }).wake, [], '没有 round-state 不报错');
});
