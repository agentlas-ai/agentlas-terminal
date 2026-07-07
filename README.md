# agentlas

**The Agentlas agent terminal.** Chat with your installed AI agents and teams
from the terminal — Claude Code style. Standalone: no desktop app required.

```sh
npm install -g agentlas
agentlas
```

Type a task and it auto-routes to the right agent. Your model, your choice:
Claude Code / Codex / Gemini CLI subscriptions or BYOK API keys.

---

**Agentlas 터미널 CLI** — Claude Code(`claude`), Codex(`codex`)처럼
`npm install` 하나로 깔리고, `agentlas` 하나로 도는 독립 에이전트 터미널.
**데스크탑 앱이 없어도 동작한다.**

- 엔진(대화형 REPL·에이전트 라우팅·팀 실행·클라우드 설치·자격증명 관리)이
  패키지에 통째로 번들되어 있다.
- 첫 실행 시 앱과 동일한 SQLite 스키마를 직접 부트스트랩하고 빌트인
  에이전트(오케스트레이터·PM 소울·메모리 큐레이터 등)를 시드한다.
- 데스크탑 앱이 설치돼 있으면 같은 데이터(에이전트·채팅·키체인)를 자동
  공유한다 — 앱에서 설치한 에이전트가 터미널에 바로 보인다.

## 설치

```sh
npm install -g agentlas
# 또는 이 폴더에서: npm install -g .
# 또는: sh install.sh              # ~/.local/bin/agentlas 심링크 (sudo 불필요)
```

Windows(미검증): `powershell -ExecutionPolicy Bypass -File install.ps1`

요구사항: Node 20+ (better-sqlite3 빌드 실패 시 Node 22+의 `node:sqlite` 폴백).
에이전트 실행에는 claude / codex / gemini 중 하나의 CLI가 필요하다(BYOK API 키도 가능).

## 사용

```sh
agentlas                           # 대화형 TUI (온보딩 → 에이전트 피커 → 스트리밍 REPL)
agentlas list                      # 설치된 에이전트/회사 + 활성 런타임
agentlas <agent>                   # 해당 에이전트와 대화형 세션
agentlas run <agent> "프롬프트"     # 1회 실행 (prompt 없으면 stdin)
agentlas firm <firm> "프롬프트"     # 회사(팀) 실행
agentlas cd <agent>                # 에이전트 폴더 경로 → cd "$(agentlas cd seo)" && claude
agentlas import <폴더>             # 로컬 에이전트/팀 임포트
agentlas storm "목표"               # Stormbreaker 파이프라인 (라우팅→검증→실행) [--research]
agentlas swarm "목표"               # emergent 에이전트 스웜 (병렬+블랙보드+종합) [--parallel N]
agentlas automation list|add|on|off|runs   # 자동화 등록/관리 (실행은 앱 스케줄러)
agentlas cloud search "찾는 일"     # 마켓플레이스 검색 (로그인 불필요)
agentlas cloud install <slug>      # 마켓플레이스에서 에이전트 설치
agentlas usage                     # 로컬 사용 현황 (실행/메시지/자동화)
agentlas telegram                  # 텔레그램 바인딩 현황 (읽기 전용)
agentlas creds / env               # 자격증명 · env
agentlas multimodal                # 이미지/영상/음성 provider
agentlas doctor                    # 런타임/데이터 점검
agentlas setup                     # 온보딩(언어→런타임→권한) 다시 실행
agentlas update                    # Desktop 최신 릴리스 확인/설치
```

공통 옵션: `--runtime claude-code|codex|gemini` · `--permission read|write|full`

## 동작 방식

런처(`bin/agentlas.cjs`)가 엔진을 골라 실행한다 (`AGENTLAS_CLI_SOURCE`):

| 소스 | 설명 |
|------|------|
| `bundled` (기본) | 패키지에 번들된 `engine/` — 시스템 Node로 실행, 앱 불필요 |
| `app` | 설치 앱의 `app.asar` CLI를 앱 Electron(`ELECTRON_RUN_AS_NODE`)으로 실행 |
| `repo` | 개발 리포 `agentlas_desktop/cli` (개발용) |
| `auto` | bundled → app → repo |

SQLite는 `better-sqlite3`(optionalDependency, npm이 네이티브 빌드) → 실패 시
Node 22+ `node:sqlite` 폴백. 데이터 폴더는 앱과 동일한 userData
(macOS `~/Library/Application Support/Agentlas`)이며 `AGENTLAS_USER_DATA_DIR`로
바꿀 수 있다.

### 엔진 갱신 (데스크탑 리포에서 재벤더링)

```sh
node scripts/sync-engine.mjs [desktop-repo-root]   # engine/*.cjs 갱신
sh scripts/gen-bootstrap-schema.sh [db-path]       # 첫 실행용 스키마 재생성
```

`engine/ENGINE_META.json`에 소스 버전/커밋이 기록된다.

### 진단

```sh
agentlas --where                   # 엔진/DB 해석 결과 JSON
sh test/smoke.sh                   # where/version/list/doctor + 신선 환경 첫 실행
```

## 제거

```sh
npm uninstall -g agentlas            # npm 설치 시
rm ~/.local/bin/agentlas             # install.sh 설치 시
```

## License

Apache-2.0 — engine sources are vendored from the public
[agentlas-ai/agentlas-desktop](https://github.com/agentlas-ai/agentlas-desktop) repo
(see `engine/ENGINE_META.json` for the exact version/commit).
