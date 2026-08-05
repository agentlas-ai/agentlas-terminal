// ⚠️ 생성된 파일입니다. 손으로 고치지 마세요.
// 정본: agentlas_desktop/shared/graph-registry/*.json
// 생성: (agentlas_desktop) node scripts/gen-graph-registry.cjs
//
// 터미널은 데스크탑과 같은 DB를 읽지만 스키마 판이 뒤따라온다. 모르는 값을 만나는 것은
// 고장이 아니라 정상이며, 그때 **그 항목만** 강등하고 나머지는 정상 처리한다.
"use strict";

const GRAPH_WIRE = "graph/1";
const GRAPH_ERROR_CODES = ["APPROVAL_REJECTED","APPROVAL_REQUIRED","APPROVAL_TIMED_OUT","ARCHITECT_NO_CHANGE","ARCHITECT_NO_REQUEST","ARCHITECT_OUTPUT_MALFORMED","ARCHITECT_OUTPUT_TOO_LARGE","ARCHITECT_OUTPUT_UNREADABLE","ARCHITECT_UNAVAILABLE","AUTOMATION_NOT_CONNECTED","BUDGET_EXHAUSTED","CODE_DEPENDENCY_MISSING","CODE_NODE_EMPTY","CODE_STEP_FAILED","CREATE_INPUT_INVALID","EDGE_CONDITION_UNRESOLVED","EVAL_INCOMPLETE","EVAL_STUCK","EVAL_UNAVAILABLE","INTERVIEW_MODEL_UNAVAILABLE","INTERVIEW_OUTPUT_UNREADABLE","INTERVIEW_REPEATED_QUESTIONS","INTERVIEW_SELF_CORRECTION_EXHAUSTED","INTERVIEW_STATE_INVALID","LOOP_BOUND_INVALID","LOOP_BOUND_UNDECLARED","LOOP_LIMIT_REACHED","LOOP_WITHOUT_EXIT","MUTATION_UNVERIFIED","NODE_FAILED","NODE_INPUT_MISSING","NODE_NEVER_REACHED","NODE_NO_RESULT","NODE_TIMEOUT","NODE_TYPE_UNSUPPORTED","NO_MATCHING_EDGE","OUTPUT_NODE_EMPTY","PATCH_CODE_EMPTY","PATCH_EDGE_CONFLICT","PATCH_EDGE_DANGLING","PATCH_EDGE_HANDLE_MISSING","PATCH_EDGE_MISSING","PATCH_EMPTY","PATCH_LOOP_BOUND_MISSING","PATCH_NODE_CONFLICT","PATCH_NODE_MISSING","PATCH_NO_GRAPH","PATCH_OP_UNKNOWN","REDUCER_MERGE_CONFLICT","REDUCER_WRITE_CONFLICT","RESUME_CONFLICT","RUN_REQUEST_DISABLED","RUN_REQUEST_INPUT_REQUIRED","RUN_REQUEST_NOT_FOUND","RUN_REQUEST_QUEUE_UNAVAILABLE","RUN_REQUEST_REF_AMBIGUOUS","RUN_REQUEST_REF_MISSING","SUBGRAPH_DEPTH_EXCEEDED","SUBGRAPH_FAILED","SUBGRAPH_NOT_FOUND","SUBGRAPH_NO_RESULT","SUBGRAPH_SELF_CALL","SWAP_CAPABILITY_MISMATCH","SWAP_HUB_RELEASE_UNPINNED","SWAP_NODE_NOT_FOUND","SWAP_NOT_AGENT_NODE","SWAP_NO_MATCH","SWAP_UNKNOWN_PROVIDER","TOOL_BROKER_CALL_UNREADABLE","TOOL_BROKER_MUTATION_IN_SIMULATION","TOOL_BROKER_PLAN_UNREADABLE","TOOL_BROKER_TOOL_NOT_DECLARED","TOOL_NODE_UNATTACHED","TOOL_NODE_UNCONFIGURED","TRANSFORM_MODE_UNKNOWN","TRANSFORM_NODE_UNCONFIGURED"];
const GRAPH_JOURNAL_KINDS = ["blob_externalized","node_failed","node_intent","node_reserved","node_retry","node_routed","node_settled","resumed","run_completed","run_created","run_failed","run_validated","suspended"];
const GRAPH_NODE_KINDS = ["action","agent","code","condition","eval","output","subgraph","tool","transform","trigger"];
const GRAPH_BLOCK_UI = {"trigger":{"section":"none","placeable":false,"placeReason":"그래프마다 하나뿐이고 처음 만들 때 함께 지어진다"},"agent":{"section":"inventory","placeable":true},"eval":{"section":"flow","placeable":true},"condition":{"section":"flow","placeable":true},"transform":{"section":"flow","placeable":true},"code":{"section":"flow","placeable":true},"tool":{"section":"inventory","placeable":true},"action":{"section":"actions","placeable":true},"output":{"section":"flow","placeable":true},"loop":{"section":"none","placeable":false,"placeReason":"노드가 아니라 되돌아가는 연결의 성질이다 — 엣지를 이어서 만든다"},"subgraph":{"section":"flow","placeable":true}};

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
  GRAPH_WIRE, GRAPH_ERROR_CODES, GRAPH_JOURNAL_KINDS, GRAPH_NODE_KINDS, GRAPH_BLOCK_UI,
  readEnum, degradedLabel,
};
