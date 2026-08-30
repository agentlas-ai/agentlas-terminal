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
/*
 * EPIPE 방어 — 발행본 1.0.29 실설치 검증에서 발견(2026-08-06):
 * `agentlas version | head -1` 처럼 파이프 소비자가 먼저 닫히면 stdout write가
 * EPIPE를 던져 스택트레이스로 크래시했다(실측: version.cjs → ctx.out → EPIPE).
 * `| head` `| less` `| grep -m1` 은 CLI의 일상 사용 패턴이고, 파이프 단절은
 * 오류가 아니라 "그만 읽겠다"는 신호다 — 조용히 성공 종료한다. 런처(bin)는
 * 엔진을 stdio:"inherit" 로 spawn 하므로 이 방어는 엔진 프로세스에 있어야 한다.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error && error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

/*
 * 예상 못 한 크래시의 마지막 예의 (clig.dev: unexpected error에는 디버그 정보와
 * 버그 리포트 경로를, 리포트는 미리 채워진 URL로 손쉽게).
 * 예전에는 Node 기본 동작(원시 스택트레이스)이 그대로 사용자에게 쏟아졌다 —
 * EPIPE 크래시(1.0.29 실측)가 정확히 그 모습이었다. 스택은 진단에 필요하므로
 * 숨기지 않되, 한 줄 요약과 이슈 URL(제목 미리 채움)을 함께 준다.
 * 종료 코드는 관례대로 1. 여기서 복구를 시도하지 않는다(crash-only).
 */
function reportCrash(kind, error) {
  const message = String((error && error.stack) || error);
  const title = encodeURIComponent(`crash: ${String((error && error.message) || error).slice(0, 100)}`);
  process.stderr.write([
    "",
    `agentlas hit an unexpected error (${kind}).`,
    message,
    "",
    `Report it (pre-filled): https://github.com/agentlas-ai/agentlas-terminal/issues/new?title=${title}`,
    `Include: your command, agentlas ${(() => { try { return require("./agentlas-banner.cjs").readVersion(); } catch { return "?"; } })()}, node ${process.version}, ${process.platform}.`,
    "",
  ].join("\n"));
  process.exit(1);
}
process.on("uncaughtException", (error) => reportCrash("uncaughtException", error));
process.on("unhandledRejection", (error) => reportCrash("unhandledRejection", error));

const { openDb, seedBuiltins, tableExists, columnExists } = require("./core/db.cjs");
const { userDataDir } = require("./core/paths.cjs");
const { loadPrefs } = require("./agentlas-config.cjs");
const { Ui } = require("./agentlas-ui.cjs");
const { parseOutputFlags, render, renderError, isRichUi } = require("./cli-output.cjs");
const commands = require("./commands/index.cjs");

const SUPPORTED_LANGS = new Set(["ko", "en"]);

/*
 * 우선순위: AGENTLAS_LANG > prefs.language > prefs.lang(v1 레거시) > OS 로케일 > en.
 *
 * v1은 언어를 `lang` 키에 저장하고 폴백이 "en"이었다(레거시 엔진 스냅샷 9e2beae의
 * agentlas.cjs:10866 — `lang = prefs.lang || "en"`). v2 재작성이 키를 `language`로
 * 바꾸면서 마이그레이션을 두지 않아, 예전에 언어를 고른 사용자의 설정이 통째로 무시되고
 * OS 로케일로 떨어졌다 — 영어를 저장해 둔 맥에서 Terminal.app의 ko_KR 때문에 UI가
 * 한국어로 뜨던 실사용 증상의 원인이다. 레거시 키를 계속 읽어 그 선택을 존중한다.
 *
 * 새로 저장하는 쪽(commands/setup)은 정본 `language`만 쓴다. `language`가 항상
 * 우선하므로 파일에 남은 옛 `lang` 값이 새 선택을 이길 수는 없다.
 */
function resolveLang(prefs) {
  if (SUPPORTED_LANGS.has(process.env.AGENTLAS_LANG)) return process.env.AGENTLAS_LANG;
  const saved = prefs && (prefs.language || prefs.lang);
  if (SUPPORTED_LANGS.has(saved)) return saved;
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
    /*
     * 출력 계약 — 명령은 문자열이 아니라 {데이터+스키마}를 준다(cli-output.cjs).
     * 형식(--json/--yaml/--quiet/--no-headers/--no-color) 해석은 여기 한 곳이라,
     * 명령마다 --json 유무가 갈리거나 에러 형식이 달라지는 일이 없다.
     */
    output: { ...require("./cli-output.cjs").DEFAULT_OPTIONS },
    emit(result) {
      const text = render(result, this.output);
      if (text) process.stdout.write(text + "\n");
    },
    fail(error) {
      process.stderr.write(renderError(error, this.output) + "\n");
    },
    get richUi() {
      return isRichUi(this.output);
    },
    db: () => {
      if (_db) return _db;
      _db = openDb();
      seedBuiltins(_db);
      // 크래시로 남은 Hub 설치 저널 스윕 — DB행과 물질화 파일의 원자성 회복 (v1 부팅 계약).
      try { require("./hub/install.cjs").recoverCloudInstallJournals(_db); } catch { /* best-effort */ }
      return _db;
    },
    tableExists,
    columnExists,
  };
  return ctx;
}

/** 편집거리 기반 근접 명령 제안 (오타 가드용). 최대 3개. */
function nearestCommands(token, names) {
  const t = String(token).toLowerCase();
  const distance = (a, b) => {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(Array(b.length).fill(0)));
    for (let j = 0; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        rows[i][j] = Math.min(
          rows[i - 1][j] + 1,
          rows[i][j - 1] + 1,
          rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return rows[a.length][b.length];
  };
  return [...new Set(names)]
    .map((name) => ({ name, d: name.startsWith(t) || t.startsWith(name) ? 0 : distance(t, name) }))
    .filter((x) => x.d <= Math.max(1, Math.floor(t.length / 3)))
    .sort((a, b) => a.d - b.d || a.name.length - b.name.length)
    .slice(0, 3)
    .map((x) => x.name);
}

function main() {
  const argv = process.argv.slice(2);
  const helpRequested = argv.some((arg) => arg === "--help" || arg === "-h");
  const helpCommand = argv.find((arg) => arg !== "--help" && arg !== "-h" && !arg.startsWith("-"));
  if (helpRequested && helpCommand) {
    const ctx = buildCtx();
    const command = commands.resolveCommandName(helpCommand);
    // ★명령이 자기 도움말을 갖고 있으면 그것을 보여준다.
    //   예전에는 무조건 표 한 줄을 긁어(`runForCommand`) "Usage: agentlas graph [options]"
    //   두 줄만 나왔다 — `graph help`에는 8줄짜리 제대로 된 안내가 있는데도 `--help`로는
    //   영원히 닿지 못했다(사용자가 가장 먼저 치는 것이 `--help`다).
    const code = commands.SELF_HELP_COMMANDS.has(command)
      ? commands.dispatch(ctx, [command, "help"])
      : require("./commands/help.cjs").runForCommand(ctx, command);
    // Self-owned help may be an async native passthrough (Research is the first
    // such command). Exiting on the unresolved Promise kills its child before
    // the help text reaches stdout.
    Promise.resolve(code).then(
      (n) => process.exit(typeof n === "number" ? n : 0),
      (error) => { ctx.fail(error); process.exit(1); },
    );
    return;
  }
  // 옵션 정규화: -h/--help/-V/--version 은 하위 명령으로 변환
  const normalized = argv.map((a) => {
    if (a === "--help" || a === "-h") return "help";
    if (a === "--version" || a === "-V") return "version";
    return a;
  });

  // 전역 출력 플래그는 명령에 닿기 전에 한 곳에서 뜯어낸다 —
  // 명령마다 --json 유무가 갈리던 것을 구조로 막는다.
  // --json + --yaml 은 모순된 요청이라 JSON/YAML 중 하나를 임의로 고르지 않고,
  // 진입점에서 결정적인 평문 INVALID_ARGUMENT 로 멈춘다.
  let parsedOutput;
  try {
    parsedOutput = parseOutputFlags(normalized);
  } catch (error) {
    process.stderr.write(renderError(error, { format: "table", noColor: true }) + "\n");
    process.exitCode = 1;
    return;
  }
  const { options: outputOptions, rest: commandArgv } = parsedOutput;
  const ctx = buildCtx();
  ctx.output = outputOptions;
  let code;
  try {
    code = commands.dispatch(ctx, commandArgv);
  } catch (e) {
    // 에러도 같은 형식 규율을 따른다: --json 이면 {"error":{code,message}}.
    ctx.fail(e);
    process.exit(1);
  }

  if (code === null) {
    // 무인자 → REPL
    const { startRepl } = require("./ui/repl.cjs");
    return startRepl(ctx).then(
      (replCode) => process.exit(replCode || 0),
      (e) => { ctx.fail(e); process.exit(1); },
    );
  }

  if (code === undefined) {
    // 알 수 없는 토큰은 프로젝트 작업으로 실행한다. 에이전트 이름 하나가
    // 전역 대화 소유권으로 바뀌는 암묵 경로는 없다.
    /*
     * 오타 가드: 인자가 "공백 없는 한 단어" 하나뿐이고 명령도 에이전트도 아니면
     * 그건 작업 지시가 아니라 명령 오타일 가능성이 압도적이다. 그대로 프롬프트로
     * 흘리면 모델 호출 비용이 나가고 에이전트가 셸까지 돌린다(실사용 `agentlas lst`
     * 에서 ls -la 실행 실증). 가장 가까운 명령을 제안하고 정직하게 멈춘다.
     * 진짜 한 단어 작업은 따옴표+run -p 로 그대로 실행된다.
     */
    if (commandArgv.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(commandArgv[0])) {
      const token = commandArgv[0];
      const names = Object.keys(commands.COMMANDS)
        .concat(Object.keys(commands.COMMAND_ALIASES || {}))
        .concat(commands.NOT_YET_PORTED || []);
      const near = nearestCommands(token, names);
      const ko = ctx.lang === "ko";
      ctx.err(ko
        ? `'${token}' 은(는) agentlas 명령이 아닙니다.${near.length ? ` 혹시: ${near.join(" · ")}` : ""}`
        : `'${token}' is not an agentlas command.${near.length ? ` Did you mean: ${near.join(" · ")}` : ""}`);
      ctx.err(ko
        ? `명령 목록: agentlas help  ·  한 단어를 그대로 실행하려면: agentlas run -p "${token}"`
        : `See: agentlas help  ·  to run it as a task: agentlas run -p "${token}"`);
      process.exit(1);
    }
    // 전역 출력 플래그는 이미 parseOutputFlags 가 소비했다. 원래 normalized argv 를
    // 다시 넘기면 `agentlas --json "do work"`가 모델에게 "--json do work"라고
    // 지시하는 꼴이 된다. 실제 명령/작업 토큰만 실행 경로로 보낸다.
    code = commands.COMMANDS.run().run(ctx, commandArgv);
  }

  Promise.resolve(code).then(
    (n) => process.exit(typeof n === "number" ? n : 0),
    (e) => { ctx.fail(e); process.exit(1); },
  );
}

if (require.main === module) main();

module.exports = { buildCtx, resolveLang };
