#!/usr/bin/env node
// deliver-review-segment.mjs — 分段投递的**唯一**出口(SC-R4 第 2 轮核验 BLOCKER)。
//
// 编排方按 order 逐段调用本脚本,把它打印的 `payload` 投给**同一个**审查会话;每段结束
// 收回执后再投下一段。coverage key 清单只在这里给出(builder 的 prompt.md 不再包含),
// 所以"没投递过就不可能知道该段该覆盖什么"——顺序性因此有了机器凭据(见
// lib.review-delivery.mjs 的诚实边界声明)。
//
// 用法:
//   node deliver-review-segment.mjs <PR> --task <task.json> --base <baseOid> --head <headOid> --order N
// 退出码:0 = 已投递(payload 在 stdout);2 = 拒绝投递(乱序/跳段/task 过期,原因在 JSON);
//         1 = 脚本自身错误。
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import { print, fail, parsePR, REPO_ROOT, STATE_DIR, loadRules } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import { deliveryPathFor, loadDeliveries, saveDeliveries, appendDelivery } from './lib.review-delivery.mjs';
import { computeReviewRequirements, coverageKeyStr, coverageCommitment } from './lib.review-requirements.mjs';
import { validatePrescanConfig, readPrescanArtifact } from './lib.prescan.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

try {
  const pr = parsePR(process.argv[2]);
  const taskFile = argOf('--task');
  const order = Number(argOf('--order'));
  if (!taskFile || !existsSync(taskFile)) fail(new Error('缺 --task <task.json>'));
  if (!Number.isInteger(order) || order < 1) fail(new Error('缺 --order <正整数>'));
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  const snapshot = buildDiffSnapshot({
    repoRoot: REPO_ROOT,
    baseRefOid: (argOf('--base') ?? '').toLowerCase(),
    headOid: (argOf('--head') ?? '').toLowerCase(),
  });
  if (!snapshot.complete) {
    print({ ok: false, pr, refused: `DiffSnapshot 不完整:${snapshot.reason}` });
    process.exit(2);
  }
  if (task.snapshotHash !== snapshot.snapshotHash) {
    print({ ok: false, pr, refused: `task 绑定的 snapshotHash 不是当前 snapshot(task=${task.snapshotHash},当前=${snapshot.snapshotHash})——需重建 task 并从第 1 段重投` });
    process.exit(2);
  }
  // 分片**权威重算**(不信 task 里的声明):task 只公开每段的计数与内容承诺,key 明细
  // 只在这里按序给出。task 的承诺与重算不符即拒(过期/被改)。
  const auth = computeReviewRequirements({ repoRoot: REPO_ROOT, snapshot, rules: loadRules() });
  const segments = auth.segments;
  const declared = Array.isArray(task.segments) ? task.segments : [];
  const mismatch = declared.length !== segments.length || segments.some((seg, i) => (
    declared[i]?.segmentId !== seg.segmentId || declared[i]?.order !== seg.order
    || declared[i]?.keyCount !== seg.assignedCoverageKeys.length
    || declared[i]?.commitment !== coverageCommitment(seg.assignedCoverageKeys)));
  if (mismatch) {
    print({ ok: false, pr, refused: 'task 声明的分片与当前 snapshot 重算不符(段数/序号/计数/内容承诺任一不符)——需重建 task 并从第 1 段重投' });
    process.exit(2);
  }
  const file = deliveryPathFor(STATE_DIR, pr);
  const loaded = loadDeliveries(file);
  const r = appendDelivery({ loaded, snapshotHash: snapshot.snapshotHash, segments, order, now: new Date().toISOString() });
  if (!r.ok) {
    print({ ok: false, pr, refused: r.error, delivered: loaded.deliveries.map((d) => d.order) });
    process.exit(2);
  }
  saveDeliveries(file, { snapshotHash: snapshot.snapshotHash, deliveries: r.deliveries });
  const seg = r.segment;
  // ── 本段的**可审查内容**(第 4 轮核验 BLOCKER:此前 payload 只有 opaque key,先读完整
  // diff 则分段不收窄上下文,不读则 key 根本没法审——分段等于没实现)。每个 hunk key 带
  // path + 行区间 + immutable patch 文本;file key 带 changeType/contentKind/modes。──
  const fileById = new Map(snapshot.files.map((f) => [f.fileId, f]));
  const segmentContent = seg.assignedCoverageKeys.map((k) => {
    const f = fileById.get(k.fileId);
    const path = f ? (f.newPath ?? f.oldPath) : null;
    if (k.kind === 'hunk') {
      const h = f?.hunks.find((x) => x.hunkId === k.hunkId);
      return {
        key: coverageKeyStr(k), kind: 'hunk', fileId: k.fileId, hunkId: k.hunkId, path,
        changeType: f?.changeType ?? null,
        oldRanges: h?.oldRanges ?? null, newRanges: h?.newRanges ?? null,
        patch: h?.patchText ?? '',
      };
    }
    return {
      key: coverageKeyStr(k), kind: 'file', fileId: k.fileId, path,
      changeType: f?.changeType ?? null, contentKind: f?.contentKind ?? null,
      oldMode: f?.oldMode ?? null, newMode: f?.newMode ?? null,
    };
  });
  // 本段涉及的 profile 必答项与 required 负向证据(第 4 轮核验:这两组的 fileId/hunkId
  // 已从 task/prompt 撤出,唯一出口在这里,跟着它们所属的 key 分段给)。
  //
  // 第 5 轮核验 BLOCKER:profile 必答项按 **fileId** 归属(不像负向证据按 hunkId),而单个
  // 文件的多个 hunk 可能被切进不同段——若直接按"本段是否含该 fileId 的任意 key"过滤,
  // 同一条必答项会在该文件涉及的**每一段**里都重复投递一次(实测:单文件双 hunk、
  // sizeBudget=1 时两段各投 7 条、重复 7 条)。改为给每个 fileId 指定**唯一 owner
  // segment**——按全量 segments 的顺序,取该 fileId 第一次出现的段 order,只在那一段
  // 投递该文件的必答项。这一步用**全量** segments(不是本段的 assignedCoverageKeys)
  // 计算,保证与调用顺序无关、任何一段单独投递都能算出同一个 owner。
  const fileOwnerOrder = new Map();
  for (const s of segments) {
    for (const k of s.assignedCoverageKeys) {
      if (!fileOwnerOrder.has(k.fileId)) fileOwnerOrder.set(k.fileId, s.order);
    }
  }
  const segHunkKeys = new Set(seg.assignedCoverageKeys.filter((k) => k.kind === 'hunk').map((k) => `${k.fileId}:${k.hunkId}`));
  const profileRequirements = auth.requiredProfileAnswers.filter((x) => fileOwnerOrder.get(x.fileId) === seg.order);
  const negativeRequirements = auth.requiredNegativeEvidenceKeys.filter((x) => segHunkKeys.has(`${x.fileId}:${x.hunkId}`));

  // SC-4.2: 本段涉及的 prescan observations——**现场按 snapshot/file/line 重算归属**,
  // 不信 artifact 自报的段归属(artifact 里没有段信息,本就无从自报;这里的"不信"体现在
  // 用本段实际的文件路径集去筛选,而不是假设 observation 顺序与段顺序对应)。
  // 只在 enabled 且 artifact.snapshotHash 匹配当前 snapshot 时才附带——否则不附带
  // observations(consumer 侧的 SC-8 用 task.prescan 判断是否该有 assessment)。
  const prescanCfg = validatePrescanConfig(loadRules().prescan);
  let prescanObservations = [];
  if (prescanCfg.enabled && prescanCfg.valid) {
    const prescanArtifact = readPrescanArtifact(STATE_DIR, pr);
    if (prescanArtifact && prescanArtifact.snapshotHash === snapshot.snapshotHash && prescanArtifact.status === 'complete') {
      const segPaths = new Set(segmentContent.map((c) => c.path).filter(Boolean));
      prescanObservations = (prescanArtifact.observations ?? []).filter((o) => segPaths.has(o.file));
    }
  }

  const payload = [
    `## 覆盖分段 ${seg.segmentId}(投递序号 ${seg.order} / 共 ${segments.length} 段)`,
    '',
    `本段分配到 ${seg.assignedCoverageKeys.length} 个 coverage key,逐个审并在 \`segmentReceipts[]\` 追加`,
    `\`{segmentId:"${seg.segmentId}", receivedOrder:${seg.order}, coverageKeys:[...本段全部 key...]}\`。`,
    '只能认领本段的 key(跨段冒领/段内重复一律判 invalid)。',
    '',
    ...segmentContent.flatMap((c) => (c.kind === 'hunk'
      ? [`### ${c.key}`, `${c.path}(${c.changeType})`, '', '```diff', c.patch.trimEnd(), '```', '']
      : [`### ${c.key}`, `${c.path}(${c.changeType},${c.contentKind},mode ${c.oldMode ?? '-'}→${c.newMode ?? '-'})`, ''])),
    ...(profileRequirements.length > 0 ? [
      '### 本段 profile 必答项(在 `profileAnswers[]` 里逐条作答)',
      ...profileRequirements.map((x) => `- \`${x.profileId}\` / \`${x.checkId}\` @ ${x.path}(fileId \`${x.fileId}\`):${x.ask}`),
      '',
    ] : []),
    ...(negativeRequirements.length > 0 ? [
      '### 本段 required 负向证据(只能 executed 满足)',
      ...negativeRequirements.map((x) => `- ${x.path} hunk \`${x.hunkId}\`(fileId \`${x.fileId}\`):${x.reason}`),
      '',
    ] : []),
    ...(prescanObservations.length > 0 ? [
      '### 本段预扫观察(advisory,需逐条 disposition)',
      ...prescanObservations.map((o) => `- \`${o.observationId}\` ${o.file}:${o.line} [${o.category}]:${o.note}`),
      '',
    ] : []),
  ].join('\n');
  print({
    ok: true, pr, segmentId: seg.segmentId, order: seg.order, replayed: r.replayed === true,
    // 结构化明细:这是编排方唯一合法的取 key/必答项/负向 key 通道(task.json 里已不含明细)
    assignedCoverageKeys: seg.assignedCoverageKeys,
    segmentContent, profileRequirements, negativeRequirements, prescanObservations,
    totalSegments: segments.length, deliveredOrders: r.deliveries.map((d) => d.order),
    remaining: segments.length - r.deliveries.length,
    snapshotHash: snapshot.snapshotHash, payload,
  });
} catch (e) {
  fail(e);
}
