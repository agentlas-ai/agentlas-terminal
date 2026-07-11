# agentlas

```
  █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗      █████╗ ███████╗
 ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║     ██╔══██╗██╔════╝
 ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║     ███████║███████╗
 ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║     ██╔══██║╚════██║
 ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████╗██║  ██║███████║
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝
```

**The operating system for agents — in your terminal.** Chat with your AI
agents and teams, build new ones, and run the full Agentlas OS surface
(`build` · `search` · `install` · `storm` · `network` · …) from one command.
Claude Code style, standalone: **no desktop app required.**

Agentlas Terminal is the already-shipped independent terminal product. It is
not a Desktop `cli/` mirror and does not require the Desktop app to run.

> **We are Agent Trust. Your agent is not a program. It is an asset. — Agentlas —**

Agent Trust means owner-scoped, portable, inspectable, and restorable agent
packages. It is a product principle, not a claim of regulated financial or
legal trust services. Private Agent Cloud stores owned packages; this existing
Terminal verifies and runs their local execution copies through supported
runtimes.

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
agentlas                           # 대화형 TUI (워드마크 → 할 일 입력 → 스트리밍 REPL)
agentlas "할 일"                    # 자동 라우팅 후 1회 실행
```

**대화 & 실행**
```sh
agentlas <agent>                   # 해당 에이전트와 대화 (예: agentlas seo)
agentlas run [agent] "프롬프트"      # 1회 실행 (agent 생략 시 자동 라우팅, prompt 없으면 stdin)
agentlas firm <firm> "프롬프트"     # 회사(팀) CEO에 위임
agentlas chats [n]                 # 최근 대화 목록
```

**에이전트 & 허브** (Agentlas OS 표면)
```sh
agentlas search "할 일"            # Hub에서 에이전트 발견            (hep-search)
agentlas install <slug>            # 공개 Hub 에이전트 설치           (hep-cloud)
agentlas build "요청"              # 에이전트/팀 빌드·수리·패키징     (hep-build)
agentlas upload <경로>             # 내 Agent Cloud에 비공개 저장    (hep-upload)
agentlas upload <경로> --visibility marketplace
                                  # 호환 flag: Agentlas Hub 공개 발행
agentlas connect                   # Telegram/플랫폼 연결             (hep-connect)
agentlas import <폴더>             # 로컬 에이전트/팀 임포트
agentlas list                      # 설치된 에이전트/회사 + 활성 런타임
```

**내 Agent Cloud 자산**
```sh
agentlas cloud save <경로>         # 소유자 전용 비공개 저장(공개 심사/라우팅 카드 없음)
agentlas cloud publish <경로>      # Agentlas Hub에 명시적으로 공개 발행
agentlas cloud list                # 로그인한 소유자의 비공개 패키지 조회
agentlas cloud restore <slug>      # 전체 hash 검증 후 이 컴퓨터에 exact snapshot 복원
```

비공개 저장도 업로드 전 로컬에서 비밀값, 안전하지 않은 경로, 파일별 hash와
전체 package hash를 검사한다. 공개 Hub 발행에만 라우팅 카드와 공개 검토가 붙는다.

`agentlas cloud install <slug>`은 기존 호환 명령이며 공개 Hub 설치다. 비공개
Agent Cloud 소유자 복원은 반드시 `agentlas cloud restore <slug>`를 사용한다.

**실행 엔진**
```sh
agentlas storm "목표"              # 견고 파이프라인 라우팅→검증→실행 (Stormbreaker) [--research]
agentlas swarm "목표"              # emergent 에이전트 스웜 [--parallel N]
agentlas network "요청"            # A2A 태스크포스로 분해            (hep-network)
agentlas call "a,b" "컨텍스트"      # 지정 에이전트 호출               (hep-call)
agentlas browser                   # 실제 브라우저 하드포인트          (hep-browser)
agentlas route "요청"              # 라우팅 미리보기 (실행 없음)
```

**지식 & 리서치**
```sh
agentlas research <sub>            # Research Engine (status|gather|search|read|plan)
agentlas ontology <sub>            # 프로젝트 지식 (status|list|add)
agentlas journal <sub>             # Stormbreaker 저널 (status|verify|repair|gate)
```

**계정 & 운영**
```sh
agentlas login | logout | whoami   # Agentlas Cloud 로그인 (브라우저 플로우)
agentlas automation <sub>          # list|add|on|off|remove|run <id>|runs|daemon (로컬 스케줄러)
agentlas creds <sub> · env         # 자격증명 볼트 · env
agentlas multimodal                # 이미지/영상/음성 provider
agentlas usage · telegram · mcp    # 사용 현황 · 텔레그램 · MCP 서버
agentlas doctor                    # 런타임/데이터 점검
agentlas update                    # npm 최신판 확인
agentlas setup                     # 온보딩 다시 실행
```

**고급**
```sh
agentlas hep <sub…>                # 전체 Hephaestus 패스스루 (wizard·security·cards·ao·plugins…)
agentlas netadmin <sub>            # 로컬 네트워크 관리 (init|status|reindex|bench)
agentlas cloud <sub>               # 자산 저장·공개·복원 (save|publish|package|list|restore|…)
```

공통 옵션: `--runtime claude-code|codex|gemini` · `--permission read|write|full`
REPL 안에서는 `/`로 명령 팔레트 (`/build` `/search` `/storm` `/network` …).

## 동작 방식

런처(`bin/agentlas.cjs`)가 이 패키지의 `engine/`(정본)을 시스템 Node로 실행한다 —
데스크탑 앱과 완전히 독립이며, 앱이 설치돼 있으면 같은 userData(SQLite)를 써서
데이터만 자연스럽게 공유된다. `engine/ENGINE_META.json`에 최초 임포트 출처가 기록돼 있다.

SQLite는 `better-sqlite3`(optionalDependency, npm이 네이티브 빌드) → 실패 시
Node 22+ `node:sqlite` 폴백. 데이터 폴더는 앱과 동일한 userData
(macOS `~/Library/Application Support/Agentlas`)이며 `AGENTLAS_USER_DATA_DIR`로
바꿀 수 있다.

### 개발

엔진 소스는 `engine/*.cjs` — 여기가 정본이므로 직접 수정한다.
첫 실행용 스키마가 데스크탑 DB 마이그레이션과 어긋나면 재생성:

```sh
sh scripts/gen-bootstrap-schema.sh [db-path]       # engine/bootstrap-schema.sql 재생성
```

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

Apache-2.0 — Agentlas Terminal is the independent terminal runtime for the
[Agentlas OS](https://github.com/agentlas-ai/Agentlas-OS) package contract. Its
`engine/` directory is maintained and released from this repository; it is not
a generated mirror of Agentlas Desktop.
