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

> **Current source release candidate (2026-07-26):** `v0.9.10`. A source commit
> does not prove npm publication. Verify the independently published package
> before installation with `npm view agentlas version`.

Release tags are published to npm through the repository's OIDC trusted
publisher workflow. The workflow accepts only an exact immutable `vX.Y.Z` tag,
runs the Core/project-bootstrap contracts and smoke suite, and verifies the
registry result after publishing. No long-lived npm publish token is stored in
GitHub.

Release history and the source-versus-registry boundary are recorded in
[CHANGELOG.md](CHANGELOG.md). A published version must always come from its
exact tag: post-tag `main` changes are the next version and must never be
republished under an older version number.

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

For team, builder, and swarm decomposition, the parent LLM first receives this
host's privacy-safe **live runtime inventory** and chooses an exact
`runtimeId`, `exactModelId`, and reasoning effort for every child and final
synthesis. When both Claude Code and Codex are connected, workers can run in
parallel across both; a plugin host only exposes the runtimes available in that
host. Terminal validates that each exact selection is still live, honors
explicit `/model <id>` and `/effort <level>` pins, and records visible fallback
reasons if a selected runtime/model disappears. It never derives a new model
name from task keywords or a fixed role table. Decision receipts contain a task
hash, not the raw prompt, in the private Agentlas user-data directory.
Operators can set `AGENTLAS_MODEL_MAX_TIER=economy|balanced|frontier` as a hard
cost ceiling.

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

**프로젝트 의존관계 지도**
```sh
agentlas project status
agentlas project init
agentlas context refresh
agentlas context refs resolveHubEntityKind
agentlas context slice --task "entity kind 라우팅 수정" \
  --target src/package-kind.ts --render
agentlas context impact --changed src/package-kind.ts
agentlas context verify --changed src/package-kind.ts \
  --reviewed src/register/route.ts
```

`agentlas project init`으로 명시적으로 초기화한 프로젝트에서만 일반
실행, 팀, Stormbreaker, Workforce가 작업이 구체화된 뒤 같은 로컬 Context
Slice를 자동으로 받는다. 읽기·쓰기·전체 권한만으로는 `.agentlas/`나
`.gitignore`를 만들거나 수정하지 않는다. Hub/Cloud 검색에는 코드맵,
소스 경로, 프로젝트 파일 내용이 전송되지 않는다.

**Portable Experience Bundle과 Variant**
```sh
agentlas experience list
agentlas experience inspect <exact-release-id|bundle-id|upload-id>
agentlas experience validate <bundle.agentlas-experience.json>
agentlas experience save <bundle> --base-cloud-id <id> --base-package-hash sha256:<hash>
agentlas experience publish <bundle> --visibility unlisted \
  --base-cloud-id <id> --base-package-hash sha256:<hash>
agentlas experience status <bundle-id|upload-id>
agentlas experience export <bundle-id|upload-id> [--out <file>] [--overwrite]
agentlas experience unpublish <exact-release-id|bundle-id|upload-id> [--dry-run]
# withdraw는 unpublish와 같은 exact receipt/revision 계약의 호환 별칭
agentlas experience withdraw <exact-release-id|bundle-id|upload-id>

# 로컬 0600 캐시만 만들고 Hub에는 보내지 않음
agentlas experience save <bundle> --local-only

# 이전 pack-only 로컬 의도 호환 명령
agentlas experience legacy-list
agentlas experience legacy-inspect <pack-id|release-id>
agentlas experience legacy-publish .agentlas/experience-pack.json
agentlas experience legacy-unpublish <pack-id|release-id>

agentlas variant resolve --candidates variants.json --base-release <release-id>
```

`validate`는 256 items/3 MiB 한도, NFC canonical hash, 비밀값·PII·raw prompt/transcript·
로컬 경로·base package·MCP 실행 정의 유입을 모델 호출 없이 검사한다. `save`는 정확한
Cloud base artifact를 서버에서 확인한 뒤 owner-private `draft-saved`로 저장한다.
`publish`도 곧바로 공개하지 않고 `verification-requested`까지만 요청한다. evaluator가
검증한 새 release와 별도 Variant가 없으면 공개 활성·평판·자동대여 권위가 생기지 않는다.
모든 변경 요청은 기존 로그인 세션, Idempotency-Key, exact revision ETag를 사용하고,
Terminal은 서버 영수증과 별도의 0600 로컬 상태만 보관한다. `--dry-run`은 로그인 확인,
네트워크, 로컬 저장을 모두 하지 않는다.
`list`와 `inspect`는 현재 프로젝트에 저장된 Portable Bundle만 다시 검증해 보여주며,
owner/account, 로컬 경로, raw content, prompt/transcript, credential은 출력하지 않는다.
pack ID가 여러 release를 가리키면 최신 것을 임의 선택하지 않고 정확한 release/bundle/
upload ID를 요구한다. `unpublish --dry-run`은 로컬에서 검증된 exact server receipt와
revision이 있을 때만 조건부 삭제 계획을 보여주며 네트워크와 로컬 쓰기를 모두 0으로
유지한다. 실제 `unpublish`는 그 revision을 `If-Match`로 보내고 서버의 새 `withdrawn`
영수증을 검증한 뒤에만 로컬 상태를 전진시킨다.
`export`는 서버가 돌려준 bundle hash/semantic content/영수증 owner를 다시 검증한 뒤
0600 파일로 원자적으로 저장한다. 기본은 기존 출력 파일을 덮어쓰지 않고 symlink는
항상 거절하며, 같은 일반 파일을 명시적으로 교체할 때만 `--overwrite`를 사용한다.

이전 pack-only 동작은 `legacy-list|legacy-inspect|legacy-publish|legacy-unpublish`로만
명시적으로 접근한다. full Portable Bundle을 `publish`하면 새 서버 교환 경로를 사용한다. Experience Bundle은
base release를 참조할 뿐 base package를 복사하지 않는다.

`variant resolve`도 로컬 호환성 미리보기다. 후보 JSON의 `score`나
`compatibilityStatus: verified`는 사용자가 직접 쓸 수 있으므로 평판·결제·대여·실행
권위로 인정하지 않는다. 실제 자동대여에는 Agentlas Web이 발급·검증한 서버 resolution
receipt가 별도로 필요하다.

**빌드 전 MCP 계획**
```sh
agentlas build "GitHub 이슈를 정리하는 에이전트" --mcp-plan-only
agentlas build "GitHub 이슈를 정리하는 에이전트" --approve-mcp github
agentlas build "오프라인 에이전트" --no-mcp
agentlas build "Windows 셸 에이전트" \
  --experience-base-release <exact-release-id> \
  --experience-pack-release <exact-experience-release-id> \
  --experience-task-signature agentlas.task.v1/debugging \
  --experience-environment agentlas.env.v1/os/windows,agentlas.env.v1/arch/x64,agentlas.env.v1/runtime/terminal
agentlas run <agent> "Windows 오류를 디버깅해줘" \
  --experience-base-release <exact-release-id> \
  --experience-pack-release <exact-experience-release-id> \
  --experience-task-signature agentlas.task.v1/debugging \
  --experience-environment agentlas.env.v1/os/windows,agentlas.env.v1/arch/x64,agentlas.env.v1/runtime/terminal

# Desktop에서 사용자가 이미 승인해 현재 장착된 exact loadout만 명시적으로 사용
agentlas run <agent> "Windows 오류를 디버깅해줘" --experience-desktop-loadout
```

로컬에 호환 Experience가 저장되어 있다는 사실만으로는 장착으로 보지 않는다. 빌드와
실행은 사용자가 선택했거나 권위 있는 loadout이 넘긴 정확한 Experience release ID가
있을 때만 그 릴리스의 항목을 조회한다. 응답 유실이나 재시작도 다른 릴리스를 대신
붙이는 근거가 되지 않는다.

Desktop 연동도 자동 장착이 아니다. `--experience-desktop-loadout`을 준 그 실행에서만
Desktop이 canonical `terminal-bridge/ontology-loadout-v2.json`에 원자적으로 쓴 0600
로컬 권위 receipt를 읽는다. 임의 receipt 경로는 지원하지 않는다. Terminal은 로컬 DB의
exact 설치 에이전트 ↔ Hub base release 결속, Desktop 설치 authority instance와 단조
sequence를 다시 확인한다. 5분이 지난 receipt, 권한이 넓은 파일, symlink, 손상·변조된
JSON, 다른 Desktop 설치에서 복사한 receipt, rollback된 sequence, 다른 설치 에이전트,
다른 base release는 모두 Experience 없는 안전 모드로 건너뛴다. 이 receipt는 Hub 서버
서명이 아니라 같은 로컬 Agentlas DB에 결속된 Desktop 권위 증명이다. 같은 OS 사용자
권한으로 DB와 canonical receipt를 함께 완전히 장악한 경우는 로컬 호스트 침해로 간주한다.
수동 exact 플래그가 receipt와 다르면 둘 중 하나를 추정하지 않고 Experience를 끈다.
`--no-experience`가 항상 최우선이다.

설치 에이전트의 성공한 실행이 새 `procedure|decision|risk` Memory를 큐레이션하면,
Terminal은 exact 에이전트/base release/현재 OS·arch·runtime에 묶인 Operational Experience
후보를 기존 로컬 exchange store에 `private + draft + candidate`로 저장한다. 실행 자체는
검증 통과로 간주하지 않으므로 후보는 자동 장착·promote·publish·Hub 전송되지 않는다.
raw prompt/transcript, 로컬 경로, URL, 이메일·전화·고객 식별자, credential, base package
재료가 감지되면 내용은 복사하지 않고 reason code만 로컬 run ledger에 남긴다. 같은
실행/Memory/base/environment 재처리는 같은 후보를 재사용한다. 실패 실행과 큐레이션된
근거가 없는 성공 실행은 RunReceipt만 남기며 후보를 만들지 않는다. `preference`는
Operational 후보에 섞지 않고 내용 없는 로컬 Taste observation으로만 분리한다.

빌드 전에는 Agentlas 시스템 전역 MCP 레지스트리의 메타데이터를 먼저 읽고, 관련
MCP·키 필요 여부·키 존재 여부만 한 번에 보여 준다. 승인 뒤에만 정확한 시스템 전역
DB 행을 다시 읽어 MCP initialize/tools-list 연결을 개별 검사한다. 성공한 행만 private
structured allowlist로 native 빌더 경계에 전달되며, 자연어 prompt는 실행 권한이 아니다.
이 첫 출력은 추천일 뿐이다. 한 번의 명시 동의 전에는 어떤 MCP도 붙이지 않고,
네트워크 key probe나 설치도 수행하지 않는다.
성공한 Build 승인에는 서버 ID·transport·command·args·키 이름을 묶은 비밀 없는 지문만
로컬 영수증으로 남는다. 이후 일반 `full` 턴은 enabled 상태와 이 exact 지문이 모두 맞는
서버만 붙이며, 행이 바뀌거나 비활성화되면 자동으로 empty-MCP로 돌아간다. Playwright를
포함한 어떤 서버도 legacy 기본값으로 자동 주입하지 않는다.
명령·인자는 로컬 host config에만 있고 package/prompt/영수증에는 들어가지 않으며 URL·키
값은 전달하지 않는다. LLM provider는 자기 로그인 환경을 유지하지만 실제 MCP 자식은
Agentlas 소유 wrapper를 거쳐 별도 HOME과 최소 실행 환경을 받는다. 이때 post-consent
레지스트리의 `env_keys_json`에 적힌 키 이름만 값이 전달되고, 나머지 process/global/project/
agent 자격증명은 상속되지 않는다. wrapper 설정과 로그에는 키 값이 기록되지 않는다.
HOME과 임시 폴더도 서버별 전용 디렉터리다. PATH/OS 실행 필수값 외의 proxy·TLS override·
NODE_OPTIONS 같은 host-control 변수는 `env_keys_json`에 적혀 있어도 거절한다.
최대 3개 probe만 병렬 실행하고 전체 12초 deadline을 적용하므로 8개 서버가 순차로 64초를
소모하지 않는다. 한 probe의 timeout/실패는 그 서버에만 남는다. 비대화형 실행은 묻지 않고 기본적으로 아무 MCP도 승인하지 않아
CI가 멈추지 않는다. 한 MCP가 없거나 키가 없어도 그 기능만 degraded가 되며 빌드는
나머지 연결 또는 empty-MCP 모드로 계속된다. `--require-mcp <catalog-id>`는 빌드 전체를 중단시키지 않고
Variant 대여 판단에서 해당 Variant만 제외하는 계약을 만든다.
한 requirement에 승인된 alternatives가 있으면 primary 실패 뒤 같은 12초 deadline 안에서
그 그룹만 순차 fallback하며, 다른 requirement의 probe와 결과는 격리한다.
시스템 전역 레지스트리를 읽지 못한 경우도 `registry: unavailable`로 명확히 구분하고,
설치나 네트워크 폴백 없이 empty-MCP 모드로 계속한다.
REPL의 `/build`도 top-level `agentlas build`와 같은 계획·한 번 동의·결과 경로를
사용하며, MCP 사전 계획을 건너뛰는 별도 builder 지름길은 없다.
로컬 promoted Experience도 같은 handler에서 사용자가 고른 exact Experience release,
exact base release, 현재 프로젝트, task signature, environment constraint가 모두 맞을 때만
조회한다. 일반 `agentlas run`의 내부 loadout 경로 역시 설치된 Cloud package marker와
로컬의 서버 확인 baseResolution이 hash/slug/release까지 정확히 같고, 권위 있는 loadout이
정확한 Experience release ID를 넘긴 경우에만 후보가 된다. 현재 요청은 고정된 양언어
키워드 표로 분류하며 허용된 `agentlas.task.v1/<class>` ID가 그 장착 릴리스의 item에 있을
때만 조회한다. 환경도 현재 host가 만든 `agentlas.env.v1/os|arch|runtime/...` 태그와 정확히
맞아야 한다. opaque hash, `general`, legacy signature/constraint는 저장·교환은 가능하지만
활성하지 않고 stderr에 skip reason을 남긴다. 동의어·embedding 추정은 쓰지 않으며 CLI의
명시 task class는 자동 분류보다 우선한다.
분류표는 `engine/experience-taxonomy-v1.json`의 checksum
`sha256:413833472e423352518f9591cd0e051c5bc0a7971e53ab3dc7b5aaf7d50c37ab`으로 고정한다.
OS는 macos/windows/linux/ios/android/unknown, arch는 arm64/x64/unknown만 허용하고 runtime은
최소 2자다. 알 수 없는 OS/arch는 해당 item만 `unknown`/ineligible 처리하며 base agent는 유지한다.
합계 8개/800
추정 토큰을 넘지 않으며, prompt에는 `NO SERVER RENTAL-RESOLUTION RECEIPT`가 표시되어
로컬 사용자 증언을 서버 검증 평판처럼 오인하지 않게 한다.

API/BYOK 경로의 항상 켜진 Memory emitter는 UTF-8 bytes/3 기준 150토큰 이하 core만
주입한다. 전체 Memory Events schema는 기억·메모리 작업에서만, 로컬 credential index
안내는 deploy/release/billing/auth/API/cloud 작업에서만 별도로 로드한다.

**내 Agent Cloud 자산**
```sh
agentlas cloud save <경로>         # 소유자 전용 비공개 저장(공개 심사/라우팅 카드 없음)
agentlas cloud publish <경로>      # Agentlas Hub에 명시적으로 공개 발행
agentlas cloud list                # 로그인한 소유자의 비공개 패키지 조회
agentlas cloud restore <slug>      # 전체 hash 검증 후 이 컴퓨터에 exact snapshot 복원
```

비공개 저장도 업로드 전 로컬에서 비밀값, 안전하지 않은 경로, 파일별 hash와
전체 package hash를 검사한다. 공개 Hub 발행에만 라우팅 카드와 공개 검토가 붙는다.
`.agentlas/experience-relations.jsonl`과 `.previous`/hidden temp siblings는 로컬에서
재생성되는 Experience 관계 인덱스이므로 base Agent hash와 Cloud bundle에서 제외된다.

`agentlas cloud install <slug>`은 기존 호환 명령이며 공개 Hub 설치다. 비공개
Agent Cloud 소유자 복원은 반드시 `agentlas cloud restore <slug>`를 사용한다.

**실행 엔진**
```sh
agentlas storm "목표"              # Agentlas 자체 Goal+UltraCode: 계획→런타임/모델/effort 배정→실행→검증 [--research]
agentlas swarm "목표"              # emergent 에이전트 스웜 [--parallel N]
agentlas network "요청"            # 상위 LLM이 Workforce Ontology에서 exact-release TF 선발·실행
agentlas network "요청" --benchmark # child/synthesis/verifier 영수증 누락 시 실패
agentlas legacy-network "요청"     # 이전 hep-network 호환 경로(명시 실행만)
agentlas call "a,b" "컨텍스트"      # 지정 에이전트 호출               (hep-call)
agentlas browser                   # 실제 브라우저 하드포인트          (hep-browser)
agentlas route "요청"              # 라우팅 미리보기 (실행 없음)
```

`swarm`은 먼저 상위 LLM이 독립 작업과 의존성을 나누고, 이 호스트에서 실제 실행
가능한 런타임·모델·effort 목록을 보고 각 워커 및 최종 종합의 정확한
`runtimeId + exactModelId + effort`를 고른다. Claude Code와 Codex가 둘 다 연결돼
있으면 둘로 병렬 분배한다. 플러그인 안에서는 그 플러그인을 호스트하는 CLI의 목록만
노출한다. 터미널 코드는 이 판단을 키워드 규칙이나 고정 모델명으로 대체하지 않고,
선택이 여전히 가능한지·capability·context·비용 상한·명시적 사용자 고정만 검증한다.
배정 JSON이 깨지거나 런타임/모델이 사라지면 현재 모델로 폴백하고 그 이유를 화면과
비공개 영수증에 남긴다.

`network`는 새 Agent Workforce Ontology 경로다. 활성 상위 LLM이 먼저 redacted
work order와 역할 슬롯을 만든 뒤 Hub MCP의 `workforce.search_candidates`를 직접
호출하고, 반환된 직무·skill·MCP/tool·eval 증거 안에서 정확한 release를 고른다.
호스트 코드는 팀을 고르지 않고 계약만 검사한다. 선택은
`workforce.validate_selection`으로 검증하고, `workforce.prepare_execution`이 같은
release/version/package hash/content digest에 고정한 directive bundle을 반환한 뒤에만
manager plan → 별도 worker → synthesis → verifier 순서로 실행한다. 후보 밖 release,
digest 불일치, 실행 불가, 대체 release, 잘못된 planner JSON은 기존 검색이나 로컬
에이전트로 폴백하지 않고 실패한다. `--benchmark`는 planner fallback 0건, 모든 child,
synthesis, verifier 영수증과 verifier pass를 모두 요구한다. 이전 Hephaestus 분해기는
`legacy-network`로만 명시 호출할 수 있다.

새 설치와 아직 network 설정을 건드리지 않은 설치에서는 일반적인 실작업형 요청도
이 Workforce 경로로 자동 진입한다. 사용자가 `/config network off`로 명시적으로 끈
값은 업그레이드 후에도 보존된다. 질문·잡담과 이미 특정 에이전트를 고른 대화에는
자동 TF를 붙이지 않는다.

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

`storm`은 외부 CLI의 자동 실행 스위치를 켜는 명령이 아니다. Agentlas Core에서 서명된 동일한
Goal/UltraCode 하네스를 읽고 SHA-256을 검증한 뒤, Terminal의 부모 플래너가 현재 연결된 런타임과
모델 목록을 보고 작업별 `runtimeId`·정확한 모델·effort를 확정한다. 독립 작업은 병렬 실행하고
증거 기반 최종 게이트에서 결과를 종합한다. Core 하네스를 읽거나 검증하지 못하면 로컬 문구로
대체하지 않고 모델 호출 전에 중단한다.

권한은 이름과 실제 런타임 실행 범위를 일치시킨다.

| Agentlas 권한 | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| `read` | `plan` | `read-only` sandbox | `plan` |
| `write` | `acceptEdits` | `workspace-write` sandbox | `auto_edit` |
| `full` | permission 검사 우회 | approval + sandbox 우회 | `yolo` |

`write`는 무제한 권한의 다른 이름이 아니다. 외부 상태를 바꿀 수 있는 MCP 도구는
`full`이면서 exact 동의 지문이 유효한 턴에만 주입한다. 입력창에서 `Shift-Tab`으로 권한을 순환할 수 있지만,
`write → full`은 5초 안에 두 번 연속 눌러야 하며 이 변경은 현재 세션에만 적용된다.
실행 중 `Ctrl-T`는 Claude Todo/Task, Codex `todo_list`, Gemini `write_todos`가 실제로
보낸 체크리스트만 열고 접는다. 일반 Bash/Read 실행을 계획 항목처럼 꾸며내지 않는다.

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
