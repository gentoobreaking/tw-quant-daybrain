#!/usr/bin/env bash
# 打包單一可執行檔（內嵌 Bun runtime）：dist/daybrain
# 用法：./scripts/build-binary.sh [--release]
# 產物：dist/daybrain（macOS arm64 單檔，無需 Node/Bun 即可執行）
set -euo pipefail

cd "$(dirname "$0")/.."

# 找 bun（PATH 或 ~/.bun/bin）
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then
  echo "❌ 找不到 bun。安裝：curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

OUT="${OUT:-dist/daybrain}"
ARGS=(--compile --outfile "$OUT" --target=bun-darwin-arm64)
[ "${1:-}" = "--release" ] && ARGS+=(--minify)

echo "📦 打包 daybrain（$(basename "$BUN") $( "$BUN" --version )）..."
"$BUN" build ./src/cli.ts "${ARGS[@]}"
echo "✅ 完成：$OUT（$(ls -lh "$OUT" | awk '{print $5}')）"
echo "   試跑：$OUT help"
