#!/usr/bin/env node
// write-review-receipt.mjs — 阶段二独立审查回执写入(P1-5,2026-08-02;对应 SKILL 4
// 「阶段二独立代码审查」结束、进入阶段三合并判定之前那一刻)。
//
// 结构性 BLOCKED 的 admin-trust 分级合并路由(decideStructuralBypassRoute 的
// review-pending-admin-bypass,见 internal-gates.md「作者侧与仓库侧 gate」)要求"本轮
// 独立审查实际跑完且 0 P0/P1"才能替代 reviewDecision=APPROVED——脚本本身判断不了代码
// 好不好,那是 LLM 审查 agent 的语义判断。审查 agent(或主 agent 汇总审查结论后)每次跑
// 完独立审查、准备进入合并判定前,必须调用本脚本落一条回执:
// {headRefOid, verdict, p0p1Count, writtenAt}。pre-merge-check.mjs 读取它并核验
// headRefOid 与当前 head 一致、verdict=clean,才会把 structuralBypassReady 判 true——
// 无回执 / 回执针对旧 head(审查通过后又推了新 commit)/ verdict≠clean 都不算,必须先
// 重新审查、重新落回执。
//
// 用法:
//   node <skill-root>/scripts/write-review-receipt.mjs <PR> --verdict <clean|dirty> --p0p1-count <N> [--head <sha>]
//     --head 省略时自动用 gh pr view --json headRefOid 查当前 head(推荐显式传:省一次
//     API 调用,也避免"查的时候和审查时的 head 不一致"这种极小概率的竞态——审查 agent
//     通常已经知道自己审的是哪个 head)。
//   node <skill-root>/scripts/write-review-receipt.mjs <PR> --get
//     → 打印当前回执(调试/人工核对用;pre-merge-check.mjs 内部直接 import
//       readReviewReceipt,不走本脚本)。
//
// 退出码:0 = 成功;1 = 脚本自身出错(参数不合法、写入失败等)。

import { parseRepo, parsePR, ghJson, writeReviewReceipt, readReviewReceipt, print, fail } from './lib.mjs';

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

try {
  const pr = parsePR(process.argv[2]);

  if (process.argv.includes('--get')) {
    print({ ok: true, pr, receipt: readReviewReceipt(pr) });
    process.exit(0);
  }

  const verdict = argAfter('--verdict');
  // SC-R1b(2026-08-05 复审共识):public CLI **彻底禁止** clean——"收到两个 hash 参数就放"
  // 守不住(hash 存在≠hash 已验证)。clean 只能由 consume-review-output.mjs 依据机器
  // verdict 经内部 writer 落盘;本 CLI 只保留 dirty(打回/如实记录还有 P0/P1)与 --get。
  if (verdict === 'clean') {
    throw new Error('本 CLI 不再接受 --verdict clean(SC-R1b):clean 回执只能由 consume-review-output.mjs 依据机器派生 verdict 写入,人工/agent 直写 clean 的通道已收口');
  }
  if (verdict !== 'dirty' && verdict !== 'skip') {
    throw new Error('--verdict 必须是 dirty 或 skip(clean 已收口到 consume-review-output.mjs)');
  }
  const p0p1CountArg = argAfter('--p0p1-count');
  if (p0p1CountArg === '') throw new Error('缺 --p0p1-count <N>');
  const p0p1Count = Number(p0p1CountArg);
  if (!Number.isInteger(p0p1Count) || p0p1Count < 0) throw new Error('--p0p1-count 必须是非负整数');
  if (verdict === 'clean' && p0p1Count > 0) {
    throw new Error('verdict=clean 但 --p0p1-count>0,自相矛盾——0 P0/P1 才能算 clean');
  }

  let headRefOid = argAfter('--head');
  if (!headRefOid) {
    const { owner, repo } = parseRepo();
    const meta = ghJson(['pr', 'view', String(pr), '--repo', `${owner}/${repo}`, '--json', 'headRefOid']);
    headRefOid = meta.headRefOid;
  }
  if (!headRefOid) throw new Error('无法确定 headRefOid(未传 --head 且查询失败)');

  const reason = argAfter('--reason');
  if (verdict === 'skip' && reason !== 'review-agent-timeout') {
    throw new Error('--verdict skip 必须带 --reason review-agent-timeout(禁止无原因 skip 冒充审查完成)');
  }
  const receipt = writeReviewReceipt({
    pr, headRefOid, verdict, p0p1Count,
    ...(reason ? { bindings: { reason } } : {}),
  });
  print({ ok: true, pr, receipt });
} catch (e) {
  fail(e);
}
