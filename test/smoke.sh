#!/bin/sh
# agentlas 터미널 CLI 스모크 테스트.
# 1) 기본(auto=bundled) where/version/list/doctor
# 2) 신선 환경(빈 userData) 첫 실행: DB 부트스트랩 + 빌트인 시드
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/../bin/agentlas.cjs"

pass=0
fail=0
check() {
  name="$1"; shift
  if out="$("$@" 2>&1)"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name"
    echo "$out" | sed 's/^/    /'
    fail=$((fail + 1))
  fi
}

check "where"   node "$BIN" --where
check "version" node "$BIN" version
check "list"    node "$BIN" list
check "doctor"  node "$BIN" doctor

# 신선 환경 첫 실행 (표준: mktemp 사용, 검증 후 Trash로 이동)
FRESH="$(mktemp -d "${TMPDIR:-/tmp}/agentlas-smoke-XXXXXX")"
check "fresh-first-run" env AGENTLAS_USER_DATA_DIR="$FRESH" node "$BIN" list
if [ -f "$FRESH/agentlas.sqlite" ]; then
  echo "PASS fresh-db-created"
  pass=$((pass + 1))
else
  echo "FAIL fresh-db-created"
  fail=$((fail + 1))
fi
mv "$FRESH" "$HOME/.Trash/agentlas-smoke-$(date +%s)" 2>/dev/null || true

# Runtime Doctor 3제품 패리티 게이트 — 데스크탑 TS ↔ 이 repo CJS ↔ system-optimizer
# 플레이북이 어긋나면 여기서 FAIL. (형제 repo가 없는 CI/신선 클론에선 자동 스킵)
SYNC="$(cd "$(dirname "$0")/.." && pwd)/../scripts/sync-runtime-doctor.sh"
if [ -f "$SYNC" ]; then
  if bash "$SYNC"; then
    echo "PASS doctor-parity"
    pass=$((pass + 1))
  else
    echo "FAIL doctor-parity"
    fail=$((fail + 1))
  fi
fi

echo ""
echo "smoke: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
