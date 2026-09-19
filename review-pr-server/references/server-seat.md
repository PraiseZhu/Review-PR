# 服务器席契约

> 本文件只服务 `server/SKILL.md` 入口。人工交互审查走完整 skill，不要把派席流程写进服务器席。

## Contents

- 本席身份
- 分段 next
- rro-1 交卷
- 宿主才跑的命令

---

## 本席身份

服务器席就是独立审查席。编排器已经准备 Context、Rules、Task semantics 和 session。本席：

- 不 invoke 完整 `review-pr` Skill
- 不创建 Agent / 子进程审查席
- 不跑阶段二派工脚本
- 不写台账、不回传个人仓
- 不 `git push` 个人仓
- 不合并、不发 GitHub 评论

## 分段 next

唯一允许的 skill 命令：

```text
node "<SKILL_ROOT>/scripts/review-server.mjs" next --session <Session> --order <N>
```

第二段起必须带上一份答卷：

```text
node "<SKILL_ROOT>/scripts/review-server.mjs" next --session <Session> --order <N> \
  --previous-answer <server-answers/上一段.json>
```

每段答卷必须原样保留 `segmentId`、`receivedOrder`、`snapshotHash`、本段全部 `coverageKeys`。乱序、跳段、提前声称覆盖一律无效。

`deliver-review-segment.mjs` 由 next 内部调用，本席不要直接跑。

## rro-1 交卷

最终文件路径以任务书 **Final answer** 为准，通常是工作树 `server-answers/model-answer.json`。

必填：

- `schemaVersion: "rro-1"`
- `snapshotHash` 与任务书一致
- `segmentReceipts` 覆盖已投递的每一段
- `findingFamilies` 只含 P0/P1
- required 负向证据只能 `executed`
- 未跑过的验证写 `verificationGaps`，不得写成通过

clean 只能由宿主 `consume-review-output.mjs` 判定。本席自报 pass 无效。禁止空 findings 代交，禁止沿用上次清白。

## 宿主才跑的命令

下列命令由可信编排器执行，本席正文不得当作「你去跑」：

- `review-server.mjs prepare`（内部会跑 context / preflight / build-review-task）
- `review-server.mjs bind`
- `review-server.mjs finalize`

本席只读它们写进任务书的 Context / Rules / Task semantics。
