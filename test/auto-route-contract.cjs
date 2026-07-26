"use strict";
/*
 * 자동 라우팅 + 에이전트별 런타임 오버라이드 계약 테스트 (완전 오프라인 — fake 판정 러너 주입).
 *
 * 검증(오너 불변식):
 *  1. 최종 픽 = 호스트 LLM 판정 — 어휘 점수 1위가 아니라 판정 라벨이 이긴다.
 *  2. build 의도 게이트 — 명시적 build 구문만 메타빌더 직행; 파일명/경로로는 발화 금지.
 *  3. 판정 런타임 없음 → 기본 에이전트 정직 폴백 + note (조용한 폴백 금지).
 *  4. 모델이 판정을 못 냄(정크 응답) → 어휘 픽으로 떨어지지 않고 정직 폴백.
 *  5. 웹 전용(private) 에이전트는 후보/판정 로스터에 절대 없다.
 *  6. 잡담은 닫힌형 결정적 가드로 직답(모델 호출 없음).
 *  7. 오버라이드 사다리: 명시 > 에이전트별 오버라이드 > (resolve.cjs 사다리);
 *     실행 불가 오버라이드는 조용히 무시되지 않고 unavailableOverride로 노출된다.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-route-test-"));
process.env.AGENTLAS_USER_DATA_DIR = tmp;

const { bootstrapDbIfMissing } = require("../bin/agentlas.cjs");
bootstrapDbIfMissing();

const { openDb, seedBuiltins } = require("../engine/core/db.cjs");
const judgment = require("../engine/agentlas-judgment.cjs");
const router = require("../engine/agents/router.cjs");
const { listRoutableAgents } = require("../engine/agents/registry.cjs");
const overrides = require("../engine/runtimes/overrides.cjs");

const db = openDb();
seedBuiltins(db);

const now = new Date().toISOString();
function insertAgent({ id, slug, name, tagline, systemPrompt, visibility = "visible", role = null }) {
  db.prepare(
    "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,0,?,?)",
  ).run(id, slug, name, name, tagline, tagline, systemPrompt, now, "", role, visibility);
  return id;
}

const deckId = insertAgent({
  id: crypto.randomUUID(),
  slug: "deck-pitch-architect",
  name: "Pitch Deck Architect",
  tagline: "builds investor pitch deck presentations",
  systemPrompt: "You build pitch deck presentations for startups.",
});
const reviewerId = insertAgent({
  id: crypto.randomUUID(),
  slug: "code-reviewer-pro",
  name: "Code Reviewer",
  tagline: "reviews source code for defects",
  systemPrompt: "You review source code.",
});
insertAgent({
  id: crypto.randomUUID(),
  slug: "secret-pitch-web-agent",
  name: "Secret Pitch Web Agent",
  tagline: "web-only private pitch deck agent",
  systemPrompt: "web only",
  visibility: "private",
});
insertAgent({
  id: crypto.randomUUID(),
  slug: "agentlas-meta-agent",
  name: "Meta Agent Builder",
  tagline: "builds new agents and teams",
  systemPrompt: "You build agents.",
});

(async () => {
  // ── 5. private 에이전트는 후보 집합에 없다 ──
  const routableSlugs = listRoutableAgents(db).map((a) => a.slug);
  assert.ok(!routableSlugs.includes("secret-pitch-web-agent"), "private web-only agent excluded from routable set");
  assert.ok(routableSlugs.includes("deck-pitch-architect"), "normal agent routable");

  // ── 1. 판정 라벨이 어휘 1위를 이긴다 ──
  const lexicalPrompt = "investor pitch deck presentations 자료 검토";
  const ranked = router.rankRouteAgents(db, lexicalPrompt, "en");
  assert.equal(ranked[0].agent.slug, "deck-pitch-architect", "lexical top scorer is the deck agent");
  assert.ok(!ranked.some((r) => r.agent.slug === "secret-pitch-web-agent"), "private agent never ranked");

  let capturedSystem = "";
  judgment.clearJudgmentCache();
  judgment.setJudgmentRunner(async ({ system }) => {
    capturedSystem = system;
    return JSON.stringify({ labels: ["code-reviewer-pro"], reason: "the user actually asks for a code-style review" });
  });
  const c1 = await router.resolveAutoRoute(db, lexicalPrompt, { lang: "en" });
  assert.equal(c1.agent && c1.agent.slug, "code-reviewer-pro", "judge's pick wins over lexical score");
  assert.equal(c1.routeSource, "llm");
  assert.ok(c1.note && c1.note.includes("Code Reviewer"), "route note names the judged pick");
  assert.ok(capturedSystem.includes("deck-pitch-architect"), "lexical layer widened recall into the judge roster");
  assert.ok(!capturedSystem.includes("secret-pitch-web-agent"), "private agent never offered to the judge");

  // 판정이 private/미설치 라벨을 주장해도 후보 밖이면 채택되지 않는다(허용 라벨 필터).
  judgment.clearJudgmentCache();
  judgment.setJudgmentRunner(async () => JSON.stringify({ labels: ["secret-pitch-web-agent"], reason: "x" }));
  const cPriv = await router.resolveAutoRoute(db, "pitch deck 자료 하나 검토 부탁", { lang: "en" });
  assert.notEqual(cPriv.agent && cPriv.agent.slug, "secret-pitch-web-agent", "private agent unreachable even if the judge names it");
  assert.equal(cPriv.noModel, true, "out-of-roster verdict resolves as honest no-verdict fallback");

  // ── 2. build 의도 게이트 ──
  assert.equal(router.isAgentBuildIntent("에이전트 하나 만들어줘"), true);
  assert.equal(router.isAgentBuildIntent("build me an agent for sales"), true);
  assert.equal(router.isAgentBuildIntent("agent-notes.md 요약해줘"), false, "file reference is not build intent");
  assert.equal(router.isAgentBuildIntent("agent-notes.md 만들어줘"), false, "file name + verb is not build intent");

  judgment.clearJudgmentCache();
  judgment.setJudgmentRunner(async () => JSON.stringify({ labels: ["direct"], reason: "plain summary request" }));
  const cBuild = await router.resolveAutoRoute(db, "에이전트 하나 만들어줘", { lang: "ko" });
  // 시드된 빌트인 메타빌더가 우선순위 1이다 — 슬러그 우선순위 목록 안이면 계약 충족.
  assert.ok(cBuild.agent && router.META_BUILDER_SLUGS.includes(cBuild.agent.slug), "explicit build phrasing routes to the meta-builder");
  assert.equal(cBuild.routeSource, "deterministic");
  const cNotBuild = await router.resolveAutoRoute(db, "agent-notes.md 요약해줘", { lang: "ko" });
  assert.ok(!(cNotBuild.agent && router.META_BUILDER_SLUGS.includes(cNotBuild.agent.slug)), "file-name mention must not hit the meta-builder");
  assert.equal(cNotBuild.direct, true, "judge said direct for the summary request");
  assert.equal(cNotBuild.routeSource, "llm");

  // ── 6. 잡담 닫힌형 가드 — 모델 호출 없이 직답 ──
  let judgeCalls = 0;
  judgment.clearJudgmentCache();
  judgment.setJudgmentRunner(async () => { judgeCalls += 1; return JSON.stringify({ labels: ["direct"] }); });
  const cTrivial = await router.resolveAutoRoute(db, "hi", { lang: "en" });
  assert.equal(cTrivial.direct, true);
  assert.equal(cTrivial.routeSource, "deterministic");
  assert.equal(judgeCalls, 0, "trivial prompt never reaches the judge");

  // ── 3. 판정 런타임 없음 → 기본 에이전트 정직 폴백 + note ──
  judgment.setJudgmentRunner(null);
  const cNoRt = await router.resolveAutoRoute(db, "재무 보고서 초안 정리 부탁", { lang: "ko" });
  assert.equal(cNoRt.noModel, true);
  assert.equal(cNoRt.noModelReason, "no_runtime");
  assert.ok(cNoRt.agent, "falls back to the default/orchestrator agent, not silence");
  assert.notEqual(cNoRt.agent.slug, "deck-pitch-architect", "lexical layer never decides a specialist");
  assert.ok(cNoRt.note && /모델|model/.test(cNoRt.note), "printed note explains the missing judge runtime");
  assert.ok(cNoRt.note.includes("판정 없음") || cNoRt.note.includes("no judgment"), "note carries the machine-readable no-judgment label");

  // ── 4. 모델이 정크를 반환 → model_unavailable 정직 폴백 (어휘 픽 금지) ──
  judgment.clearJudgmentCache();
  judgment.setJudgmentRunner(async () => "totally not json output");
  const cJunk = await router.resolveAutoRoute(db, "pitch deck presentations 리뷰 한 번 더", { lang: "en" });
  assert.equal(cJunk.noModel, true);
  assert.equal(cJunk.noModelReason, "model_unavailable");
  assert.notEqual(cJunk.agent && cJunk.agent.slug, "deck-pitch-architect", "junk verdict must not fall back to the lexical top scorer");
  assert.ok(cJunk.note, "model_unavailable path prints a note too");
  judgment.setJudgmentRunner(null);

  // ── 7. 에이전트별 런타임 오버라이드 ──
  db.prepare(
    "INSERT INTO agent_runtime_overrides (scope, target_id, label, kind, backend, source, model, effort, long_context, updated_at) VALUES ('agent',?,?,?,?,?,?,?,?,?)",
  ).run(deckId, "test override", "codex", null, "cli", "o4-mini", "high", 0, now);
  db.prepare(
    "INSERT INTO agent_runtime_overrides (scope, target_id, label, kind, backend, source, model, effort, long_context, updated_at) VALUES ('agent',?,?,?,?,?,?,?,?,?)",
  ).run(reviewerId, "byok override", "byok", "anthropic", "byok", "claude-sonnet-4-6", null, 1, now);

  const ov = overrides.readAgentRuntimeOverride(db, deckId);
  assert.ok(ov, "override row read back");
  assert.equal(ov.selection.kind, "codex");
  assert.equal(ov.selection.model, "o4-mini");
  assert.equal(ov.selection.effort, "high");
  assert.equal(ov.selection.longContext, false);
  assert.equal(overrides.readAgentRuntimeOverride(db, "no-such-agent"), null);

  // 오버라이드 적용: 실행 파일이 있으면 kind/model/effort가 오버라이드에서 온다.
  const fakeWhich = (bin) => (bin === "codex" ? "/fake/bin/codex" : null);
  const r1 = overrides.resolveRuntimeForAgent({ db, prefs: {}, explicit: null, agentId: deckId, deps: { which: fakeWhich } });
  assert.equal(r1.kind, "codex");
  assert.equal(r1.bin, "/fake/bin/codex");
  assert.equal(r1.model, "o4-mini");
  assert.equal(r1.source, "agent-override");

  // 명시(--runtime)가 항상 이긴다 — 오버라이드를 읽기 전에 resolve.cjs로 위임된다.
  let resolveArgs = null;
  const fakeResolve = (args) => { resolveArgs = args; return { kind: "claude-code", bin: "/fake/claude", source: args.explicit ? "explicit" : "detected" }; };
  const r2 = overrides.resolveRuntimeForAgent({ db, prefs: {}, explicit: "claude-code", agentId: deckId, deps: { which: fakeWhich, resolve: fakeResolve } });
  assert.equal(resolveArgs.explicit, "claude-code");
  assert.equal(r2.source, "explicit");
  assert.equal(r2.unavailableOverride, undefined, "explicit path never reports the override");

  // 오버라이드가 있으나 실행 불가(bin 없음) → 사다리로 위임하되 unavailableOverride 노출.
  const r3 = overrides.resolveRuntimeForAgent({ db, prefs: {}, explicit: null, agentId: deckId, deps: { which: () => null, resolve: fakeResolve } });
  assert.equal(r3.kind, "claude-code");
  assert.ok(r3.unavailableOverride, "unusable override surfaces honestly");
  assert.equal(r3.unavailableOverride.selection.kind, "codex");
  assert.ok(overrides.unavailableOverrideNote(r3, "en").includes("codex"), "note names the assigned runtime");

  // byok 오버라이드: v2 실행 사다리에 없는 kind → unavailableOverride (조용한 둔갑 금지).
  const r4 = overrides.resolveRuntimeForAgent({ db, prefs: {}, explicit: null, agentId: reviewerId, deps: { which: () => "/fake/bin/whatever", resolve: fakeResolve } });
  assert.ok(r4.unavailableOverride, "byok override is not silently executed by a CLI runtime");
  assert.equal(r4.unavailableOverride.selection.kind, "byok");

  // 오버라이드 없는 에이전트 → 순수 위임.
  resolveArgs = null;
  const r5 = overrides.resolveRuntimeForAgent({ db, prefs: {}, explicit: null, agentId: "no-such-agent", deps: { resolve: fakeResolve } });
  assert.equal(r5.source, "detected");
  assert.equal(r5.unavailableOverride, undefined);
  assert.equal(resolveArgs.explicit, null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("auto-route-contract: OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
