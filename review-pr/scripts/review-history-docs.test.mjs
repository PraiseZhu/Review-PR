import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const autoSkill = readFileSync(fileURLToPath(new URL('../../review-pr-auto/SKILL.md', import.meta.url)), 'utf8');
const gates = readFileSync(fileURLToPath(new URL('../references/internal-gates.md', import.meta.url)), 'utf8');

const includesAll = (body, values) => values.forEach((value) =>
  assert.equal(body.includes(value), true, `missing documentation contract: ${value}`));

test('auto skill documents the exact one-card Feishu contract', () => {
  includesAll(autoSkill, [
    '当前 PR',
    '本轮有变化',
    '进入 Review',
    '本轮已合并',
    '本轮未合并',
    '`进入 Review = 本轮已合并 + 本轮未合并`',
    '`#<PR号> · <PR标题>`',
    '`本轮没有合并 PR`',
    '只生成一张',
    '`receive_id_type=chat_id`',
  ]);
  for (const stale of [
    '超过单卡字节限制时按脚本页码顺序发送同一报告的续页',
    '以及按原因分类的未合并 PR',
  ]) assert.equal(autoSkill.includes(stale), false, `stale documentation remains: ${stale}`);
});

test('auto skill documents allowlisted Git history, recovery, and completion ordering', () => {
  includesAll(autoSkill, [
    '仅对精确仓库 `makecindy/cindy`',
    '`review-pr/history/makecindy-cindy/runs/<runId>/summary.json`',
    '`review-pr/history/makecindy-cindy/runs.jsonl`',
    '`review-pr/history/makecindy-cindy/round-state.json`',
    '本机外部 `round-state.json` 存在时始终优先',
    '本机文件缺失',
    '版本、仓库、模式和逐 PR 状态结构',
    'Git 历史成功推送后',
    '才能发送最终飞书卡片并关闭 queue',
    '`feishu-cards.json` 和 `notification.json`',
    '不提交到 Git',
  ]);
});

test('internal gates mirrors the history fallback and publication gate', () => {
  includesAll(gates, [
    '仅对精确仓库 `makecindy/cindy`',
    '本机外部 `round-state.json` 优先',
    'Git 历史只在本机文件缺失时作为回退',
    '历史成功推送是 finalize 完成和 queue close 的前置条件',
  ]);
});
