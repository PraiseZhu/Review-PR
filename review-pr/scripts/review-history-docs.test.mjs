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

const skill = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');
const mivoReadme = readFileSync(fileURLToPath(new URL('../../mivo/README.md', import.meta.url)), 'utf8');
const patches = readFileSync(fileURLToPath(new URL('../../MIVO-PATCHES.md', import.meta.url)), 'utf8');
const worker = readFileSync(fileURLToPath(new URL('../../review-pr-auto/references/pr-worker.md', import.meta.url)), 'utf8');

test('2026-10-21 维护者决定:免独立 Approve、无 admin、四人完整维护者', () => {
  for (const [name, body] of [['SKILL', skill], ['internal-gates', gates], ['auto-skill', autoSkill],
    ['mivo-readme', mivoReadme], ['patches', patches], ['pr-worker', worker]]) {
    assert.equal(body.includes('2026-10-21'), true, `${name} 应写明 2026-10-21`);
  }
  includesAll(skill, ['免另一位维护者独立 Approve', '不启用 admin bypass', 'approval.status=exempt']);
  includesAll(gates, ['不启用 admin bypass', 'approval.status=exempt']);
  includesAll(autoSkill, ['zhongxingtian-ai', '不启用 admin bypass']);
  includesAll(mivoReadme, ['zhongxingtian-ai', '免其他人 Approve']);
  includesAll(patches, ['maintainer-author-exempt', 'zhongxingtian-ai']);
  includesAll(worker, ["status:'exempt'", 'approved=false']);
  for (const stale of ['维护者作者也不例外', '维护者作者也不再免 Approve', '放行权不扩大:给别人 PR 放行仍只认']) {
    assert.equal(skill.includes(stale) || gates.includes(stale) || patches.includes(stale), false, `stale rule remains: ${stale}`);
  }
});
