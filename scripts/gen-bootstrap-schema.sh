#!/bin/sh
# 실제 앱 DB에서 부트스트랩 스키마를 재생성한다 (앱 없는 첫 실행용).
#
#   sh scripts/gen-bootstrap-schema.sh [db-path]
#
# 기본 소스: ~/Library/Application Support/Agentlas/agentlas.sqlite
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(dirname "$SCRIPT_DIR")"
DB="${1:-$HOME/Library/Application Support/Agentlas/agentlas.sqlite}"
OUT="$PKG_ROOT/engine/bootstrap-schema.sql"

[ -f "$DB" ] || { echo "DB를 찾을 수 없습니다: $DB" >&2; exit 1; }

USER_VERSION="$(sqlite3 "$DB" 'PRAGMA user_version;')"
{
  echo "-- Agentlas 첫 실행 부트스트랩 스키마 (생성: $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "-- 소스 DB user_version=$USER_VERSION — 앱이 나중에 설치되면 여기서부터 마이그레이션한다."
  echo "PRAGMA user_version=$USER_VERSION;"
  sqlite3 "$DB" ".schema" | grep -v "sqlite_sequence"
} > "$OUT"
echo "written: $OUT (user_version=$USER_VERSION, $(grep -c 'CREATE' "$OUT") CREATE statements)"
