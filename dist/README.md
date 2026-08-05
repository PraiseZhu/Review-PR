# review-pr 分发版（dist/）

本目录是 review-pr skill 的**只读分发版**，由主仓构建器从主 skill 自动生成（来源与产物指纹见
`dist_manifest.json`）。它剥离了维护者侧的台账数据与写回上游的能力，审查机制本身完整保留。

## 1. 使用

- 直接 `git clone` 本仓库，把 skill 加载路径指向 `dist/`（软链或配置均可）。**推荐 clone，不推荐 fork**：
  你不需要写权限，clone + pull 即可持续获得更新。
- `dist/` 本身也是只读生成物：**不要编辑 dist/ 内的任何文件**，你的编辑会在下次同步时被覆盖，
  且立即退出支持路径（见第 4 节）。

## 2. 配置

所有仓库差异放在**你的目标仓库**的 `agent-use/docs/pr-rules.json`（解析优先级：
`REVIEW_PR_RULES_FILE` 环境变量 > 目标仓库 `agent-use/docs/pr-rules.json` > `dist/config/pr-rules.json`
中性默认值）。字段说明见 `dist/config/pr-rules.json` 顶部 `_comment`。
本分发版默认配置里的人员名单/通知收件人均为空值——按需在你的仓库配置里填自己的。

## 3. 升级

```bash
git -C <本仓库> rev-list --count origin/main..HEAD   # 必须为 0(无本地领先提交)才能安全升级
git -C <本仓库> pull --ff-only
```

- 升级前先跑上面第一条自检：输出非 0 说明你有本地改动，pull 不再保证 fast-forward，
  需要自行 rebase 或弃改——这不在支持路径内。
- 可按 tag（`review-pr-dist-vYYYY.MM.DD.N`）pin 版本：tag 一经发布不会被移动或覆盖。

## 4. 支持边界

官方支持路径 = **clone 主仓 + 只消费 dist/ + 配置放你自己仓库的 pr-rules.json**。以下行为退出支持路径，
后果自担：fork 后修改任何文件、直接编辑 dist/、依赖 dist/ 之外的主仓内部文件。

## 5. 反馈

问题走本仓库 issue。请只包含**最小复现与公开信息**：不要贴 token、完整原始日志、内部仓库细节。
维护者会把有效问题收进主仓维护台账跟进（只记录 issue 链接、标题摘要与根因指纹，不复制正文）。

## 6. 隐私边界

- 本分发版不含维护者侧历史台账数据；`evolution/` 台账目录在你本地运行时按机制自动重建，属于
  **你自己的本地状态**，不会也无法回推到上游（写回能力已在构建时剥离，`sync-skill-repo.mjs push`
  恒返回 skipped）。
- 你在 issue 里贴出的内容对本仓库所有可见成员公开，发帖前自查敏感信息。
