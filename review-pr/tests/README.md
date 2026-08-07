# review-pr 回归测试

三层分级合并策略(structural-check 分级 bypass + 授权快速合并通道)的回归防线,
2026-08-01 建立。纯 Node 内置 `node:test` + `node:assert/strict`,零第三方依赖,
不引入 `package.json`。

## 跑测试

```bash
cd review-pr
node --test "tests/*.test.mjs"
```

`node --test tests`(裸目录)在当前 Node 版本下不会递归发现测试文件,必须显式给
glob。单跑一个文件同理:`node --test tests/lib.decide-structural-bypass-route.test.mjs`。

## 文件说明

- `lib.classify-required-checks.test.mjs`——required/非 required 检查分类(授权快速
  合并通道 CI 口径的基础)。
- `lib.find-approve-merge-authorization.test.mjs`——`/approve-merge` 授权检测
  (admins 名单、机器人排除、独占一行、晚于最后一次 push、fail-closed)。
- `lib.decide-structural-bypass-route.test.mjs`——结构性 BLOCKED 三层分级路由,
  直接复现 PR #342/#366 型零 review fail-open 场景。
- `lib.evaluate-authorized-fast-merge.test.mjs`——授权快速合并通道机械前提判定,
  含 2026-08-01 owner 裁决新增的两条("格式门未过"与"未 resolve thread"不再阻断,
  改为 `reportOnly`)以及三类任何情况不可绕过的硬阻断(泄密硬门 / 物理冲突 /
  required 检查未全绿)的回归防线。
- `integration.authorized-fast-merge.live.test.mjs`——端到端:对真实 GitHub 数据
  (只读 GraphQL,不产生任何写操作)跑完整链路,验证纯函数单测之外「真实数据形状」
  也能被正确消费。**不落地任何 PR 数据快照文件**——查询在测试运行时现场发出,避免
  仓库里出现可能包含敏感内容的静态 fixture。需要已认证的 `gh` CLI + 网络;
  离线/CI 环境会通过 `t.skip()` 自动跳过,不会让整个套件失败,核心正确性由同目录
  的纯函数单测保证。
- `lib.validate-finding-family.test.mjs`——独立代码审查输出契约(SKILL 第 4 节第 6
  条「family 归族」,conv/output-contract)的形状校验:`family_id`/`invariant`/
  `severity`/`manifestations[]`/`fixGuidance` 字段是否存在、severity 取值是否合法、
  family severity 是否等于成员最高。反向变异覆盖:预先列出「预测红集」(逐个改坏
  一个字段),断言红集与实际失败恰好一一对应。只验形状,不判断多条 manifestation
  是否真的同属一个不变量——那是审查 agent 的语义判断,机器不能代它下结论。
- `lib.invariant-slug.test.mjs`——`invariantSlug`(**仅供人类阅读的展示文本,不是
  任何 join key**)的确定性归一化行为:同输入同输出、大小写归一、内部空白归一
  (含中英文混排/多空格/tab/换行)、截断边界(恰好 64 / 超过 64)、非法输入
  (非字符串/空串/纯空白)必须 `throw` 而不是返回空字符串。另含一条文档漂移断言:
  SKILL.md 的 thread marker 规范必须写 `invariantKey`、且不得回退成 slug。
  > 2026-08-02 对抗审阻断修正:本条**原文**把 `invariantSlug` 写成「SKILL 5.0 跨轮
  > 识别"同 family 复发"的一级/确定性判定用 join key」,还把截断碰撞写成「**已知的**
  > 截断碰撞」——那正是本轮专门删掉的**错误契约**,它在这份测试文档里原地存活了下来。
  > 跨轮身份的唯一权威是 `invariantKey`(`ik1-` + 完整 64 位 hex,**不截断**),
  > 见 `lib.invariant-key.test.mjs`。slug 撞车之所以无所谓,前提是它没有任何机器
  > 消费者;一旦有(上一版的 thread marker 就是),它立刻变成一个真缺陷。

## 判定逻辑单一来源

多数测试直接 import `../scripts/lib.mjs` 的导出函数(`classifyRequiredChecks`、
`findApproveMergeAuthorization`、`decideStructuralBypassRoute`、
`evaluateAuthorizedFastMerge`),不重新实现判定逻辑——这些函数本身就是
`context.mjs` 与 `pre-merge-check.mjs` 共用的单一判据来源(防两处漂移),测试只
验证这一份来源的行为。`lib.validate-finding-family.test.mjs`/`lib.invariant-slug.test.mjs`
是例外:它们测的是 `../scripts/lib.review-output-shape.mjs`,一个独立于 `lib.mjs`
的纯函数模块(审查输出契约的形状校验 + 跨轮 join key 归一化,不涉及 gh/git 状态,
故意不并入 `lib.mjs`)。

## automated-review-gate wave0(2026-08-08):合并授权策略测试

本波把「自动审查闸」的策略锁成测试:正常自动合并均需 current-head clean receipt,
人工 break-glass 是唯一例外。契约与文件映射:

| 契约 | 锁定文件 |
|------|---------|
| SC-1:approval 必须绑定当前 head(四 basis 中只有 independent / own-account@head 作数,stale/none 一律不作数) | `lib.merge-authorization-policy.test.mjs` + `premerge-approval-basis.test.mjs` |
| SC-2:approved shortcut = 聚合裁决 ∧ head 绑定 ∧ own-account 配置约束三条件合取;判定 head 与执行 head 的原子护栏(merge-pr 强制 --match-head 且 gh 命令带 --match-head-commit) | `lib.merge-authorization-policy.test.mjs` + `merge-pr.test.mjs` |
| SC-3:break-glass 唯一合法形态 = admins 成员人工 + 未编辑 + 独占一行 + 当前 head SHA;bot/非 admin/edited/stale/裸格式/head 缺失一律不授权 | `lib.merge-authorization-policy.test.mjs` + `lib.find-approve-merge-authorization.test.mjs` + `premerge-approval-basis.test.mjs` + `context-scan-wiring.test.mjs` |
| SC-4:break-glass 机械前提(泄密扫描未完成/硬命中、物理冲突、required 检查未全绿或读取失败)不可绕过;硬阻断时 reportOnly 不吞信号 | `lib.merge-authorization-policy.test.mjs` + `lib.evaluate-authorized-fast-merge.test.mjs` |
| SC-5:loop 托管 PR 无条件封死 break-glass;「唯一例外」不豁免事后审计 | `lib.merge-authorization-policy.test.mjs` + `pkg-a.review-gates.test.mjs` + `premerge-approval-basis.test.mjs` |
| SC-6:自动化不得生成授权评论(字面量只允许在解析/消费文件;投递脚本零字面量;canary 保证 detector 可观测) | `static-break-glass-origin.test.mjs` |

- `lib.merge-authorization-policy.test.mjs`(新)——合并授权策略矩阵:四 basis 分类、
  shortcut 三条件合取、break-glass 唯一形态表、机械前提预测红集。策略层组合断言,
  不重复各单测文件的逐函数矩阵。
- `static-break-glass-origin.test.mjs`(新)——自动化不得生成授权评论的静态纪律
  (与 `static-merge-inventory.test.mjs` 同款):`/approve-merge` 字面量只允许出现在
  `lib.mjs`/`context.mjs`/`pre-merge-check.mjs` 三个解析/消费文件,且这些文件不得含
  评论投递调用点;任何评论投递脚本的非注释代码行零字面量。SC-6d 是 detector 的
  canary(植入违规必须被抓住、纯注释提及不得误伤),防"现在碰巧没违规"的侥幸。
- 反向变异纪律(SC-1..SC-5 各文件):表驱动「预测红集」——每个输入维度逐一变异,
  断言翻转恰红在目标字段/理由上,不是靠别的维度碰巧红。
