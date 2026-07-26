"use strict";
/*
 * upload — `agentlas upload <path> [--visibility marketplace]`.
 * 기본은 owner-private `cloud save`다. 공개 Hub 발행은 오직 명시적
 * `--visibility marketplace` 로만 일어난다 (조용한 공개 승격 금지).
 */
const { runUpload } = require("../cloud-assets/commands.cjs");

async function run(ctx, args) {
  try {
    return await runUpload(ctx, args);
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
}

module.exports = { run };
