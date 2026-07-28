# agentlas

```
  █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗      █████╗ ███████╗
 ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║     ██╔══██╗██╔════╝
 ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║     ███████║███████╗
 ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║     ██╔══██║╚════██║
 ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████╗██║  ██║███████║
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝
```

**Agentlas 터미널 CLI** — `npm install -g agentlas` 하나로 깔리고 `agentlas`
하나로 도는 독립 에이전트 터미널. 설치된 AI 에이전트·팀과 대화하고, 새로 만들고,
멀티세션으로 굴린다. 데스크탑 앱이 없어도 동작하며, 앱이 깔려 있으면 같은
SQLite(userData)를 공유해 에이전트·대화·자동화가 양쪽에서 그대로 보인다.
모델은 당신 것을 쓴다 — Claude Code / Codex / Gemini CLI 구독 또는 BYOK API 키.

> **We are Agent Trust. Your agent is not a program. It is an asset. — Agentlas —**

Agent Trust는 에이전트 패키지를 소유자 범위·이식 가능·검사 가능·복원 가능하게
다룬다는 **제품 원칙**이다. 금융·법률상 신탁(trust) 서비스를 뜻하지 않는다.
Agent Cloud는 소유한 패키지를 보관하고, 이 터미널은 그 로컬 실행 사본을 지원
런타임으로 검증·실행한다.

---

## 요구사항

| 항목 | 내용 |
| --- | --- |
| Node | **22+ 권장.** `package.json`의 `engines`는 `>=20`이지만, 런처는 optional 네이티브 의존성 `better-sqlite3` 빌드가 실패하면 Node 22+의 `node:sqlite`로만 폴백한다 (`bin/agentlas.cjs`). 즉 **Node 20은 better-sqlite3 네이티브 빌드가 성공할 때만** 동작한다. |
| 에이전트 CLI | 실행에는 `claude` · `codex` · `gemini` 중 최소 하나가 PATH에 필요하다. 하나도 없으면 `no_runtime`으로 정직하게 멈춘다(가짜 응답 폴백 없음). |
| OS | macOS / Linux 검증. Windows는 런처·설치 스크립트가 있으나 미검증. |

`kimi` · `grok` · `cursor-agent`는 **탐지만 되고 아직 구동되지 않는다**
(`engine/runtimes/resolve.cjs`의 `EXECUTABLE_KINDS = claude-code, codex, gemini`).
`doctor`가 이들을 "감지됨"으로 표시해도 `--runtime`으로 지정하면
`has no v2 streaming driver yet`으로 거절한다.

## 설치

```sh
npm install -g agentlas
# 또는 이 폴더에서: npm install -g .
# 또는:            sh install.sh              # ~/.local/bin/agentlas 심링크 (sudo 불필요)
# 또는:            sh install.sh --prefix /usr/local/bin
```

Windows(미검증): `powershell -ExecutionPolicy Bypass -File install.ps1`

## 빠른 시작

```sh
agentlas
```

**1. 첫 실행 마법사** — TTY 첫 실행에서 3단계 온보딩이 뜬다: 언어 → 기본 런타임
(`auto` 또는 설치된 CLI) → 기본 권한(read/write/full). 결과는 `cli-prefs.json`에
저장되고, 언제든 `agentlas setup`으로 다시 돌린다. 같은 실행에서 데이터 폴더가
없으면 데스크탑과 동일한 스키마로 SQLite를 부트스트랩하고 빌트인 에이전트
(오케스트레이터·PM 소울·메모리 큐레이터 등)를 시드한다.

**2. 실제 작업 한 번 돌리기**

```sh
agentlas "이 저장소의 테스트 실패 원인을 찾아줘"   # 자동 라우팅 → 1회 실행
agentlas run -p "CHANGELOG 최근 3개 요약"          # 최종 답만 stdout (파이프용)
git log --oneline -20 | agentlas run              # 프롬프트 없으면 stdin을 읽는다
agentlas <agent>                                   # 그 에이전트와 대화형 REPL
agentlas firm <firm> "요청"                        # 회사(팀) CEO에 위임
```

자동 라우팅은 호스트 LLM 판정이 고른다. 어휘 점수는 후보 모집에만 쓰고 선택은
하지 않는다. 판정 런타임이 없으면 기본 에이전트로 폴백하되 그 사실을 stderr에
반드시 남긴다(조용한 오라우팅 금지).

**3. 대화 이어가기**

```sh
agentlas chats            # 최근 대화 목록 (데스크탑과 같은 DB)
agentlas chats 30
agentlas open <chat-id>   # 그 챗의 에이전트로 REPL 재개
```

## 명령 목록

`agentlas help`가 정본이다. 아래는 같은 그룹 구성이다.

### TALK & RUN
```sh
agentlas <agent>                 # 에이전트와 대화 (= chat <agent>)
agentlas chat <agent>
agentlas run [agent] [prompt]    # 1회 실행 (-p · --runtime · --permission · stdin)
agentlas firm <firm> [task]      # 회사 CEO에 위임
agentlas chats [n]               # 최근 대화
agentlas open <chat-id>          # 대화 재개
agentlas cd <agent>              # 그 에이전트 폴더 경로만 출력 (cd "$(agentlas cd x)")
```

### AGENTS & HUB
```sh
agentlas search "<필요한 일>"     # Hub 에이전트 검색 (로그인 불필요)
agentlas install <slug>          # Hub 에이전트 로컬 설치 (아래 설치 게이트 참고)
agentlas plugin add <slug>       # Hub 플러그인(MCP 서버) 추가
agentlas plugin list             # (= agentlas plugins)
agentlas build "<요청>"           # 에이전트/팀 빌드·수리·패키징
agentlas upload <경로>            # 기본은 owner-private Agent Cloud 저장
agentlas upload <경로> --visibility marketplace   # 명시적 공개 Hub 발행
agentlas connect <sub>           # Telegram 등 플랫폼 연결 (무인자는 usage, exit 0)
agentlas import <폴더>            # 로컬 에이전트/팀 임포트
agentlas native prepare <agent>  # 네이티브 CLI 문맥 파일 생성
agentlas list                    # 설치 에이전트/회사 + 활성 런타임
agentlas uninstall <agent> [--yes]  # 설치 에이전트 제거 (빌트인 거부).
                                 # 대화 이력이 있으면 건수를 보여주고 --yes 없이는 거절한다
                                 # (챗/메시지가 CASCADE로 함께 영구 삭제되기 때문).
agentlas experience <sub>        # list|inspect|validate|save|publish|status|export|unpublish|withdraw
agentlas variant resolve --base-release <id>   # 로컬 variant 호환성 프리뷰 (권위 없음, `agentlas variant help`)
```

### EXECUTE
```sh
agentlas storm "<목표>"           # Goal+UltraCode 하네스: 계획 → 배정 → 실행 → 검증 [--research]
agentlas swarm "<목표>"           # emergent 에이전트 스웜 [--parallel N]
agentlas workforce "<요청>"       # Agent Workforce Ontology 라우트
agentlas network "<요청>"         # workforce 별칭
agentlas taskforce "<요청>"       # workforce 별칭
agentlas legacy-network "<요청>"  # 이전 Hephaestus 분해기 (명시 호출 전용)
agentlas call "a,b" "<맥락>"      # 이름을 정확히 지정한 Hub/Cloud 에이전트 호출
agentlas browser [...]           # 실제 브라우저 하드포인트
agentlas route "<요청>" [--json]  # 라우팅 미리보기 (실행 없음)
agentlas research <sub>          # status|gather|search|read|plan
```

### KNOWLEDGE
```sh
agentlas memory import <경로> --agent <id> [--apply]
agentlas evolve [list|apply <id>|revert <id>]
agentlas ontology <sub>          # status|list|add
agentlas career-graph <sub>      # 상태·소스 등록 + ingest|query|verify|trace|public-card 위임
agentlas journal <sub>           # status|verify|repair|gate
agentlas project [status|init]   # `.agentlas/` 를 만드는 유일한 진입점
agentlas context <sub>           # refresh|locate|refs|slice|impact|verify
```

`agentlas project init`으로 **명시 초기화한 프로젝트에서만** 일반 실행·팀·
Stormbreaker·Workforce가 같은 로컬 Context Slice를 받는다. 읽기·쓰기·전체 권한만
으로는 `.agentlas/`나 `.gitignore`를 만들거나 고치지 않는다. Hub/Cloud 검색에는
코드맵·소스 경로·프로젝트 파일 내용이 전송되지 않는다.

### ACCOUNT & OPS
```sh
agentlas login | logout | whoami  # Agentlas Cloud 로그인 (loopback 브라우저 플로우)
agentlas billing                  # 크레딧 잔액
agentlas cloud <sub>              # save|publish|package|list|restore|delete|search|install
                                  # |security scan|runtime bundle|field-test  (cloud help 참고)
agentlas automation <sub>         # list|add|on|off|remove|run <id>|runs|daemon
agentlas creds save --provider <n> --key <ENV> --value <v>
agentlas creds file --source <경로> [--env <ENV>]   # 값은 어떤 경로로도 출력하지 않음
agentlas env                      # 공유 env 키 이름만 열거 (값 없음)
agentlas usage                    # 로컬 사용 현황 (공급자 쿼터 대시보드는 데스크탑)
agentlas telegram                 # 바인딩 현황 (읽기 전용)
agentlas mcp                      # MCP 서버 목록
agentlas mcp probe <id>           # initialize→tools/list 핸드셰이크만 확인
agentlas multimodal               # 이미지/영상/음성 provider 설정
agentlas doctor                   # 런타임·데이터·세션 점검
agentlas setup                    # 첫 실행 마법사 재실행 (TTY 필요)
agentlas update                   # npm 최신판 확인 (자기 패키지만)
agentlas oberon <sub>             # AI 필름 렌더: scaffold|render|list|open (= agentlas film)
agentlas hep <sub…>               # Hephaestus 네이티브 전체 패스스루
agentlas netadmin <sub>           # 로컬 네트워크 admin (init|status|reindex|bench|add-source)
agentlas version | help
```

공통 옵션: `-p|--print` · `--runtime claude-code|codex|gemini` ·
`--permission read|write|full`

### 오타 가드 / 데스크탑 표면 거절

공백 없는 **한 단어**를 넣었는데 명령도 에이전트도 아니면, 프롬프트로 흘려서
모델을 부르지 않는다. 편집거리로 가장 가까운 명령을 최대 3개 제안하고 exit 1로
멈춘다.

```
$ agentlas lst
'lst' 은(는) agentlas 명령이 아닙니다. 혹시: list
명령 목록: agentlas help  ·  한 단어를 그대로 실행하려면: agentlas run -p "lst"
```

데스크탑 전용 표면 이름(`site` `trex` `prompts` `dashboard` `marketplace`
`library` `groups` `settings` `apps` `quests` `bookmarks` `one` …)도 같은 방식으로
멈추고 터미널 대체 경로를 안내한다. 진짜 그 단어를 작업으로 돌리려면 따옴표로
감싸거나 `run -p`를 쓴다.

### 권한

| Agentlas 권한 | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| `read` | `plan` | `read-only` sandbox | `plan` |
| `write` | `acceptEdits` | `workspace-write` sandbox | `auto_edit` |
| `full` | permission 검사 우회 | approval + sandbox 우회 | `yolo` |

저장된 `full`은 세션 한정이라 다음 실행에서 `write`로 fail-closed 강등된다.
REPL의 `!<셸명령>`은 작업 공간 경계를 강제할 수 없어 **`full`에서만** 실행되며,
출력 8MB 캡·표시 전 시크릿 마스킹·프로세스 그룹 종료가 걸린다.

## REPL & Orca 멀티세션

`agentlas`를 인자 없이 실행하면 REPL로 들어간다. 포그라운드 턴도 하나의 세션이고,
`/spawn`으로 만든 서브에이전트는 백그라운드 세션으로 병렬로 돈다. 화면은 활성
세션 하나만 스트리밍하고, 백그라운드 턴 종료는 한 줄 알림으로 뜬다.

### 슬래시 명령 (정본: `engine/ui/palette.cjs`)

| 명령 | 하는 일 |
| --- | --- |
| `/help` | 명령·단축키 |
| `/sessions` · `/tree` | 세션 표 / 부모-자식 트리 |
| `/s <n>` · `/switch <n>` | 활성 세션 전환 (tail 재생 + 라이브 구독) |
| `/spawn <agent> [task]` | 서브에이전트 세션 생성(+task 주면 즉시 실행) |
| `/steer <n> <msg>` | 그 세션의 다음 턴에 지시 큐잉 |
| `/kill <n>` | 실행 중 턴 중단 |
| `/rm <n>` | 세션 제거 |
| `/broadcast <msg>` | 모든 세션에 같은 지시 |
| `/use <agent>` | 메인 세션 에이전트 교체 |
| `/agents` · `/list` | 설치 에이전트 목록 |
| `/chats [n]` | 최근 대화 |
| `/mcp` | MCP 서버 목록 |
| `/doctor` | 런타임·데이터 점검 |
| `/runtime <kind>` | 새 세션 런타임 지정 (claude-code\|codex\|gemini) |
| `/permission <level>` | 새 세션 권한 지정 (read\|write\|full) |
| `/quit` · `/exit` | 종료 |

목록에 없는 슬래시는 `unknown: /xxx (see /help)`로 멈춘다 — REPL 슬래시는
top-level 명령으로 흘러가지 않는다.

### 키·입력

| 입력 | 동작 |
| --- | --- |
| 실행 중 타이핑 후 Enter | 그 세션의 **다음 턴 스티어링 큐**에 들어간다 (턴을 끊지 않음) |
| `ctrl-c` (실행 중) | 현재 턴만 중단 |
| `ctrl-c` (유휴) | 1회는 경고, **2회 연속이면 종료** |
| `Tab` | 슬래시 명령 · 에이전트/회사 슬러그 · **살아있는 세션 키(s1, s2…)** · `/runtime` `/permission` 값 완성 |
| `@경로` + `Tab` | 파일 경로 완성 |
| `↑` / `↓` | 입력 히스토리 |
| `!<셸명령>` | 셸 실행 — **`full` 권한에서만** |

동시 실행 상한은 기본 4다. 초과 스폰은 대기가 아니라 정직한 거부이며
`AGENTLAS_MAX_PARALLEL`(최대 16)로 올린다.

## 동작 방식

### 엔진 경계 — 터미널은 Agentlas OS를 재구현하지 않는다

이건 자주 오해된다. 터미널은 **설치된 Agentlas OS(Hephaestus/Core) 런타임을 찾아
그 런타임을 실행**한다. 자체 사본을 들고 있지 않다.

탐색 순서 (`engine/agentlas-core-harness.cjs`, `engine/hephaestus/runtime.cjs`):

1. `HEPHAESTUS_BIN` / `HEPHAESTUS_RUNTIME_ROOT`
2. `~/.agentlas/runtime/current`
3. 패키징된 Core (`<resources>/Hephaestus`, macOS는
   `/Applications/Agentlas.app/Contents/Resources/Hephaestus`)

`storm` · `swarm` · `workforce`/`network` · `route` · `research` · `context` ·
`career-graph`(파생 인덱스) · `journal` · `netadmin` · `hep` · `build` · `call` ·
`browser` · `connect`은 이 런타임으로 넘어가는 **패스스루**다. 런타임이 없으면
로컬 모조 실행이나 어휘 폴백을 만들지 않고 무엇이 없는지 말하고 exit 1 한다
(예: `storm`은 `stormbreaker-core-harness-unavailable`, `context`는 Core/Python
부재를 보고). 이 정직 정지가 계약이다.

터미널 자체가 소유한 것: REPL·세션 오케스트레이션·에이전트 레지스트리·Hub/Cloud
HTTP 표면·자격증명·MCP 프리플라이트·자동화 스케줄러·SQLite 스키마.

### 공유 상태 — 데스크탑과 같은 DB

런처(`bin/agentlas.cjs`)가 이 패키지의 `engine/`(정본)을 시스템 Node로 실행한다.
데이터 폴더는 데스크탑 앱과 **동일한 userData**다 (`engine/core/paths.cjs`):

| OS | 경로 |
| --- | --- |
| macOS | `~/Library/Application Support/Agentlas` |
| Windows | `%APPDATA%\Agentlas` |
| Linux | `$XDG_CONFIG_HOME/Agentlas` (기본 `~/.config/Agentlas`) |

DB는 그 폴더의 `agentlas.sqlite`. 첫 실행 시 `engine/bootstrap-schema.sql`
(`user_version=45`)로 부트스트랩하며, 앱을 나중에 깔면 앱이 거기서부터
마이그레이션한다. 결과적으로 **에이전트·챗·자동화·MCP 등록이 양쪽에서 같이
보인다.** `/spawn`으로 만든 서브에이전트 세션은 데스크탑의 `division` 서브챗
(`kind='division'` + `parent_chat_id`)으로 그대로 남는다.

SQLite 드라이버 사다리: `better-sqlite3`(optionalDependency, 네이티브 빌드
성공 시) → 실패하면 Node 22+ `node:sqlite`.

### Hub는 빌려 쓰는 게 기본, 설치는 예외

`engine/hub/install.cjs`의 `assertHubInstallAllowed`가 로컬 설치를 게이트한다.
막히는 경우:

- **cloud-callable / call-only 에이전트** — 로컬 설치 불가. 빌려 쓴다:
  `agentlas call <slug>` (데스크탑에서는 북마크). 소유자는
  `agentlas cloud restore <slug>`로 자기 패키지를 복원한다.
- **지시문 없는 패키지** — 안전한 로컬 설치에 필요한 instructions가 없으면 거절.
- **trustGrade가 A/B가 아님** — 사이드로드는 명시 승인이 필요하다며 차단.
- **web-only 에이전트** — 터미널에서 제공하지 않는다.
- **회수된 공개 리스팅** — 데스크탑 마켓플레이스와 같은 관측 결과
  (`Hub agent not found`).

`upload`도 같은 방향이다: 기본은 owner-private Agent Cloud 저장이고, 공개 Hub
발행은 `--visibility marketplace`를 명시할 때만 일어난다.

## 데스크탑 전용 (터미널에서 약속하지 않는 것)

- Telegram 봇 발급·포트 관리 (터미널의 `telegram`은 **읽기 전용 바인딩 조회**)
- 에이전트 그룹(조합)
- 승인 인박스 / 브라우저 승인 시트
- MCP 커스텀 서버 추가·토글 (터미널은 목록 + `mcp probe`만)
- Site 스튜디오 · T-rex 슬라이드 스튜디오 · Prompt Store
- 모바일 페어링
- 퀘스트
- Hub 북마크
- 공급자 쿼터 대시보드, Marketplace/Library 브라우징, Agentlas One

## 환경변수

| 변수 | 효과 |
| --- | --- |
| `AGENTLAS_USER_DATA_DIR` | 데이터 폴더 override (기본: 데스크탑과 같은 userData) |
| `AGENTLAS_LANG` | `ko` \| `en` — prefs와 `LANG`보다 우선 |
| `AGENTLAS_MAX_PARALLEL` | 동시 실행 세션 상한 (기본 4, 최대 16) |
| `AGENTLAS_SESSION` | Agentlas Cloud 세션 쿠키 값. 해석 순서는 env → 세션 파일이라, 설정돼 있으면 `logout` 후에도 로그인 상태로 보인다 |
| `AGENTLAS_WEB_BASE_URL` | 웹 베이스 (기본 `https://agentlas.cloud`) |
| `AGENTLAS_MCP_BASE_URL` | Hub MCP 베이스 (기본 `<web>/api/mcp/v1`) |
| `HEPHAESTUS_BIN` · `HEPHAESTUS_RUNTIME_ROOT` | Agentlas OS 런타임 위치 지정 (탐색 사다리 1순위) |
| `AGENTLAS_MODEL_MAX_TIER` | `economy`\|`balanced`\|`frontier` — **swarm 배정 한정** 비용 상한 |
| `NO_COLOR` | 비어 있지 않으면 컬러 출력 끔 (`FORCE_COLOR=1`로 강제 켜기, `AGENTLAS_NO_COLOR=1`도 끔) |

## 문제 해결

```sh
agentlas doctor      # DB · PATH의 런타임 · 활성 런타임 · 클라우드 세션
agentlas --where     # 런처/엔진/DB 해석 결과 + sqlite 드라이버 + Node 버전 JSON
```

- **`no_runtime: no agent CLI found`** — `claude` / `codex` / `gemini` 중 하나를
  설치하고 PATH에 올린다. `doctor`가 `kimi`/`grok`/`cursor-agent`를 감지했더라도
  구동 드라이버가 없어 실행 대상이 아니다.
- **`runtime '<kind>' has no v2 streaming driver yet`** — `--runtime`에 아직
  구동되지 않는 런타임을 지정했다. `claude-code` · `codex` · `gemini`만 된다.
- **`Node vX — Node 22+ (node:sqlite) is required when better-sqlite3 is
  unavailable.`** — Node 20/21에서 `better-sqlite3` 네이티브 빌드가 실패했다.
  Node 22+로 올리거나 빌드 도구를 갖추고 재설치한다. `--where`의 `sqliteDriver`가
  실제 사용 드라이버를 알려준다.
- **`storm`/`context`/`hep`가 런타임 없음으로 멈춤** — Agentlas OS 런타임이 없다.
  설치하거나 `HEPHAESTUS_BIN=<경로>`를 지정한다.
- **`'xxx' 은(는) agentlas 명령이 아닙니다`** — 오타 가드다. 작업으로 돌리려면
  `agentlas run -p "xxx"`.
- **`logout` 했는데 로그인 상태** — `AGENTLAS_SESSION`이 설정돼 있다. env를 지운다.
- **`agentlas setup requires an interactive terminal`** — 비-TTY에서 마법사를 돌리면
  조용한 성공으로 위장되므로 거절한다.

## 개발

엔진 소스는 `engine/*.cjs` — 여기가 정본이므로 직접 수정한다.

```sh
sh test/smoke.sh                              # 기본 표면 + 무인자 가드 + 신선 환경 첫 실행
                                              # + 계약 테스트 + Runtime Doctor 3제품 패리티 게이트
npm run smoke                                 # 동일 (= npm run test:release-contracts)
sh scripts/gen-bootstrap-schema.sh [db-path]  # engine/bootstrap-schema.sql 재생성
```

스모크는 임시 `AGENTLAS_USER_DATA_DIR`에서 돌아 실제 데이터를 건드리지 않는다.
런타임 진단·수리 규칙(`engine/agentlas-doctor.cjs`)을 고쳤다면 3제품 패리티
게이트를 반드시 통과시켜라.

## 제거

```sh
npm uninstall -g agentlas     # npm 설치 시
rm ~/.local/bin/agentlas      # install.sh 설치 시 (또는 지정한 --prefix)
```

데이터는 userData 폴더에 남는다 (위 "공유 상태" 표 참고) — 데스크탑 앱과 공유하는
폴더이므로 지우기 전에 확인한다. `agentlas uninstall <agent>`는 **설치 에이전트**를
지우는 별개 명령이며 CLI 자체를 제거하지 않는다.

## 릴리스 / npm 경계

published 버전은 `npm view agentlas version`이 알려주는 값이 정본이다. 이
저장소의 소스 커밋이나 `package.json`의 버전은 GitHub 릴리스나 npm 발행을 증명하지
않는다 — 설치 전에 레지스트리를 직접 확인하라.

발행은 저장소의 OIDC trusted publisher 워크플로(`.github/workflows/npm-publish.yml`)
하나로만 이뤄진다. 정확한 immutable `vX.Y.Z` 태그(또는 현재 main의 정확한 커밋
SHA + 명시 버전)만 받고, 태그↔패키지 identity 검증 → 릴리스 계약 + 스모크 →
`npm pack` 산출물 allowlist 검사(test/docs/fixtures/scripts 등 개발 전용 경로 차단)
→ 발행 → 레지스트리 재확인 순으로 진행한다. 장기 npm publish 토큰은 GitHub에
저장하지 않는다.

릴리스 이력과 소스-대-레지스트리 경계는 [CHANGELOG.md](CHANGELOG.md)에 기록된다.
발행된 버전은 언제나 그 정확한 태그에서 나와야 하고, 태그 이후의 `main` 변경은
다음 버전이지 옛 번호로 재발행되지 않는다.

## License

Apache-2.0 — Agentlas Terminal is the independent terminal runtime for the
[Agentlas OS](https://github.com/agentlas-ai/Agentlas-OS) package contract. Its
`engine/` directory is maintained and released from this repository; it is not
a generated mirror of Agentlas Desktop.
