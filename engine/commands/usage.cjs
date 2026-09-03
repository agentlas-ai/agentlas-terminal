"use strict";
/* usage — 로컬 사용 현황 요약 (공유 DB 읽기 전용). 공급자 쿼터 대시보드는 데스크탑 소관. */
const { listAgents } = require("../agents/registry.cjs");
const {
  DEFAULT_OPTIONS,
  single,
  render,
  parseOutputFlags,
} = require("../cli-output.cjs");

const OUTPUT_FLAGS = new Set(["--json", "--yaml", "--quiet", "-q", "--no-headers", "--no-color"]);

function withOutputFlags(ctx, args) {
  if (!args.some((arg) => OUTPUT_FLAGS.has(arg))) return { ctx, args };
  const parsed = parseOutputFlags(args);
  return {
    ctx: { ...ctx, output: { ...(ctx.output || DEFAULT_OPTIONS), ...parsed.options } },
    args: parsed.rest,
  };
}

function outputOptions(ctx) {
  return { ...DEFAULT_OPTIONS, ...(ctx.output || {}) };
}

function usageSchema(en) {
  return Object.freeze({
    // A summary has no natural resource id. Keep quiet useful and deterministic
    // without leaking the human note into the machine payload.
    idField: "command",
    columns: [
      { header: en ? "metric" : "항목", field: "command" },
      { header: en ? "value" : "값", field: "activeRuntime" },
    ],
    serialize(item) {
      const { command, ...payload } = item || {};
      return payload;
    },
    renderHuman(result, options = {}) {
      const data = result.data || {};
      const lines = en
        ? [
          `Active runtime    ${data.activeRuntime || "(none)"}`,
          `Installed agents  ${data.installedAgents ?? "?"}`,
          `Active chats      ${data.activeChats ?? "?"}`,
          `Messages          24h ${data.messages24h ?? 0}  ·  7d ${data.messages7d ?? 0}`,
          `Automations       ${data.automations ?? 0}`,
          `Runs (7d)         ${data.runs7d ?? 0}${data.failedRuns ? `  (${data.failedRuns} failed)` : ""}`,
        ]
        : [
          `활성 런타임      ${data.activeRuntime || "(없음)"}`,
          `설치 에이전트    ${data.installedAgents ?? "?"}`,
          `활성 대화        ${data.activeChats ?? "?"}`,
          `메시지           24시간 ${data.messages24h ?? 0}  ·  7일 ${data.messages7d ?? 0}`,
          `자동화           ${data.automations ?? 0}`,
          `실행(7일)        ${data.runs7d ?? 0}${data.failedRuns ? `  (실패 ${data.failedRuns})` : ""}`,
        ];
      lines.push("");
      const note = String(data.note || "");
      lines.push(options.noColor ? note : `\u001b[2m${note}\u001b[0m`);
      return lines.join("\n");
    },
  });
}

function emit(ctx, result) {
  if (typeof ctx.emit === "function") {
    ctx.emit(result);
    return;
  }
  const text = render(result, outputOptions(ctx));
  if (text) ctx.out(text);
}

function run(ctx, args = []) {
  const normalized = withOutputFlags(ctx, args);
  ctx = normalized.ctx;
  args = normalized.args;
  if (args.length) {
    const error = new Error("usage: agentlas usage");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const ko = ctx.lang === "ko";
  const db = ctx.db();
  const day = new Date(Date.now() - 86400000).toISOString();
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const q = (sql, ...p) => {
    try { return db.prepare(sql).get(...p) || {}; } catch { return {}; }
  };
  const ar = q("SELECT kind FROM active_runtime WHERE id=1");
  const agents = { n: listAgents(db).length };
  const chats = q("SELECT COUNT(*) AS n FROM chats WHERE archived_at IS NULL");
  const msg24 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", day);
  const msg7 = q("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?", week);
  const auto = q("SELECT COUNT(*) AS n FROM automations WHERE enabled=1");
  const runs7 = q("SELECT COUNT(*) AS n, SUM(CASE WHEN status='error' OR error IS NOT NULL THEN 1 ELSE 0 END) AS err FROM run_history WHERE ran_at > ?", week);
  const data = {
    command: "usage",
    activeRuntime: ar.kind || null,
    installedAgents: Number.isFinite(Number(agents.n)) ? Number(agents.n) : null,
    activeChats: Number.isFinite(Number(chats.n)) ? Number(chats.n) : null,
    messages24h: Number.isFinite(Number(msg24.n)) ? Number(msg24.n) : 0,
    messages7d: Number.isFinite(Number(msg7.n)) ? Number(msg7.n) : 0,
    automations: Number.isFinite(Number(auto.n)) ? Number(auto.n) : 0,
    runs7d: Number.isFinite(Number(runs7.n)) ? Number(runs7.n) : 0,
    failedRuns: Number.isFinite(Number(runs7.err)) ? Number(runs7.err) : 0,
    note: ko
      ? "세션 토큰·비용은 대화에서 /cost로 확인합니다. 공급자 할당량 대시보드는 Desktop에 있습니다."
      : "Session tokens/cost: /cost in chat. Provider quota dashboards are in Desktop.",
  };
  emit(ctx, single(data, usageSchema(!ko)));
  return 0;
}

module.exports = { run };
