"use strict";
/*
 * Agentlas terminal splash — AGENTLAS wordmark banner + status card.
 */
const path = require("node:path");
const os = require("node:os");
const permissions = require("./agentlas-permissions.cjs");
const { truncateWidth, visWidth } = require("./agentlas-composer.cjs");

// AGENTLAS wordmark (block letters). Rendered with a brand gradient across columns.
const WORDMARK = [
  "  █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗      █████╗ ███████╗",
  " ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║     ██╔══██╗██╔════╝",
  " ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║     ███████║███████╗",
  " ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║     ██╔══██║╚════██║",
  " ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████╗██║  ██║███████║",
  " ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝",
];

// Compact single-line wordmark for narrow terminals.
const WORDMARK_COMPACT = "▞▖ AGENTLAS";

// Brand gradient (emerald → green → lime → blue) applied left-to-right across the wordmark.
const GRADIENT = [
  [110, 231, 183],
  [52, 211, 153],
  [16, 185, 129],
  [45, 212, 191],
  [56, 189, 248],
  [147, 197, 253],
];

function readVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version || "";
  } catch {
    return "";
  }
}

function shorten(p) {
  if (!p) return "";
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// AGENTLAS wordmark, per-column brand gradient. Falls back to plain / compact.
function renderMascot(ui) {
  const c = ui.c;
  // A one-line mark keeps first launch and setup compact. The old six-row wordmark
  // remains exported for recordings/assets, but is no longer startup chrome.
  ui.line("  " + c.bold(c.emerald(WORDMARK_COMPACT)));
}

function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function fit(value, width) {
  let s = stripAnsi(value);
  if (s.length > width) {
    if (width <= 1) return "…";
    s = s.slice(0, Math.max(0, width - 1)) + "…";
  }
  return s + " ".repeat(Math.max(0, width - s.length));
}

function row(ui, width, text) {
  const inner = Math.max(10, width - 4);
  ui.line(ui.c.faint("│ ") + ui.c.text(fit(text, inner)) + ui.c.faint(" │"));
}

function sessionValues(ctx) {
  const ui = ctx.ui;
  return {
    version: ctx.version || readVersion(),
    subject: ctx.subjectLabel || ui.t("composer.autoroute"),
    permission: permissions.copy(ctx.permission || "write", ui.lang).label,
    runtime: ctx.runtimeLabel || "—",
    model: ctx.modelLabel || "auto",
    effort: ctx.effortLabel || "auto",
    cwd: ctx.cwd ? shorten(ctx.cwd) : process.cwd(),
  };
}

function renderStatusCard(ctx, opts = {}) {
  const ui = ctx.ui;
  const c = ui.c;
  const value = sessionValues(ctx);
  const columns = ui.out.columns || 80;
  const labels = [
    ui.t("status.runtime"),
    ui.t("status.model"),
    ui.t("status.effort"),
    ui.t("status.agent"),
    ui.t("status.permission"),
    ui.t("status.directory"),
  ].map((label) => `${label}:`);
  const labelCells = Math.min(Math.max(...labels.map((label) => visWidth(label))) + 2, Math.max(12, Math.floor(columns * 0.42)));
  const line = (label, text) => {
    const labelText = `${label}:`;
    const padded = labelText + " ".repeat(Math.max(1, labelCells - visWidth(labelText)));
    const room = Math.max(8, columns - 2 - visWidth(padded));
    ui.line("  " + c.faint(padded) + c.text(truncateWidth(text, room)));
  };
  ui.line("");
  ui.rule(ui.t("status.title"));
  line(ui.t("status.runtime"), value.runtime);
  line(ui.t("status.model"), value.model);
  line(ui.t("status.effort"), value.effort);
  line(ui.t("status.agent"), value.subject);
  line(ui.t("status.permission"), value.permission);
  line(ui.t("status.directory"), value.cwd);
}

/*
 * ── 카드 프리미티브 ────────────────────────────────────────────────
 * 폭 계산은 전부 visWidth 기준이다. 한글 라벨은 칸당 2열이라 .length 로 채우면
 * 테두리가 어긋난다(기존 fit()이 그랬다 — 카드에서는 쓰지 않는다).
 */
const CARD_MARGIN = "  ";
const CARD_PAD = 3; // 테두리 안쪽 좌우 여백
const CARD_MIN_INNER = 44; // 이보다 좁으면 카드를 접고 3줄 스플래시로 간다
const CARD_MAX_INNER = 76;

function padTo(text, width) {
  return text + " ".repeat(Math.max(0, width - visWidth(text)));
}

// 좌측 라벨 + 우측 정렬 힌트. Grok 메뉴 행(New worktree ⋯ ctrl+w)과 같은 구조다.
function splitRow(label, hint, inner, c) {
  const room = inner - CARD_PAD * 2;
  const hintText = truncateWidth(String(hint || ""), Math.max(0, room));
  const labelRoom = Math.max(0, room - visWidth(hintText) - 2);
  const labelText = truncateWidth(String(label || ""), labelRoom);
  const gap = " ".repeat(Math.max(2, room - visWidth(labelText) - visWidth(hintText)));
  return c.text(labelText) + gap + c.faint(hintText);
}

function cardTop(inner, c) {
  return CARD_MARGIN + c.faint("╭" + "─".repeat(inner) + "╮");
}

function cardRow(painted, plainWidth, inner, c) {
  const pad = " ".repeat(Math.max(0, inner - CARD_PAD - plainWidth));
  return CARD_MARGIN + c.faint("│") + " ".repeat(CARD_PAD) + painted + pad + c.faint("│");
}

function cardBlank(inner, c) {
  return CARD_MARGIN + c.faint("│" + " ".repeat(inner) + "│");
}

// 하단 테두리 우측에 라벨을 박는다 — Grok 입력 박스의 "Grok 4.5 (high)" 자리.
function cardBottom(label, inner, c) {
  const text = truncateWidth(String(label || ""), Math.max(0, inner - 8));
  if (!text) return CARD_MARGIN + c.faint("╰" + "─".repeat(inner) + "╯");
  const right = 2;
  const left = Math.max(1, inner - visWidth(text) - right - 2);
  return CARD_MARGIN + c.faint("╰" + "─".repeat(left) + " ") + c.dim(text) + c.faint(" " + "─".repeat(right) + "╯");
}

// 좁은 터미널·비대화형용 3줄 스플래시 (카드를 접었을 때의 정본 표시).
function renderCompactSplash(ui, value, room) {
  const c = ui.c;
  const version = value.version ? "  v" + value.version : "";
  ui.line("");
  ui.line(CARD_MARGIN + c.bold(c.emerald(WORDMARK_COMPACT)) + c.faint(version) + c.dim("  ·  " + ui.t("banner.product")));
  ui.line(CARD_MARGIN + c.text(truncateWidth(ui.t("banner.session", value.runtime, value.subject, value.permission), room)));
  ui.line(CARD_MARGIN + c.faint(truncateWidth(ui.t("banner.location", value.cwd), room)));
  ui.line("");
}

/*
 * Main splash. ctx = { ui, version, runtimeLabel, subjectLabel, permission, cwd }
 *
 * ui.line 으로 직접 그리고 아무것도 반환하지 않는다 — 호출부가 반환값을 문자열로
 * 쓰면 터진다(그 회귀가 실제로 있었다: repl-banner-contract 참조).
 *
 * 메뉴 행은 실제로 동작하는 슬래시 명령만 싣는다. 화면이 광고하는 조작은 전부
 * 실재해야 한다 — 없는 단축키를 안내하던 전례를 되풀이하지 않는다.
 */
function renderBanner(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const value = sessionValues(ctx);
  const columns = ui.out.columns || 80;
  const inner = Math.min(CARD_MAX_INNER, columns - visWidth(CARD_MARGIN) * 2 - 2);
  if (inner < CARD_MIN_INNER) {
    renderCompactSplash(ui, value, Math.max(20, columns - 4));
    return;
  }

  const version = value.version ? "v" + value.version : "";
  const title = WORDMARK_COMPACT + (version ? "  " : "");
  const menu = [
    [ui.t("banner.menu.help"), "/help"],
    [ui.t("banner.menu.sessions"), "/sessions"],
    [ui.t("banner.menu.quit"), "/quit"],
  ];
  const infoRoom = inner - CARD_PAD * 2;

  ui.line("");
  ui.line(cardTop(inner, c));
  ui.line(cardBlank(inner, c));
  ui.line(cardRow(
    c.bold(c.emerald(WORDMARK_COMPACT)) + c.faint(version ? "  " + version : ""),
    visWidth(title + version),
    inner, c,
  ));
  ui.line(cardRow(c.dim(ui.t("banner.product")), visWidth(ui.t("banner.product")), inner, c));
  ui.line(cardBlank(inner, c));

  const subject = truncateWidth(value.subject, infoRoom);
  const cwd = truncateWidth(value.cwd, infoRoom);
  ui.line(cardRow(c.text(subject), visWidth(subject), inner, c));
  ui.line(cardRow(c.faint(cwd), visWidth(cwd), inner, c));
  ui.line(cardBlank(inner, c));

  for (const [label, command] of menu) {
    ui.line(cardRow(splitRow(label, command, inner, c), infoRoom, inner, c));
  }
  ui.line(cardBlank(inner, c));
  ui.line(cardBottom(`${value.runtime} · ${value.permission}`, inner, c));
  ui.line("");
}

// runtime · subject · permission · working folder (no wordmark — used for /status).
function renderStatus(ctx) {
  renderStatusCard(ctx, { noTip: true, noWordmark: true });
}

module.exports = { renderBanner, renderStatus, renderMascot, readVersion, shorten, WORDMARK, fit };
