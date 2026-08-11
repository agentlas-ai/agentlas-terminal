"use strict";
/*
 * ui/pitui-shell — pi-tui 기반 실험 셸 (D3 Phase 2 증분 1, 2026-08-11).
 *
 * 켜는 법: AGENTLAS_TUI=pi agentlas   (TTY 필수 · 기본 REPL은 그대로 정본)
 *
 * 설계 (D2 위험 5의 해법이 이 파일의 구조다):
 *  - PiUi 는 기존 Ui 를 상속하되 write() 초크포인트만 pi-tui 트랜스크립트로 돌린다.
 *    line/_message/tool/rule 등 기존 메서드는 전부 write 로 수렴하므로 그대로 산다.
 *  - 스트리밍 3종은 Markdown 누적으로 교체 — 표·코드블록이 실시간 재렌더된다.
 *  - 스피너는 pi-tui Loader 로 교체 (기존 \r 기반 페인트는 dummy 스트림으로 무해화).
 *  - ctx.out/err 55파일의 직출력은 shellCtx 재지정으로 전부 프레임 안에 들어온다.
 *  - 자동완성은 ui/palette 정본(SLASH_COMMANDS)을 pi-tui SlashCommand 로 변환 — 목록 드리프트 금지.
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

function loadPiTui() {
  try {
    // ESM 패키지 — Node >=20.19 의 require(esm). engines 가 이 최소선을 선언한다.
    return require("@earendil-works/pi-tui");
  } catch (cause) {
    throw Object.assign(
      new Error("pi-tui shell needs Node >=20.19 (require(esm)). Run without AGENTLAS_TUI=pi, or upgrade Node."),
      { code: "pitui_unavailable", cause },
    );
  }
}

/* Ui 를 상속해 write 초크포인트만 pi-tui 로 돌린다. */
class PiUi extends Ui {
  constructor(opts, pi, tui, transcript) {
    // 실터미널 대신 dummy 스트림 — 놓친 직접 out.write 가 프레임을 찢는 대신 소멸한다.
    super({ ...opts, stream: new PassThrough(), color: true });
    this._pi = pi;
    this._tui = tui;
    this._transcript = transcript;
    this._lineBuf = "";
    this._md = null;      // 스트리밍 중 Markdown 누적 컴포넌트
    this._mdText = "";
    this._loader = null;
  }
  _appendText(text) {
    this._transcript.addChild(new this._pi.Text(String(text), 1, 0));
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
    this._md = new this._pi.Markdown("", 3, 0, this._mdTheme());
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

function toSlashCommands(lang) {
  // 팔레트 정본 → pi-tui SlashCommand. "/" 접두는 pi-tui 가 관리하므로 벗긴다.
  return palette.SLASH_COMMANDS.map((cmd) => ({
    name: cmd.command.slice(1),
    description: lang === "ko" ? cmd.ko : cmd.en,
    argumentHint: cmd.args || undefined,
  }));
}

async function startPiShell(ctx, opts = {}) {
  const pi = loadPiTui();
  const en = ctx.lang === "en";
  const db = ctx.db();

  const terminal = new pi.ProcessTerminal();
  const tui = new pi.TuiMainScreen(terminal);
  const ui = new PiUi({ lang: ctx.lang }, pi, tui, tui);

  // ctx 초크포인트 재지정 — 55파일의 ctx.out 직출력이 전부 프레임 안으로 들어온다.
  const shellCtx = {
    ...ctx,
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
  ui.line(`${ui.c.paw("▞▖")} ${ui.c.bold("AGENTLAS")} ${ui.c.dim(`${readVersion()} · pi-tui shell (experimental) · parallel ≤${maxParallel()}`)}`);
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
  const editor = new pi.Editor(tui, editorTheme, { autocompleteMaxVisible: 8 });
  editor.setAutocompleteProvider(new pi.CombinedAutocompleteProvider(toSlashCommands(ctx.lang), process.cwd()));

  const commands = require("../commands/index.cjs");
  const handleSlash = async (cmdline) => {
    const raw = cmdline.split(/\s+/)[0] || "";
    const rest = cmdline.slice(raw.length).trim().split(/\s+/).filter(Boolean);
    const cmd = commands.resolveCommandName(raw);
    if (cmd === "quit" || cmd === "exit") return "quit";
    if (cmd === "help") {
      ui.line(palette.renderPalette(ctx.lang));
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
    ui.line(ui.c.dim(en ? `not in the pi shell yet: /${cmd} — use the classic REPL` : `pi 셸에는 아직 없음: /${cmd} — 기본 REPL을 쓰세요`));
  };

  let busy = false;
  editor.onSubmit = (text) => {
    const input = String(text || "").trim();
    if (!input) return;
    editor.addToHistory(input);
    editor.setText("");
    ui.ensureNl();
    ui.line(ui.c.emerald("› ") + ui.c.text(input));
    (async () => {
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
  tui.addChild(editor);
  tui.setFocus(editor);

  const shutdown = (code) => {
    try { renderer.detach(); } catch { /* 종료 경로 */ }
    try { tui.stop(); } catch { /* 종료 경로 */ }
    Promise.resolve(orch.shutdown && orch.shutdown()).finally(() => process.exit(code));
  };

  tui.addInputListener((data) => {
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
  // pi-tui 가 프로세스를 잡고 있는 동안 살아 있는 프라미스
  return new Promise(() => {});
}

module.exports = { startPiShell };
