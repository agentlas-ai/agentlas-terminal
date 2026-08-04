// ⚠️ 생성된 파일입니다. 손으로 고치지 마세요.
// 정본: agentlas_desktop/shared/graph-registry/*.json
// 생성: (agentlas_desktop) node scripts/gen-graph-registry.cjs
//
// 터미널은 데스크탑과 같은 DB를 읽지만 스키마 판이 뒤따라온다. 모르는 값을 만나는 것은
// 고장이 아니라 정상이며, 그때 **그 항목만** 강등하고 나머지는 정상 처리한다.
"use strict";

const GRAPH_WIRE = "graph/1";
const GRAPH_ERROR_CODES = ["APPROVAL_REJECTED","APPROVAL_REQUIRED","APPROVAL_TIMED_OUT","ARCHITECT_NO_REQUEST","ARCHITECT_UNAVAILABLE","AUTOMATION_NOT_CONNECTED","BUDGET_EXHAUSTED","CREATE_INPUT_INVALID","EDGE_CONDITION_UNRESOLVED","EVAL_INCOMPLETE","EVAL_UNAVAILABLE","INTERVIEW_MODEL_UNAVAILABLE","INTERVIEW_SELF_CORRECTION_EXHAUSTED","INTERVIEW_STATE_INVALID","LOOP_BOUND_INVALID","LOOP_BOUND_UNDECLARED","LOOP_LIMIT_REACHED","LOOP_WITHOUT_EXIT","MUTATION_UNVERIFIED","NODE_FAILED","NODE_INPUT_MISSING","NODE_NEVER_REACHED","NODE_NO_RESULT","NODE_TIMEOUT","NODE_TYPE_UNSUPPORTED","NO_MATCHING_EDGE","PATCH_NO_GRAPH","REDUCER_MERGE_CONFLICT","REDUCER_WRITE_CONFLICT","RESUME_CONFLICT","SWAP_CAPABILITY_MISMATCH","SWAP_HUB_RELEASE_UNPINNED","SWAP_NODE_NOT_FOUND","SWAP_NOT_AGENT_NODE","SWAP_NO_MATCH","SWAP_UNKNOWN_PROVIDER","TOOL_NODE_UNATTACHED","TOOL_NODE_UNCONFIGURED"];
const GRAPH_JOURNAL_KINDS = ["blob_externalized","node_failed","node_intent","node_reserved","node_retry","node_routed","node_settled","resumed","run_completed","run_created","run_failed","run_validated","suspended"];
const GRAPH_NODE_KINDS = ["action","agent","condition","eval","output","tool","transform","trigger"];

/** 모르는 값은 원문을 보존한 채 항목 단위로 강등한다. 집합 폐기 금지. */
function readEnum(value, allowed) {
  const text = typeof value === "string" ? value : String(value == null ? "" : value);
  return allowed.includes(text) ? { known: text } : { unknown: text };
}

function degradedLabel(value, lang) {
  if (value && typeof value === "object" && "known" in value) return value.known;
  const raw = value && value.unknown ? value.unknown : "";
  return lang === "en" ? `unknown (raw: ${raw})` : `알 수 없음 (원문: ${raw})`;
}

module.exports = {
  GRAPH_WIRE, GRAPH_ERROR_CODES, GRAPH_JOURNAL_KINDS, GRAPH_NODE_KINDS,
  readEnum, degradedLabel,
};
