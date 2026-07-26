"use strict";
/*
 * film — oberon의 별칭.
 * v1 디스패처(§13061-13063)는 `case "oberon": case "film": return cmdOberon(rest.slice(1))`
 * 로 두 이름을 완전히 동일하게 처리했다 (인자 변형·프리픽스 없음). 그대로 복제한다.
 * v1 usage 표기도 동일 형태였다: "usage: agentlas film <scaffold|render|list|open> [args]".
 */
module.exports = require("./oberon.cjs");
