#!/bin/bash
# install-mini.sh — 在 Mini 上部署或升级一个前置审查实例(launchd 每 180 秒跑一轮)。
#
#   bash install-mini.sh --sha <Review-PR 提交> --instance <名字> --target-repo <owner/repo> \
#        --mode <dry-run|sandbox|live> --workflow-ref <分支> [--rules <sandbox>] [--max-parallel 3] [--daily-cap 30] [--no-load]
#
# 全部落在 ~/mivo-prereview/ 下,不碰任何已有仓库和已有 launchd 任务:
#   skill/                    PraiseZhu/Review-PR,detached 在 --sha
#   repos/<instance>/         审查对象仓库的独立 clone(只给 Cindy 脚本读 remote、建临时 worktree)
#   state/<instance>/         Cindy 状态目录(锁、轮次、round-state)
#   config/<instance>.json    round.mjs 的配置
#   ~/Library/Logs/mivo-prereview/<instance>/   运行日志
# launchd 标签:com.mivo.prereview.<instance>
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

SHA="" INSTANCE="" TARGET="" MODE="" REF="" RULES="" MAX_PARALLEL=3 DAILY_CAP=30 LOAD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="$2"; shift 2 ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    --target-repo) TARGET="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --workflow-ref) REF="$2"; shift 2 ;;
    --rules) RULES="$2"; shift 2 ;;
    --max-parallel) MAX_PARALLEL="$2"; shift 2 ;;
    --daily-cap) DAILY_CAP="$2"; shift 2 ;;
    --no-load) LOAD=0; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "--sha 必须是完整提交 SHA" >&2; exit 2; }
[[ "$INSTANCE" =~ ^[a-z0-9-]{1,40}$ ]] || { echo "--instance 只能用小写字母、数字和连字符" >&2; exit 2; }
[[ "$TARGET" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "--target-repo 不合法" >&2; exit 2; }
[[ "$MODE" =~ ^(dry-run|sandbox|live)$ ]] || { echo "--mode 不合法" >&2; exit 2; }
[ -n "$REF" ] || { echo "缺少 --workflow-ref" >&2; exit 2; }

ROOT="$HOME/mivo-prereview"
LABEL="com.mivo.prereview.${INSTANCE}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOGS="$HOME/Library/Logs/mivo-prereview/${INSTANCE}"
mkdir -p "$ROOT/repos" "$ROOT/state/$INSTANCE" "$ROOT/config" "$LOGS"

# 1. skill:钉在指定提交(detached),pre-check 的自动 pull 对 detached HEAD 不生效。
if [ ! -d "$ROOT/skill/.git" ]; then
  git clone --quiet --filter=blob:none https://github.com/PraiseZhu/Review-PR.git "$ROOT/skill"
fi
git -C "$ROOT/skill" fetch --quiet origin "$SHA"
git -C "$ROOT/skill" -c advice.detachedHead=false checkout --quiet --detach "$SHA"
test "$(git -C "$ROOT/skill" rev-parse HEAD)" = "$SHA"

# 2. 审查对象的独立 clone(blob 按需取)。
REPO="$ROOT/repos/$INSTANCE"
if [ ! -d "$REPO/.git" ]; then
  git clone --quiet --filter=blob:none "https://github.com/${TARGET}.git" "$REPO"
fi
git -C "$REPO" fetch --quiet origin
test "$(git -C "$REPO" remote get-url origin | sed -E 's#^https://github.com/##; s#\.git$##')" = "$TARGET"

RULES_FILE=""
if [ "$RULES" = "sandbox" ]; then RULES_FILE="$ROOT/skill/mivo/config/sandbox-pr-rules.json"; fi

# 3. 配置
CONFIG="$ROOT/config/${INSTANCE}.json"
node -e '
const [file, repoRoot, stateDir, target, mode, ref, logDir, rules, maxParallel, dailyCap] = process.argv.slice(1);
const config = { instance: file.split("/").pop().replace(/\.json$/, ""), repoRoot, stateDir, targetRepo: target, mode,
  workflowRepo: "xindong/mivo-canvas-plugin", workflowRef: ref, logDir, rulesFile: rules || null,
  maxParallel: Number(maxParallel), dailyCap: Number(dailyCap), pollSeconds: 30 };
require("node:fs").writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "$CONFIG" "$REPO" "$ROOT/state/$INSTANCE" "$TARGET" "$MODE" "$REF" "$LOGS" "$RULES_FILE" "$MAX_PARALLEL" "$DAILY_CAP"

# 4. launchd 任务(StartInterval 180;上一轮没跑完时 launchd 不会再起第二个)。
NODE_BIN="$(command -v node)"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ROOT}/skill/mivo/prereview/round.mjs</string>
    <string>--config</string>
    <string>${CONFIG}</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOGS}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/launchd.err.log</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

if [ "$LOAD" = "1" ]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi
echo "installed ${LABEL} sha=${SHA} mode=${MODE} target=${TARGET} ref=${REF}"
