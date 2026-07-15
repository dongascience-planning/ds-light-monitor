#!/bin/bash
# ds-status 설치 — SwiftBar 플러그인으로 등록 (bun·SwiftBar 없으면 자동 설치)
set -e
cd "$(dirname "$0")"
ROOT="$PWD"

echo "🚨 ds-status 설치"
echo "────────────────────"

# 1) bun — 없으면 자동 설치
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "ⓘ  bun이 없어 설치합니다…"
  curl -fsSL https://bun.sh/install | bash
fi
BUN=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
if [ ! -x "$BUN" ]; then
  echo "❌ bun 설치 실패. 수동 설치 후 다시 실행: curl -fsSL https://bun.sh/install | bash"; exit 1
fi
echo "✅ bun: $BUN"

# 2) SwiftBar — 없으면 Homebrew로 설치 시도
if [ ! -d "/Applications/SwiftBar.app" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "ⓘ  SwiftBar가 없어 설치합니다…"
    brew install --cask swiftbar
  else
    echo "❌ SwiftBar도 Homebrew도 없습니다. 아래를 순서대로 실행 후 다시 시도하세요:"
    echo '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo "   brew install --cask swiftbar"; exit 1
  fi
fi
if [ ! -d "/Applications/SwiftBar.app" ]; then echo "❌ SwiftBar 설치 실패"; exit 1; fi
echo "✅ SwiftBar"

# 3) 진입점 shebang을 이 환경의 bun 절대경로로 (SwiftBar는 GUI라 PATH 제한적)
sed -i '' "1s|.*|#!$BUN|" "$ROOT/ds-status.5m.js"
chmod +x "$ROOT/ds-status.5m.js"

# 4) 플러그인 폴더에 심볼릭 링크 (imports는 실제 위치로 해석됨)
PLUGIN_DIR="${SWIFTBAR_PLUGIN_DIR:-$HOME/.swiftbar-plugins}"
mkdir -p "$PLUGIN_DIR"
ln -sf "$ROOT/ds-status.5m.js" "$PLUGIN_DIR/ds-status.5m.js"
echo "✅ 플러그인 링크: $PLUGIN_DIR/ds-status.5m.js"

# 5) SwiftBar에 폴더 지정 + 재시작(새 플러그인 스캔)
BID=$(defaults read /Applications/SwiftBar.app/Contents/Info CFBundleIdentifier 2>/dev/null || echo "com.ameba.SwiftBar")
defaults write "$BID" PluginDirectory -string "$PLUGIN_DIR"
osascript -e 'tell application "SwiftBar" to quit' >/dev/null 2>&1 || true
sleep 1
open -a SwiftBar

echo "────────────────────"
echo "✅ 완료! 메뉴바 오른쪽에 경광등이 뜹니다 (초록=정상 / 주황·빨강=이상)."
echo "   클릭하면 서비스별 상태·응답시간·24h 가동률이 보입니다."
