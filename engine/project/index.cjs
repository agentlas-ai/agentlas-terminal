"use strict";
/*
 * project/index — 프로젝트 상태 서브시스템 배럴.
 *
 * test/project-bootstrap-contract.cjs (릴리스 게이트)가 v1 monolith 대신 이 표면을
 * require 한다. 여기서 내보내는 이름/시그니처는 v1 계약 그대로다 — 바꾸면 게이트가
 * 깨진다.
 */
const paths = require("./paths.cjs");
const envFile = require("./env-file.cjs");
const credentials = require("./credentials.cjs");
const seed = require("./seed.cjs");
const state = require("./state.cjs");
const memoryContext = require("./memory-context.cjs");
const ontology = require("./ontology.cjs");
const careerGraph = require("./career-graph.cjs");

module.exports = {
  ...paths,
  ...envFile,
  ...credentials,
  ...seed,
  ...state,
  ...memoryContext,
  ...ontology,
  ...careerGraph,
};
