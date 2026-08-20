"use strict";
/*
 * "이 노드가 바깥을 바꾸나" — 터미널 쪽 **거울 하나**.
 *
 * 정본은 데스크탑의 `shared/graph-node-protocol.ts` 다. 터미널이 그걸 직접 부르지
 * 못하는 이유는 하나뿐이다: 그 판정은 `.filter()` 안에서 **동기로** 필요한데, 엔진을
 * 얻는 길(`acquireCore`)은 비동기다(새 설치는 아직 내려받지 않았을 수 있다).
 * 동기 로더로 우회하면 새로 설치한 사람에게만 조용히 다른 답이 나온다 —
 * `verify-engine-reachable` 게이트가 정확히 그걸 막는다.
 *
 * 그래서 규칙을 여기 한 번 편다. 대신 **같은 답을 내는지 게이트가 증명한다**
 * (`scripts/verify-node-effect-parity.cjs`). 거울이 허용되는 조건은 그 증명뿐이다.
 *
 * 왜 이 판정이 중요한가 (실측 2026-08-20):
 *   `config.effect === "mutation"` 만 보면 emitter 가 만든 출력 노드(effect 칸이
 *   아예 없음)가 "바깥에 안 나감"으로 읽힌다. 그 노드의 기본값은 나가는 것이다.
 *   데스크탑에서 같은 구멍이 다섯 곳에 있었다 — 도구 모드·패키지 경고·권한 유도·
 *   발행 심사·패치 승인. 터미널도 세 곳에 있었다.
 */

/** 안 적힌 효과의 기본값. 출력 블록은 "바깥으로 내보내기"다(레지스트리 선언). */
function defaultNodeEffect(nodeType) {
  return nodeType === "output" ? "mutation" : "read";
}

/** 이 노드의 효과. 선언된 것이 있으면 그것을 믿고, 없으면 종류의 기본값이다. */
function resolveNodeEffect(node) {
  const declared = typeof node?.config?.effect === "string" ? node.config.effect.trim() : "";
  if (declared === "mutation" || declared === "read" || declared === "pure") return declared;
  return defaultNodeEffect(String(node?.type ?? ""));
}

/**
 * ① 바깥으로 나간다고 **선언돼 있는가** — 사람에게 "이 단계는 발행한다"고 말할 근거.
 *    패키지 경고·발행 고지가 쓴다.
 */
function nodeDeclaresOutwardEffect(node) {
  return resolveNodeEffect(node) === "mutation";
}

/**
 * ② 바깥에 뭔가 **했을 수 있는가** — 재개가 묻는 다른 질문. ①의 상위집합이다.
 *    모델을 부르는 단계는 선언이 read 여도 도구를 부를 수 있다.
 *    (정본이 이 둘을 갈라 놓은 이유는 shared/graph-node-protocol.ts 주석에 있다.)
 */
function nodeCouldHaveActedOutside(node) {
  if (nodeDeclaresOutwardEffect(node)) return true;
  return node?.type === "agent" || node?.type === "action" || node?.type === "output";
}

module.exports = {
  defaultNodeEffect,
  resolveNodeEffect,
  nodeDeclaresOutwardEffect,
  nodeCouldHaveActedOutside,
};
