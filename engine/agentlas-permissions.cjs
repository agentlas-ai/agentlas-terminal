"use strict";

/*
 * One permission vocabulary for every Agentlas terminal surface.
 *
 * The host adapters still own their exact CLI flags, but they all normalize through
 * this module so a corrupt preference or an unknown value fails closed to `read`.
 */

const LEVELS = ["read", "write", "full"];

function isLevel(value) {
  return LEVELS.includes(String(value || "").trim().toLowerCase());
}

const COPY = {
  en: {
    read: {
      label: "read only",
      short: "inspect only",
      description: "inspect only; workspace writes blocked",
    },
    write: {
      label: "workspace write",
      short: "edit workspace",
      description: "workspace + runtime temp writes; external MCP off",
    },
    full: {
      label: "unrestricted",
      short: "unrestricted",
      description: "bypass approvals and sandbox; trusted use only",
    },
  },
  ko: {
    read: {
      label: "읽기 전용",
      short: "조회만",
      description: "조회만; 작업 공간 쓰기 차단",
    },
    write: {
      label: "작업 공간 쓰기",
      short: "작업 공간 편집",
      description: "작업 공간·런타임 임시 경로 쓰기; 외부 MCP 꺼짐",
    },
    full: {
      label: "무제한 권한",
      short: "무제한",
      description: "승인과 샌드박스를 우회; 신뢰 환경 전용",
    },
  },
};

function normalize(value, fallback = "read") {
  const level = String(value || "").trim().toLowerCase();
  if (LEVELS.includes(level)) return level;
  return LEVELS.includes(fallback) ? fallback : "read";
}

function persistent(value, fallback = "write") {
  const level = normalize(value, fallback);
  if (level !== "full") return level;
  const safeFallback = normalize(fallback, "write");
  return safeFallback === "full" ? "write" : safeFallback;
}

function next(value) {
  const current = normalize(value);
  return LEVELS[(LEVELS.indexOf(current) + 1) % LEVELS.length];
}

function copy(value, lang = "en") {
  const level = normalize(value);
  const table = COPY[lang] || COPY.en;
  return { level, ...table[level] };
}

function createCycleController(options = {}) {
  const now = options.now || Date.now;
  const armMs = Number(options.armMs) > 0 ? Number(options.armMs) : 5_000;
  let fullArmedUntil = 0;
  return {
    step(value) {
      const level = normalize(value);
      const at = now();
      if (level === "write" && at >= fullArmedUntil) {
        fullArmedUntil = at + armMs;
        return { level, armed: true, enteredFull: false };
      }
      if (level === "write") {
        fullArmedUntil = 0;
        return { level: "full", armed: false, enteredFull: true };
      }
      fullArmedUntil = 0;
      return { level: next(level), armed: false, enteredFull: false };
    },
    cancel() { fullArmedUntil = 0; },
    armed() { return now() < fullArmedUntil; },
  };
}

/*
 * ── 통합 능력 승인(데스크탑 capability_grants)과의 합류 ───────────────────────
 *
 * 이 모듈은 오래도록 read/write/full 세 낱말만 알았다. 그런데 오너 결정(2026-08-20)
 * 이후 "무엇을 해도 되는가"의 정본은 등급이 아니라 **행동 규칙**이다: 데스크탑에서
 * "항상 허용"한 행동은 read 등급에서도 통과해야 하고, 영구 거부된 행동은 full 등급으로도
 * 뚫리지 않아야 한다. 등급은 규칙이 없을 때의 기본값으로 남는다.
 *
 * 우선순위는 데스크탑 중재자(electron/ipc.ts setRuntimeToolPermissionArbiter)와 **같은
 * 문장**이다. 갈리면 같은 행동에 두 제품이 다른 답을 준다:
 *   1) 저장된 규칙 deny  → deny (등급 무관)
 *   2) 저장된 규칙 allow → allow (등급 무관)
 *   3) permission=full   → allow
 *   4) 비변이(mutating=false) → allow
 *   5) permission=write  → allow
 *   6) 그 외(read + 변이) → null = 경계를 넘는 요청. 호출부가 묻거나 거부한다.
 */

/** 능력 규칙 모듈은 공유 DB 를 열므로 지연 로드한다(권한 어휘만 쓰는 호출부에 부담 금지). */
function grantsModule() {
  return require("./core/capability-grants.cjs");
}

/**
 * 한 번의 도구/서버 실행에 대한 판정.
 *
 * @param {object|null} db 공유 DB 핸들. 없으면 규칙을 못 읽고 등급 기본값만 쓴다.
 * @param {object} ask { capability?, kind?, tool, detail?, agentId?, chatId?, mutating?, permission? }
 * @returns {{decision:"allow"|"deny"|null, source:string, ruled:"allow"|"deny"|null,
 *            grantsAvailable:boolean, reason:string|null, capability:string}}
 */
function decideCapability(db, ask) {
  const grants = grantsModule();
  const capability = ask && ask.capability
    ? String(ask.capability)
    : grants.capabilityClassFor(String((ask && ask.kind) || ""), String((ask && ask.tool) || ""));
  const query = {
    capability,
    tool: ask && ask.tool ? String(ask.tool) : undefined,
    detail: ask && ask.detail ? String(ask.detail) : undefined,
    agentId: ask && ask.agentId ? String(ask.agentId) : undefined,
    chatId: ask && ask.chatId ? String(ask.chatId) : undefined,
  };
  const ruling = db
    ? grants.readCapabilityDecision(db, query)
    : { decision: null, available: false, reason: "no shared database handle was provided to the capability gate" };

  if (ruling.decision === "deny") {
    return { decision: "deny", source: "capability-grants", ruled: "deny", grantsAvailable: ruling.available, reason: ruling.reason, capability };
  }
  if (ruling.decision === "allow") {
    return { decision: "allow", source: "capability-grants", ruled: "allow", grantsAvailable: ruling.available, reason: ruling.reason, capability };
  }

  const level = normalize(ask && ask.permission);
  const mutating = !!(ask && ask.mutating);
  if (level === "full") {
    return { decision: "allow", source: "permission-level", ruled: null, grantsAvailable: ruling.available, reason: ruling.reason, capability };
  }
  if (!mutating) {
    return { decision: "allow", source: "non-mutating", ruled: null, grantsAvailable: ruling.available, reason: ruling.reason, capability };
  }
  if (level === "write") {
    return { decision: "allow", source: "permission-level", ruled: null, grantsAvailable: ruling.available, reason: ruling.reason, capability };
  }
  return { decision: null, source: "boundary", ruled: null, grantsAvailable: ruling.available, reason: ruling.reason, capability };
}

/**
 * 터미널에서 사용자가 "항상 허용"을 골랐을 때 **같은 표**에 남긴다 — 데스크탑도 이
 * 규칙을 읽으므로 다음부터 양쪽 모두 묻지 않는다. 규칙 키는 데스크탑 persistAlwaysGrant
 * 와 동일: capability `tool:<name>` + 일반화된 인자 패턴 + scope global.
 */
function rememberAlwaysAllow(db, ask, options = {}) {
  const grants = grantsModule();
  return grants.recordCapabilityGrant(db, {
    capability: `tool:${String((ask && ask.tool) || "")}`,
    pattern: grants.generalizeDetailPattern(ask && ask.detail),
    decision: options.decision === "deny" ? "deny" : "allow",
    scope: options.scope || "global",
    source: options.source || "terminal-chip",
  });
}

module.exports = {
  LEVELS,
  isLevel,
  normalize,
  persistent,
  next,
  copy,
  createCycleController,
  decideCapability,
  rememberAlwaysAllow,
};
