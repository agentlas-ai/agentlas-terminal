"use strict";
/*
 * connect — Telegram 연결·조종 (2026-08-06 독립화).
 *
 * 오너 원칙: 데스크탑에서 쉽게 되는 telegram 연결이 터미널에서도 돼야 한다.
 * 데스크탑 electron/telegram/connect.ts 의 실제 연결 코어는 순수 HTTPS
 * (api.telegram.org)이고 Electron 이 필요 없다 — 브라우저 자동 조종은 봇 자동
 * 생성 편의일 뿐. 그 코어를 engine/telegram/connect.cjs 로 이식했다. 여기서는
 * CLI 표면만 배선한다.
 *
 * 이전: connect 는 hep-connect 플러그인 패스스루라 라우터 원시 JSON 을 덤프했다.
 *
 * 하위 명령:
 *   connect                           상태 표
 *   connect telegram <agent|firm>     이 대상에 봇을 연결(토큰 stdin) + 방 페어링
 *   connect test <id>                 연결된 방에 확인 메시지
 *   connect remove <id>               연결 제거(토큰 파일도 삭제)
 */
const { renderTelegram } = require("./telegram.cjs");
const tg = require("../telegram/connect.cjs");
const { findAgent } = require("../agents/registry.cjs");
const readline = require("node:readline");

function usage(ko) {
  return ko
    ? "사용법: agentlas connect [ status | telegram <agent|firm> | test <id> | remove <id> ]"
    : "Usage: agentlas connect [ status | telegram <agent|firm> | test <id> | remove <id> ]";
}

function resolveTarget(db, token) {
  const agent = findAgent(db, token);
  if (agent) return { kind: "agent", id: agent.id, name: agent.name || agent.slug };
  try {
    const q = String(token).trim().toLowerCase();
    const firm = db.prepare("SELECT id, slug, name FROM firms WHERE lower(id)=? OR lower(slug)=? OR lower(name)=?").get(q, q, q)
      || db.prepare("SELECT id, slug, name FROM firms WHERE lower(slug) LIKE ? ORDER BY slug LIMIT 1").get(`%${q}%`);
    if (firm) return { kind: "firm", id: firm.id, name: firm.name || firm.slug };
  } catch { /* no firms table */ }
  return null;
}

/** 봇 토큰을 stdin 에서 읽는다(비밀은 argv 금지). 파이프면 첫 줄, TTY면 숨김 안내. */
async function readTokenFromStdin(ctx, ko) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = "";
      process.stdin.on("data", (d) => { buf += d; });
      process.stdin.on("end", () => resolve(buf.split(/\r?\n/)[0].trim()));
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  ctx.out(ko
    ? "@BotFather 에서 봇을 만들고 받은 토큰을 붙여넣으세요 (입력은 화면에 남습니다 — 끝나면 창을 지우세요):"
    : "Create a bot with @BotFather and paste the token (it echoes — clear your screen after):");
  return new Promise((resolve) => {
    rl.question("token> ", (answer) => { rl.close(); resolve(String(answer).trim()); });
  });
}

async function connectTelegram(ctx, targetToken) {
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  const target = resolveTarget(db, targetToken);
  if (!target) {
    ctx.err((ko ? "대상을 찾을 수 없습니다: " : "target not found: ") + targetToken);
    ctx.err(ctx.ui.dim(ko ? "에이전트·회사 목록: agentlas list" : "list agents and companies: agentlas list"));
    return 1;
  }
  const token = await readTokenFromStdin(ctx, ko);
  if (!token) { ctx.err(ko ? "토큰이 필요합니다." : "a bot token is required."); return 1; }

  let started;
  try {
    if (typeof ctx.ui.startSpinner === "function") ctx.ui.startSpinner(ko ? "봇 토큰 확인 중…" : "Verifying bot token…");
    started = await tg.startConnection(db, target.kind, target.id, token);
  } catch (e) {
    if (typeof ctx.ui.stopSpinner === "function") ctx.ui.stopSpinner();
    ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`);
    return 1;
  }
  if (typeof ctx.ui.stopSpinner === "function") ctx.ui.stopSpinner();
  const botAt = started.botUsername ? "@" + started.botUsername : "(bot)";
  ctx.out(`${ctx.ui.green("✓")} ${ko ? "봇 확인됨" : "bot verified"}: ${botAt} → ${target.name}`);
  ctx.out(ko
    ? `이제 텔레그램에서 ${botAt} 에게 아무 메시지나 보내세요 (예: /start). 방을 기다립니다…`
    : `Now message ${botAt} on Telegram (e.g. /start). Waiting for the chat…`);

  let paired;
  try {
    if (typeof ctx.ui.startSpinner === "function") ctx.ui.startSpinner(ko ? "방 연결 대기 중…" : "Waiting for the chat…");
    paired = await tg.pairByPolling(db, started.id, { timeoutMs: 120_000 });
  } catch (e) {
    if (typeof ctx.ui.stopSpinner === "function") ctx.ui.stopSpinner();
    ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`);
    return 1;
  }
  if (typeof ctx.ui.stopSpinner === "function") ctx.ui.stopSpinner();

  if (!paired) {
    ctx.out(ctx.ui.dim(ko
      ? `방을 못 받았습니다(2분 초과). ${botAt} 에게 메시지를 보낸 뒤 다시: agentlas connect test ${started.id}`
      : `No chat received (2 min). Message ${botAt}, then retry: agentlas connect test ${started.id}`));
    return 0;
  }
  ctx.out(`${ctx.ui.green("✓")} ${ko ? "방 연결됨" : "chat paired"}: ${paired.telegram_chat_title || paired.telegram_chat_id}`);
  try {
    await tg.sendTest(db, started.id, ko ? `Agentlas 연결 완료 — ${target.name}` : `Agentlas connected — ${target.name}`);
    ctx.out(ctx.ui.dim(ko ? "확인 메시지를 보냈습니다." : "Sent a confirmation message."));
  } catch { /* 페어링은 됐으니 테스트 실패는 치명적 아님 */ }
  return 0;
}

async function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const sub = String(args[0] || "").toLowerCase();

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") { ctx.out(usage(ko)); return 0; }
  if (sub === "status") return renderTelegram(ctx);
  if (sub === "telegram") {
    if (!args[1]) { ctx.err(usage(ko)); return 1; }
    return connectTelegram(ctx, args[1]);
  }
  if (sub === "test") {
    if (!args[1]) { ctx.err(ko ? "사용법: agentlas connect test <id>" : "Usage: agentlas connect test <id>"); return 1; }
    try {
      await tg.sendTest(ctx.db(), args[1], ko ? "Agentlas 테스트 메시지" : "Agentlas test message");
      ctx.out(`${ctx.ui.green("✓")} ${ko ? "메시지를 보냈습니다." : "message sent."}`);
      return 0;
    } catch (e) { ctx.err(`${ctx.ui.red("✖")} ${String((e && e.message) || e)}`); return 1; }
  }
  if (sub === "remove") {
    if (!args[1]) { ctx.err(ko ? "사용법: agentlas connect remove <id>" : "Usage: agentlas connect remove <id>"); return 1; }
    tg.removeBinding(ctx.db(), args[1]);
    ctx.out(`${ctx.ui.green("✓")} ${ko ? "연결을 제거했습니다." : "connection removed."}`);
    return 0;
  }
  ctx.err(usage(ko));
  return 1;
}

module.exports = { run };
