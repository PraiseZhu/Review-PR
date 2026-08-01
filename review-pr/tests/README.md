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

## 判定逻辑单一来源

所有测试直接 import `../scripts/lib.mjs` 的导出函数(`classifyRequiredChecks`、
`findApproveMergeAuthorization`、`decideStructuralBypassRoute`、
`evaluateAuthorizedFastMerge`),不重新实现判定逻辑——这些函数本身就是
`context.mjs` 与 `pre-merge-check.mjs` 共用的单一判据来源(防两处漂移),测试只
验证这一份来源的行为。
