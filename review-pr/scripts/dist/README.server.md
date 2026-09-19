# review-pr 服务器席分发版（review-pr-server/）

本目录是仓内独立 skill，给**审查机独立席**用，由主仓构建器从 `review-pr/` 生成。入口是独立席，不再派 sub，不含个人仓台账回传与对外汇总。

人工交互审查请继续用仓库里的 `review-pr/`，不要用本目录。

## 1. 本产物做什么

- 席读取编排器写入的 Context / Rules / Task semantics
- 只跑 `scripts/review-server.mjs next` 取分段
- 交 `schemaVersion: "rro-1"` 答卷
- 审查质量十维（第 10 维是本席交卷，不是再派 general-purpose）

## 2. 本产物不做什么

- 不自动接到插件仓 seat1。当前审查机仍拷人工 `review-pr/` 树；要换加载路径需另开插件仓 PR。
- 不派 Agent / Skill 子审查席
- 不写台账、不回传个人仓
- 不合并、不发 GitHub 评论、不跑 auto 汇总

## 3. 谁跑门控

`prepare` / `bind` / `finalize` 由可信宿主执行。席不重跑 `context.mjs` / `review-preflight.mjs`。

## 4. 不要编辑

不要改 `review-pr-server/` 里的文件。下次构建会覆盖。
