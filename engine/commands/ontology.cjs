"use strict";
/*
 * ontology — 프로젝트 온톨로지 상태/소스 등록 (v1 cmdOntology 포팅).
 * status/list는 비변형, add/open은 초기화된 프로젝트에서만 동작한다.
 */
const { runOntologyCli } = require("../project/ontology.cjs");

function run(ctx, args) {
  try {
    const lines = runOntologyCli(args, {
      cwd: process.cwd(),
      projectPath: process.cwd(),
      lang: ctx.lang,
      notify: (line) => ctx.out(line),
    });
    for (const line of lines) ctx.out(line);
    return 0;
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
}

module.exports = { run };
