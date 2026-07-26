"use strict";
/*
 * First-run onboarding wizard (openclaw-style): language → default runtime → safe default permission.
 * Runs once; result is saved to cli-prefs.json. Re-run anytime with `agentlas setup`.
 */
const i18n = require("./agentlas-i18n.cjs");
const banner = require("./agentlas-banner.cjs");
const { visWidth, wrapWidth } = require("./agentlas-composer.cjs");

// req = { ui, rl, helpers }  → Promise<{ onboarded, lang, runtime, permission }>
async function runOnboard({ ui, rl, helpers }) {
  const H = helpers;
  const c = ui.c;
  const contentWidth = () => Math.max(20, (ui.out.columns || 80) - 5);
  const printIndented = (value, paint = (text) => text, indent = "   ") => {
    const room = Math.max(2, (ui.out.columns || 80) - visWidth(indent));
    for (const line of wrapWidth(value, room)) ui.line(indent + paint(line));
  };
  const printSaved = (value) => {
    const lines = wrapWidth(value, Math.max(2, (ui.out.columns || 80) - 6));
    ui.ok(lines[0] || "");
    for (const line of lines.slice(1)) ui.line("    " + c.text(line));
  };
  const optionLine = (index, label, isDefault = false) => {
    const suffix = isDefault ? `  ${ui.t("wiz.default")}` : "";
    const prefix = `${index}  `;
    const continuation = " ".repeat(visWidth(prefix));
    const lines = wrapWidth(`${label}${suffix}`, Math.max(2, contentWidth() - visWidth(prefix)));
    lines.forEach((line, lineIndex) => {
      ui.line("     " + c.text((lineIndex === 0 ? prefix : continuation) + line));
    });
  };
  const pendingLines = [];
  let lineWaiter = null;
  const onLine = (line) => {
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = null;
      resolve((line || "").trim());
    } else {
      // A pasted multi-line setup response can arrive in one terminal data
      // burst before the next prompt is installed. Preserve those later lines.
      pendingLines.push((line || "").trim());
    }
  };
  rl.on("line", onLine);
  const ask = (q) => {
    if (pendingLines.length) return Promise.resolve(pendingLines.shift());
    return new Promise((resolve) => {
      lineWaiter = resolve;
      rl.setPrompt(q);
      rl.prompt();
    });
  };
  let localSigintArmedUntil = 0;
  const ownsSigint = rl.listenerCount("SIGINT") === 0;
  const onSigint = () => {
    const now = Date.now();
    if (now < localSigintArmedUntil) {
      ui.line(ui.c.dim(ui.t("bye")));
      process.exit(0);
    }
    localSigintArmedUntil = now + 3_000;
    ui.warn(ui.t("ctrlcAgain"));
  };
  if (ownsSigint) rl.on("SIGINT", onSigint);
  const pickNum = async (n) => {
    // Empty keeps the explicitly labelled first option. In a TTY, Up/Down
    // places a real numeric choice into the readline field so arrows and
    // number entry share the same validation path.
    let selected = 1;
    printIndented(ui.t("wiz.nav"), c.dim);
    for (;;) {
      let settled = false;
      let arrowWriteScheduled = false;
      const flushArrowWrite = () => {
        arrowWriteScheduled = false;
        if (settled || rl.closed) return;
        rl.write(null, { ctrl: true, name: "u" });
        rl.write(String(selected));
      };
      const onKeypress = (_str, key = {}) => {
        if (key.name === "return" || key.name === "enter") {
          // readline may emit `line` before the coalesced setImmediate write.
          // Commit the final arrow target synchronously before Enter reaches
          // readline's own key handler.
          if (arrowWriteScheduled) flushArrowWrite();
          return;
        }
        if (key.name !== "up" && key.name !== "down") return;
        selected = key.name === "up"
          ? (selected - 2 + n) % n + 1
          : selected % n + 1;
        if (arrowWriteScheduled) return;
        arrowWriteScheduled = true;
        setImmediate(() => {
          if (arrowWriteScheduled) flushArrowWrite();
        });
      };
      if (rl.terminal && rl.input) rl.input.prependListener("keypress", onKeypress);
      const a = await ask("   " + c.emerald(ui.t("wiz.pick")));
      settled = true;
      if (rl.input) rl.input.removeListener("keypress", onKeypress);
      if (a === "") return selected;
      if (/^\d+$/.test(a)) {
        const i = parseInt(a, 10);
        if (i >= 1 && i <= n) return i;
      }
      ui.warn(ui.t("wiz.invalid", String(n)));
    }
  };

  try {
    // small mascot + header
    ui.line("");
    banner.renderMascot(ui);
    ui.line("   " + c.bold(c.emerald("Agentlas")) + c.dim(" · setup"));
    printIndented(ui.t("wiz.welcome"), c.dim);

  // Step 1 — language
  ui.line("");
  printIndented(ui.t("wiz.langQ"), c.bold);
  i18n.LANGS.forEach((l, i) => optionLine(i + 1, l.label, i === 0));
  const li = await pickNum(i18n.LANGS.length);
  const lang = i18n.LANGS[li - 1].code;
  ui.lang = lang; // localize the rest of the wizard

  // Step 2 — default runtime
  ui.line("");
  printIndented(ui.t("wiz.runtimeQ"), c.bold);
  const cliKinds = ["claude-code", "codex", "gemini"];
  const rtOpts = [{ value: "auto", label: ui.t("wiz.runtimeAuto") }];
  for (const k of cliKinds) {
    const has = !!H.which(H.RUNTIME_BIN[k]);
    rtOpts.push({ value: k, label: `${k}  (${has ? ui.t("wiz.runtimeInstalled") : ui.t("wiz.runtimeMissing")})` });
  }
  rtOpts.forEach((o, i) => optionLine(i + 1, o.label, i === 0));
  const ri = await pickNum(rtOpts.length);
  const runtime = rtOpts[ri - 1].value;

  // Step 3 — default permission
  ui.line("");
  printIndented(ui.t("wiz.permQ"), c.bold);
  const permOpts = [
    { v: "read", l: ui.t("wiz.permRead") },
    { v: "write", l: ui.t("wiz.permWrite") },
  ];
  permOpts.forEach((o, i) => optionLine(i + 1, o.l, i === 0));
  const pi = await pickNum(permOpts.length);
  const permission = permOpts[pi - 1].v;

    ui.line("");
    printSaved(ui.t("wiz.saved"));
    printIndented(ui.t("wiz.changeLang"), c.faint);
    return { onboarded: true, lang, runtime, permission };
  } finally {
    rl.removeListener("line", onLine);
    if (ownsSigint) rl.removeListener("SIGINT", onSigint);
    lineWaiter = null;
  }
}

module.exports = { runOnboard };
