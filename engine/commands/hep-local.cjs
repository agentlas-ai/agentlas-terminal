"use strict";
/*
 * hep-local — 소스 스코프(local) 편성, 터미널 네이티브 (2026-08-05 배선).
 *
 * 이 이름은 두 번의 결함을 지나 여기 도착했다:
 *   7/28  별칭이 스코프를 버려 엉뚱한 명령으로 접힘 → 외부 CLI 1급 승격
 *   8/5   그 외부 CLI가 exit 3 스텁임이 드러남 → 삭제 → 자기 엔진에 재배선
 * 실행 주체는 이 터미널의 편성 루프(리더 LLM이 WorkOrder 작성·정확 릴리스 선택),
 * 메뉴 연합은 로컬 Agentlas-OS Core. 배선 상세는 commands/workforce.cjs 참조.
 */
const { dispatch } = require("./workforce.cjs");

function run(ctx, args) {
  return dispatch(ctx, "hep-local", args);
}

module.exports = { run };
