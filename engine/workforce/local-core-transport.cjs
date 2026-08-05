"use strict";
/*
 * workforce/local-core-transport — 편성 루프(agentlas-workforce.cjs)를 로컬
 * Agentlas Core(연합 소유자)에 잇는 어댑터.
 *
 * 전선 계약 — 전부 2026-08-05 실측(모델 호출 0회 프로브)으로 확정:
 *   search_candidates  요청 {workOrder, sourceScope}
 *                      응답 agentlas.workforce-federation-result.v1 봉투
 *                      → 루프에는 봉투를 벗긴 candidateSet만 준다.
 *   validate_selection 요청 {workOrder, selection, candidateSet}
 *                      (federationResult를 실으면 invalid_federation_result —
 *                       Core는 자기 선택 세션에서 연합을 이미 안다)
 *                      응답 안의 selectionValidation이 정확히
 *                      agentlas.workforce-selection-validation.v1 — 루프 검증기와
 *                      동일 계약이라 그대로 돌려준다. 원본 응답은 여기 상태로
 *                      붙잡아 둔다(prepare가 요구).
 *   prepare_execution  요청 {workOrder, selection, candidateSet,
 *                       federatedSelection: <validate 원본 응답>,
 *                       validationReceipt: <동일>, projectDir}
 *                      응답 안의 executionPlan이 정확히
 *                      agentlas.workforce-execution-plan.v5 (roster에
 *                      directiveBundle·permissionPolicy 동봉) — 그대로 돌려준다.
 *
 * 원격(agentlas.cloud) 경로는 건드리지 않는다: 이 어댑터는 D.callHubTool로
 * 주입될 때만 산다. Core 거절 코드는 원문 그대로 전파된다(local-core.cjs 계약).
 */
const crypto = require("node:crypto");
const { createLocalCoreClient } = require("../hephaestus/local-core.cjs");

const SOURCE_SCOPES = new Set(["network", "local", "cloud", "hub"]);

/*
 * ── id 정규화 (실측 2026-08-05 라이브 런 실패의 수리) ──
 *
 * 리더 LLM은 사람이 읽는 id를 짓는다(work-order:korean-summary-…-20260805,
 * slotId "korean-doc-writer"). 원격 서버는 받아주지만 로컬 Core 경계는 finite id
 * 정책으로 거절한다 — 실측 issues: work_order_id_not_public_finite,
 * slot_id_not_public_finite. novel id 의 유효 형식은 <ns>:opaque-<64hex> 다.
 *
 * 그래서 Core 로 나가는 모든 workOrderId·slotId 를 결정론적 opaque 로 정규화하고
 * (sha256(원본) — 같은 원본은 항상 같은 opaque, 재검색·재개에도 안정), Core 에서
 * 들어오는 응답의 그 값들을 원본으로 역치환한다. 루프·리더 프롬프트·영수증은
 * 사람이 읽는 원본만 본다. 치환은 "문자열 값의 정확 일치"로만 한다 — 부분 문자열
 * 치환은 다이제스트·서술문을 오염시킨다.
 */
const sha256hex = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const OPAQUE_RE = /^[a-z][a-z-]*:(?:opaque-[0-9a-f]{64}|ordinal-\d+)$/;

function opaqueId(namespace, id) {
  return OPAQUE_RE.test(id) ? id : `${namespace}:opaque-${sha256hex(id)}`;
}

/** workOrder에서 forward(원본→opaque)/reverse(opaque→원본) 값 지도를 만든다. */
function buildIdMaps(workOrder) {
  const forward = new Map();
  const reverse = new Map();
  const add = (namespace, id) => {
    if (typeof id !== "string" || !id) return;
    const mapped = opaqueId(namespace, id);
    if (mapped === id) return;
    forward.set(id, mapped);
    reverse.set(mapped, id);
  };
  add("work-order", workOrder.workOrderId);
  for (const slot of workOrder.roleSlots || []) add("slot", slot.slotId);
  return { forward, reverse };
}

/*
 * 경계 거절 issues 의 path("edges[0].artifactKinds[0]")에서 실제 값을 찾는다.
 * 선제 정규화(workOrderId·slotId)가 못 덮는 finite 어휘가 있다 — 실측:
 * artifactKinds 는 finite 카탈로그다(artifact_concept_not_public_finite). 카탈로그를
 * 하드코딩하면 Core 업데이트마다 어긋나므로, 거절이 지목한 값만 opaque 화해
 * 1회 재시도한다. role/skill/community 는 open-world 라 여기 올 일이 없다.
 */
function valueAtPath(root, issuePath) {
  const segments = String(issuePath || "").match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) || [];
  let current = root;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = segment.startsWith("[") ? current[Number(segment.slice(1, -1))] : current[segment];
  }
  return current;
}

function boundaryIssues(error) {
  const issues = error?.detail?.boundary?.issues;
  return Array.isArray(issues) ? issues : null;
}

/** 깊은 순회로 문자열 값을 정확 일치 치환한 사본을 만든다. */
function mapDeep(value, map) {
  if (map.size === 0) return value;
  if (typeof value === "string") return map.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => mapDeep(item, map));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapDeep(item, map);
    return out;
  }
  return value;
}

function createLocalCoreHubTool({ sourceScope, projectDir, cwd, client } = {}) {
  if (!SOURCE_SCOPES.has(sourceScope)) {
    const error = new Error(`sourceScope must be network|local|cloud|hub, got: ${String(sourceScope)}`);
    error.code = "source_scope_invalid";
    throw error;
  }
  if (!projectDir || typeof projectDir !== "string") {
    const error = new Error("projectDir is required — local Core prepare_execution binds the preparation to a project");
    error.code = "project_dir_required";
    throw error;
  }
  const core = client || createLocalCoreClient({ cwd: cwd || projectDir });
  // 편성 계보 상태 — 전부 "Core 어휘"(opaque id) 원본이다:
  //   maps: 마지막 search 의 id 지도. 재검색(refinement)마다 재구성된다.
  //   coreCandidateSet: Core 가 준 원본 CandidateSet (validate/prepare 로 무수정 반송).
  //   lastValidationEnvelope: validate 원본 응답. prepare 의 federatedSelection 은
  //     이것이어야 한다 — 루프가 들고 있는 것은 벗겨낸 selectionValidation 뿐이다.
  let maps = { forward: new Map(), reverse: new Map() };
  let coreCandidateSet = null;
  let lastValidationEnvelope = null;
  // validate 가 실제로 수락한 Core 어휘 selection. prepare 는 정확히 이 본을
  // 반송해야 한다 — 반응형 reasonCode 수리가 있었으면 루프의 selection 을 다시
  // 변환한 것과 다르다(exact binding).
  let lastCoreSelection = null;

  const invalid = (message) => {
    const error = new Error(message);
    error.code = "local_core_invalid_response";
    return error;
  };

  async function callHubTool(name, args) {
    if (name === "workforce.search_candidates") {
      maps = buildIdMaps(args.workOrder);
      coreCandidateSet = null;
      lastValidationEnvelope = null;
      // fullDossier: 터미널 루프의 후보 검증기는 legacy full-echo 계약이다
      // (qualificationEvidence·packageHash·contentDigest 필수 — 실측: 기본
      // reference-first 메뉴는 candidate_set_invalid 로 거절된다).
      let envelope;
      try {
        envelope = await core.call(name, { workOrder: mapDeep(args.workOrder, maps.forward), sourceScope, fullDossier: true });
      } catch (error) {
        // 반응형 정규화(1회): 경계가 지목한 finite 값만 opaque 로 바꿔 재시도.
        const issues = error.code === "work_order_hub_boundary_rejected" ? boundaryIssues(error) : null;
        if (!issues || !issues.length) throw error;
        const sentWorkOrder = mapDeep(args.workOrder, maps.forward);
        let repaired = 0;
        for (const issue of issues) {
          const value = valueAtPath(sentWorkOrder, issue.path);
          if (typeof value !== "string" || !value) continue;
          const namespace = value.includes(":") ? value.slice(0, value.indexOf(":")) : "id";
          const original = maps.reverse.get(value) || value;
          const mapped = opaqueId(namespace, value);
          if (mapped === value) continue;
          maps.forward.set(original, mapped);
          maps.reverse.set(mapped, original);
          repaired += 1;
        }
        if (!repaired) throw error;
        envelope = await core.call(name, { workOrder: mapDeep(args.workOrder, maps.forward), sourceScope, fullDossier: true });
      }
      const candidateSet = envelope && envelope.candidateSet;
      if (!candidateSet || typeof candidateSet !== "object") throw invalid("local Core federation returned no candidateSet");
      coreCandidateSet = candidateSet;
      return mapDeep(candidateSet, maps.reverse);
    }
    if (name === "workforce.validate_selection") {
      if (!coreCandidateSet) {
        const error = new Error("validate_selection called before search_candidates — the federated lineage is missing");
        error.code = "local_core_lineage_missing";
        throw error;
      }
      // 루프의 candidateSet(역치환본)과 보관본의 계보 일치를 다이제스트로 확인한다.
      if (args.candidateSet?.candidateSetDigest !== coreCandidateSet.candidateSetDigest) {
        throw invalid("candidateSet lineage mismatch between the loop and the local Core session");
      }
      let envelope;
      let coreSelection = mapDeep(args.selection, maps.forward);
      try {
        envelope = await core.call(name, {
          workOrder: mapDeep(args.workOrder, maps.forward),
          selection: coreSelection,
          candidateSet: coreCandidateSet,
        });
      } catch (error) {
        /*
         * 반응형 정규화(1회): 리더의 자유 reasonCodes 는 finite 정책에 걸린다
         * (실측: selection_reason_code_not_public_finite). 선택 경계의 finite id
         * 정책은 "public finite reason codes" — opaque 형식 허용 문구가 없어
         * 카탈로그 값으로만 대체한다. reason:host-semantic-judgment 는 관측된
         * 카탈로그 값이며 사실 그 자체다(호스트 LLM 의 의미 판단). 사람이 읽을
         * 원문 사유는 루프의 영수증(selection.assignments 원본)에 이미 남아 있다.
         */
        const issues = error.code === "selection_hub_boundary_rejected" ? boundaryIssues(error) : null;
        const reasonIssues = issues ? issues.filter((issue) => issue.code === "selection_reason_code_not_public_finite") : [];
        if (!reasonIssues.length) throw error;
        const repairedSelection = mapDeep(args.selection, maps.forward);
        for (const assignment of repairedSelection.assignments || []) {
          assignment.reasonCodes = ["reason:host-semantic-judgment"];
        }
        envelope = await core.call(name, {
          workOrder: mapDeep(args.workOrder, maps.forward),
          selection: repairedSelection,
          candidateSet: coreCandidateSet,
        });
        coreSelection = repairedSelection;
      }
      if (!envelope || typeof envelope.selectionValidation !== "object") throw invalid("local Core validation returned no selectionValidation receipt");
      lastValidationEnvelope = envelope;
      lastCoreSelection = coreSelection;
      return mapDeep(envelope.selectionValidation, maps.reverse);
    }
    if (name === "workforce.prepare_execution") {
      if (!lastValidationEnvelope) {
        const error = new Error("prepare_execution called before validate_selection — the federated lineage is missing");
        error.code = "local_core_lineage_missing";
        throw error;
      }
      const envelope = await core.call(name, {
        workOrder: mapDeep(args.workOrder, maps.forward),
        // validate 가 수락한 정확한 본 — 반응형 reasonCode 수리를 반영한다.
        selection: lastCoreSelection || mapDeep(args.selection, maps.forward),
        candidateSet: coreCandidateSet,
        federatedSelection: lastValidationEnvelope,
        validationReceipt: lastValidationEnvelope,
        projectDir,
      });
      if (!envelope || typeof envelope.executionPlan !== "object") throw invalid("local Core preparation returned no executionPlan");
      const plan = mapDeep(envelope.executionPlan, maps.reverse);
      /*
       * 어휘 왕복의 마지막 두 조각 (실측: 루프의 execution_context_mismatch):
       *  1) Core 는 워크오더의 미선언 slot 필드를 스키마 기본값 [] 로 정규화해
       *     돌려준다. 루프의 expectedContext 는 원본 워크오더에서 유도하므로
       *     undefined ↔ [] 가 불일치가 된다. 원본에 없던 필드가 빈 값으로 돌아온
       *     경우만 제거한다 — 값이 실제로 다르면 그대로 두어 루프가 잡게 한다.
       *  2) 반응형 reasonCode 수리가 있었으면 Core 어휘의 assignments 에는
       *     카탈로그 값이 들어 있다. 사람이 읽는 원문 사유(루프의 selection)를
       *     자리(slotId+agentReleaseId) 기준으로 복원한다.
       */
      const context = plan.executionContext;
      if (context && Array.isArray(context.slots)) {
        const originalSlots = new Map((args.workOrder.roleSlots || []).map((slot) => [slot.slotId, slot]));
        for (const slot of context.slots) {
          const original = originalSlots.get(slot.slotId);
          if (!original) continue;
          for (const [key, value] of Object.entries(slot)) {
            const emptyDefault = Array.isArray(value) && value.length === 0;
            if (emptyDefault && original[key] === undefined && !["allowedEntityKinds"].includes(key)) {
              delete slot[key];
            }
          }
        }
      }
      if (context && Array.isArray(context.assignments)) {
        const originalAssignments = new Map((args.selection.assignments || []).map(
          (assignment) => [`${assignment.slotId} ${assignment.agentReleaseId}`, assignment],
        ));
        for (const assignment of context.assignments) {
          const original = originalAssignments.get(`${assignment.slotId} ${assignment.agentReleaseId}`);
          if (original) assignment.reasonCodes = original.reasonCodes;
        }
      }
      /*
       * 다이제스트 재서명: Core 의 executionContextDigest 는 Core 어휘(opaque id·
       * 카탈로그 reason·[] 기본값) 위에서 계산됐다. 위의 어휘 왕복으로 루프 어휘
       * 컨텍스트가 됐으므로 루프와 같은 함수로 재계산한다 — 게이트웨이에서의
       * 재서명이지 위조가 아니다: 원본 무결성은 Core 세션과 영수증이 지킨다.
       */
      if (context) {
        const { _test } = require("../agentlas-workforce.cjs");
        plan.executionContextDigest = _test.executionContextDigest(context);
        // roster 행도 같은 이유로 재서명한다 — 역치환이 행 내용(slot 어휘)을
        // 루프 어휘로 바꿨으므로 bundleDigest/executionGraphDigest 를 루프와 같은
        // 함수로 재계산한다.
        for (const row of plan.executionRoster || []) {
          if (row && row.executionGraph && typeof row.executionGraphDigest === "string") {
            row.executionGraphDigest = _test.executionGraphDigest(_test.validateExecutionGraph(row.executionGraph));
          }
          if (row && typeof row.bundleDigest === "string") {
            row.bundleDigest = _test.workforceRuntimeBundleDigest(row);
          }
        }
      }
      return plan;
    }
    const error = new Error(`unsupported local-core workforce tool: ${name}`);
    error.code = "local_core_unsupported_tool";
    throw error;
  }

  return { callHubTool, close: () => core.close() };
}

module.exports = { createLocalCoreHubTool, SOURCE_SCOPES };
