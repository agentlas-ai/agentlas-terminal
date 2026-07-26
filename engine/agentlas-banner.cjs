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

// Main splash. ctx = { ui, version, runtimeLabel, subjectLabel, permission, cwd }
function renderBanner(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const value = sessionValues(ctx);
  const columns = ui.out.columns || 80;
  const room = Math.max(20, columns - 4);
  const headlineRoom = Math.max(12, columns - 2);
  const version = value.version ? "  v" + value.version : "";
  const separator = "  ·  ";
  const headline = `${WORDMARK_COMPACT}${version}${separator}${ui.t("banner.product")}`;
  ui.line("");
  if (visWidth(headline) <= headlineRoom) {
    ui.line("  " + c.bold(c.emerald(WORDMARK_COMPACT)) + c.faint(version) + c.dim(separator + ui.t("banner.product")));
  } else {
    ui.line("  " + c.bold(c.emerald(WORDMARK_COMPACT)) + c.faint(version));
    ui.line("  " + c.dim(ui.t("banner.product")));
  }
  ui.line("  " + c.text(truncateWidth(ui.t("banner.session", value.runtime, value.subject, value.permission), room)));
  ui.line("  " + c.faint(truncateWidth(ui.t("banner.location", value.cwd), room)));
  ui.line("");
}

// runtime · subject · permission · working folder (no wordmark — used for /status).
function renderStatus(ctx) {
  renderStatusCard(ctx, { noTip: true, noWordmark: true });
}

module.exports = { renderBanner, renderStatus, renderMascot, readVersion, shorten, WORDMARK, fit };
