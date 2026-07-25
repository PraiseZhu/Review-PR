---
name: generate-update-notice
description: 把上个版本到当前的所有 commit（含 merge commit）整理成 xdt-maker 公告 JSON，写入 apps/notice/版本号.json（文件名跟随用户确认后的版本号）。锚点优先自动——从上个版本 notice.json 的 githash 字段读上版 main HEAD，无需用户输入；上版没有 githash（历史文件）才回退到让用户给「发布时间 + 末位 commit hash」两参数交叉验证。按作者分组（先按邮箱归一化——同一邮箱取全仓最高频作者名为规范名，避免同人多名被拆成多个 contributor）、同人同主题合并、口语化中文。日期一律用代码取系统时间，不由 LLM 猜。
---

# Generate Update Notice

把一段 commit 区间整理成 xdt-maker 用户更新公告(`apps/notice/<version>.json`)。

## 锚点 `<START>` 怎么定:优先自动,回退手动

`<START>` 是区间 `<START>..HEAD` 的起点,语义是「上个版本的最后一个主线 commit」。确定它有两条路径,**默认先走自动 A,A 不成立才回退手动 B**:

### A. 自动模式(默认,零输入)——从上个版本 notice.json 读 `githash`

上个版本 JSON 里的 `githash` 字段(本 skill 在「步骤 5」写入)记录的就是**上版生成公告那一刻的 main HEAD**,天然在主线上、天然是精确锚点,不存在「hash 跑到 feature 分支」的风险。所以只要上版 json 有它,就**不需要用户给任何时间 / hash**:

```bash
# 1) 找当前最大版本号的 json(忽略 template.json),读它的 githash
ls apps/notice/*.json | grep -v template.json    # 人工挑出最大版本号那个,或脚本排序
# 2) 读 githash 字段(假设上版是 0.0.103)
node -e "process.stdout.write(require('./apps/notice/0.0.103.json').githash || '')"
# 3) 确认本地能解析到这个 commit
git cat-file -e <githash>^{commit} && echo OK || echo BAD
```

- 解析成功(`OK`)→ `<START>` = 该 githash,**自动模式成立**。「上个版本发布时间」直接 `git log -1 --format=%cI <githash>` 取(仅用于步骤 6 汇报对账,**不用问用户**)。直接进步骤 1。
- 解析失败(`BAD` / 上版 json 压根没有 `githash` 字段,即历史文件)→ 自动模式不成立,转手动模式 B。
- ⚠ 自动模式下**不要**再用「时间反推 main HEAD」那套交叉验证——githash 本身就是可信主线锚点,再引一个用户记忆的时间去「验」反而自找麻烦(用户记忆不准时会误报不一致)。

### B. 手动模式(回退)——上版没有可用 `githash` 时,要用户给「时间 + hash」交叉验证

历史版本的 json 还没有 `githash` 字段(本 skill 加这个字段之前生成的),这时退回老流程:**两个参数缺一不可,必须同时提供**。

#### B1. 上个版本的发布时间 `<RELEASE_TIME>`

用户给的格式可以是 `2026-05-21 02:08` / `今天早上 2:08` / `昨天 18:00` 等口语化表达,**自己解析成 ISO 时间戳**(本地时区),不确定时回问一次。

#### B2. 上个版本最后一个 commit hash `<RELEASE_HASH>`

通常是发布时打的 release tag 或 `apps/notice/version` 文件里写的 hash(注意:`apps/notice/version` 是发布流程产物,里面的 hash **不一定能在本地解析**,不可盲信)。

#### B3. 缺任一就停下来追问,**不要**用任何一项单独兜底

- 只给 hash 没给时间:**追问时间**。不能直接用 `<HASH>^..HEAD` 兜底——这是 2026-05-21 踩坑的根因(详见下方教训章节),hash 可能是 feature 分支上的 commit,它的父链不包含晚于它 merge 进 main 的其他 feature 分支,会导致那批 commit 被误判成「新内容」。
- 只给时间没给 hash:**追问 hash**。不能只靠时间反推——用户记忆的发布时间可能是「点了发布按钮的时间」而不是「打包 commit 的时间」,两者可能差几分钟到几小时,只靠时间 awk 出来的 commit 容易错位。
- 两者都给了:**先用步骤 0 交叉验证**,通过后才进步骤 1。

> ⚠ 为什么自动模式能省掉时间、手动模式不能:时间的作用是「验尺」——验证 hash 是不是真在 main 主线上。自动模式的 githash 来源本身就可信(就是上版 main HEAD),不需要验;手动模式的 hash 来源不可信(用户记忆 / 随手抄),必须用一个**独立来源**的时间去量,而且这个时间**不能从 hash 自己取**(自己量自己,hash 错了发现不了)。

### `version` 号(两种模式都要和用户确认)

默认从 `apps/notice/` 下扫已有的 `*.json`(忽略 `template.json`)取最大版本号 + 1 patch,列出来向用户复述一次问对不对。**无论自动还是手动模式,版本号都要让用户确认**——自动模式下它通常是**唯一**需要用户拍板的输入。**用户最终确认的版本号同时决定**:① JSON 里的 `version` 字段、② 输出文件名 `apps/notice/<version>.json`。用户改了版本号,文件名也要跟着改,不要写到旧文件里。

### `date` 字段

**必须用代码取系统当前日期**,禁止 LLM 自己写日期、禁止从 commit message / 上下文里的 `currentDate` / `apps/notice/version` 推断。取法见步骤 1。

### `githash` 字段(线上业务不读,但本 skill 下次会用它当锚点)

记录本次公告区间的**止点 commit**——也就是生成公告那一刻的 main `HEAD` 完整 hash(40 位,和 `apps/notice/version` 文件同格式)。**线上消费方(`releaseNotesService.ts`)和 renderer 都不读它**,公告展示完全不受影响;它唯一的用处是**下次生成公告时被本 skill 读回来当自动锚点**(见上面「锚点 A. 自动模式」):有了它,下个版本就不用用户再给时间 / hash。**必须用代码取**(`git rev-parse HEAD`),禁止 LLM 手写或猜测,取法见步骤 1。

## ⚠ 为什么手动模式必须同时要时间和 hash(2026-05-21 教训)

> 本节只约束**手动模式 B**。自动模式 A 的锚点来自上版 json 的 `githash`(可信主线 HEAD),不受此限。

用户曾经只给 hash `e5290ff6`,我直接用了 `e5290ff6^..HEAD`,公告里塞进了 Orca 多 agent、scheduler v2、协同模式 tab、独立 workspace、worktree 持久化 一大堆「上个版本已经发了」的内容。

根因:
- `e5290ff6` 是 MR !65 的 commit,作者日期 2026-05-21 10:17
- 但 MR !21 (Orca)、协同模式 等是从独立 feature 分支上,**author date 在 5-13~5-19**(看起来"很老"),却 **commit/merge date 晚于 e5290ff6 才进 main**
- 所以 `e5290ff6^..HEAD` 把它们全包了进来,而上个版本(2026-05-21 02:08 发布,主干当时 HEAD 在 `ad5c3eb0`)其实压根没这些内容
- **author date "看起来旧"完全不代表它在上个版本里**,只有 commit 在 `<上个版本发布时刻>` 时已经能从 main HEAD 追溯到,才算「上个版本发过」

教训:**hash 是精确锚点(避免时间精度问题),时间是验证 hash 真伪的尺子(避免 hash 跑到 feature 分支上去)**,两者互相校验,缺一不可。这套交叉验证存在的根因是「用户手给的 hash 来源不可信」;一旦锚点来源可信(自动模式从上版 json 读 githash),这把尺子就没用了,可以省掉。

## 步骤

### 0.（仅手动模式 B）交叉验证 `<RELEASE_HASH>` + `<RELEASE_TIME>`,得到最终锚点 `<START>`

> 自动模式 A 已经直接拿到可信 `<START>`(上版 json 的 `githash`),**跳过本步**,直接进步骤 1。

```bash
# 1) 看 hash 的 commit 时间
git log -1 --format='%h %cd %s' --date=iso <RELEASE_HASH>

# 2) 看 hash 是否在 main 的第一父链上(即 main 历史的主线)
git merge-base --is-ancestor <RELEASE_HASH> main && \
  git log --first-parent --oneline main | grep -q "^<RELEASE_HASH短形>" \
  && echo "ON_MAIN_FIRST_PARENT" || echo "NOT_ON_MAIN_FIRST_PARENT"

# 3) 用时间反推出 main 当时的 HEAD
git log --first-parent --pretty=format:'%h %cd %s' --date=iso main \
  | awk '$2"T"$3 <= "<RELEASE_TIME_ISO>"' \
  | head -1
```

判定规则:

| 场景 | 判定 |
|---|---|
| hash 在 main 第一父链上,且 commit 时间和 `<RELEASE_TIME>` 相差 ≤ 30 分钟 | ✅ 一致,`<START>` = `<RELEASE_HASH>` |
| hash 在 main 第一父链上,但 commit 时间和 `<RELEASE_TIME>` 差很多(>30 分钟) | ⚠ **停下来回问用户**:hash 和时间对不上,是哪个记错了?把 hash 的时间和时间反推出的 hash 一起列出来让用户选 |
| hash 不在 main 第一父链上(是 feature 分支或 fork 分支的 commit) | ⚠ **停下来回问用户**:`<RELEASE_HASH>` 不在 main 主线上,是不是给错了?把时间反推出的 main HEAD 列出来作为建议值 |

⚠ **绝对不要**默默替换用户给的 hash——任何不一致都必须**显式告知用户并等待确认**,因为这往往意味着用户记忆 / 笔记 / 发布流程有问题,LLM 静默改值会让用户失去对锚点的判断力。

确认后的 `<START>` 写下来,后续所有 `git log` 都用它。

### 1. 取系统当前日期 + commit 列表

先用 bash 取"今天"和**当前 HEAD 完整 hash**，原样填进最终 JSON 的 `date` / `githash` 字段（**不要**手写、不要改格式）：

```bash
date +%Y-%m-%d        # → date 字段
git rev-parse HEAD    # → githash 字段（本次区间止点 commit 的完整 hash，纯记录、不参与业务）
```

然后用 **两条独立 query 并行抓取**——一条拿所有真实业务 commit、一条拿所有 merge commit 用来还原 MR 作者。**禁止只用 `--first-parent` 一条 query 撑全场**（见下方踩坑说明）：

```bash
# Query A: 所有非 merge 的真实业务 commit（作者就是真实作者）
git log --no-merges --reverse --pretty=format:'%h|%an|%ae|%ad|%s' --date=short <START>..HEAD

# Query B: 所有 merge commit（用来识别 MR 入口 + 还原 AutoMr-Bot-Merge 类机器人作者）
git log --merges --reverse --pretty=format:'%h|%P|%an|%ae|%ad|%s' --date=short <START>..HEAD
```

- 区间用 `<START>..HEAD`（**不含** START 本身），因为 `<START>` 是从步骤 0 反推出来的「上个版本发布时刻的 main HEAD」，本身已经在上个版本里发过了，**不能再算进本次公告**。
- ⚠ 注意和老版本 skill 的差异：以前用 `<START>..HEAD`（含 START）是因为把 START 当成「本次区间第一个 commit」；新版本里 START 是「上个版本的最后一个 commit」，语义反过来了。
- Query A 已经天然包含 MR 内所有真实 commit 且作者正确，**这是公告内容的主来源**。
- Query B 里 `Merge MR !N: <title>` 这种 commit 的 `%an` 通常是机器人（如 `AutoMr-Bot-Merge`）或仓库管理员，**不能直接用**——真实作者要从第二个 parent 拿（见第 3 步）。Query B 主要用来：① 识别哪些 commit 是 MR 整合入口、② 当 Query A 里某 MR 的内部 commit 主题模糊时，用 MR 标题做交叉理解。
- **不要**用 `|` 当分隔符之外的特殊处理；commit message 里偶尔有 `|` 时手工核对一下即可。
- 纯仓库整合 merge（`Merge branch 'main' of ...`、`Merge branch 'main' into mr-XX`、`Merge remote-tracking ...`）一律丢掉，没有业务含义。

#### ⚠ 历史教训：为什么不能只用 `--first-parent`

老版本 skill 教过 `git log --first-parent <START>..HEAD`。这条命令**在干净的"feature 分支 → 一次性 squash/merge 进 main"流程下没问题**，但 xdt-maker 的 main 经常出现下面这类拓扑，会让 `--first-parent` 跑岔到 feature 分支里去、**整段漏掉一批真实落到 main 的 feat/fix**：

- `Merge branch 'main' into mr-XX` （反向把 main 合进 feature 分支后又推回 main）
- 多个开发同时 `git pull --no-rebase` 产生的 `Merge branch 'main' of origin ...`
- MR 用 GitLab "Create merge commit" 但 first parent 不一定是 main side

实际事故：0.0.74 → 0.0.75 区间用 `--first-parent` 只抓到 24 条、漏了 MR !21（Orca 整合）/ !57 / !58 / !59 / !61 / !62 全部内容，以及 Confluence、Google Gemini、worktree 持久化、协同模式 UI 等大量 feat。改用 Query A + Query B 双查后命中 80+ 条真实 commit。

**所以无脑双查就对了，不要再尝试单条 `--first-parent` 走天下。**

#### ⚠ 写入项必须补读 body（`%s` 只是索引，不是数据源）

Query A / B 都只取 `%s`（一行 subject），而 bug 的**用户症状 / 受影响平台 / 主 bug** 往往只写在 commit body 或 PR 描述里，subject 常常只讲技术机制（解包 / 打包 / 构建产物 / 签名 / asar / 配置）。只吃 subject 会稳定复现一类偏差：**抓住某条带症状词的次要 commit 当代表，写出只覆盖次要问题 / 次要平台的描述，把影响面最大的主 bug 漏掉**。所以:

- 凡准备写进公告的 `fix` 类或多 commit 合并项，归纳前对代表 commit 读全文 body：
  ```bash
  git show -s --format='%B' <hash>
  ```
  **用户症状 / 受影响平台 / 主 bug 以 body 的「Bug 现象 / 影响范围 / 根因」为准，禁止只靠 subject 归纳。**
- merge commit 是 **GitHub `Merge pull request #N`**、且 `gh` 已鉴权时，best-effort 拉正文当第一手症状源：
  ```bash
  gh pr view <N> --json title,body   # 取不到就跳过，退回 commit body，不阻断
  ```
  ⚠ **仅限 GitHub `Merge pull request #N` 条目**。历史 **GitLab `Merge MR !N`** 的编号会和 GitHub PR 号重叠（本仓从 GitLab 迁来，`Merge MR !65` 和 `Merge pull request #65` 可能并存），对 MR 条目跑 `gh pr view <N>` 会**误拉到一个不相关的 GitHub PR** 且不报错，反而归纳出错误症状——所以 GitLab `Merge MR !N` **不要**用 `gh pr view`，直接退回 commit body（或用 GitLab API/工具）。
  **不得因为拉不到 PR 就退回只看 subject。**
- 判别口诀:**subject 讲"怎么修的"，body/PR 讲"修好了什么"。公告写给用户，只认后者。** 一组机制型 subject + 一条带症状词的次要 commit —— 警报:大概率漏了主 bug，回去读 body。

### 1.5 完整性 Sanity Check（必做）

在进入分类前，先跑一个对账，把 Query A 的 commit 数和 `--first-parent` 对照，**如果差距 ≥ 30% 就说明 main 历史很乱，必须以 Query A 为准**：

```bash
git log --no-merges --oneline <START>..HEAD | wc -l
git log --first-parent --oneline <START>..HEAD | wc -l
```

同时主动对用户提到的"应该有"的功能做关键词搜索，确认没漏：

```bash
# 例：用户说"应该有 Confluence / Google 模型 / Orca"，就 grep 看在不在
git log --no-merges --oneline <START>..HEAD | grep -iE 'confluence|gemini|google|orca'
```

**如果用户在追问"为什么漏了 X"**，立即跑 `git log --all --no-merges --oneline <START>..HEAD | grep -iE '<关键词>'` 自检，不要嘴硬说"区间里没有"。

### 2. 分类

按 conventional commit 前缀 + 关键词归类：

| Section title  | 触发条件                                          |
| -------------- | --------------------------------------------- |
| `New Features` | `feat`/`feature`/`add`/`新增`/`上线`/`支持` 开头      |
| `Bug Fixes`    | `fix`/`bugfix`/`hotfix`/`修复`/`修` 开头           |

**前缀只是参考，最终以 commit 内容为准**：常见反例是 `fix(desktop): 支持导入会话截图`——前缀写 `fix` 但内容是新能力，应归 Features。读完 subject 再判断。

**Merge commit 的处理**：

- 现在用的是双 query 策略，Query A 已经覆盖了所有真实业务内容，**默认不要把 Query B 的 merge commit 也单独列进公告**——否则会出现"一个 MR 里 5 个 commit 都进了 Query A，再加一条 MR 标题"的重复。
- Query B 的真正用途：当 Query A 里某条 commit 的 subject 信息量极低（如 `fix bug`、`update`），而它恰好属于某个 MR 时，可以读 MR 标题辅助理解；**写公告时仍以 Query A 那条 commit 的真实作者和实际改动为准**。
- 例外：如果某个 MR 的内容是"作者用 force-push squash 进来"或者"内部 commit 全是 review fixup、看不出业务含义"，可以**回退到用 MR 标题**写一条，作者从第二个 parent 拿（见第 3 步）。
- 纯仓库整合 merge（`Merge branch 'main' into ...` / `Merge remote-tracking ...`）一律丢掉。

**忽略**：`chore`、`docs`、`refactor`、`test`、`ci`、`build`、`style`、`perf`（除非 perf 是用户能感知到的明显提速）以及 revert commit。如果发现重要的 refactor 实际影响了用户体验，可以归到 Features 但要换成用户视角的描述。

**成对的 revert 必须双向消除**：如果区间里同时有 `commit X` 和 `Revert "commit X"`，两条都丢掉、不要只丢 revert。例：`fix(scaffold): vendor 官方 pnpm` + `Revert "feat(scaffold): vendor 官方 pnpm"` 都不进公告。

### 3. 按作者分组 + 合并同主题

- **先做作者身份归一化(按邮箱,运行时规则,必做,无需任何映射文件)**:同一个人可能用了多个 git `user.name`(如 `Dash` / `dashhuang`),但提交邮箱通常一致。所以**用 commit 的 `%ae`(转小写)作分组身份键**,而不是 `%an`。每个邮箱的**规范显示名 = 该邮箱在全仓历史里 commit 数最多的那个名字**,取法:

  ```bash
  # 对本区间出现的每个邮箱(先转小写),求它在全仓历史里最高频的作者名 = 规范名。
  # 用 awk 精确匹配邮箱列(不用 --author,那是正则子串匹配,邮箱里的 . / + 会被当特殊字符误匹配);
  # 末尾 sed 去掉 uniq -c 的计数前缀,直接吐出规范名本身(无需再手工截列)。
  git log --all --no-merges --format='%ae|%an' \
    | awk -F'|' -v e='<该邮箱小写>' 'tolower($1)==e {print $2}' \
    | sort | uniq -c | sort -rn | head -1 | sed 's/^ *[0-9]* *//'
  ```

  **按规范名分组**——`contributors` 数组和各 section 里 `items[].name` 一律用规范名,绝不出现同一个人被拆成两个 name(如 `Dash` + `dashhuang`)。这条纯规则每次运行现算,自动覆盖将来新出现的「同邮箱多名字」,无需维护任何名单;也不会误伤正常作者(单名字邮箱算出来就是它自己)。规则确定性来自"全仓最高频名字"这个稳定口径——不随区间变化漂移。
  - ⚠ 边界:纯邮箱分组**不处理「同一个人用多个不同邮箱且显示名也不同」**的跨邮箱情况(没有信号能把两个不同邮箱判成同一人)。本仓现有的多邮箱作者(Dash 3 个邮箱、zhangyongjie 2 个邮箱)因各邮箱最高频名字恰好一致,仍会自然并成一个 name;若将来出现跨邮箱且名字不一致、确需合并的,再单独跟用户确认处理,不在本规则内自动猜。
- 作者身份键之外,commit 的真实归属**优先看 Query A**（Query A 里就是真实写代码的人）。
- **机器人 / 管理员 merge commit 的作者还原**：Query B 里 `Merge MR !N: ...` 的 `%an` 经常是机器人账号（`AutoMr-Bot-Merge` 等）或按 merge 按钮的管理员，**不是真实作者**。只有当步骤 2 的"例外"分支用 MR 标题写公告时，才需要还原作者：
  - merge commit 的第二个 parent（`%P` 列表里空格后面那个 hash）就是被合并分支的 tip，跑 `git log -1 --pretty=format:'%ae' <2nd-parent>` 拿到真实作者邮箱;再**同样按上面的邮箱归一化规则**(该邮箱全仓最高频名字)得到规范名。
- **不要**强行把所有人合并成 `Team`（除非提交数极少、单人不超过 1 条且总人数 ≥ 3 才考虑）。
- 对每个作者，把「明显是同一个 feature / 同一个 bug」的多条 commit 合并成 **一条** list item：
  - 同一文件 / 同一模块的连续多次「补丁式」提交（如 `fix(X): xxx` + `fix(X): 再修一下`）合并。
  - 标题里包含同一个 scope（`fix(feishu-bot): ...`、`feat(scheduler): Phase 0 / Phase 2 / P3`）的多条优先合并。
  - 合并后描述要覆盖到最终效果，**不要**写"经过 3 次提交才修好"这类过程。
  - **主症状 + 全平台覆盖**：合并后的描述必须覆盖这些 commit body 里出现的**全部受影响平台**和**主症状**，不能只取某条 subject 里恰好出现的平台。若 body 显示主 bug 在平台 A、附带修了平台 B，描述以主 bug（平台 A）为主、平台 B 为辅，**不能只写平台 B**。

### 4. 口语化改写

**铁律**：每条 list item 必须让一个**完全不懂代码**的同事看懂。

- 禁用纯技术词：`IPC`、`hook`、`refactor`、`schema`、`endpoint`、`payload`、`debounce`、`memoize`、`callback`、`null safety`、`type-safe`、`zustand`、`useState`…
- 保留用户能直接看到 / 用到的名词：「侧栏」「会话」「飞书 Bot」「通知卡片」「快捷键」…
- 句式参考 `apps/notice/0.0.31.json`：以**用户能感知的变化**开头，必要时用 `—` 接补充说明。
- **症状优先，机制其次**：当一组 commit 的 subject 都在讲技术机制（解包 / 打包 / 构建产物 / 签名 / asar / 配置 / 重构），而 body 讲的是用户症状（起不来 / 崩溃 / 白屏 / 卡死 / 数据丢失）时，必须用 body 里的用户症状造句，**禁止照搬机制型 subject**。机制是"怎么修的"，公告只写"修好了什么用户能感知的问题"。
- 中文长度合适即可，不要堆砌；一条 30~80 字最佳，超过 100 字考虑拆开或精简。
- 如果一条 commit 改的是纯内部实现（用户感知不到），果断丢掉，**不要**为了凑数把它翻译成"优化了某某模块"。

### 5. 组装 JSON

输出 schema 完全对标 `apps/notice/template.json`（**只有 `New Features` 和 `Bug Fixes` 两栏，按作者分组**，不要用 `"Team"` 聚合写法）：

```json
{
  "version": "<x.y.z>",
  "date": "<步骤 1 用 date +%Y-%m-%d 取到的字符串>",
  "githash": "<步骤 1 用 git rev-parse HEAD 取到的完整 hash，纯记录>",
  "contributors": ["<author1>", "<author2>"],
  "sections": [
    { "title": "New Features", "items": [ { "name": "<author>", "list": ["…"] } ] },
    { "title": "Bug Fixes",    "items": [ { "name": "<author>", "list": ["…"] } ] }
  ]
}
```

- `githash` 紧跟在 `date` 之后，值就是步骤 1 `git rev-parse HEAD` 的原样输出（完整 40 位 hash），**只做存档记录，不参与任何业务**；不要手写、不要截短成短 hash。
- 只有 `New Features` 和 `Bug Fixes` 两个 section，不要新增别的栏目。
- `contributors` 按本次区间内 commit 数从多到少排序。
- 每个 section 内的 `items` 按作者 commit 数从多到少排序；同一作者的 list 内部按时间倒序（最新的功能放前面）。
- 同一作者在同一 section 里，**同主题 / 同一 feature / 同一 bug** 的多条提交必须按第 3 步合并成一条 list item，不要让同一作者的 list 出现重复主题。
- 如果某个 section 没有内容，整段省略，不要留空 `items: []`。

### 6. 写入

写到 `apps/notice/<version>.json`，文件名里的 `<version>` 用第 5 步 JSON 里那个 `version` 字段（也就是用户在「入参」环节最终确认的版本号）。例：用户确认 `0.0.32` → 写到 `apps/notice/0.0.32.json`。

- **文件名必须等于 JSON 里的 `version` 字段**，不要二者错开（如 JSON 是 `0.0.32` 但文件名写成 `notice.json` / `0.0.31.json`）。
- 如果目标文件已存在，**先提示用户**："`apps/notice/<version>.json` 已存在，确认覆盖？" 用户同意再覆盖；不要默默覆盖也不要自动 +1 patch 绕过。
- **不要**动 `apps/notice/version` 文件 —— 那个是发布流程更新的，不归这个 skill 管。
- **不要**再生成 `notice.json` 这种非版本号文件名（老版本 skill 的遗留行为，已废弃）。

### 6.5 同步刷新 `apps/notice/index.json`(必做)

跨版本升级时,桌面端需要一份 CDN 侧的**有序版本索引**来把 `(用户上次读版本, 当前版本]` 之间所有的 notice 一次性拉齐显示(见 `apps/desktop/src/main/releaseNotesService.ts` / `useUpdateNotice`)。索引文件是 `apps/notice/index.json`,内容是**从 `apps/notice/*.json` 扫出来的、按 semver 升序排的版本号数组**(**不含** `template.json` / `index.json` 自身)。

写完新 `<version>.json` 后**立刻重生成整份 index**——不要追加、不要手改,因为区间截取依赖数组严格有序且不重复。用下面这条一句话流水线原地覆盖:

```bash
ls apps/notice/*.json \
  | xargs -n1 basename \
  | grep -v -E '^(template|index)\.json$' \
  | sed 's/\.json$//' \
  | sort -t. -k1,1n -k2,2n -k3,3n \
  | awk 'BEGIN{printf "["} NR>1{printf ","} {printf "\n  \"%s\"", $0} END{printf "\n]\n"}' \
  > apps/notice/index.json
```

自检:`cat apps/notice/index.json` 末尾几行应看到本次新增的 `"<version>"`,并且 `jq length apps/notice/index.json` 等于当前目录下真实 notice 数(`ls apps/notice/*.json | grep -v -E 'template|index' | wc -l`)。

写完后输出：

- 版本号 / 日期（注明"取自系统时间 `date +%Y-%m-%d`"）/ contributors 列表
- **邮箱归一化结果**（如有多名字邮箱）：本区间里被合并的同人多名，逐条列「<规范名> ← 合并掉 <别名列表>」；没有就写「无」
- **githash**:本次写入 JSON 的 `githash`（注明"取自 `git rev-parse HEAD`，供下次自动锚点复用"），方便用户核对止点。
- **锚点说明**:先讲清本次走的是**自动模式 A** 还是**手动模式 B**。
  - 自动 A:`<START>` 取自上版 `<上版version>.json` 的 `githash`(短 hash + 该 commit 时间 + 标题),并说明「本次未向用户索取时间 / hash」。
  - 手动 B:用户给的 `<RELEASE_HASH>` 和 `<RELEASE_TIME>` 是否一致;最终用的 `<START>` 短 hash + commit 时间 + 标题。如果步骤 0 出现过不一致并和用户确认了,把确认前后的差异也写出来,方便复盘。
- 区间止点：`HEAD` 短 hash + 标题
- **数据采集对账**：Query A 业务 commit 数、Query B merge commit 数、`--first-parent` 数（如果三者差距 ≥ 30%，明确说"main 历史有交叉合并，已用双 query 兜底"）
- 每个 section 多少条 list item
- **重点 scope 自检**：把最终公告里覆盖到的主要功能 scope 一行列出（如 `scheduler / orca / confluence / gemini / voice-input / 会话导入`），让用户一眼看出"哪些大块在 / 哪些不在"，便于追问漏项
- **fix 条目 body 自检**：每条写入的 `fix` 是否读过对应 commit body（而非只看 subject）？多 commit 合并项 body 里的受影响平台是否**全部**覆盖、影响面最大的**主 bug** 是否进了公告（没有只写次要平台 / 次要问题）？
- 文件绝对路径（应当形如 `…/apps/notice/<version>.json`）
- **index.json 已刷新**:数组长度、末位版本号(应等于本次 `<version>`),让用户一眼确认索引没漏刷。

让用户审一眼，问要不要改。

## 用户反馈区间不对时的标准应对

如果用户回复"少了 X" 或 "**这些感觉是上个版本就发了 / 不该出现**"，**不要先解释、不要嘴硬**，按下面顺序处理：

### A. 用户说「多了 / 这些上个版本就有」(锚点错了)

这是最容易踩的坑。看到这种反馈,**第一反应应该是怀疑 `<START>` 锚点定错了**,而不是逐条解释 commit:

1. 复查用户给的 `<RELEASE_TIME>` 是否准确。如果只给了 hash 没给时间,**立即追问发布时间**,然后按步骤 0 重新反推 `<START>`。
2. 检查"多出来"的 commit 是不是 author date 很老但 commit/merge date 在 `<START>` 之后的——这就是典型的「feature 分支晚 merge」陷阱,正确的 `<START>` 应该排除它们。
3. 验证方法:跑 `git merge-base --is-ancestor <可疑 commit> <START>`,如果返回 0 说明 commit 在 `<START>` 之前就在 main 上了(用户是对的),返回 1 说明 commit 是 `<START>` 之后才进 main 的(理论上属于本次区间)。
4. 锚点修正后**整份重写**,不要打补丁式删条目。

### B. 用户说「少了 X / Y」

1. 立即跑 `git log --no-merges --oneline <START>..HEAD | grep -iE '<用户提到的关键词>'` 核实
2. 如果搜到了：承认漏了 + 说明根因（很可能就是把 `feat(X)` 误判为 `chore` 给丢了,或合并主题时漏了），重写整份公告，不要打补丁式追加
3. 如果真没搜到:用 `git log --all --no-merges --oneline | grep -iE '<关键词>'` 全仓搜一遍,看是不是在 `<START>` 之前就发过了。把结果给用户看,问是不是锚点或关键词记错了
4. 重写时**重新跑步骤 1.5 的对账**，并在汇报里把对账数字一起给出来，证明这次是覆盖全的

## 注意事项

- 全程**不要** `console.log` 类的开发者侧描述泄露到公告里。
- 不要把 commit hash / PR 号 / MR 号 / Jira 号写进 list item。
- 同一作者出现在 Features 和 Bugfixes 里是正常的，不要去重。
- 如果某条 commit message 太简略看不出做了啥（比如就一句 `fix bug`），可以 `git show <hash> --stat` 看看动了哪些文件辅助理解，但**不要**把文件名写进公告。
- 跨平台描述：是否提到某平台差异，一律以 **commit body / PR 描述**为准，不是只看 subject。body / PR 里提到的受影响平台都要覆盖；**subject 没提但 body 提了 = 提了，必须写进公告**；body / PR 也没提，才不补。
- **再次强调**：`date` 字段一律用 `date +%Y-%m-%d` 的返回值，**禁止**手写、禁止抄上下文里出现过的任何日期。
