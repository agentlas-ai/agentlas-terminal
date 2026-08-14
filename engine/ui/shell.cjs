"use strict";
/*
 * ui/shell — Agentlas 대화형 셸 (D3 Phase 2~3, 2026-08-11).
 *
 * 켜는 법: AGENTLAS_TUI=1 agentlas   (TTY 필수 · 기본 REPL은 그대로 정본)
 *
 * 렌더러 의존은 구현 세부다 — 사용자 문구·환경변수·명령 어디에도 상류 이름을 쓰지 않는다.
 *
 * 설계 (D2 위험 5의 해법이 이 파일의 구조다):
 *  - PiUi 는 기존 Ui 를 상속하되 write() 초크포인트만 렌더러 트랜스크립트로 돌린다.
 *    line/_message/tool/rule 등 기존 메서드는 전부 write 로 수렴하므로 그대로 산다.
 *  - 스트리밍 3종은 Markdown 누적으로 교체 — 표·코드블록이 실시간 재렌더된다.
 *  - 스피너는 렌더러 Loader 로 교체 (기존 \r 기반 페인트는 dummy 스트림으로 무해화).
 *  - ctx.out/err 55파일의 직출력은 shellCtx 재지정으로 전부 프레임 안에 들어온다.
 *  - 자동완성은 ui/palette 정본(SLASH_COMMANDS)을 렌더러 SlashCommand 로 변환 — 목록 드리프트 금지.
 *
 * 증분 1 범위 밖(기본 REPL로): Shift-Tab 권한 순환 · ! 셸 · 세션 전환(/s) ·
 * 히스토리 디스크 영속 · 스티어링 큐 표시. 이 항목들은 D3 Phase 2-2에서 이전한다.
 */
const { PassThrough } = require("node:stream");
const { Ui } = require("../agentlas-ui.cjs");
const { Orchestrator, maxParallel } = require("../sessions/orchestrator.cjs");
const { Renderer } = require("./renderer.cjs");
const { resolveRuntimeForAgent } = require("../runtimes/overrides.cjs");
const permissions = require("../agentlas-permissions.cjs");
const palette = require("./palette.cjs");
const { readVersion } = require("../agentlas-banner.cjs");
const { resolveProjectController, withProjectControllerContext } = require("../project/controller.cjs");

function loadRenderer() {
  try {
    /*
     * 렌더러는 engine/vendor/tui 에 내재화돼 있다 — npm 의존성이 아니다.
     * 이유: 정확 핀+무결성 해시는 버전 드리프트·변조를 막지만 레지스트리에서
     * 그 버전이 삭제되면 설치가 실패한다. 소스가 저장소에 있으면 그 위험이 없고
     * 우리가 직접 고칠 수 있다. 갱신은 scripts/vendor-tui.mjs.
     * ESM 이므로 require(esm) 이 필요하다 — engines 가 Node >=20.19 를 선언한다.
     */
    return require("../vendor/tui/index.js");
  } catch (cause) {
    throw Object.assign(
      new Error("The Agentlas shell needs Node >=20.19. Run without AGENTLAS_TUI=1, or upgrade Node."),
      { code: "shell_unavailable", cause },
    );
  }
}

/* Ui 를 상속해 write 초크포인트만 렌더러로 돌린다. */
class ShellUi extends Ui {
  /*
   * 실터미널 대신 dummy 스트림 — 놓친 직접 out.write 가 프레임을 찢는 대신 소멸한다.
   * 단 columns 는 살려야 한다: Ui 의 줄바꿈·표·구분선이 전부 this.out.columns 를 읽는데
   * PassThrough 에는 그 속성이 없어 전부 80/100 에 고정돼 있었다(폭 넓은 터미널에서
   * 화면 절반만 쓰던 원인). 렌더러의 실제 폭을 게터로 물린다.
   */
  static _sinkFor(tui) {
    const sink = new PassThrough();
    Object.defineProperty(sink, "columns", {
      get() { return (tui.terminal && tui.terminal.columns) || 80; },
    });
    return sink;
  }
  constructor(opts, pi, tui, transcript) {
    super({ ...opts, stream: ShellUi._sinkFor(tui), color: true });
    this._pi = pi;
    this._tui = tui;
    this._transcript = transcript;
    this._lineBuf = "";
    this._md = null;      // 스트리밍 중 Markdown 누적 컴포넌트
    this._mdText = "";
    this._loader = null;
  }
  _appendText(text) {
    /*
     * 벤더 Text.render 는 공백만 있는 줄에 [] 를 돌려준다 — screens.cjs 의 ui.line("")
     * 22곳이 전부 조용히 사라져 화면이 한 덩어리로 붙어 있었다. 빈 줄은 Spacer 로.
     */
    const value = String(text);
    this._transcript.addChild(value.trim() === "" ? new this._pi.Spacer(1) : new this._pi.Text(value, 1, 0));
    this._tui.requestRender();
  }
  write(s) {
    // line()/tool()/rule()/_message() 전부 여기로 수렴한다.
    this._lineBuf += String(s);
    let idx;
    while ((idx = this._lineBuf.indexOf("\n")) !== -1) {
      this._appendText(this._lineBuf.slice(0, idx));
      this._lineBuf = this._lineBuf.slice(idx + 1);
    }
    this._atLineStart = this._lineBuf === "";
  }
  ensureNl() {
    if (this._lineBuf) { this._appendText(this._lineBuf); this._lineBuf = ""; }
    this._atLineStart = true;
  }
  // ── 스피너 → Loader ──
  updateSpinner(text) {
    this._spinText = String(text || this._spinText || "");
    if (!this._loader) {
      this._loader = new this._pi.Loader(this._tui, this.c.emerald, this.c.dim, this._spinText);
      this._transcript.addChild(this._loader);
    } else {
      this._loader.setMessage(this._spinText);
    }
    this._tui.requestRender();
  }
  stopSpinner() {
    if (this._loader) {
      this._loader.stop();
      this._transcript.removeChild(this._loader);
      this._loader = null;
      this._tui.requestRender();
    }
    this._spinText = "";
  }
  // ── 스트리밍 → Markdown 누적 (표·코드블록 실시간 재렌더) ──
  streamStart() {
    this.stopSpinner();
    this.ensureNl();
    this._mdText = "";
    this._md = new this._pi.Markdown("", 1, 0, this._mdTheme());
    this._transcript.addChild(this._md);
    this._streaming = true;
  }
  streamDelta(text) {
    if (!text) return;
    if (!this._md) this.streamStart();
    this._mdText += String(text);
    /*
     * Memory Events 봉투는 런타임 계약(펜스 파이프라인이 수확)이지 사용자용이 아니다.
     * append-only 기본 REPL은 이미 찍힌 봉투를 지울 수 없지만, 누적 재렌더는
     * 표시만 잘라낼 수 있다 — 수확 경로(st.text/fences)는 건드리지 않는다.
     */
    const visible = this._mdText.replace(/\n#{1,3} Memory Events\b[\s\S]*$/, "\n");
    this._md.setText(visible);
    this._tui.requestRender();
    this._streaming = true;
  }
  streamEnd() {
    this._md = null;
    this._mdText = "";
    this._streaming = false;
  }
  _mdTheme() {
    const c = this.c;
    return {
      heading: (s) => c.bold(c.emerald(s)), link: c.blue, linkUrl: c.dim,
      code: c.amber, codeBlock: c.green, codeBlockBorder: c.faint,
      quote: c.dim, quoteBorder: c.faint, hr: c.faint, listBullet: c.emerald,
      bold: c.bold, italic: c.italic, strikethrough: c.dim, underline: c.underline,
    };
  }
}

/*
 * 셸 전용 화면 (D3 Phase 3). 공용 팔레트(ui/palette)에는 넣지 않는다 —
 * 그 정본은 기본 REPL 이 실제로 처리하는 명령만 광고해야 하고,
 * palette-command-coverage-contract 가 그 계약을 잠근다.
 */
const SHELL_SCREENS = [
  { name: "dashboard", ko: "관제 대시보드 — 확인 필요·실행 활동·자동화", en: "Dashboard — attention, run activity, automations" },
  { name: "library", ko: "라이브러리 — 에이전트·MCP", en: "Library — agents, MCP" },
  { name: "marketplace", ko: "Hub — 북마크·대여 현황", en: "Hub — bookmarks and borrows" },
  { name: "settings", ko: "설정 현황", en: "Settings overview" },
  { name: "projects", ko: "프로젝트 목록 — 채팅·작업 수", en: "Projects — chats and tasks" },
  { name: "automations", ko: "자동화 목록·상세 [이름]", en: "Automations list/detail [name]" },
  { name: "firms", ko: "회사(팀) 목록·조직도 [슬러그]", en: "Firms and rosters [slug]" },
];

function toSlashCommands(lang) {
  // 팔레트 정본 → 렌더러 SlashCommand. "/" 접두는 렌더러가 관리하므로 벗긴다.
  const base = palette.SLASH_COMMANDS.map((cmd) => ({
    name: cmd.command.slice(1),
    description: lang === "ko" ? cmd.ko : cmd.en,
    argumentHint: cmd.args || undefined,
  }));
  const seen = new Set(base.map((c) => c.name));
  for (const s of SHELL_SCREENS) {
    if (!seen.has(s.name)) base.push({ name: s.name, description: lang === "ko" ? s.ko : s.en });
  }
  return base;
}

async function startShell(ctx, opts = {}) {
  const pi = loadRenderer();
  const en = ctx.lang === "en";
  const db = ctx.db();

  const terminal = new pi.ProcessTerminal();
  const tui = new pi.TuiMainScreen(terminal);
  /*
   * Container.render 는 삽입 순서로 그린다. 예전엔 헤더 3줄 뒤에 Editor 를 넣어서
   * 입력면이 4번째 줄에 영구 고정됐고, 이후 모든 출력이 그 아래로 흘러 입력 상자가
   * 화면 한가운데 박혔다. 위=트랜스크립트 / 아래=입력면 두 칸으로 나눈다.
   */
  const transcript = new pi.Container();
  const bottom = new pi.Container();
  tui.addChild(transcript);
  tui.addChild(bottom);
  const ui = new ShellUi({ lang: ctx.lang }, pi, tui, transcript);

  // ctx 초크포인트 재지정 — 55파일의 ctx.out 직출력이 전부 프레임 안으로 들어온다.
  const shellCtx = {
    ...ctx,
    // 명령이 "지금 사용자가 어디에 서 있는지"를 알아야 안내를 옳게 쓴다.
    surface: "shell",
    uiInstance: ui,
    out: (s = "") => ui.line(String(s)),
    err: (s = "") => ui.line(ui.c.amber(String(s))),
  };

  const orch = new Orchestrator({ db, lang: ctx.lang });
  const renderer = new Renderer(ui);
  let permission = permissions.normalize(opts.permission || (ctx.prefs && ctx.prefs.permission) || "write");

  const resolveRt = (agentId = null) => resolveRuntimeForAgent({
    db, prefs: ctx.prefs, explicit: opts.runtime || null,
    model: opts.model || null, effort: opts.effort || null,
    role: "orchestrator", agentId,
  });
  const pickController = () => {
    const resolved = resolveProjectController(db, process.cwd());
    return withProjectControllerContext(resolved.controller, resolved.project);
  };
  const ensureMainSession = () => {
    const agent = orch.active() ? orch.active().agent : pickController();
    if (!agent) {
      throw Object.assign(new Error(en
        ? "This project has no available controller — connect with: agentlas project use <agent>"
        : "이 프로젝트에 실행 가능한 컨트롤러가 없습니다 — agentlas project use <에이전트>로 연결하세요"),
        { code: "project_not_connected", honestStop: true });
    }
    const active = orch.active();
    if (active && active.agent.id === agent.id) return active;
    const session = orch.spawn({
      agent, runtime: resolveRt(agent.id), permission,
      cwd: process.cwd(), activate: true, chatId: opts.chatId || null,
    });
    renderer.attach(session, { replay: false });
    return session;
  };

  // ── 헤더 ──
  ui.line(`${ui.c.paw("▞▖")} ${ui.c.bold("AGENTLAS")} ${ui.c.dim(`${readVersion()} · parallel ≤${maxParallel()}`)}`);
  ui.line(ui.c.dim(en
    ? "plain words run a task · / commands · Esc interrupts · Ctrl+C quits"
    : "문장을 치면 실행 · / 명령 · Esc 중단 · Ctrl+C 종료"));
  ui.line("");

  // ── 입력면 ──
  const editorTheme = {
    borderColor: ui.c.faint,
    selectList: {
      selectedPrefix: ui.c.emerald, selectedText: ui.c.bold,
      description: ui.c.dim, scrollInfo: ui.c.faint, noMatch: ui.c.dim,
    },
  };
  /*
   * 빈 입력 상자가 "구분선 사이의 빈 칸"으로 보이던 문제(오너 지적). 렌더러의 Editor 는
   * placeholder 를 지원하지 않으므로, 비어 있을 때만 첫 내용 줄 뒤에 힌트를 덧붙인다.
   * 커서는 그 줄에 이미 그려져 있으므로 교체가 아니라 append 여야 안전하다.
   */
  class ShellEditor extends pi.Editor {
    render(width) {
      const lines = super.render(width);
      if (this.getText() === "" && lines.length >= 3) {
        const hint = ui.c.faint(en
          ? "type a task  ·  / for commands"
          : "할 일을 문장으로  ·  / 명령");
        // 에디터가 줄을 폭까지 공백으로 채운다 — 그대로 덧붙이면 힌트가 오른쪽 끝으로 밀린다.
        // 꼬리 공백만 걷어내고 커서 바로 뒤에 붙인다(ANSI 리셋은 보존).
        lines[1] = lines[1].replace(/[ \t]+(\u001b\[0m)?$/, "$1") + " " + hint;
      }
      return lines;
    }
  }
  const editor = new ShellEditor(tui, editorTheme, { autocompleteMaxVisible: 8, paddingX: 1 });
  editor.setAutocompleteProvider(new pi.CombinedAutocompleteProvider(toSlashCommands(ctx.lang), process.cwd()));

  // ── 히스토리 디스크 영속 (증분 2) — cli-history.json v2 계약을 그대로 재사용 ──
  const input = require("../agentlas-input.cjs");
  const historyLedger = (() => { try { return input.loadHistory(process.cwd()); } catch { return []; } })();
  // readline 히스토리는 최신-우선 배열 — Editor에는 과거→최신 순으로 먹인다.
  for (const entry of [...historyLedger].reverse()) editor.addToHistory(entry);
  const recordHistory = (line) => {
    historyLedger.unshift(line);
    if (historyLedger.length > input.HISTORY_MAX) historyLedger.length = input.HISTORY_MAX;
    try { input.saveHistory(historyLedger, process.cwd()); } catch { /* 히스토리는 최선노력 */ }
  };

  // ── Shift-Tab 권한 순환 (증분 2) — repl의 순수 상태기계를 그대로 재사용 ──
  const { createPermissionShortcut } = require("./repl.cjs");
  const permShortcut = createPermissionShortcut({
    lang: ctx.lang,
    getPermission: () => permission,
    setPermission: (level) => { permission = level; },
    onMessage: (msg) => { ui.ensureNl(); ui.line(ui.c.dim(msg.text)); },
  });

  /*
   * 목록 피커 — 슬러그를 손으로 받아치게 하지 않는다(오너 지적).
   * SelectList 는 Focusable 이 아니라 포커스로는 키가 안 온다(Loader 와 같은 함정) —
   * 전역 리스너에서 직접 forward 하고, 뜨는 동안 에디터 입력을 막는다.
   */
  let activePicker = null;
  function pick(items, opts = {}) {
    return new Promise((resolve) => {
      if (!items.length) { resolve(null); return; }
      ui.ensureNl();
      if (opts.title) ui.line(ui.c.bold(opts.title));
      ui.line(ui.c.dim(en
        ? "↑/↓ choose · Enter confirm · Esc cancel"
        : "↑/↓ 이동 · Enter 선택 · Esc 취소"));
      const list = new pi.SelectList(items, Math.min(10, items.length), editorTheme.selectList, {});
      const finish = (value) => {
        if (activePicker !== list) return;
        activePicker = null;
        bottom.removeChild(list);
        tui.setFocus(editor);
        tui.requestRender();
        resolve(value);
      };
      list.onSelect = (item) => finish(item);
      list.onCancel = () => finish(null);
      activePicker = list;
      bottom.addChild(list);
      tui.setFocus(null);
      tui.requestRender();
    });
  }

  const commands = require("../commands/index.cjs");
  const handleSlash = async (cmdline) => {
    const raw = cmdline.split(/\s+/)[0] || "";
    // 팔레트가 따옴표 인자를 가르치므로 REPL 과 같은 토크나이저를 쓴다.
    const rest = require("../agentlas-input.cjs").tokenizeCommandLine(cmdline).slice(1);
    const cmd = commands.resolveCommandName(raw);
    if (cmd === "quit" || cmd === "exit") return "quit";
    if (cmd === "help") {
      ui.line(palette.renderPalette(ctx.lang, { all: String(rest[0] || "") === "all" }));
      ui.line("");
      ui.line(ui.c.dim(en
        ? "Tab completes commands · ↑/↓ history · Shift-Tab cycles permission · Esc interrupts a turn"
        : "Tab: 명령 완성 · ↑/↓ 히스토리 · Shift-Tab 권한 순환 · Esc 턴 중단"));
      return;
    }
    // 그래프 보기 (Phase 4) — 캔버스를 흉내내지 않는다: mermaid → 유니코드 박스 아트.
    if (cmd === "graph" && rest[0] === "show" && rest[1]) {
      const name = rest.slice(1).join(" ");
      const row = db.prepare(
        "SELECT name, graph_json FROM automations WHERE name = ? AND graph_json IS NOT NULL").get(name);
      if (row) {
        try {
          const g = JSON.parse(row.graph_json);
          const esc = (s) => String(s || "").replace(/["[\]{}|<>]/g, " ").trim().slice(0, 28) || "·";
          const lines = ["flowchart TD"];
          for (const n of g.nodes || []) {
            const label = esc(n.label || n.id);
            lines.push(n.type === "condition" ? `  ${n.id}{${label}}` : `  ${n.id}[${label}]`);
          }
          for (const e of g.edges || []) {
            const lbl = e.sourceHandle === "true" ? (en ? "|yes|" : "|참|")
              : e.sourceHandle === "false" ? (en ? "|no|" : "|거짓|") : "";
            lines.push(`  ${e.source} -->${lbl} ${e.target}`);
          }
          const { render, toAnsi } = require("../vendor/mermaid/index.js");
          const art = toAnsi(render(lines.join("\n")));
          ui.ensureNl();
          ui.line(ui.c.bold(row.name));
          for (const rowLine of (Array.isArray(art) ? art : String(art).split("\n"))) ui.line(rowLine);
          ui.line("");
          return;
        } catch { /* 렌더 실패 → 아래 클래식 폴스루가 텍스트로 보여준다 */ }
      }
    }
    /*
     * /search — 결과를 목록으로 띄우고 방향키로 고른다. 슬러그를 손으로 받아치게
     * 하지 않는다(오너 지적). 고르면 바로 설치까지 간다.
     *
     * kind 는 서버 열거값을 그대로 보여주지 않는다. "cloud-callable" 은 사용자에게
     * "설치 안 해도 바로 부를 수 있음"이라는 뜻이지, 설치가 안 된다는 뜻이 아니다.
     */
    if (cmd === "search" && rest.length) {
      const query = rest.join(" ");
      const { callHubTool, HubError } = require("../cloud/hub-client.cjs");
      let result;
      ui.updateSpinner(en ? "Searching the Hub…" : "Hub 검색 중…");
      try {
        result = await callHubTool("marketplace.search_agents", { q: query, limit: 12 });
      } catch (e) {
        ui.stopSpinner();
        ui.error(Object.assign(new Error(e instanceof HubError ? e.message : String((e && e.message) || e)),
          { code: "hub_search_failed", honestStop: true }));
        return;
      }
      ui.stopSpinner();
      const raw = (result && (result.results || result.agents || result.items)) || (Array.isArray(result) ? result : []);
      const hidden = (slug) => /^researcher-\d+/.test(String(slug || "").toLowerCase())
        || String(slug || "").toLowerCase().startsWith("hephaestus-");
      const rows = (Array.isArray(raw) ? raw : []).filter((it) => !hidden(it && (it.slug || it.id)));
      if (!rows.length) { ui.line(ui.c.dim(en ? `No results for "${query}"` : `"${query}" 결과 없음`)); return; }
      const callable = (k) => (String(k || "").includes("cloud")
        ? (en ? "callable without installing" : "설치 없이 호출 가능")
        : (en ? "install to use" : "설치해야 사용"));
      const chosen = await pick(rows.map((it) => ({
        value: it.slug || it.id || "?",
        label: `${it.slug || it.id}`,
        description: `${it.name || it.title || ""} — ${callable(it.kind || it.entity_kind)}`,
      })), { title: en ? `Hub results for "${query}"` : `"${query}" Hub 결과` });
      if (!chosen) { ui.line(ui.c.dim(en ? "cancelled" : "취소됨")); return; }
      ui.line(ui.c.dim(en ? `installing ${chosen.value}…` : `${chosen.value} 설치 중…`));
      await commands.COMMANDS.install().run(shellCtx, [chosen.value]);
      return;
    }

    /*
     * /graph — 저장된 그래프를 목록으로 띄우고 고른 것을 실행한다.
     * (저장 테이블 이름은 automations 이지만 이 화면이 다루는 건 그래프다.)
     */
    if (cmd === "graph" && (!rest.length || rest[0] === "list")) {
      const rowsOf = db.prepare("SELECT name, enabled, schedule, graph_json FROM automations ORDER BY name").all();
      const graphs = rowsOf.filter((r) => r.graph_json);
      if (!graphs.length) { ui.line(ui.c.dim(en ? "No saved graphs yet." : "저장된 그래프가 없습니다.")); return; }
      const chosen = await pick(graphs.map((g) => {
        let steps = 0;
        try { steps = (JSON.parse(g.graph_json).nodes || []).length; } catch { steps = 0; }
        return {
          value: g.name,
          label: g.name,
          description: `${steps} ${en ? "steps" : "단계"} · ${g.enabled ? (en ? "on" : "켜짐") : (en ? "off" : "꺼짐")}`
            + (g.schedule ? ` · ${g.schedule}` : ""),
        };
      }), { title: en ? "Saved graphs" : "저장된 그래프" });
      if (!chosen) { ui.line(ui.c.dim(en ? "cancelled" : "취소됨")); return; }
      await commands.COMMANDS.graph().run(shellCtx, ["run", chosen.value]);
      return;
    }

    /*
     * 세션 설정 4종. 자동완성은 되는데 처리 case 가 없어 "여기서는 아직 안 됩니다"만
     * 답하던 죽은 광고였다(신설 게이트가 잡았다). 기본 REPL 과 같은 의미로 배선하고,
     * 영구 저장 경로를 같은 줄에서 알려준다 — 이 값들은 이 셸 한정이다.
     */
    if (cmd === "permission" || cmd === "model" || cmd === "runtime" || cmd === "effort") {
      const value = String(rest[0] || "").trim();
      const entry = require("./commands-catalog.cjs").byName(cmd);
      if (!value) {
        ui.line(ui.c.dim(`Usage: /${cmd} ${entry ? entry.args : ""}`));
        return;
      }
      if (cmd === "permission") {
        if (!permissions.isLevel(value)) {
          ui.line(ui.c.dim("Usage: /permission read|write|full"));
          return;
        }
        const next = permissions.normalize(value);
        permission = next;
        ui.line(ui.c.dim(`permission: ${next}  ·  ${en ? "persist: agentlas setup" : "영구 저장: agentlas setup"}`));
        return;
      }
      if (cmd === "model") opts.model = value === "default" ? null : value;
      else if (cmd === "runtime") opts.runtime = value;
      else opts.effort = value;
      ui.line(ui.c.dim(`${cmd}: ${value}  ·  ${en
        ? "applies to new sessions here (persist: agentlas roles set)"
        : "이 셸의 새 세션부터 (영구 저장: agentlas roles set)"}`));
      return;
    }
    // 셸 끄기 — 여기서도 되돌아갈 수 있어야 한다(들어와서 못 나가면 갇힌다)
    if (cmd === "shell") {
      const want = String(rest[0] || "").toLowerCase();
      if (!["on", "off"].includes(want)) { ui.line(ui.c.dim(en ? "Usage: /shell on|off" : "사용법: /shell on|off")); return; }
      const config = require("../agentlas-config.cjs");
      const { userDataDir } = require("../core/paths.cjs");
      config.updatePrefs(userDataDir(), { shell: want === "on" ? "interactive" : "classic" });
      ui.line(ui.c.dim(want === "on"
        ? (en ? "Already here." : "이미 이 셸입니다.")
        : (en ? "Interactive shell disabled — restart agentlas for the classic REPL."
              : "대화형 셸을 껐습니다 — agentlas 를 다시 실행하면 기본 REPL 입니다.")));
      return;
    }
    // 데스크탑 대응 화면 (Phase 3) — 정직 정지였던 표면들을 실물로 대체
    {
      const screens = require("./screens.cjs");
      const SCREEN = {
        dashboard: screens.dashboard,
        library: screens.library,
        marketplace: screens.marketplace,
        bookmarks: screens.marketplace,
        settings: screens.settings,
        projects: screens.projects,
        automations: screens.automations,
        firms: screens.firms,
      };
      // 인자 있는 화면(automations/firms 상세)은 restStr 을 그대로 넘긴다.
      if (SCREEN[cmd]) { SCREEN[cmd](ui, db, en, shellCtx, cmdline.slice(raw.length).trim()); return; }
    }
    // 세션 관찰/전환 (증분 2b) — 기본 REPL과 같은 orch/renderer 배선
    if (cmd === "sessions" || cmd === "tree") {
      require("./repl.cjs").printSessions(shellCtx, orch);
      return;
    }
    if (cmd === "s" || cmd === "switch" || cmd === "kill" || cmd === "rm") {
      const token = rest[0];
      if (!token) { ui.line(ui.c.dim(`Usage: /${cmd} <n>`)); return; }
      const key = String(token).startsWith("s") ? token : `s${token}`;
      if (cmd === "kill") { orch.kill(key); return; }
      if (cmd === "rm") {
        orch.remove(key);
        const act = orch.active();
        if (act) renderer.attach(act, { replay: false });
        return;
      }
      const session = orch.setActive(key);
      renderer.attach(session, { replay: true });
      return;
    }
    const EXCLUDED = new Set(["firm", "setup", "run"]);
    if (!EXCLUDED.has(cmd) && commands.COMMANDS[cmd]) {
      await commands.COMMANDS[cmd]().run(shellCtx, rest);
      return;
    }
    if (commands.DESKTOP_ONLY_SURFACES && commands.DESKTOP_ONLY_SURFACES[cmd]) {
      ui.line(ui.c.dim(commands.DESKTOP_ONLY_SURFACES[cmd]));
      return;
    }
    ui.line(ui.c.dim(en ? `not available here yet: /${cmd}` : `여기서는 아직 안 됩니다: /${cmd}`));
  };

  let busy = false;
  editor.onSubmit = (text) => {
    const input = String(text || "").trim();
    if (!input) return;
    editor.addToHistory(input);
    recordHistory(input);
    editor.setText("");
    ui.ensureNl();
    ui.line(ui.c.emerald("› ") + ui.c.text(input));
    (async () => {
      if (input.startsWith("!")) {
        await require("./repl.cjs").runShell(shellCtx, input.slice(1).trim(), permission)
          .catch((e) => { if (e && (e.code || e.honestStop)) ui.error(e); else ui.error(); });
        return;
      }
      if (input.startsWith("/")) {
        const verdict = await handleSlash(input.slice(1)).catch((e) => {
          if (e && (e.code || e.honestStop)) ui.error(e);
          else ui.error();
          return null;
        });
        if (verdict === "quit") shutdown(0);
        return;
      }
      if (busy) { orch.active()?.send(input).catch(() => {}); return; } // 스티어링 큐
      busy = true;
      try {
        const session = ensureMainSession();
        await orch.sendTo(session.key, input);
      } catch (e) {
        if (e && (e.code || e.honestStop)) ui.error(e);
        else ui.error();
      } finally {
        busy = false;
      }
    })();
  };
  bottom.addChild(editor);
  tui.setFocus(editor);

  const shutdown = (code) => {
    try { renderer.detach(); } catch { /* 종료 경로 */ }
    try { tui.stop(); } catch { /* 종료 경로 */ }
    Promise.resolve(orch.shutdown && orch.shutdown()).finally(() => process.exit(code));
  };

  tui.addInputListener((data) => {
    // 피커가 떠 있으면 그 키는 피커 것이다 — 에디터로 새면 목록 위에서 글이 써진다.
    if (activePicker) {
      if (pi.matchesKey(data, "escape")) { activePicker.onCancel && activePicker.onCancel(); return { handled: true }; }
      activePicker.handleInput(data);
      tui.requestRender();
      return { handled: true };
    }
    // Shift-Tab 권한 순환 — 렌더러가 raw mode 를 단독 소유하므로 readline 의
    // swallowCompletion 우회 없이 여기서 직접 소비한다 (D2 위험 2의 해소 형태).
    if (pi.matchesKey(data, "shift+tab")) {
      permShortcut.handleKey("", { name: "tab", shift: true });
      return { handled: true };
    }
    if (permShortcut.armed()) permShortcut.handleKey("", { name: "other" }); // 다른 키 = 무장 해제
    if (pi.matchesKey(data, "ctrl+c")) {
      const active = orch.active();
      if (active && active.isBusy()) {
        active.kill();
        ui.ensureNl();
        ui.line(ui.c.dim(en ? "(turn interrupted)" : "(턴 중단됨)"));
        return { handled: true };
      }
      shutdown(0);
      return { handled: true };
    }
    if (pi.matchesKey(data, "escape")) {
      const active = orch.active();
      if (active && active.isBusy()) {
        active.kill();
        ui.ensureNl();
        ui.line(ui.c.dim(en ? "(turn interrupted — Esc)" : "(턴 중단됨 — Esc)"));
        return { handled: true };
      }
    }
  });

  tui.start();
  // 렌더러가 프로세스를 잡고 있는 동안 살아 있는 프라미스
  return new Promise(() => {});
}

module.exports = { startShell };
