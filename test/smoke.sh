#!/bin/sh
# agentlas 터미널 CLI 스모크 테스트 (v2 엔진).
# 1) 기본 표면: where/version/list/doctor/help/usage/mcp/chats
# 2) 무인자 가드: search/install/upload 는 usage + exit 1
# 3) 신선 환경 첫 실행: DB 부트스트랩
# 4) 살아있는 계약 테스트 + Runtime Doctor 3제품 패리티 게이트
#
# v2 재구축 중 비활성(대응 모듈 포팅 시 이 게이트로 복귀시킬 것):
#   semver-precedence            → v2 update 모듈 (모놀리스 소스 검사였음 — v2용 재작성 필요)
#   desktop-ontology-loadout-contract → v2 run --experience-desktop-loadout 배선
#   experience-exchange-contract / experience-auto-intake-contract / experience-p6-cli-contract
#                                → v2 experience CLI 배선 (agentlas-experience-mcp 후계 모듈)
#   mcp-child-env-isolation / mcp-config-isolation / mcp-probe-concurrency / mcp-consent-allowlist
#                                → v2 mcp 모듈
#   permission-mapping           → v2 runner 배선 (native-host capture 경로)
#   workload-routing-contract / workforce-runtime-contract / stormbreaker-core-contract
#                                → v2 workforce/storm 배선 (agentlas-parity 후계 모듈)
#   credential-env-regression / runtime-env-protection / memory-prompt-budget
#                                → v2 credentials/runner/memory 배선
#   기타 v1 전용(cloud-*, route-regression, terminal-ui-regression, …)은
#     legacy-v1-engine-snapshot 태그에 보존.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/../bin/agentlas.cjs"
SMOKE_USER_DATA="$(mktemp -d "${TMPDIR:-/tmp}/agentlas-smoke-state-XXXXXX")"
export AGENTLAS_USER_DATA_DIR="$SMOKE_USER_DATA"

cleanup_smoke_state() {
  if [ -n "${SMOKE_USER_DATA:-}" ] && [ -d "$SMOKE_USER_DATA" ]; then
    destination="$HOME/.Trash/agentlas-smoke-state-$(date +%s)-$$"
    mv "$SMOKE_USER_DATA" "$destination" 2>/dev/null || true
    SMOKE_USER_DATA=""
  fi
}
trap cleanup_smoke_state EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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
guard() {
  name="$1"; shift
  if out="$("$@" 2>&1)"; then echo "FAIL $name (should exit non-zero)"; fail=$((fail + 1));
  else echo "PASS $name"; pass=$((pass + 1)); fi
}

# 기본 표면
check "where"   node "$BIN" --where
check "version" node "$BIN" version
check "list"    node "$BIN" list
check "doctor"  node "$BIN" doctor
check "help"    node "$BIN" help
check "usage"   node "$BIN" usage
check "mcp"     node "$BIN" mcp
check "chats"   node "$BIN" chats

# 무인자 호출은 usage를 내고 exit 1 (프롬프트 오라우팅 방지)
guard "guard-search"  node "$BIN" search
guard "guard-install" node "$BIN" install
guard "guard-upload"  node "$BIN" upload

# 미포팅 v1 명령은 정직 정지 (exit 1, 조용한 성공 금지)
guard "guard-not-ported" node "$BIN" storm "goal"

# 살아있는 계약 테스트
check "bootstrap-race" node "$SCRIPT_DIR/bootstrap-race.cjs"
check "sqlite-driver-probe" node "$SCRIPT_DIR/sqlite-driver-probe.cjs"
check "experience-taxonomy-parity" node "$SCRIPT_DIR/experience-taxonomy-parity.cjs"
check "tool-workspace-boundary" node "$SCRIPT_DIR/tool-workspace-boundary.cjs"

# 신선 환경 첫 실행
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
# (형제 repo가 없는 CI/신선 클론에선 자동 스킵)
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
