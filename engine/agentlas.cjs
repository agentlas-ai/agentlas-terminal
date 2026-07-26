"use strict";
/*
 * engine/agentlas — v2 엔진 진입점.
 *
 * v1의 13,347줄 모놀리스를 대체하는 얇은 디스패처다. 규칙:
 *  - 여기에는 기능 로직을 두지 않는다. argv 해석 → ctx(DI) 구성 → commands/ 디스패치.
 *  - 명령이 아니면 REPL(ui/repl)로 진입한다.
 *  - 아직 포팅되지 않은 v1 명령은 commands/index의 정직 정지 목록이 처리한다.
 *
 * ctx(DI) 계약: 명령/REPL은 이 객체만 받는다. 전역 상태 접근 금지.
 *   ctx.db()          지연 오픈된 공유 SQLite (openDb + seedBuiltins 1회)
 *   ctx.lang          "ko" | "en"
 *   ctx.ui            { bold, dim, accent, green, red } 스타일 함수
 *   ctx.out/err       stdout/stderr 한 줄 출력
 *   ctx.tableExists / ctx.columnExists
 */
const { openDb, seedBuiltins, tableExists, columnExists } = require("./core/db.cjs");
const { userDataDir } = require("./core/paths.cjs");
const { loadPrefs } = require("./agentlas-config.cjs");
const { Ui } = require("./agentlas-ui.cjs");
const commands = require("./commands/index.cjs");

function resolveLang(prefs) {
  if (process.env.AGENTLAS_LANG === "ko" || process.env.AGENTLAS_LANG === "en") return process.env.AGENTLAS_LANG;
  if (prefs && (prefs.language === "ko" || prefs.language === "en")) return prefs.language;
  const envLang = String(process.env.LANG || process.env.LC_ALL || "");
  return /^ko/i.test(envLang) ? "ko" : "en";
}

function buildCtx() {
  let prefs = {};
  try { prefs = loadPrefs(userDataDir()) || {}; } catch { /* 첫 실행 */ }
  const lang = resolveLang(prefs);
  const ui = new Ui({ lang });
  let _db = null;
  const ctx = {
    lang,
    prefs,
    uiInstance: ui,
    ui: {
      bold: ui.c.bold,
      dim: ui.c.dim,
      accent: ui.c.paw,
      green: ui.c.green,
      red: (s) => (ui.enabled ? `\x1b[31m${s}\x1b[0m` : String(s)),
    },
    out: (s = "") => process.stdout.write(s + "\n"),
    err: (s = "") => process.stderr.write(s + "\n"),
    db: () => {
      if (_db) return _db;
      _db = openDb();
      seedBuiltins(_db);
      return _db;
    },
    tableExists,
    columnExists,
  };
  return ctx;
}

function main() {
  const argv = process.argv.slice(2);
  // 옵션 정규화: -h/--help/-V/--version 은 하위 명령으로 변환
  const normalized = argv.map((a) => {
    if (a === "--help" || a === "-h") return "help";
    if (a === "--version" || a === "-V") return "version";
    return a;
  });

  const ctx = buildCtx();
  let code;
  try {
    code = commands.dispatch(ctx, normalized);
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    process.exit(1);
  }

  if (code === null) {
    // 무인자 → REPL
    const { startRepl } = require("./ui/repl.cjs");
    return startRepl(ctx).then(
      (replCode) => process.exit(replCode || 0),
      (e) => { ctx.err(String((e && e.message) || e)); process.exit(1); },
    );
  }

  if (code === undefined) {
    // 알 수 없는 토큰: v2에서는 아직 에이전트 점프/원샷 자동 라우팅이 배선되지 않았다.
    // 조용히 프롬프트로 삼켜 오라우팅하는 대신 정직하게 안내한다.
    ctx.err(
      `'${normalized[0]}' is not a v2 command yet (agent jump / one-shot routing lands with the v2 runner).\n` +
      `See: agentlas help`,
    );
    process.exit(1);
  }

  process.exit(code);
}

if (require.main === module) main();

module.exports = { buildCtx, resolveLang };
