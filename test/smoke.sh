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
check "help"    node "$BIN" help
check "usage"   node "$BIN" usage
check "mcp"     node "$BIN" mcp
check "chats"   node "$BIN" chats
check "run-api-regression" node "$SCRIPT_DIR/run-api-regression.cjs"
check "cloud-runtime-paths" node "$SCRIPT_DIR/cloud-runtime-paths.cjs"
check "cloud-save-publish" node "$SCRIPT_DIR/cloud-save-publish.cjs"
check "cloud-asset-restore" node "$SCRIPT_DIR/cloud-asset-restore.cjs"
check "cloud-owner-restore" node "$SCRIPT_DIR/cloud-owner-restore.cjs"
check "cloud-cas-client" node "$SCRIPT_DIR/cloud-cas-client.cjs"
check "runtime-env-protection" node "$SCRIPT_DIR/runtime-env-protection.cjs"
check "credential-env-regression" node "$SCRIPT_DIR/credential-env-regression.cjs"
check "tool-workspace-boundary" node "$SCRIPT_DIR/tool-workspace-boundary.cjs"
check "mcp-config-isolation" node "$SCRIPT_DIR/mcp-config-isolation.cjs"
check "mcp-child-env-isolation" node "$SCRIPT_DIR/mcp-child-env-isolation.cjs"
check "mcp-probe-concurrency" node "$SCRIPT_DIR/mcp-probe-concurrency.cjs"
check "mcp-consent-allowlist" node "$SCRIPT_DIR/mcp-consent-allowlist.cjs"
check "memory-prompt-budget" node "$SCRIPT_DIR/memory-prompt-budget.cjs"
check "experience-mcp-contract" node "$SCRIPT_DIR/experience-mcp-contract.cjs"
check "experience-exchange-contract" node "$SCRIPT_DIR/experience-exchange-contract.cjs"
check "experience-auto-intake-contract" node "$SCRIPT_DIR/experience-auto-intake-contract.cjs"
check "experience-p6-cli-contract" node "$SCRIPT_DIR/experience-p6-cli-contract.cjs"
check "desktop-ontology-loadout-contract" node "$SCRIPT_DIR/desktop-ontology-loadout-contract.cjs"
check "experience-taxonomy-parity" node "$SCRIPT_DIR/experience-taxonomy-parity.cjs"
check "bootstrap-race" node "$SCRIPT_DIR/bootstrap-race.cjs"
check "login-loopback-security" node "$SCRIPT_DIR/login-loopback-security.cjs"
check "timeout-regression" node "$SCRIPT_DIR/timeout-regression.cjs"
check "terminal-ui-regression" node "$SCRIPT_DIR/terminal-ui-regression.cjs"
check "route-regression" node "$SCRIPT_DIR/route-regression.cjs"
check "engine-hardening-regression" node "$SCRIPT_DIR/engine-hardening-regression.cjs"
check "permission-mapping" node "$SCRIPT_DIR/permission-mapping.cjs"
check "sqlite-driver-probe" node "$SCRIPT_DIR/sqlite-driver-probe.cjs"
check "capture-runtime-guard" node "$SCRIPT_DIR/capture-runtime-guard.cjs"
check "workload-routing-contract" node "$SCRIPT_DIR/workload-routing-contract.cjs"
check "workforce-runtime-contract" node "$SCRIPT_DIR/workforce-runtime-contract.cjs"
check "update-safety" node "$SCRIPT_DIR/update-safety.cjs"
check "semver-precedence" node "$SCRIPT_DIR/semver-precedence.cjs"
# 공개 저장소 push 가드가 test/ 아래 신규 파일을 막아 이 스크립트는 로컬에만 존재한다.
# 있으면 돌리고, 없으면(공개 clone/CI) 조용히 건너뛴다 — 실패로 잡지 않는다.
if [ -f "$SCRIPT_DIR/plugin-add-contract.cjs" ]; then
  check "plugin-add-contract" node "$SCRIPT_DIR/plugin-add-contract.cjs"
fi
if [ -f "$SCRIPT_DIR/memory-import-contract.cjs" ]; then
  check "memory-import-contract" node "$SCRIPT_DIR/memory-import-contract.cjs"
fi

# Agentlas OS 표면: 무인자 호출은 usage를 내고 exit 1 (프롬프트 오라우팅 방지 확인)
guard() {
  name="$1"; shift
  if out="$("$@" 2>&1)"; then echo "FAIL $name (should exit non-zero)"; fail=$((fail + 1));
  else echo "PASS $name"; pass=$((pass + 1)); fi
}
guard "guard-search"  node "$BIN" search
guard "guard-install" node "$BIN" install
guard "guard-upload"  node "$BIN" upload

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
