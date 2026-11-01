// deploy-tuple.mjs 的派发前提检查(PraiseZhu/Review-PR#163)的命令行行为:夹具见 deploy-tuple.fixture.mjs。
// 四项:MIVO_REVIEW_MODE=live、review-pr.yml 已登记且 active、只有 workflow_dispatch 触发、main 上 pr-rules.json 可读。
// 预检(--preview 与正式运行共用)不满足就在写停点之前失败;切换后的 verifyTuple 再查一次,不满足整组退回。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupFixture, sha256, WORKFLOW_NEW, WORKFLOW_OLD, WF_NEW, WF_OLD, WF_PATH, PR_NUMBER, PR_HEAD } from './deploy-tuple.fixture.mjs';

const STATE = 'mivo-prereview/state/mivo/mivo';
// 在 on: 块里多一个二级缩进的 pull_request 触发器
const WITH_PULL_REQUEST = `${WORKFLOW_NEW}  pull_request:\n`;
const rulesFile = (text) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });

// 每个场景只坏一项:fixture 选项、跑 deploy 的选项、输出里应有的原因。
const BAD_SCENARIOS = [
  { name: 'MIVO_REVIEW_MODE 不是 live', fixture: { mode: 'dry-run' }, reason: /仓库变量 MIVO_REVIEW_MODE 是 "dry-run",不是 live/ },
  { name: 'review-pr.yml 在 Actions 里不是 active', fixture: { workflowApi: { path: WF_PATH, state: 'disabled_manually' } }, reason: /状态是 disabled_manually,不是 active/ },
  { name: 'review-pr.yml 在 Actions 里读不到登记', fixture: { workflowApi: null }, reason: /读不到 \.github\/workflows\/review-pr\.yml 在 GitHub Actions 里的登记/ },
  { name: 'workflow 多了 pull_request 触发器', fixture: { workflows: [WITH_PULL_REQUEST] }, deploy: { newWf: sha256(WITH_PULL_REQUEST), oldWf: sha256(WITH_PULL_REQUEST) },
    reason: /触发器不是只有 workflow_dispatch/ },
  { name: 'main 上读不到 pr-rules.json', fixture: { rules: null }, reason: /读不到 main 上的 agent-use\/docs\/pr-rules\.json/ },
  { name: 'pr-rules.json 不是合法 JSON', fixture: { rules: rulesFile('{oops') }, reason: /不是合法 JSON/ },
  { name: 'pr-rules.json 不是 JSON 对象', fixture: { rules: rulesFile('[1]') }, reason: /不是 JSON 对象/ },
];

test('四项都满足:--preview 通过', (t) => {
  const f = setupFixture(t);
  const r = f.deploy({ extra: ['--preview'] });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

for (const scenario of BAD_SCENARIOS) {
  test(`${scenario.name}:--preview 与正式运行都在动停点之前失败,什么都不改`, (t) => {
    const preview = setupFixture(t, scenario.fixture);
    const p = preview.deploy({ ...scenario.deploy, extra: ['--preview'] });
    assert.equal(p.status, 1, `${p.stdout}\n${p.stderr}`);
    assert.match(p.stdout + p.stderr, /派发前提不满足:/);
    assert.match(p.stdout + p.stderr, scenario.reason);

    const f = setupFixture(t, scenario.fixture);
    const r = f.deploy(scenario.deploy);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, scenario.reason);
    assert.deepEqual(f.ghState().sets, [], '仓库变量没动');
    assert.equal(f.checkoutHead(), f.oldSkill, 'Mini 检出没动');
    assert.equal(f.exists(`${STATE}/deploy-hold.json`), false, '没写停点');
    assert.equal(f.exists(`${STATE}/deploy-tuple.lock`), false, '没拿过部署锁');
    assert.deepEqual(f.records(), [], '没写部署记录');
  });
}

test('几项同时不满足:一次报全,每项一条', (t) => {
  const f = setupFixture(t, { mode: 'sandbox', workflowApi: { path: WF_PATH, state: 'disabled_inactivity' }, rules: null });
  const r = f.deploy({ extra: ['--preview'] });
  assert.equal(r.status, 1);
  const text = r.stdout + r.stderr;
  assert.match(text, /MIVO_REVIEW_MODE 是 "sandbox"/);
  assert.match(text, /状态是 disabled_inactivity/);
  assert.match(text, /读不到 main 上的 agent-use\/docs\/pr-rules\.json/);
});

test('切换后 verifyTuple 再查一次:MIVO_REVIEW_MODE 在切换中途被改掉,核对失败,变量和检出整组退回,exit 1', (t) => {
  // 读 MIVO_REVIEW_MODE 依次是:预检(live)→ 切换后核对(dry-run)。old-wf 等于 new-wf(没有 workflow 变化),退回后 tuple 整齐。
  const f = setupFixture(t, { mode: ['live', 'dry-run'] });
  const r = f.deploy({ oldWf: WF_NEW });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /派发前提不满足:仓库变量 MIVO_REVIEW_MODE 是 "dry-run",不是 live/);
  assert.match(r.stdout, /已整组退回旧 tuple/);
  assert.deepEqual(f.ghState().sets, [f.newSkill, f.oldSkill]);
  assert.equal(f.ghState().variable, f.oldSkill);
  assert.equal(f.checkoutHead(), f.oldSkill);
  assert.equal(f.exists(`${STATE}/deploy-hold.json`), false);
  assert.equal(f.exists(`${STATE}/deploy-tuple.lock`), false);
});

test('带 --pr:预检的触发器检查看 PR head 上的 workflow(合并前把关),不是 main 上现在的', (t) => {
  const prArgs = ['--pr', PR_NUMBER, '--pr-head', PR_HEAD, '--preview'];
  // 读 workflow 依次是:main(旧,合法)→ PR head(多了 pull_request 触发器)。只有看 PR head 的那份才会发现。
  const bad = setupFixture(t, { workflows: [WORKFLOW_OLD, WITH_PULL_REQUEST] });
  const b = bad.deploy({ oldWf: WF_OLD, newWf: sha256(WITH_PULL_REQUEST), extra: prArgs });
  assert.equal(b.status, 1, `${b.stdout}\n${b.stderr}`);
  assert.match(b.stdout + b.stderr, /触发器不是只有 workflow_dispatch/);
  // 对照:PR head 上的 workflow 合法时同样的命令通过。
  const good = setupFixture(t, { workflows: [WORKFLOW_OLD, WORKFLOW_NEW] });
  const g = good.deploy({ oldWf: WF_OLD, newWf: WF_NEW, extra: prArgs });
  assert.equal(g.status, 0, `${g.stdout}\n${g.stderr}`);
});

test('源码里预检和 verifyTuple 都调用了 assertDispatchReady,且 workflow 只读一次(哈希和内容共用)', () => {
  const source = fs.readFileSync(new URL('./deploy-tuple.mjs', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/\bassertDispatchReady\(/g)].length, 3, '定义 1 处 + 预检 1 处 + verifyTuple 1 处');
  assert.match(source, /function readWorkflow\(/);
  assert.doesNotMatch(source, /sha256\(Buffer\.from\(raw/, '哈希在 readWorkflow 里和内容一起算');
});
