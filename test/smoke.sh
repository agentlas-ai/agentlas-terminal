#!/bin/sh
# agentlas 터미널 CLI 스모크 테스트 (v2 엔진).
# 1) 기본 표면: where/version/list/doctor/help/usage/mcp/chats
# 2) 무인자 가드: search/install/upload 는 usage + exit 1
# 3) 신선 환경 첫 실행: DB 부트스트랩
# 4) 살아있는 계약 테스트 + Runtime Doctor 3제품 패리티 게이트
#
# v1의 전 계약 테스트가 v2 모듈로 복원 완료됐다. 신규 test/ 파일은 공개 push
# 가드에 걸릴 수 있어 아래 optional 루프에서 존재할 때만 실행한다.
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
# doctor는 문제를 찾으면 정직하게 exit 1 한다(스크립트가 쓰라고). 게이트가 확인할 것은
# "진단이 돌아서 보고를 냈는가"이지 "이 머신에 런타임이 깔렸는가"가 아니다.
if node "$BIN" doctor 2>&1 | grep -q "doctor:"; then
  echo "PASS doctor"; pass=$((pass + 1))
else
  echo "FAIL doctor (no report line)"; fail=$((fail + 1))
fi
check "help"    node "$BIN" help
check "usage"   node "$BIN" usage
check "mcp"     node "$BIN" mcp
check "chats"   node "$BIN" chats

# 무인자 호출은 usage를 내고 exit 1 (프롬프트 오라우팅 방지)
guard "guard-search"  node "$BIN" search
guard "guard-install" node "$BIN" install
guard "guard-upload"  node "$BIN" upload

# 프롬프트 없는 run은 usage + exit 1 (모델 호출 없이 정직 실패해야 함).
guard "guard-run-no-prompt" sh -c "node '$BIN' run < /dev/null"

# 살아있는 계약 테스트
check "bootstrap-race" node "$SCRIPT_DIR/bootstrap-race.cjs"
check "sqlite-driver-probe" node "$SCRIPT_DIR/sqlite-driver-probe.cjs"
check "experience-taxonomy-parity" node "$SCRIPT_DIR/experience-taxonomy-parity.cjs"
check "tool-workspace-boundary" node "$SCRIPT_DIR/tool-workspace-boundary.cjs"

# 공개 저장소 push 가드가 test/ 신규 파일을 막을 수 있어, v2 신규 계약 테스트는
# 존재할 때만 실행한다 (로컬/사설 CI에서는 전부 돈다 — v1과 동일 관례).
for optional in \
  session-orchestrator-contract timeout-regression update-semver-contract \
  login-loopback-security plugin-add-contract hub-install-contract \
  automation-contract workforce-runtime-contract capture-runtime-guard \
  mcp-config-isolation mcp-probe-concurrency mcp-consent-allowlist mcp-child-env-isolation \
  experience-p6-cli-contract experience-exchange-contract experience-auto-intake-contract \
  desktop-ontology-loadout-contract cloud-runtime-paths cloud-save-publish \
  cloud-asset-restore cloud-owner-restore cloud-cas-client \
  stormbreaker-core-contract workload-routing-contract swarm-protocol-contract \
  hephaestus-passthrough-contract oberon-contract project-bootstrap-contract \
  memory-prompt-budget credential-env-regression runtime-env-protection permission-mapping \
  session-fences-contract auto-route-contract firm-orchestrate-contract \
  repl-banner-contract repl-shortcuts-contract language-resolution-contract \
  slash-palette-navigation-contract repl-slash-parsing-contract \
  palette-command-coverage-contract repl-enter-and-arity-contract \
  model-role-pool-contract
do
  if [ -f "$SCRIPT_DIR/$optional.cjs" ]; then
    check "$optional" node "$SCRIPT_DIR/$optional.cjs"
  fi
done

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

# 런타임 번들 계약 패리티 — 허브(TS 발신) ↔ Core(파이썬 수신) ↔ 이 repo(CJS 수신).
# 허브는 머지 즉시 배포되고 두 수신자는 사용자 속도로 갱신되므로, 발신 쪽 필드명
# 하나가 바뀌면 배포된 클라이언트가 통째로 fail-closed 한다. 2026-07-27 P0
# (lazyRead ↔ allowRead)가 정확히 이 자리였고, 세 제품의 자체 테스트는 모두 초록이었다.
BUNDLE_SYNC="$(cd "$(dirname "$0")/.." && pwd)/../scripts/sync-runtime-bundle-contract.sh"
if [ -f "$BUNDLE_SYNC" ]; then
  if bash "$BUNDLE_SYNC"; then
    echo "PASS bundle-contract-parity"
    pass=$((pass + 1))
  else
    echo "FAIL bundle-contract-parity"
    fail=$((fail + 1))
  fi
fi

echo ""
echo "smoke: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
