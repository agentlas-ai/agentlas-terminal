"use strict";

/*
 * One permission vocabulary for every Agentlas terminal surface.
 *
 * The host adapters still own their exact CLI flags, but they all normalize through
 * this module so a corrupt preference or an unknown value fails closed to `read`.
 */

const LEVELS = ["read", "write", "full"];

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

module.exports = { LEVELS, normalize, persistent, next, copy, createCycleController };
