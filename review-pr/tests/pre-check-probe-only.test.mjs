// pre-check.mjs --probe-only 的只读性测试(SC-D,2026-08-04 #469 复盘)。
// 背景:pre-check 自称 precheck,实际有三类副作用——skillRepoPull(动 skill 仓工作区)、
// notify-merge-backfill(可能对外发消息)、.skill-diverged 状态写入。"验证调度时只跑
// pre-check"这句话此前本身就会重演副作用。--probe-only 必须做到:
//   ① 状态目录跑前跑后逐字节一致(零本地状态写);
//   ② fake gh 只见只读子命令(零写调用);
//   ③ 不 spawn notify-merge-backfill(fake gh 日志里没有它会发起的调用);
//   ④ decision JSON 照常输出并带 probeOnly:true。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'pre-check.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');

// 只对**文件**做摘要:lib.mjs 模块加载期会 mkdir 状态目录骨架(空目录,无数据),那是
// 无害准备动作,不算状态写入;本测试守的不变量是「probe-only 零数据落盘」。
function dirDigest(root) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`F:${p.slice(root.length)}:${readFileSync(p)}`);
    }
  };
  if (existsSync(root)) walk(root);
  return h.digest('hex');
}

test('--probe-only:零状态写、零 gh 写调用、不 spawn backfill、输出带 probeOnly', () => {
  const work = mkdtempSync(join(tmpdir(), 'probe-only-test-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git']);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const fixtures = join(work, 'fixtures');
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, 'pr-list.json'), JSON.stringify([{ number: 483, isDraft: false }]));
  const log = join(work, 'gh-calls.jsonl');
  chmodSync(join(FAKE_GH_DIR, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAKE_GH_FIXTURE_DIR: fixtures,
    FAKE_GH_LOG: log,
    REVIEW_PR_STATE_DIR: stateDir,
  };
  const before = dirDigest(stateDir);
  const r = spawnSync('node', [SCRIPT, '--repo-root', repo, '--probe-only'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.decision, 'run');
  assert.equal(out.probeOnly, true);
  assert.equal(out.candidateCount, 1);
  // ① 状态目录逐字节一致
  const listAll = (d) => { const acc = []; const w = (x) => { for (const e of readdirSync(x)) { const q = join(x, e); if (statSync(q).isDirectory()) w(q); else acc.push(q); } }; if (existsSync(d)) w(d); return acc; };
  assert.equal(dirDigest(stateDir), before, `probe-only 不得写任何本地状态;多出的文件: ${JSON.stringify(listAll(stateDir))}`);
  // ② 零写调用 ③ 无 backfill 痕迹(backfill 会调 gh pr list --search merged 之类;
  //   这里更强:全部调用只允许这一条 pr list)
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(calls.filter((c) => c.isWrite).length, 0);
  assert.equal(calls.length, 1, `probe-only 只应有一次 gh pr list 只读调用,got: ${JSON.stringify(calls.map((c) => c.args.slice(0, 3)))}`);
});
