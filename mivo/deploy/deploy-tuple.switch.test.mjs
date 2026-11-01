// deploy-tuple.mjs 真正切换的命令行行为(hold 停点,不带 --pr):夹具见 deploy-tuple.fixture.mjs。
// 临时 HOME 当作 Mini,gh 替身带状态,launchctl 替身让前置审查算「已停用」。没有 trust 文件、ssh 一调用就记下来:
// 换版本不需要 Pro、Air(PraiseZhu/Review-PR#161)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupFixture, WORKFLOW_NEW, WORKFLOW_OLD, WF_NEW, WF_OLD } from './deploy-tuple.fixture.mjs';

const STATE = 'mivo-prereview/state/mivo/mivo';

test('整组换版本成功:变量和 Mini 检出都到新提交,核对通过,停点、锁、维护标记都清掉,不用 ssh、不读 trust', (t) => {
  const f = setupFixture(t);
  const r = f.deploy();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /整组上线完成/);
  assert.match(r.stdout, /tuple 核对通过/);
  assert.equal(f.ghState().variable, f.newSkill);
  assert.deepEqual(f.ghState().sets, [f.newSkill]);
  assert.equal(f.checkoutHead(), f.newSkill);
  assert.equal(f.exists(`${STATE}/deploy-hold.json`), false, '停点标记已删');
  assert.equal(f.exists(`${STATE}/deploy-tuple.lock`), false, '部署锁已释放');
  assert.equal(f.exists('mivo-prereview/monitor/scripts/schedule-checks/pause-until.json'), false, '巡检维护标记已删');
  assert.equal(fs.existsSync(f.sshLog), false);
  assert.equal(f.exists('.claude'), false);
  const [record] = f.records();
  assert.deepEqual(record.switched, ['variable', 'checkout']);
  assert.ok(record.phases.some((p) => p.name.startsWith('tuple 核对通过')));
  assert.ok(!JSON.stringify(record).includes('trust'), '部署记录里没有 trust');
});

test('切换后 main 上的 workflow 不是新值:核对失败,变量和检出整组退回,前置照旧,exit 1', (t) => {
  // 读 workflow 依次是:预检(新)→ 切换后核对(旧,不对)→ 退回后核对旧 tuple(旧,和 --old-wf 一致)。
  const f = setupFixture(t, { workflows: [WORKFLOW_NEW, WORKFLOW_OLD, WORKFLOW_OLD] });
  const r = f.deploy();
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`核对失败:main 上 \\.github/workflows/review-pr\\.yml 是 ${WF_OLD},不是 ${WF_NEW}`));
  assert.match(r.stdout, /已整组退回旧 tuple/);
  assert.deepEqual(f.ghState().sets, [f.newSkill, f.oldSkill], '先切到新、再退回旧');
  assert.equal(f.ghState().variable, f.oldSkill);
  assert.equal(f.checkoutHead(), f.oldSkill);
  assert.equal(f.exists(`${STATE}/deploy-hold.json`), false);
  assert.equal(f.exists(`${STATE}/deploy-tuple.lock`), false);
  assert.equal(fs.existsSync(f.sshLog), false);
});

test('核对失败、退回后 workflow 既不是旧值也不是新值:保持停止(停点标记留着),exit 2,变量和检出仍退回', (t) => {
  const f = setupFixture(t, { workflows: [WORKFLOW_NEW, '第三个版本\n', '第三个版本\n'] });
  const r = f.deploy();
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /保持停止,没有 bootstrap/);
  assert.match(r.stdout, /退回后整组 tuple 不一致/);
  assert.equal(f.ghState().variable, f.oldSkill);
  assert.equal(f.checkoutHead(), f.oldSkill);
  assert.equal(f.exists(`${STATE}/deploy-hold.json`), true, '停点标记留给人工处理');
  assert.equal(f.exists(`${STATE}/deploy-tuple.lock`), false, '锁仍按内容释放');
});

test('预检时仓库变量已被别人改了:什么都不切,不留停点', (t) => {
  const f = setupFixture(t, { variable: 'e'.repeat(40) });
  const r = f.deploy();
  assert.equal(r.status, 1);
  assert.deepEqual(f.ghState().sets, []);
  assert.equal(f.checkoutHead(), f.oldSkill);
  assert.equal(f.exists(`${STATE}/deploy-hold.json`), false);
  assert.equal(f.exists(`${STATE}/deploy-tuple.lock`), false);
});
