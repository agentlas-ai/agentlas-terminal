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
      description: "inspect files and reason; runtime tools cannot change the workspace",
    },
    write: {
      label: "workspace write",
      short: "edit workspace",
      description: "read and edit the current workspace inside the runtime sandbox",
    },
    full: {
      label: "unrestricted",
      short: "unrestricted",
      description: "bypass runtime approvals and sandboxing; use only in a trusted environment",
    },
  },
  ko: {
    read: {
      label: "읽기 전용",
      short: "조회만",
      description: "파일을 읽고 판단하지만 런타임 도구가 작업 공간을 변경할 수 없음",
    },
    write: {
      label: "작업 공간 쓰기",
      short: "작업 공간 편집",
      description: "런타임 샌드박스 안에서 현재 작업 공간을 읽고 편집",
    },
    full: {
      label: "무제한 권한",
      short: "무제한",
      description: "런타임 승인과 샌드박스를 우회함; 신뢰할 수 있는 환경에서만 사용",
    },
  },
};

function normalize(value, fallback = "read") {
  const level = String(value || "").trim().toLowerCase();
  if (LEVELS.includes(level)) return level;
  return LEVELS.includes(fallback) ? fallback : "read";
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

module.exports = { LEVELS, normalize, next, copy, createCycleController };
