"use strict";
/* mcp — 등록된 MCP 서버 목록 (공유 DB). 설치/동의 흐름은 v2 mcp 모듈 포팅 시 확장. */

function run(ctx) {
  const en = ctx.lang === "en";
  const db = ctx.db();
  if (!ctx.tableExists(db, "mcp_servers")) {
    ctx.out(en ? "No MCP servers registered." : "등록된 MCP 서버가 없습니다.");
    return 0;
  }
  const rows = db.prepare("SELECT id, name FROM mcp_servers ORDER BY name").all();
  if (!rows.length) {
    ctx.out(en ? "No MCP servers registered." : "등록된 MCP 서버가 없습니다.");
    return 0;
  }
  ctx.out(ctx.ui.bold(en ? "MCP servers" : "MCP 서버"));
  for (const r of rows) ctx.out(`  ${ctx.ui.accent(String(r.id).padEnd(28))} ${r.name || ""}`);
  return 0;
}

module.exports = { run };
