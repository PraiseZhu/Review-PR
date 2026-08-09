# signoff-hold 变异清单（MUTATION MANIFEST）

本清单是 PR #11（`feat/signoff-gates-p1-scripts`）反向变异验证的**落盘索引**。
目的（R6-4）：此前五轮的所有变异只存在于各轮执行席的对话里——没有 ID、没有 seam 锚、
没有预期红集,第三方无法复核也无法证伪（R5 复审对 M11 只能如实标 `attribution_sound: false`）。
本清单终结该状态：每一条含 seam 锚（函数名 + 唯一代码片段,禁行号）、变异内容、
预期红集（测试名）、复现命令,可以被人照着跑出来。

统一复现前提：
- 变异在 `/tmp` 副本执行:`cp -r review-pr/{scripts,tests} <副本>/`,改副本,`cd <副本>/review-pr && node --test tests/signoff-policy.test.mjs`
- 判据：预期红集**恰好**转红（其余全绿）,失败形态为 `AssertionError`（非崩溃、非进程级错误）

---

## 一、round7 新增一条（本轮,seam 锚基于本轮 tip 代码,已实测）

### M-R7-1 去 isFinite 校验（非数值 env 让派生量变 NaN 的原始缺陷回归）

| 项 | 内容 |
|---|---|
| 目标文件 | `scripts/signoff-hold.mjs`（resolveGhCallTimeoutMs,常量区） |
| seam 锚 | `if (!Number.isFinite(n) \|\| n <= 0) { ... return { ms: GH_CALL_TIMEOUT_DEFAULT_MS, state: 'fallback' }; }` |
| 变异内容 | 去掉 `!Number.isFinite(n) \|\|`,退回 `if (n <= 0) {`——`Number('abc')=NaN` 不再走回落,NaN 经 `Math.max(1, Math.floor(NaN))` 带进 `GH_CALL_TIMEOUT_MS`/派生预算 |
| 预期红集 | `signoff: R7-1 非数值 env——回落默认 15000,派生量全有限,三态可分辨(abc/Infinity/-Infinity/空串/纯空格)` 与 `signoff: R7-1 主流程——非数值 env 不再崩溃,回落默认 + 双通道警告(stderr + JSON warnings)`（T/预算 finite 断言与 state=fallback 断言转红;数值形态的 0/-1 回落不受影响,R6-1 保持全绿） |
| 复现命令 | 变异后 `node --test tests/signoff-policy.test.mjs`,断言输出 `T("abc") 必须为有限正整数,实际 NaN` |
| 本轮实测 | 恰红 2 条,全部 `AssertionError: T("abc") 必须为有限正整数,实际 NaN`,其余 56 条全绿,无崩溃 |

---

## 二、round6 新增三条（seam 锚基于 R6 tip 代码;R7-1 重构后 M-R6-1 锚点已更新,其余两条锚点未变,三条均已在 R7 tip 复验仍红）

### M-R6-1 去钳位（租约不等式失效）

| 项 | 内容 |
|---|---|
| 目标文件 | `scripts/signoff-hold.mjs`（resolveGhCallTimeoutMs,常量区） |
| seam 锚 | `if (ms > CLAMP_CAP_MS) { ... return { ms: CLAMP_CAP_MS, state: 'clamped' }; }`（R7-1 重构后锚点;R6 原锚为 `export const GH_CALL_TIMEOUT_MS = Math.min(Math.max(RAW_GH_CALL_TIMEOUT_MS, 1), CLAMP_CAP_MS);`） |
| 变异内容 | 钳位分支直接返回未钳值:`return { ms: CLAMP_CAP_MS, state: 'clamped' };` → `return { ms, state: 'none' };`（即 R5 的 `Number(env \|\| 15000)` 无上限形态;警告分支保留,与原 R6 变异语义一致） |
| 预期红集 | `signoff: R6-1 租约耦合——T 钳位/回落默认与派生预算,断言生效后的派生量(unset+8 数值形态+300000)`（300000/45001/1e12 的 expectedT 与 state 断言转红） |
| 复现命令 | 变异后 `node --test tests/signoff-policy.test.mjs`,断言输出 `300000 !== 45000`（T(300000) 不再被钳） |
| 本轮实测 | R6 实测恰红 1 条（`AssertionError: T(300000) 生效值(钳位后) 300000 !== 45000`,其余 55 条全绿）;R7-1 重构后复验:恰红 1 条（同 R6-1 测试,58 条中 57 绿）,AssertionError |

### M-R6-2 去预留（可延后循环吃光预算饿死真正 hold）

| 项 | 内容 |
|---|---|
| 目标文件 | `scripts/signoff-hold.mjs`（main() reconcile 接线） |
| seam 锚 | `const reconcile = dryRun ? null : reconcileDuplicateHoldIssues({ slug, urls: markerUrls, ghFn: ghD });` |
| 变异内容 | `ghFn: ghD` → `ghFn: ghE`（可延后循环与不可延后调用共享同一池,且循环排在 `issue create` 之前） |
| 预期红集 | `signoff: R6-2 预算分层——可延后吃光额度不影响必要路径(issue create 仍发出,饿死不可达)`；附带红 `signoff: D2 对账上界——主流程接线` 与 `signoff: R6-3 主流程多轮收敛`（同根因:reconcile 吃光池后 issue view / label create / label POST 全部 budgetExhausted,held=false） |
| 复现命令 | 变异后 `node --test tests/signoff-policy.test.mjs` |
| 本轮实测 | 恰红 3 条（R6-2 核心断言 `issue create 必须发出` 转红 + 2 条同根因附带红）,全部 AssertionError |

### M-R6-3 固定切片（对账永不前进）

| 项 | 内容 |
|---|---|
| 目标文件 | `scripts/signoff-hold.mjs`（reconcileDuplicateHoldIssues） |
| seam 锚 | `const openDups = entries.slice(1).filter((d) => openNumbers.has(d.number));` |
| 变异内容 | 退回固定切片、不看状态:`const openDups = entries.slice(1);`（每轮取同一段已关闭的重复,后面的永远轮不到） |
| 预期红集 | `signoff: R6-3 多轮收敛——10 个重复连续跑到 0,每轮剩余严格递减,已关的不再消耗` 与 `signoff: R6-3 主流程多轮收敛——10 个重复 3 轮跑完...` |
| 复现命令 | 变异后 `node --test tests/signoff-policy.test.mjs`,断言输出 `closed:[2,3,4]` 四轮不变、`remaining_open:6` 不减 |
| 本轮实测 | 恰红 2 条,断言输出与 R5 复审实测一致（每轮 `closed=[2,3,4] unprocessed=[5..10]`,open 集合不变） |

---

## 三、round5（MUTA/MUTC 与 M01-M08 系）

R5 轮次的变异是**对测试断言的变异**（隔离性/必要性判据）,由 R5 commit 声称如下,但
seam 锚未随 R5 落盘（这正是 R6-4 要终结的现状,以下如实标注可核范围）：

| ID | 内容（R5 commit 声称） | seam 锚 | 状态 |
|---|---|---|---|
| M02 | 目标断言单删即转绿（断言必要性成立） | 未落盘 | 对话内变异,无锚,无法独立复跑 |
| M01 / M03 / M07 | 断言合取绑定（单删仍红,删合取集转绿） | 未落盘 | 同上 |
| MUTA | 恰红 2 条目标测试（R5 commit） | 未落盘 | 同上 |
| MUTC | 恰红 3 条目标测试（R5 commit） | 未落盘 | 同上 |
| M11 等其余 | 复审核验时无法绑定到任何对象（`attribution_sound: false`） | 未落盘 | 同上 |

> R5 commit 原文（4ebb411）：「M02 目标断言单删即转绿;M01/M03/M07 为断言合取绑定
> （单删仍红,删合取集转绿),如实记录。」

---

## 四、round3 / round4（15 条 = R3 七条 + R4 八条）

R4 commit（45a1150）声称「变异验证 15/15 转红（七条 R3 反向变异 + 八条本轮）,全部断言
失败零崩溃」。以下为**可从测试文件锚点与 commit 声称重建**的条目；未列出者属对话内
变异（无 seam 锚）,已在「四、黑洞清单」如实标注。

### R3 七条反向变异（可锚定部分）

| ID | seam 锚（函数 + 唯一片段） | 变异内容 | 预期红集（测试名） |
|---|---|---|---|
| R3-m1 | `tryTakeoverStaleLock` 的两阶段抢占（`.takeover` sibling 文件 + 写后复核 token） | 移除 takeover 阶段,直接 unlink+recreate 主锁 | `signoff: mutation①探针——stale 主锁 + 新鲜 takeover 残留必须等待不抢(移除两阶段 takeover 会转红)` |
| R3-m2 | `isLockStale` 的 `Date.now() - startedAt > LOCK_STALE_MS` 时间子句 | 去掉时间判据,退回纯 `isPidAlive` 判定 | `signoff: mutation②探针——死 pid + 新鲜 startedAt 的锁必须回收(isPidAlive 恒 true 会转红)` |
| R3-m3 | `isMainModule` 的 `realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)` 归一化比较 | 退回裸字符串 `===` 比较 | `signoff: 入口守卫-symlink 调用(realpathSync 穿透符号链接)`、`-带空格路径`、`-中文路径` 三条 |
| R3-m4 | `releaseHoldLock` 的 unlink 失败分支 `if (e.code === 'ENOENT')` | 非 ENOENT（EACCES/EBUSY 等）也报 `alreadyAbsent: true` | `signoff: #6 releaseHoldLock 非 ENOENT unlink 失败必须带 unlinkError,不伪装 alreadyAbsent` |
| R3-m5 | `acquireHoldLock` 的 `openSync(path, 'wx')` 排他 + 超时分支 | 恒返回 acquired（不互斥） | `signoff: acquireHoldLock 首次获取 + 占用时超时(非总是成功,非静默)`（mutation④ 探针） |
| R3-m6 | `tryTakeoverStaleLock` 的超 TTL 残留清理重试分支 | 残留 takeover 文件永不清理（永久阻塞） | `signoff: D3 自愈——超 TTL 的 takeover 残留清理后重试,不永久堵死` |
| R3-m7 | `readTakeoverInfo` 的 JSON 解析（{startedAt, token}） | 退回裸 pid 字符串写入,TTL 无从计算 | `signoff: D3 自愈——round2 裸 pid 格式的 takeover 残留同样自愈` |

### R4 八条反向变异（可锚定部分）

| ID | seam 锚（函数 + 唯一片段） | 变异内容 | 预期红集（测试名） |
|---|---|---|---|
| R4-m1 | `acquireHoldLock` 的 `writeOwn` 写入 `new Date().toISOString()` | 改回数字毫秒时间戳（Date.parse → NaN） | `signoff: D1 写入格式为 ISO 8601 字符串(不再写数字)`、`signoff: D1 端到端——生产写入锁文件读回...` |
| R4-m2 | `ghT` 的 `timeoutMs: GH_CALL_TIMEOUT_MS` | 去掉超时包装（裸 gh 调用） | `signoff: D2 挂住的 gh 调用被超时杀掉——临界区不可能无限挂住` |
| R4-m3 | `main()` 的 `const lock = dryRun ? null : acquireHoldLock(owner, repo, pr);` | 删除 acquireHoldLock 接线（无锁） | `signoff: D3 真并发双子进程——恰好 1 issue + 1 评论(锁串行化)`（测试注释明说删接线转红） |
| R4-m4 | 入口守卫误判分支的 `print({ ok:false, error:'entry-guard-misclassified', ... }) + process.exit(1)` | 只写 stderr、exit 0（静默 fail-open） | `signoff: D4 入口守卫误判(--preserve-symlinks-main)必须 stdout JSON 错误 + 非零退出,不再静默 fail-open` |
| R4-m5 | `releaseHoldLock` 读失败分支 `if (e.code === 'ENOENT')` | 非 ENOENT 读失败也报 alreadyAbsent | `signoff: D5 releaseHoldLock 读失败(chmod 000)→ readError + 非 alreadyAbsent + 文件仍在` |
| R4-m6 | `tryTakeoverStaleLock` 重建块 `if (e instanceof ReferenceError \|\| e instanceof TypeError) throw e;` | 宽 catch 吞掉编程错误（ReferenceError 静默降级） | `signoff: D6 takeover 重建块编程错误(ReferenceError)必须重抛,不留 0 字节锁` |
| R4-m7 | `reconcileDuplicateHoldIssues` 整函数在 `main()` 的接线 | 删除对账调用（双写后不自愈） | `signoff: D2 对账——多份 hold issue 保留最早...` 系列、`signoff: D2 对账主流程接线——双写残留自愈,保留最早 issue` |
| R4-m8 | `syncSignoffLabel` 失败路径的 `errors.push` → `withWarning` | 标签失败不设 warning / labelsOk 被写死 | `signoff: labelsOk 判别——标签 POST 失败 → held=false 点名 labels(mutation③ 探针)`、`signoff: D5 解耦——legacy 清理失败不连坐 labelsOk(mutation③ 探针)` |

---

## 五、黑洞清单（对话内变异,无 seam 锚——如实声明）

R3 七条 + R4 八条 = 15 条的**精确划分**、以及 R5 的 M01/M03/M07/MUTA/MUTC 的 seam 与
红集明细,只存在于各轮执行席对话,本仓无任何落盘。以上「可锚定部分」按测试文件探针
注释与 commit 声称重建,编号（m1..m8）为本清单自拟,不代表原轮次编号。R5 复审核 M11
时的结论（`attribution_sound: false`）即针对这类条目——**自本轮起,所有新变异一律
先入本清单再执行**,杜绝再产生无锚变异。
