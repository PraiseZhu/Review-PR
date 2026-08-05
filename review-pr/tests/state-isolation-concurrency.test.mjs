// state-isolation-concurrency.test.mjs — 第 4 轮核验 R0:默认全量测试的跨进程状态隔离。
//
// 事故:核验席同时启动两份默认 `node --test`,主线程 432/432,另一份 431/432——
// convergence-state.test.mjs 的状态文件在断言之前被另一个进程的 resetPr() 删掉。两份跑
// 共用真实持久 STATE_DIR + 同一批固定 PR 号,互相拆台。
//
// 三层锁:
//   ① 机制层(确定性):两个不预置 REVIEW_PR_STATE_DIR 的子进程分别 import helper +
//      lib.mjs,拿到的 STATE_DIR 必须**互不相同**且落在临时目录下;
//   ② 接线层:helper 有没有被真的接进两个写状态的测试文件——由 static-source-hygiene
//      的顺序守卫钉死(那里删掉 import 即红);
//   ③ 端到端(复现层):同一份状态密集测试文件双进程并发跑,两边都必须绿。竞态本身有
//      概率性,所以它只是复现尝试,真正的回归锁是 ① 与 ②——如实声明。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_URL = new URL('./helpers.isolated-state-dir.mjs', import.meta.url).href;
const LIB_URL = new URL('../scripts/lib.mjs', import.meta.url).href;

/** spawn 一个子进程并拿到 { code, stdout, stderr }(不抛)。 */
function run(args, { env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

/** 干净 env:抹掉本进程可能带的 REVIEW_PR_STATE_DIR,让 helper 自己分配。
 *  同时抹掉 NODE_TEST_CONTEXT —— 本文件自己跑在 `node --test` 的子进程里,该变量会被
 *  继承,让**孙进程**误以为自己也是 test runner 的子进程,于是把结果写进 v8 序列化通道、
 *  stdout 空且 exit 0(第一版实测:断言"两边都绿"完全真空)。 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.REVIEW_PR_STATE_DIR;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('① 机制层:两个子进程各自 import helper 后拿到的 STATE_DIR 互不相同', async () => {
  const code = `await import(${JSON.stringify(HELPER_URL)});
const { STATE_DIR } = await import(${JSON.stringify(LIB_URL)});
process.stdout.write(STATE_DIR);`;
  const [a, b] = await Promise.all([
    run(['--input-type=module', '-e', code], { env: cleanEnv() }),
    run(['--input-type=module', '-e', code], { env: cleanEnv() }),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(a.stdout.length > 0 && b.stdout.length > 0, '子进程应打印 STATE_DIR');
  assert.notEqual(a.stdout, b.stdout, `两个进程拿到同一个 STATE_DIR(${a.stdout})——隔离没生效`);
  for (const p of [a.stdout, b.stdout]) {
    assert.ok(p.includes('review-pr-state-'), `隔离目录应由 helper 在临时目录下分配:${p}(tmp=${tmpdir()})`);
  }
});

test('② 对照组:显式预置 REVIEW_PR_STATE_DIR 时 helper 不覆盖(宿主指定目录仍生效)', async () => {
  const shared = join(tmpdir(), `review-pr-state-explicit-${process.pid}`);
  const code = `await import(${JSON.stringify(HELPER_URL)});
process.stdout.write(process.env.REVIEW_PR_STATE_DIR);`;
  const r = await run(['--input-type=module', '-e', code], { env: { ...process.env, REVIEW_PR_STATE_DIR: shared } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, shared, 'helper 不得覆盖外部显式指定的状态目录');
});

test('③ 复现层:convergence-state.test.mjs 双进程并发跑,两边都绿', async () => {
  const args = ['--test', join('tests', 'convergence-state.test.mjs')];
  const [a, b] = await Promise.all([
    run(args, { env: cleanEnv() }),
    run(args, { env: cleanEnv() }),
  ]);
  assert.equal(a.code, 0, `并发第 1 份失败:\n${a.stdout.slice(-3000)}\n${a.stderr.slice(-2000)}`);
  assert.equal(b.code, 0, `并发第 2 份失败:\n${b.stdout.slice(-3000)}\n${b.stderr.slice(-2000)}`);
  // 非真空自检:两个子进程必须**真的**跑完了那一整份状态密集测试(否则 exit 0 毫无意义)
  for (const [i, r] of [a, b].entries()) {
    const m = r.stdout.match(/^ℹ pass (\d+)$/m);
    assert.ok(m, `第 ${i + 1} 份没有 pass 汇总行,说明它根本没跑测试:${r.stdout.slice(-500)}`);
    assert.ok(Number(m[1]) >= 50, `第 ${i + 1} 份只跑了 ${m[1]} 条,远少于该文件的规模——并发断言是真空的`);
    assert.match(r.stdout, /^ℹ fail 0$/m);
  }
});
