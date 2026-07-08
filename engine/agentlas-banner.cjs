"use strict";
/*
 * Agentlas terminal splash — AGENTLAS wordmark banner + status card.
 */
const path = require("node:path");
const os = require("node:os");

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
  const cols = (ui.out && ui.out.columns) || 80;
  if (!ui.enabled) {
    ui.line("  AGENTLAS");
    return;
  }
  // Narrow terminal → compact wordmark.
  if (cols < 72) {
    ui.line("  " + c.bold(c.emerald(WORDMARK_COMPACT)));
    return;
  }
  const g = (rgb, s) => `\x1b[1;38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m`;
  for (const rowStr of WORDMARK) {
    let outLine = "";
    const n = rowStr.length || 1;
    for (let i = 0; i < rowStr.length; i++) {
      const ch = rowStr[i];
      if (ch === " ") { outLine += " "; continue; }
      const idx = Math.min(GRADIENT.length - 1, Math.floor((i / n) * GRADIENT.length));
      outLine += g(GRADIENT[idx], ch);
    }
    ui.line(outLine);
  }
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

function renderStatusCard(ctx, opts = {}) {
  const ui = ctx.ui;
  const c = ui.c;
  const cols = ui.out.columns || 80;
  const width = Math.max(54, Math.min(cols - 2, 78));
  const version = ctx.version || readVersion();
  const subject = ctx.subjectLabel || "Pick an agent, choose a company, or type a task";
  const permission = ctx.permission || "write";
  const runtime = ctx.runtimeLabel || "(not configured)";
  const cwd = ctx.cwd ? shorten(ctx.cwd) : process.cwd();

  ui.line("");
  if (!opts.noWordmark) {
    renderMascot(ui);
    ui.line("  " + c.dim("the operating system for agents") + (version ? c.faint("   v" + version) : ""));
  }
  ui.line("");
  ui.line(c.faint("╭" + "─".repeat(width - 2) + "╮"));
  row(ui, width, `model:       ${runtime}`);
  row(ui, width, `agent:       ${subject}`);
  row(ui, width, `directory:   ${cwd}`);
  row(ui, width, `permissions: ${permission}`);
  ui.line(c.faint("╰" + "─".repeat(width - 2) + "╯"));
  if (!opts.noTip) {
    ui.line(
      "  " +
        c.bold(c.text("Tip:")) +
        c.dim(" Type ") +
        c.faint("/help") +
        c.dim(" for commands, ") +
        c.faint("/status") +
        c.dim(" for session state, ") +
        c.faint("/exit") +
        c.dim(" to quit."),
    );
  }
}

// Main splash. ctx = { ui, version, runtimeLabel, subjectLabel, permission, cwd }
function renderBanner(ctx) {
  renderStatusCard(ctx);
  ctx.ui.line("");
}

// runtime · subject · permission · working folder (no wordmark — used for /status).
function renderStatus(ctx) {
  renderStatusCard(ctx, { noTip: true, noWordmark: true });
}

module.exports = { renderBanner, renderStatus, renderMascot, readVersion, shorten, WORDMARK, fit };
