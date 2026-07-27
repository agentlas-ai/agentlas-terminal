"use strict";
/*
 * ui/repl — v2 REPL (Claude Code 방식 + 오르카 멀티세션).
 *
 * 원칙:
 *  - 실행 경로는 orchestrator 하나. 포그라운드 턴도 세션이다.
 *  - 화면은 활성 세션 하나만 스트리밍(Renderer). 백그라운드 턴 종료는 한 줄 notice.
 *  - 실행 중 입력: 텍스트는 다음 턴 스티어링 큐로, ctrl-c는 현재 턴 중단.
 *
 * 세션 조종(오르카):
 *  /spawn <agent> [task]   백그라운드 서브세션 생성(+실행)
 *  /sessions · /tree       세션 표 / 부모-자식 트리
 *  /s <n> · /switch <n>    활성 세션 전환 (tail 재생 + 라이브 구독)
 *  /steer <n> <msg>        해당 세션 다음 턴 큐잉
 *  /kill <n> · /rm <n>     턴 중단 / 세션 제거
 *  /broadcast <msg>        전 세션에 동일 지시
 */
const readline = require("node:readline");
const { renderBanner, readVersion } = require("../agentlas-banner.cjs");
const { Orchestrator, maxParallel } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("./renderer.cjs");
const { findAgent, listAgents } = require("../agents/registry.cjs");
const { resolveRuntimeForAgent } = require("../runtimes/overrides.cjs");
const { EFFORTS } = require("../agentlas-workload-routing.cjs");
const permissions = require("../agentlas-permissions.cjs");
const i18n = require("../agentlas-i18n.cjs");
const { tokenizeCommandLine } = require("../agentlas-input.cjs");

const DEFAULT_AGENT_SLUG = "agentlas-orchestrator";

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

function pickDefaultAgent(db) {
  const visible = listAgents(db);
  if (visible.length) return visible[0];
  const builtin = findAgent(db, DEFAULT_AGENT_SLUG);
  if (builtin) return builtin;
  return null;
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
      ctx.err(ui.c.dim((en ? "setup wizard failed: " : "설정 마법사 실패: ") + String((e && e.message) || e)));
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
  const ensureMainSession = (agentToken) => {
    const agent = agentToken ? findAgent(db, agentToken) : (orch.active() ? orch.active().agent : pickDefaultAgent(db));
    if (!agent) {
      throw new Error(en
        ? (agentToken ? `agent not found: ${agentToken}` : "no installed agent (agentlas search/install first)")
        : (agentToken ? `에이전트를 찾을 수 없음: ${agentToken}` : "설치된 에이전트가 없습니다 (agentlas search/install 먼저)"));
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
      const subject = opts.agent ? findAgent(db, opts.agent) : pickDefaultAgent(db);
      if (subject) subjectLabel = subject.slug;
    } catch { /* 표시용 — 못 정해도 배너는 그린다 */ }
    renderBanner({ ui, version: readVersion(), runtimeLabel, subjectLabel, permission, cwd: process.cwd() });
  } catch (e) {
    ctx.out(`agentlas ${readVersion()}`);
    ctx.err(ui.c.dim(`banner failed: ${(e && e.message) || e}`));
  }

  // 배너 카드가 런타임·권한·작업 폴더와 명령 메뉴를 이미 보여준다 — 남은 것만.
  ctx.out(ui.c.dim(en
    ? `v2 engine · parallel ≤${maxParallel()}`
    : `v2 엔진 · 동시 ≤${maxParallel()}`));

  if (opts.agent) {
    try {
      const session = ensureMainSession(opts.agent);
      ctx.out(ui.c.dim(`agent: ${session.agent.slug} · ${session.runtime.kind}`));
    } catch (e) {
      ctx.err(String((e && e.message) || e));
    }
  }

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
    const prompt = () => {
      if (!renderer.session || !renderer.session.isBusy()) {
        rl.setPrompt(PROMPT);
        rl.prompt();
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
        p.then(() => prompt(), (e) => { ui.error(String((e && e.message) || e)); prompt(); });
      }
    };

    rl.on("line", (line) => {
      sigints = 0;
      const input = line.trim();
      if (!input) { prompt(); return; }

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
          ui.error(String((e && e.message) || e));
        }
        prompt();
        return;
      }

      if (input.startsWith("!")) {
        runShell(ctx, input.slice(1).trim(), permission).then(prompt, (e) => { ui.error(String((e && e.message) || e)); prompt(); });
        return;
      }

      let session;
      try {
        session = orch.active() || ensureMainSession(null);
        if (!renderer.session) renderer.attach(session, { replay: false });
      } catch (e) {
        ui.error(String((e && e.message) || e));
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
        ui.error(String((e && e.message) || e));
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
    child.on("error", (e) => { ui.streamEnd(); ui.error(e.message); resolve(); });
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
    ctx.out(ui.c.dim(ctx.lang === "en" ? "no sessions yet — type a task or /spawn <agent> <task>" : "세션 없음 — 작업을 입력하거나 /spawn <agent> <task>"));
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
   * (/spawn·/steer·/broadcast)라 계속 원문에서 자른다.
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
      ctx.out(ui.c.bold(en ? "In-REPL session control (Orca)" : "REPL 세션 조종 (오르카)"));
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
    case "chats": require("../commands/chats.cjs").run(ctx, rest); return;
    case "doctor": require("../commands/doctor.cjs").run(ctx, rest); return;
    case "mcp": require("../commands/mcp.cjs").run(ctx, rest); return;

    case "sessions": case "tree": printSessions(ctx, orch); return;

    case "s": case "switch": {
      const key = sessionKeyArg(rest, `Usage: /${cmd} <n>`);
      const session = orch.setActive(key);
      renderer.attach(session, { replay: true });
      return;
    }

    case "spawn": {
      const agentToken = rest[0];
      if (!agentToken) throw new Error("Usage: /spawn <agent> [task]");
      const agent = findAgent(ctx.db(), agentToken);
      if (!agent) throw new Error((en ? "agent not found: " : "에이전트를 찾을 수 없음: ") + agentToken);
      const task = restStr.slice(agentToken.length).trim();
      const parent = orch.active();
      const session = orch.spawn({
        agent,
        runtime: parent ? parent.runtime : api.resolveRt(),
        permission: api.getPermission(),
        cwd: process.cwd(),
        parentKey: parent ? parent.key : null,
        activate: false,
        title: task ? `sub: ${task.slice(0, 60)}` : undefined,
      });
      if (task) orch.sendTo(session.key, task);
      ctx.out(ui.c.dim(`${session.key} ${agent.slug} ${task ? (en ? "started" : "시작됨") : (en ? "ready (use /steer)" : "대기 (—/steer 로 지시)")}`));
      return;
    }

    case "steer": {
      const key = sessionKeyArg(rest, `Usage: /${cmd} <n> <message>`);
      const msg = restStr.slice(rest[0].length).trim();
      if (!msg) throw new Error("Usage: /steer <n> <message>");
      orch.sendTo(key, msg);
      ctx.out(ui.c.dim(`→ ${key}`));
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

    case "broadcast": {
      if (!restStr) throw new Error("Usage: /broadcast <message>");
      const sent = orch.broadcast(restStr);
      ctx.out(ui.c.dim(`→ ${sent.join(", ") || "(none)"}`));
      return;
    }

    case "use": {
      if (!rest[0]) throw new Error("Usage: /use <agent>");
      const session = ensureMainSession(rest[0]);
      renderer.attach(session, { replay: false });
      ctx.out(ui.c.dim(`agent: ${session.agent.slug}`));
      return;
    }

    case "runtime": {
      if (!rest[0]) throw new Error("Usage: /runtime claude-code|codex|gemini");
      api.setRuntime(rest[0]);
      ctx.out(ui.c.dim(`runtime: ${rest[0]} (${en ? "applies to new sessions" : "새 세션부터 적용"})`));
      return;
    }
    case "model": {
      const model = String(rest[0] || "").trim();
      if (!model) throw new Error("Usage: /model <provider-model-id|default>");
      const next = ["default", "inherit"].includes(model.toLowerCase()) ? null : model;
      api.setModel(next);
      ctx.out(ui.c.dim(
        `model: ${next || "default"} (${en ? "applies to new sessions" : "새 세션부터 적용"})`,
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
      // help/agents/list/chats/mcp/doctor 등은 위 케이스에서 이미 처리된다.
      const REPL_EXCLUDED = new Set(["chat", "open", "firm", "setup", "run"]);
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
