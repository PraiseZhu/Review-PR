---
schema: mivo-pr-handoff/v1
kind: review
pr: 77
---

## 2. 改动地图

```
| 触发入口 | 改动点 | 直接下游 | 必须保持的不变量 |
| 假表头 | `src/ghost.ts` | x | 代码块里的假表格 |
```

| 触发入口 | 改动点 | 直接下游 | 必须保持的不变量 |
|---|---|---|---|
| a | b | c | d |

## 3. 风险清单

### R1：围栏假结构
- 触发：真实触发，见 `src/alpha.ts`

```
### R9：代码块里的假 R
- 触发：假的 `src/ghost.ts`
```

<!--
### R8：注释里的假 R `src/ghost.ts`
-->

> ### R7：引用块里的假 R `src/ghost.ts`

- 怎么证明我错了：看 [链接](src/beta.ts) 的行为
