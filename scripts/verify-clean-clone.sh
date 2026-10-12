#!/usr/bin/env bash
# 用途：干净副本验收（Linux/macOS）—— tar 复制工作区（排除 node_modules/dist/.env/日志/运行期状态），
#       在副本中执行：npm ci → typecheck → lint → format:check → test → build → CLI smoke。
# 用法：
#   bash scripts/verify-clean-clone.sh [source] [dest]
# 退出码：0 = 全绿；非 0 = 首个失败步骤的退出码（set -e）。
# 修改记录：
#   2026-10-12 新增（交付质量：干净副本闭环验证）
set -euo pipefail

SOURCE="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
DEST="${2:-/tmp/clean-verify-cco}"

rm -rf "$DEST"
mkdir -p "$DEST"
tar -C "$SOURCE" \
  --exclude='./node_modules' --exclude='./dist' --exclude='./.git' \
  --exclude='./.env' --exclude='./.memory' --exclude='./.tasks' --exclude='./.team' \
  --exclude='./.transcripts' --exclude='./.task_outputs' --exclude='./.cron' \
  --exclude='./.audit' --exclude='./.vector_index' --exclude='./.mcp' --exclude='./.workflow' \
  --exclude='*.log' --exclude='*.tgz' \
  -cf - . | tar -C "$DEST" -xf -

cd "$DEST"
echo "== clean copy: $DEST (source: $SOURCE)"
echo "== node $(node -v) / npm $(npm -v)"

npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
node dist/main.js --version

echo "ALL GREEN"
