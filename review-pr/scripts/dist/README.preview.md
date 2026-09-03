# review-pr 预审版（preview-dist/）

本目录是 review-pr skill 的**第二个受限构建版本**，由主仓构建器从主 skill 自动生成（来源与
产物指纹见 `preview-dist/dist_manifest.json`）。它供 **submit-pr 三审的第③席（push 前预审）**
直接调用：保留主仓的完整审查能力 + 自进化账本 + 维护者分流开 issue + 产品/架构 hold，剥离两类
危险能力——(A) 合并/批准/修代码类，(B) 普通评论/通知/催办类。**它只审，不落地。**

## 1. 用途与输入

- **用途**：submit-pr 三审第③席的 push 前预审——在 PR 正式 push 之前，用本版对 draft PR 跑
  一遍完整审查链（阶段一四门 + 阶段二独立审查 + 收敛状态机制），输出内部结论。
- **输入**：draft PR 号。审查产物（回执/台账）只写本地状态目录，不产生任何 GitHub 写操作
  （除下方白名单三类）。
- 本版保留自进化账本（第 8 章 + `evolution-note.mjs` + `evolution/ledger.json` + `EVOLUTION.md`），
  但**只记账、不回推**：`sync-skill-repo.mjs push` 与 `skillRepoCommitPush` 均为只读 stub
  （恒返回 `skipped: 'dist-readonly'`），`evolution-note.mjs` 写盘后仅本地落盘，不提交不推送。

## 2. 必做配置

**必须设置 `REVIEW_PR_STATE_DIR` 指向一次性隔离目录**（如临时目录），不要指向正式巡审的
状态目录——本版会把审查状态、回执、run-log 与收敛状态写进该目录，混用会污染正式巡审的
状态账本。示例：

```bash
REVIEW_PR_STATE_DIR=$(mktemp -d) node "<preview-dist>/scripts/…"
```

其余仓库差异仍放目标仓库的 `agent-use/docs/pr-rules.json`（解析优先级不变：
`REVIEW_PR_RULES_FILE` > 目标仓库配置 > `preview-dist/config/pr-rules.json` 默认值）。

## 3. 对外写白名单（唯一允许的写面）

本版剥离了普通评论/通知/催办，**对外只允许以下三类写操作**：

1. **开讨论 issue**（产品/UI 与技术架构 gate 命中时，`product-hold.mjs` 的 issue 生命周期）；
2. **PR hold 说明评论**（转 draft 场景的说明评论，模板 D，人格与表情双关闭）；
3. **转 draft 及 release/close 收尾**（`product-release.mjs` / `close-product-issue.mjs`）。

白名单之外的一切 GitHub 写操作（approve / REQUEST_CHANGES / 合并 / 代修 / 评论催办 / 通知播报）
在本版均不可执行——相关脚本不在产物中，SKILL.md 相应章节已剥离。

## 4. 能力剥离清单

**A 类（合并/批准/修代码，文件级剥离）**：`merge-pr.mjs`、`self-approve.mjs`、
`approve-workflows.mjs`、`fix-session-state.mjs`、`fix-worktree-cleanup.mjs`；SKILL.md 5.1
（批准并合并）、5.2（REQUEST_CHANGES）、5.4（已停用的 fix-handoff）、5.5（冲突代合并）、5.6（代修合并）
整节剥离，原位保留替代说明。

**B 类（普通对外传播，文件级剥离）**：`notify-author-resolve.mjs`、`notify-merge-ack.mjs`、
`notify-merge-backfill.mjs`、`notify-summary.mjs`、`notify-sync-alert.mjs`、
`remind-stale-author.mjs`、`resolve-author-feishu.mjs`、`audit-merged-loop-prs.mjs`；模板
A/B/C/E/F 剥离，模板 D（产品/架构门告知）保留。

**保留能力**：全部审查链（阶段一四门 + 阶段二独立审查 + 收敛状态机制）、自进化第 8 章与
账本（本地落盘不回推）、5.3 维护者分流、`product-hold.mjs` / `product-release.mjs` /
`close-product-issue.mjs`、`config/pr-rules.json`（不做中性化）。

## 5. 升级与支持边界

- `preview-dist/` 与 `dist/` 同级，均为入仓生成物：**不要编辑其中的任何文件**，编辑会在下次
  构建时被覆盖。
- 构建与 freshness 校验走主仓构建器：`node scripts/build-dist.mjs --manifest scripts/preview-dist.manifest.json --out ../preview-dist`（`--check` 校验同 dist）。
- 正式巡审仍用主仓或 `dist/`；本版只服务 submit-pr 席③预审场景。
