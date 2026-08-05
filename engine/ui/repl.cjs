"use strict";
/*
 * ui/repl — 프로젝트 Work 컨트롤러와 실행 트리.
 *
 * 원칙:
 *  - 실행 경로는 orchestrator 하나. 포그라운드 턴도 세션이다.
 *  - 화면은 활성 세션 하나만 스트리밍(Renderer). 백그라운드 턴 종료는 한 줄 notice.
 *  - 실행 중 입력: 텍스트는 다음 턴 스티어링 큐로, ctrl-c는 현재 턴 중단.
 *
 * 실행 관찰:
 *  /sessions · /tree       세션 표 / 부모-자식 트리
 *  /s <n> · /switch <n>    활성 세션 전환 (tail 재생 + 라이브 구독)
 *  /kill <n> · /rm <n>     턴 중단 / 세션 제거
 * 서브에이전트 배정과 지시는 프로젝트 컨트롤러만 수행한다.
 */
const readline = require("node:readline");
const { renderBanner, readVersion } = require("../agentlas-banner.cjs");
const { Orchestrator, maxParallel } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("./renderer.cjs");
const { listAgents } = require("../agents/registry.cjs");
const { resolveRuntimeForAgent } = require("../runtimes/overrides.cjs");
const { EFFORTS } = require("../agentlas-workload-routing.cjs");
const permissions = require("../agentlas-permissions.cjs");
const i18n = require("../agentlas-i18n.cjs");
const { tokenizeCommandLine } = require("../agentlas-input.cjs");
const { resolveProjectController, withProjectControllerContext } = require("../project/controller.cjs");

/*
 * Shift-Tab 권한 순환 — 배너(banner.location)와 permCycleHint/permFullArm/
 * help.shiftTab 이 광고해 온 단축키의 실제 구현.
 *
 * 배경: v1→v2 재작성에서 이 단축키를 들고 있던 입력면(composer)이 호출되지
 * 않게 되면서, 배너는 계속 "Shift-Tab 권한"을 광고하는데 눌러도 아무 일이
 * 없었다. 화면 문구와 키 동작을 다시 같은 곳에 묶는다.
 *
 * 두 단계 확인은 계약이다 — write 에서 Shift-Tab 은 곧장 full 로 가지 않고
 * 5초 창을 무장(permFullArm)하고, 그 사이 다른 키가 오면 무장을 푼다.
 * full 은 이 프로세스 한정이라 prefs 에 저장하지 않는다(v2 /permission 과 동일).
 *
 * 입력면과 무관하게 단위 테스트할 수 있도록 순수 상태기계로 분리한다.
 */
function createPermissionShortcut(opts = {}) {
  const lang = opts.lang || "en";
  const getPermission = opts.getPermission || (() => "write");
  const setPermission = opts.setPermission || (() => {});
  const emit = opts.onMessage || (() => {});
  const cycle = permissions.createCycleController(opts.controller || {});
  let armed = false;

  return {
    armed: () => armed,
    /*
     * 이 키를 소비했으면 true. readline 은 Shift-Tab 을 Tab 과 구분하지 않고
     * 완성기를 호출하므로(Node 25 확인), 호출자는 true 를 받은 턴의 완성
     * 후보를 비워 입력 줄이 순환에 휘말리지 않게 해야 한다.
     */
    handleKey(_str, key = {}) {
      if (!(key && key.name === "tab" && key.shift)) {
        if (armed) { cycle.cancel(); armed = false; } // 다른 키 = FULL 무장 취소
        return false;
      }
      const step = cycle.step(getPermission());
      if (step.armed) {
        armed = true;
        emit({ kind: "arm", level: permissions.normalize(getPermission()), text: i18n.t(lang, "permFullArm") });
        return true;
      }
      armed = false;
      const level = permissions.normalize(step.level);
      setPermission(level);
      emit({
        kind: step.enteredFull ? "full" : "set",
        level,
        text: step.enteredFull
          ? i18n.t(lang, "permFullConfirm")
          : i18n.t(lang, "permCycleConfirm", permissions.copy(level, lang).label),
      });
      return true;
    },
  };
}

function pickProjectController(db, cwd = process.cwd()) {
  const resolved = resolveProjectController(db, cwd);
  return withProjectControllerContext(resolved.controller, resolved.project);
}

async function startRepl(ctx, opts = {}) {
  // 마법사가 언어를 바꾸면 이 뒤의 문구도 따라가야 한다 — 아래 온보딩 블록에서 갱신한다.
  let en = ctx.lang === "en";
  const ui = ctx.uiInstance;
  const db = ctx.db();

  // 첫 실행 온보딩 (언어 → 런타임 → 권한). setup 명령으로 언제든 재실행 가능.
  // 스플래시는 이 뒤에 그린다 — 배너가 광고하는 런타임·권한은 이번 세션에 실제로
  // 적용될 값이어야 한다. 첫 실행 사용자는 마법사가 먼저 마스코트를 띄운다.
  if (!ctx.prefs.onboarded && process.stdin.isTTY) {
    const wizardRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const { runWizard } = require("../commands/setup.cjs");
      const result = await runWizard(ctx, wizardRl);
      if (result) {
        /*
         * 고른 언어를 이번 세션에도 즉시 반영한다. 예전에는 prefs 에만 적어서,
         * runOnboard 가 손댄 ui.lang 덕에 배너만 새 언어로 나오고 /help·팔레트·
         * 오케스트레이터·단축키 안내는 재시작 전까지 OS 로케일 언어로 남았다.
         */
        if (result.lang) {
          ctx.prefs.language = result.lang;
          ctx.lang = result.lang;
          ui.lang = result.lang;
          en = ctx.lang === "en";
        }
        if (result.permission) ctx.prefs.permission = result.permission;
        if (result.runtime) ctx.prefs.runtime = result.runtime;
        ctx.prefs.onboarded = !!result.onboarded;
      }
    } catch (e) {
      // 온보딩 실패는 REPL 진입을 막지 않지만, 조용히 삼키면 마법사 프롬프트와
      // REPL이 stdin을 경합하는 사고(실사용 테스트에서 실증)가 위장된다 — 표시한다.
      ctx.err(ui.c.dim(en ? "One is recovering setup." : "One이 설정을 복구하고 있습니다."));
    } finally {
      wizardRl.close();
    }
  }

  const orch = new Orchestrator({ db, lang: ctx.lang });
  const renderer = new Renderer(ui);
  let permission = permissions.normalize(opts.permission || (ctx.prefs && ctx.prefs.permission) || "write");
  let runtimeOverride = opts.runtime || null;
  let modelOverride = opts.model || null;
  let effortOverride = opts.effort || null;

  const recoverPresentation = (operation, error) => {
    /*
     * 정직 정지(honestStop)는 복구 대상이 아니다 (2026-08-06 실사용 실측).
     * 실제 REPL에 자연어 지시를 하면 "이 프로젝트에 팀이 없다"는 정직한 안내가
     * "One이 복구 중" 한 줄로 삼켜졌다 — 사용자는 무엇이 왜 안 되는지, 무엇을
     * 하면 되는지 전혀 못 봤다(빈 답보다 나쁜 침묵). 정직 정지는 그 사유를
     * 그대로 보여주고, 어떻게 실행하는지까지 덧붙인다. One 복구는 예상 못 한
     * 실패에만 쓴다. (사람용 문장과 기계 판단은 다른 필드 — 스케줄러와 같은 원칙.)
     */
    if (error && (error.honestStop || error.code)) {
      // 공유 controller 모듈은 lang을 모른다 — 기계 code로 여기서 현지화한다.
      const KO_REASON = {
        project_team_empty: "이 프로젝트에 에이전트 팀이 없습니다. Agentlas Desktop의 Work에서 에이전트를 넣고 다시 시도하세요.",
        project_not_connected: "이 폴더는 Agentlas 프로젝트에 연결돼 있지 않습니다. Desktop Work에서 연결하거나, 특정 에이전트를 지정해 바로 실행하세요.",
        project_ambiguous: "이 폴더에 Agentlas 프로젝트가 둘 이상 연결돼 있습니다. 소스 연결을 하나만 남기고 다시 시도하세요.",
        project_team_unreadable: "이 프로젝트의 에이전트 팀을 읽을 수 없습니다. Agentlas Desktop에서 프로젝트를 열어 팀을 다시 저장하세요.",
        project_teams_unsupported: "이 Agentlas 데이터 저장소는 아직 프로젝트 팀을 지원하지 않습니다. 최신 Agentlas Desktop을 한 번 실행한 뒤 다시 시도하세요.",
      };
      const reason = (!en && error.code && KO_REASON[error.code]) || String(error.message || error);
      ui.line(ui.c.amber("✖ ") + reason);
      ui.line(ui.c.dim(en
        ? "Run a specific agent directly: agentlas run <agent> \"<task>\"  ·  list agents: /list  ·  connect a project in Agentlas Desktop."
        : "특정 에이전트로 바로 실행: agentlas run <에이전트> \"<할 일>\"  ·  에이전트 목록: /list  ·  프로젝트 연결은 Agentlas Desktop에서."));
      return;
    }
    const active = orch.active();
    const evidence = String((error && error.message) || error || "").slice(0, 8000);
    if (active && !active.isBusy()) {
      orch.sendTo(active.key, [
        `The user operation “${operation}” did not complete.`,
        "Private evidence follows. Never quote codes, paths, provider text, or stack details to the user.",
        evidence,
        "Judge the situation, perform safe reversible recovery within current authority, verify the original outcome, then give only a concise useful result. Ask only when identity or an irreversible choice is required.",
      ].join("\n")).catch(() => {});
      return;
    }
    ui.line(ui.c.dim(en ? "One is checking and recovering this operation." : "One이 상태를 확인하고 복구하고 있습니다."));
  };

  const resolveRt = (agentId = null) => resolveRuntimeForAgent({
    db,
    prefs: ctx.prefs,
    explicit: runtimeOverride,
    model: modelOverride,
    effort: effortOverride,
    role: "orchestrator",
    agentId,
  });

  let resumeChatId = opts.chatId || null;
  const ensureMainSession = () => {
    const agent = orch.active() ? orch.active().agent : pickProjectController(db);
    if (!agent) {
      throw new Error(en
        ? "This project has no available controller. Configure its ordered team in Desktop Work."
        : "이 프로젝트에 실행 가능한 컨트롤러가 없습니다. Desktop Work에서 순서가 있는 팀을 설정하세요.");
    }
    const active = orch.active();
    if (active && active.agent.id === agent.id) return active;
    const session = orch.spawn({
      agent,
      runtime: resolveRt(agent.id),
      permission,
      cwd: process.cwd(),
      activate: true,
      chatId: resumeChatId,
    });
    resumeChatId = null; // 재개는 첫 세션에만 적용
    renderer.attach(session, { replay: false });
    return session;
  };

  /*
   * renderBanner는 ui.line으로 직접 그리고 아무것도 반환하지 않는다(ctx는 {ui,...} 형태).
   * v2 REPL이 이걸 "문자열을 반환하는 v1 배너"로 호출해 매 실행 TypeError로 죽었고,
   * 인자 없는 catch가 그 크래시를 `agentlas <version>` 한 줄로 위장해 왔다 —
   * 스플래시 전체가 사라진 걸 사람도 게이트도 못 봤다. 실패 사유는 이제 남긴다.
   */
  try {
    let runtimeLabel = "—";
    try { runtimeLabel = resolveRt().kind; } catch { /* no_runtime: 첫 턴에서 정직 정지 */ }
    let subjectLabel;
    try {
      const subject = pickProjectController(db);
      if (subject) subjectLabel = subject.slug;
    } catch { /* 표시용 — 못 정해도 배너는 그린다 */ }
    renderBanner({ ui, version: readVersion(), runtimeLabel, subjectLabel, permission, cwd: process.cwd() });
  } catch (e) {
    ctx.out(`agentlas ${readVersion()}`);
    void e;
  }

  // 배너 카드가 런타임·권한·작업 폴더와 명령 메뉴를 이미 보여준다 — 남은 것만.
  ctx.out(ui.c.dim(en
    ? `v2 engine · parallel ≤${maxParallel()}`
    : `v2 엔진 · 동시 ≤${maxParallel()}`));

  return new Promise((resolve) => {
    // 히스토리는 v1 input 모듈 재사용, 완성기는 v2 팔레트(ui/palette)가 정본이다.
    const input = require("../agentlas-input.cjs");
    const palette = require("./palette.cjs");
    const completer = palette.makeCompleter({
      getAgentSlugs: () => { try { return listAgents(db).map((a) => a.slug); } catch { return []; } },
      getFirmSlugs: () => {
        try { return db.prepare("SELECT slug FROM firms ORDER BY slug").all().map((r) => r.slug); } catch { return []; }
      },
      getSessionKeys: () => orch.list().map((r) => r.key),
      getCwd: () => process.cwd(),
    });
    // 진행 중인 비동기 슬래시 명령 — 종료가 이걸 잘라먹지 않도록 close 핸들러가 기다린다.
    const pendingCommands = new Set();
    const trackCommand = (promise) => {
      pendingCommands.add(promise);
      promise.then(() => pendingCommands.delete(promise), () => pendingCommands.delete(promise));
      return promise;
    };
    // Shift-Tab 이 온 턴에는 완성 후보를 비운다 — 아래 권한 순환 주석 참고.
    let swallowCompletion = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line) => (swallowCompletion ? [[], line] : completer(line)),
    });
    input.attachHistory(rl);

    /*
     * 입력 중 뜨는 슬래시 오버레이. 후보는 v2 정본(ui/palette)에서만 받는다 —
     * input 모듈의 기본 목록은 v1 REPL 전용이라 여기 없는 명령을 광고한다.
     */
    const slashPalette = input.attachSlashPalette(rl, {
      ui,
      lang: ctx.lang,
      force: true,
      suggest: (line, limit, lang) => {
        /*
         * 턴이 도는 동안 화면은 append-only 다(agentlas-ui `_drawFooter` 규약:
         * 활성 턴에 멀티행 라이브 프레임은 스크롤백 안전하지 않다). 스트리밍
         * 위에 오버레이를 그리면 실제 출력이 지워진다 — 그동안은 접어 둔다.
         */
        const active = orch.active();
        if (active && active.isBusy()) return [];
        return palette.suggestions(line, limit, lang);
      },
    });
    const PROMPT = "› ";
    /*
     * 빈 입력 고스트 힌트 (2026-08-06, 레퍼런스 REPL 대조에서 나온 유도 격차).
     * claude-code류 REPL은 빈 입력줄에 무엇을 칠 수 있는지 흐리게 보여준다 —
     * 우리는 `› ` 뿐이라 첫 사용자가 / 팔레트·@ 멘션·? 도움의 존재를 알 길이
     * 없었다. 커서 "뒤"에 dim 힌트를 쓰고 커서를 되돌린다. 어떤 키든 처음
     * 눌리는 순간 커서-뒤 지우기(CSI K)로 걷어내므로 readline 의 echo·팔레트
     * 오버레이와 겹치지 않는다. 비TTY·바쁜 세션에서는 그리지 않는다.
     */
    const { visWidth } = require("../agentlas-composer.cjs");
    const GHOST_HINT = en
      ? "type a task · / commands · @ files · ? shortcuts"
      : "할 일을 문장으로 · / 명령 · @ 파일 · ? 단축키";
    let ghostVisible = false;
    const drawGhost = () => {
      if (!process.stdout.isTTY || rl.line) return;
      const width = visWidth(GHOST_HINT);
      const room = (process.stdout.columns || 80) - visWidth(PROMPT) - 2;
      if (width > room) return; // 좁은 터미널에서는 유도보다 입력이 우선이다
      ui.write(ui.c.faint(GHOST_HINT) + `\x1b[${width}D`);
      ghostVisible = true;
    };
    const clearGhost = () => {
      if (!ghostVisible) return;
      ghostVisible = false;
      if (process.stdout.isTTY) ui.write("\x1b[K");
    };
    const prompt = () => {
      if (!renderer.session || !renderer.session.isBusy()) {
        rl.setPrompt(PROMPT);
        rl.prompt();
        drawGhost();
      }
    };

    /*
     * Shift-Tab 권한 순환을 입력 줄에 붙인다.
     *
     * readline 은 Shift-Tab 을 Tab 과 구분하지 않고 완성기를 호출한다(Node 25
     * 확인: `\x1b[Z` → {name:"tab", shift:true} 인데도 완성이 돌아 줄이 바뀐다).
     * 그래서 이 키를 소비한 턴에는 완성 후보를 비워(swallowCompletion) 타이핑
     * 중이던 내용을 지킨다. 오버레이 쪽도 Shift-Tab 을 확정 키로 보지 않는다.
     */
    const clearInputLine = () => {
      slashPalette.clear();
      // 턴이 도는 동안은 append-only — 스트리밍 중인 줄을 지우면 실제 출력이 날아간다.
      const busy = Boolean(renderer.session && renderer.session.isBusy());
      if (!busy && process.stdout.isTTY) ui.write("\r\x1b[2K");
      else ui.ensureNl();
    };
    const permissionShortcut = createPermissionShortcut({
      lang: ctx.lang,
      getPermission: () => permission,
      setPermission: (level) => { permission = level; },
      onMessage: ({ kind, text }) => {
        clearInputLine();
        // 활성 세션은 이미 자기 권한으로 떠 있다 — /permission 과 같은 범위 안내.
        const scope = en ? "applies to new sessions" : "새 세션부터 적용";
        if (kind === "arm") ui.line(ui.c.amber("! ") + text);
        else if (kind === "full") ui.line(ui.c.paw("▶▶ ") + text + ui.c.dim(` (${scope})`));
        else ui.line(ui.c.dim(`◆ ${text} (${scope})`));
        if (!renderer.session || !renderer.session.isBusy()) rl.prompt(true); // 커서 보존 = 타이핑 중이던 줄 유지
      },
    });
    const onShortcutKey = (str, key) => {
      // 고스트 힌트는 어떤 키가 와도 readline 이 echo 하기 전에 걷어낸다.
      clearGhost();
      if (!permissionShortcut.handleKey(str, key)) return;
      swallowCompletion = true;
      setImmediate(() => { swallowCompletion = false; });
    };
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin, rl);
      // readline 자신의 핸들러보다 먼저 돌아야 완성 억제 플래그가 제때 선다.
      process.stdin.prependListener("keypress", onShortcutKey);
    }

    orch.on("notice", ({ text, ok }) => {
      ui.ensureNl();
      ui.line((ok ? ui.c.emerald("◆ ") : ui.c.amber("◆ ")) + ui.c.dim(text));
      prompt();
    });

    let sigints = 0;
    rl.on("SIGINT", () => {
      const active = orch.active();
      if (active && active.isBusy()) {
        active.kill();
        ui.ensureNl();
        ui.line(ui.c.dim(en ? "(turn interrupted)" : "(턴 중단됨)"));
        sigints = 0;
        prompt();
        return;
      }
      sigints += 1;
      if (sigints >= 2) { rl.close(); return; }
      ui.line(ui.c.dim(en ? "(ctrl-c again to quit)" : "(한 번 더 ctrl-c 하면 종료)"));
      prompt();
    });

    const runForeground = (session, text) => {
      const p = orch.sendTo(session.key, text);
      if (p && typeof p.then === "function") {
        p.then(() => prompt(), (e) => { recoverPresentation("project task", e); prompt(); });
      }
    };

    let emptyEnters = 0;
    rl.on("line", (line) => {
      sigints = 0;
      const input = line.trim();
      if (!input) {
        /*
         * 빈 Enter 유도 (2026-08-06 레퍼런스 대조): 1회는 조용히 — 실수로 친
         * Enter 마다 잔소리하면 소음이다. 연달아 두 번이면 길을 잃은 것이므로
         * 다음 행선지를 한 줄로 보여준다.
         */
        emptyEnters += 1;
        if (emptyEnters >= 2) {
          emptyEnters = 0;
          ui.line(ui.c.dim(en
            ? "Type a task in plain words, / for commands, ? for shortcuts."
            : "할 일을 그냥 문장으로 치세요. / 는 명령, ? 는 단축키입니다."));
        }
        prompt();
        return;
      }
      emptyEnters = 0;

      /*
       * `?` 단축키 도움 (2026-08-06): 첫 화면 어디에도 키 조작법이 없었다 —
       * Shift-Tab 권한 순환·조종 큐·@멘션은 아는 사람만 썼다. 한 글자로 요약을
       * 준다(claude-code 의 ? 관례).
       */
      if (input === "?") {
        const rowsHelp = en ? [
          ["/", "command palette (type to filter, ↑↓ pick, Tab complete, Esc close)"],
          ["Tab", "complete commands, agent names, @file paths, session keys"],
          ["@path", "mention a file anywhere in your sentence"],
          ["↑ / ↓", "input history (kept across sessions)"],
          ["Shift-Tab", "cycle permission read → write (twice for full)"],
          ["Ctrl-C", "interrupt the running turn · press twice to quit"],
          ["typing while running", "queues steering for the current turn"],
          ["/sessions · /s <n>", "list · switch parallel sessions"],
        ] : [
          ["/", "명령 팔레트 (입력=검색, ↑↓ 선택, Tab 완성, Esc 닫기)"],
          ["Tab", "명령·에이전트 이름·@파일 경로·세션 키 완성"],
          ["@경로", "문장 어디서든 파일 멘션"],
          ["↑ / ↓", "입력 히스토리 (세션 넘어 유지)"],
          ["Shift-Tab", "권한 순환 read → write (두 번이면 full)"],
          ["Ctrl-C", "실행 중 턴 중단 · 두 번이면 종료"],
          ["실행 중 타이핑", "현재 턴에 조종 지시로 쌓임"],
          ["/sessions · /s <n>", "병렬 세션 목록 · 전환"],
        ];
        // 한글 키 라벨은 전각 폭 — padEnd(코드포인트 수)로 맞추면 열이 어긋난다.
        const keyWidth = Math.max(...rowsHelp.map(([k]) => visWidth(k)));
        ui.line(ui.c.bold(en ? "Shortcuts" : "단축키"));
        for (const [k, desc] of rowsHelp) {
          ui.line("  " + ui.c.blue(k) + " ".repeat(keyWidth - visWidth(k)) + "  " + ui.c.dim(desc));
        }
        prompt();
        return;
      }

      if (input.startsWith("/")) {
        try {
          const quit = handleSlash(ctx, input.slice(1), {
            orch,
            renderer,
            ensureMainSession,
            resolveRt,
            track: trackCommand,
            setPermission: (p) => { permission = p; },
            getPermission: () => permission,
            setRuntime: (r) => { runtimeOverride = r; },
            setModel: (model) => { modelOverride = model; },
            setEffort: (effort) => { effortOverride = effort; },
          });
          if (quit === "quit") { rl.close(); return; }
        } catch (e) {
          recoverPresentation("command", e);
        }
        prompt();
        return;
      }

      if (input.startsWith("!")) {
        runShell(ctx, input.slice(1).trim(), permission).then(prompt, (e) => { recoverPresentation("shell action", e); prompt(); });
        return;
      }

      let session;
      try {
        session = orch.active() || ensureMainSession(null);
        if (!renderer.session) renderer.attach(session, { replay: false });
      } catch (e) {
        recoverPresentation("project startup", e);
        prompt();
        return;
      }

      if (session.isBusy()) {
        // 실행 중 타이핑 = 스티어링(다음 턴 큐)
        session.send(input);
        return;
      }
      try {
        runForeground(session, input);
      } catch (e) {
        recoverPresentation("project task", e);
        prompt();
      }
    });

    rl.on("close", () => {
      input.persistHistory(rl);
      process.stdin.removeListener("keypress", onShortcutKey);
      slashPalette.detach();
      renderer.detach();
      /*
       * 슬래시 명령은 비동기다. 예전에는 close 가 곧바로 resolve 해서 프로세스가 끝나 버렸고,
       * `/search …` 직후 `/quit` 을 치면 그 명령이 출력 한 줄 없이 사라졌다(실측: 같은 입력을
       * 25초 벌려 치면 결과가 나온다). 진행 중인 명령을 먼저 기다린다.
       *
       * 다만 무한정 기다리지는 않는다 — 종료를 누른 사용자를 응답 없는 프로세스에 가둘 수 없다.
       */
      const finish = () => { orch.shutdown(); ui.ensureNl(); resolve(0); };
      if (!pendingCommands.size) { finish(); return; }
      let settled = false;
      const once = () => { if (settled) return; settled = true; clearTimeout(notice); finish(); };
      // 곧 끝나는 명령까지 매번 고지하면 종료 화면이 시끄러워진다 — 실제로 기다릴 때만 알린다.
      const notice = setTimeout(() => {
        ui.ensureNl();
        ui.line(ui.c.dim(en
          ? `finishing ${pendingCommands.size} command(s)…`
          : `실행 중인 명령 ${pendingCommands.size}개를 마무리하는 중…`));
      }, 400);
      if (notice.unref) notice.unref();
      const cap = setTimeout(once, 30_000);
      if (cap.unref) cap.unref();
      Promise.allSettled([...pendingCommands]).then(() => { clearTimeout(cap); once(); }, once);
    });

    prompt();
  });
}

/*
 * !셸 실행 (v1 runShell의 v2 이식 — 핵심 계약 보존):
 *  - full 권한에서만 실행 (셸은 작업 공간 경계를 강제할 수 없다).
 *  - env는 턴 한정: buildChildEnv 결과를 spawn에만 전달하고 호스트 프로세스의
 *    env 객체는 절대 변형하지 않는다 (credential-env-regression 계약).
 *  - 출력 8MB 캡, 표시 전 시크릿 마스킹, 프로세스 그룹 종료.
 */
async function runShell(ctx, cmd, permission) {
  const ui = ctx.uiInstance;
  const en = ctx.lang === "en";
  if (!cmd) return;
  if (permission !== "full") {
    ui.warn(en
      ? "Shell commands require full permission because they cannot enforce the workspace boundary."
      : "셸 명령은 작업 공간 경계를 강제할 수 없어 무제한 권한에서만 실행됩니다.");
    return;
  }
  const { spawn } = require("node:child_process");
  const { buildChildEnv } = require("../workforce/capture.cjs");
  const { redactCommandSecrets } = (() => {
    try { return require("../agentlas-ui.cjs"); } catch { return { redactCommandSecrets: (s) => s }; }
  })();
  let turnEnv;
  try {
    turnEnv = await buildChildEnv(ctx.db(), { cwd: process.cwd() });
  } catch {
    turnEnv = { ...process.env };
  }
  ui.tool("$", typeof redactCommandSecrets === "function" ? redactCommandSecrets(cmd) : cmd);
  const maxBytes = 8 * 1024 * 1024;
  await new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const child = spawn(cmd, {
      shell: true,
      cwd: process.cwd(),
      env: turnEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });
    let bytes = 0;
    let capped = false;
    const onData = (d) => {
      bytes += d.length;
      if (bytes > maxBytes) {
        if (!capped) {
          capped = true;
          ui.warn(en ? "(output capped at 8MB — command stopped)" : "(출력 8MB 초과 — 명령 중단)");
          try { grouped ? process.kill(-child.pid, "SIGTERM") : child.kill("SIGTERM"); } catch { /* dead */ }
        }
        return;
      }
      ui.streamDelta(d.toString("utf8"));
    };
    ui.streamStart(true);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => { ui.streamEnd(); ui.error(); resolve(); });
    child.on("close", (code) => {
      ui.streamEnd();
      if (code !== 0 && !capped) ui.line(ui.c.dim(`exit ${code}`));
      resolve();
    });
  });
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

function statusGlyph(ui, row) {
  if (row.busy) return ui.c.emerald("●");
  if (row.status === "failed") return ui.c.amber("✗");
  if (row.status === "killed") return ui.c.dim("■");
  if (row.status === "done") return ui.c.dim("✓");
  return ui.c.dim("○");
}

function printSessions(ctx, orch) {
  const ui = ctx.uiInstance;
  const rows = orch.list();
  if (!rows.length) {
    ctx.out(ui.c.dim(ctx.lang === "en" ? "no project run yet — type a task" : "아직 프로젝트 실행이 없습니다 — 작업을 입력하세요"));
    return;
  }
  for (const r of rows) {
    const indent = "  ".repeat(r.depth);
    const mark = r.active ? ui.c.paw("▸") : " ";
    const queued = r.queued ? ui.c.dim(` +${r.queued}q`) : "";
    const elapsed = r.busy ? ui.c.dim(` ${fmtElapsed(r.elapsedMs)}`) : "";
    ctx.out(` ${mark} ${statusGlyph(ui, r)} ${ui.c.bold(r.key.padEnd(4))}${indent}${ui.c.paw(r.agent.padEnd(20))}${elapsed}${queued} ${ui.c.dim(r.lastLine || r.status)}`);
  }
}

/*
 * 세션 키 파싱. 인자가 없으면 사용법을 낸다 — 예전에는 `s${undefined}` 가 그대로
 * 조립돼 `/kill` 이 "no such session: sundefined" 를, `/steer` 는 rest[0].length 에서
 * 날 TypeError 를 냈다. 팔레트가 `/steer <n> <msg>` 라고 안내하므로 인자 없이 Enter 를
 * 눌러 사용법을 보려는 것은 정상적인 탐색이다.
 */
function sessionKeyArg(rest, usage) {
  const token = rest[0];
  if (!token) throw new Error(usage);
  return String(token).startsWith("s") ? token : `s${token}`;
}

function handleSlash(ctx, cmdline, api) {
  const en = ctx.lang === "en";
  const ui = ctx.uiInstance;
  const { orch, renderer, ensureMainSession } = api;
  const commands = require("../commands/index.cjs");
  /*
   * 인자는 따옴표를 인식해 쪼갠다. 공백 분해는 따옴표를 인자 안에 그대로 남겨,
   * 팔레트가 안내하는 그대로 `/search "무엇이 필요한지"` 를 치면 따옴표째 검색어가 됐다.
   * 최상위 CLI 와 같은 토크나이저를 쓴다. restStr 은 원문 꼬리를 그대로 넘기는 자리
   * 일부 패스스루 명령은 원문 꼬리를 그대로 전달한다.
   */
  const rawCmd = cmdline.split(/\s+/)[0] || "";
  const rest = tokenizeCommandLine(cmdline).slice(1);
  const restStr = cmdline.slice(rawCmd.length).trim();
  // 별칭도 최상위 CLI 와 동일하게 해석한다 — `agentlas hep-network` 는 되는데
  // `/hep-network` 는 "알 수 없는 명령" 이던 비대칭을 없앤다.
  const cmd = commands.resolveCommandName(rawCmd);

  switch (cmd) {
    case "quit": case "exit": return "quit";
    case "help": {
      require("../commands/help.cjs").run(ctx, rest);
      ctx.out("");
      ctx.out(ui.c.bold(en ? "Project Work runs" : "프로젝트 Work 실행"));
      // 팔레트는 Tab 완성과 같은 정본(ui/palette)에서 렌더한다 — 목록 드리프트 금지.
      ctx.out(require("./palette.cjs").renderPalette(ctx.lang));
      ctx.out("");
      ctx.out(ctx.uiInstance.c.dim(en
        ? "Tab completes commands, agent names and session keys · ↑/↓ history · typing during a run queues steering · ctrl-c interrupts"
        : "Tab: 명령·에이전트·세션키 완성 · ↑/↓ 히스토리 · 실행 중 입력은 스티어링 큐 · ctrl-c 턴 중단"));
      // 배너가 광고하는 Shift-Tab 은 여기에도 적힌다 — 문구와 구현은 한 곳에서 움직인다.
      ctx.out(ctx.uiInstance.c.dim(`Shift-Tab: ${i18n.t(ctx.lang, "help.shiftTab")}`));
      return;
    }
    case "agents": case "list": require("../commands/list.cjs").run(ctx, rest); return;
    case "doctor": require("../commands/doctor.cjs").run(ctx, rest); return;
    case "mcp": require("../commands/mcp.cjs").run(ctx, rest); return;

    case "sessions": case "tree": printSessions(ctx, orch); return;

    case "s": case "switch": {
      const key = sessionKeyArg(rest, `Usage: /${cmd} <n>`);
      const session = orch.setActive(key);
      renderer.attach(session, { replay: true });
      return;
    }

    case "kill": {
      const key = sessionKeyArg(rest, `Usage: /${cmd} <n>`);
      orch.kill(key);
      return;
    }
    case "rm": {
      const key = sessionKeyArg(rest, `Usage: /${cmd} <n>`);
      orch.remove(key);
      const active = orch.active();
      if (active) renderer.attach(active, { replay: false });
      return;
    }

    case "runtime": {
      if (!rest[0]) throw new Error("Usage: /runtime claude-code|codex|gemini");
      // 세션 오버라이드는 저장되지 않는다 — 고지 없이는 사용자가 영구 설정으로
      // 믿는다(2026-08-05 감사 결함 C). 영구 경로를 같은 줄에서 알려준다.
      api.setRuntime(rest[0]);
      ctx.out(ui.c.dim(`runtime: ${rest[0]} (${en
        ? "new sessions in this REPL only — persist with: agentlas roles set orchestrator " + rest[0]
        : "이 REPL의 새 세션 한정 — 영구 설정: agentlas roles set orchestrator " + rest[0]})`));
      return;
    }
    case "model": {
      const model = String(rest[0] || "").trim();
      if (!model) throw new Error("Usage: /model <provider-model-id|default>");
      const next = ["default", "inherit"].includes(model.toLowerCase()) ? null : model;
      api.setModel(next);
      ctx.out(ui.c.dim(
        `model: ${next || "default"} (${en
          ? "new sessions in this REPL only — persist with: agentlas roles set"
          : "이 REPL의 새 세션 한정 — 영구 설정: agentlas roles set"})`,
      ));
      return;
    }
    case "effort": {
      const effort = String(rest[0] || "").trim().toLowerCase();
      if (!EFFORTS.includes(effort)) {
        throw new Error(`Usage: /effort ${EFFORTS.join("|")}`);
      }
      api.setEffort(effort === "none" ? null : effort);
      ctx.out(ui.c.dim(
        `effort: ${effort} (${en ? "applies to new sessions" : "새 세션부터 적용"})`,
      ));
      return;
    }
    case "permission": {
      if (!["read", "write", "full"].includes(String(rest[0] || ""))) {
        throw new Error("Usage: /permission read|write|full");
      }
      const level = permissions.normalize(rest[0]);
      api.setPermission(level);
      ctx.out(ui.c.dim(`permission: ${level} (${en ? "applies to new sessions" : "새 세션부터 적용"})`));
      return;
    }

    default: {
      /*
       * 최상위 명령 폴스루: REPL 안에서 /search /install /storm /usage … 를 그대로
       * 쓸 수 있어야 한다(없으면 사용자가 REPL을 나갔다 들어와야 했다).
       * 제외: 자기 자신을 다시 여는 대화형 명령(chat/open/firm/setup)과 run
       * (REPL의 평문 입력이 곧 run이다).
       */
      // help/agents/list/mcp/doctor 등은 위 케이스에서 이미 처리된다.
      const REPL_EXCLUDED = new Set(["firm", "setup", "run"]);
      if (!REPL_EXCLUDED.has(cmd) && commands.COMMANDS[cmd]) {
        const result = commands.COMMANDS[cmd]().run(ctx, rest);
        if (result && typeof result.then === "function") {
          // 진행 중임을 REPL 이 알아야 종료가 이걸 잘라먹지 않는다 (close 핸들러 참고).
          api.track(result.catch((e) => ctx.err(String((e && e.message) || e))));
        }
        return;
      }
      if (commands.DESKTOP_ONLY_SURFACES && commands.DESKTOP_ONLY_SURFACES[cmd]) {
        ctx.out(ui.c.dim(commands.DESKTOP_ONLY_SURFACES[cmd]));
        return;
      }
      ctx.out(ui.c.dim(en ? `unknown: /${cmd} (see /help)` : `알 수 없는 명령: /${cmd} (/help 참고)`));
    }
  }
}

module.exports = { startRepl, printSessions, createPermissionShortcut };
