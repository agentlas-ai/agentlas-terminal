"use strict";
const { readVersion } = require("../agentlas-banner.cjs");

function run(ctx) {
  ctx.out(`agentlas ${readVersion()}`);
  return 0;
}

module.exports = { run };
