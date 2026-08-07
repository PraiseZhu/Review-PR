#!/usr/bin/env node
// pick.mjs — review-pr「未指定 PR 时自动选取」(只读)
//
// 用户没传 PR 编号时,选出「最早创建 + 可处理」的 open PR 交给主流程,
// 取代旧的「问用户要编号」。「可处理」= state=open 且非 draft(草稿还没准备好被 review);
// 不过滤格式不合规 / 有冲突 / 有未 resolve thread 的 PR —— 那些正是本 skill 要处理的对象
// (格式不过→打回、冲突→如实报告、thread 没 resolve→卡 gate),滤掉等于专挑老 PR 跳过。
//
// 排序 / 过滤都在代码里做(对应 agent 约束「优先用代码保证确定性」),不靠 LLM「自己去找」。
// 不做任何决策 / 写操作:只输出候选与选中项;候选为空由 skill 告诉用户没活可干。
//
// 跑:node <skill-root>/scripts/pick.mjs

import { parseRepo, gh, print, fail } from './lib.mjs';

// 内部 repo 同时 open 的 PR 远不到这个量级,一次拉全;gh pr list 默认按创建倒序且含 draft,
// 这里全量拉回后在 JS 里自己过滤 / 升序排,正确性不依赖 gh 的默认排序与默认 30 条上限。
const LIMIT = 100;

try {
  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;

  const raw = JSON.parse(
    gh([
      'pr', 'list', '--repo', slug, '--state', 'open',
      '--limit', String(LIMIT),
      '--json', 'number,title,author,createdAt,isDraft,url',
    ]).stdout || '[]',
  );

  // 可处理 = 非 draft;按 createdAt 升序(ISO 字符串字典序 = 时间序)取最早。
  const candidates = raw
    .filter((p) => !p.isDraft)
    .map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author?.login ?? '',
      createdAt: p.createdAt,
      url: p.url,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  print({
    ok: true,
    repo: slug,
    picked: candidates[0] ?? null, // 最早的可处理 PR;null = 当前无活可干
    candidateCount: candidates.length,
    draftSkipped: raw.length - candidates.length,
    candidates, // 全量候选(升序),供 skill 汇报「共 N 个待处理」
  });
} catch (e) {
  fail(e);
}
