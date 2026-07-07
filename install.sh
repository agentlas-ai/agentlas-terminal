#!/bin/sh
# agentlas 터미널 CLI 설치 스크립트 (macOS/Linux).
#
#   sh install.sh                # ~/.local/bin/agentlas 에 심링크 (sudo 불필요)
#   sh install.sh --prefix /usr/local/bin
#
# 제거: rm <prefix>/agentlas
set -eu

PREFIX="$HOME/.local/bin"
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help)
      echo "usage: sh install.sh [--prefix DIR]   (default: ~/.local/bin)"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/bin/agentlas.cjs"
TARGET="$PREFIX/agentlas"

if [ ! -f "$LAUNCHER" ]; then
  echo "런처를 찾을 수 없습니다: $LAUNCHER" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || {
  echo "node 가 필요합니다 (런처 실행용). https://nodejs.org" >&2
  exit 1
}

mkdir -p "$PREFIX"
chmod +x "$LAUNCHER"
ln -sf "$LAUNCHER" "$TARGET"
echo "설치됨: $TARGET -> $LAUNCHER"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    echo ""
    echo "PATH에 $PREFIX 가 없습니다. 셸 rc에 추가하세요:"
    echo "  export PATH=\"$PREFIX:\$PATH\""
    ;;
esac

echo ""
echo "확인:"
"$TARGET" --where || true
echo ""
echo "사용: agentlas | agentlas list | agentlas run <agent> \"프롬프트\" | agentlas doctor"
