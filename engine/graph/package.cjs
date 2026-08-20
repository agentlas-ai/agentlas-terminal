"use strict";

const { nodeDeclaresOutwardEffect: reachesOutside } = require("./node-effect.cjs");
/*
 * .agentgraph 패키징 — 그래프를 남에게 줄 수 있는 형태로 만든다.
 *
 * 핵심 계약 두 줄:
 *  1) 지울 수 없는 비밀이 하나라도 남으면 **내보내지 않는다**. 몰래 지우고 통과시키면
 *     사용자는 자기 키가 빠진 줄 알고 공유하게 된다.
 *  2) 모델 고정은 유통될 수 없다. 받는 사람의 기본 모델로 돌아야 하므로 등급 힌트로 바꾼다.
 *
 * 여기서 만드는 건 파일 하나(JSON)다. 허브 업로드는 별도 표면이며, 이 모듈은
 * "무엇을 지웠고 무엇을 채워야 하는지"까지 파일 안에 적어 둔다.
 */
const crypto = require("node:crypto");

const SCHEMA_VERSION = "agentgraph/1.0";

/** 값이 자격증명처럼 보이는가 — 형태 판정만 한다(의미 판정 아님). */
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\beyJ[A-Za-z0-9._-]{30,}/,
];

/** 키 이름이 비밀을 담기로 되어 있는가. 값이 비어 있어도 템플릿 대상이다. */
const SECRET_KEY_RE = /(token|secret|password|passwd|apikey|api_key|credential|private_key|access_key)/i;

/** 로컬 사용자 경로 — 남의 기계에서 의미가 없고, 계정명이 그대로 드러난다. */
const PERSONAL_PATH_RE = /(\/Users\/[^/\s"']+|\/home\/[^/\s"']+|C:\\Users\\[^\\\s"']+)/g;



function vaultKeyFor(nodeId, key) {
  return `${String(key).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function looksSecretValue(value) {
  return typeof value === "string" && SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

/**
 * 노드 설정을 훑어 비밀·모델핀·개인 경로를 처리한다.
 * 반환: { config, findings, vaultTemplate, blockers }
 */
function scrubNodeConfig(nodeId, config) {
  const out = {};
  const findings = [];
  const vaultTemplate = [];
  const blockers = [];
  for (const [key, value] of Object.entries(config || {})) {
    // 1) 비밀로 선언된 칸 — 값 유무와 무관하게 금고 변수로 바꾼다.
    if (SECRET_KEY_RE.test(key)) {
      const vaultKey = vaultKeyFor(nodeId, key);
      out[key] = `$\{vault.${vaultKey}}`;
      vaultTemplate.push({ key: vaultKey, kind: "secret", requiredBy: [nodeId], sourceField: key });
      findings.push({ rule: "secret-field", nodeId, field: key, action: `templated:${vaultKey}` });
      continue;
    }
    // 2) 비밀처럼 생긴 값이 엉뚱한 칸에 있으면 — 자동 치환하지 않고 막는다.
    //    이름 없는 칸의 비밀은 무엇을 채워야 하는지 우리가 알 수 없다.
    if (looksSecretValue(value)) {
      blockers.push({
        nodeId,
        field: key,
        reason: `"${key}" 값이 자격증명처럼 보입니다. 어떤 키인지 알 수 없어 자동으로 빈칸 처리할 수 없습니다.`,
        nextAction: `이 값을 금고 변수로 바꾼 뒤(예: $\{vault.MY_TOKEN}) 다시 내보내세요.`,
      });
      out[key] = value;
      continue;
    }
    // 3) 모델 고정 — 받는 사람 기계엔 그 모델이 없다. 등급 힌트로 바꾼다.
    if (key === "model" && typeof value === "string" && value) {
      out.tierHint = "standard";
      findings.push({ rule: "model-pin", nodeId, field: key, action: "replaced:runner-primary" });
      continue;
    }
    // 4) 개인 경로 — 계정명이 그대로 드러난다.
    if (typeof value === "string" && PERSONAL_PATH_RE.test(value)) {
      out[key] = value.replace(PERSONAL_PATH_RE, "<사용자 폴더>");
      findings.push({ rule: "personal-path", nodeId, field: key, action: "removed" });
      PERSONAL_PATH_RE.lastIndex = 0;
      continue;
    }
    out[key] = value;
  }
  return { config: out, findings, vaultTemplate, blockers };
}

function digestOf(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * 그래프 하나를 .agentgraph 패키지로 만든다.
 * 막을 사유가 있으면 { blocked: true, blockers } 를 돌려주고 패키지를 만들지 않는다.
 */
function buildPackage(input) {
  const { automation, graph } = input;
  const findings = [];
  const vaultTemplate = [];
  const blockers = [];
  const nodes = [];
  const dependencies = { agents: [], mcp: [], subGraphs: [] };

  for (const node of graph.nodes || []) {
    const scrubbed = scrubNodeConfig(node.id, node.config);
    findings.push(...scrubbed.findings);
    vaultTemplate.push(...scrubbed.vaultTemplate);
    blockers.push(...scrubbed.blockers);
    nodes.push({ ...node, config: scrubbed.config });

    // 에이전트 참조는 핀으로 남긴다 — 받는 사람이 무엇을 빌려야 하는지 알아야 한다.
    // 노드가 ref를 선언하지 않으면 자동화의 대상 에이전트를 상속한다(제품의 실제 동작).
    // 그 경우를 빼면 패키지가 "채울 것 없음"이라고 거짓말한다.
    // judgment-exempt: 이건 "바깥을 바꾸나"가 아니라 "이 단계가 에이전트를 굴리나"다.
    const isAgentish = node.type === "agent" || node.type === "action" || node.type === "output";
    const ref = typeof node.config?.ref === "string" && node.config.ref ? node.config.ref : null;
    const inheritedSlug = automation.target_id || null;
    const slug = ref || (isAgentish && node.type === "agent" ? inheritedSlug : null);
    if (isAgentish && slug) {
      const source = (ref ? node.config?.targetType : automation.target_type) === "hub" ? "hub" : "local";
      if (!dependencies.agents.some((dep) => dep.slug === slug)) {
        dependencies.agents.push({
          nodeId: node.id,
          slug,
          source,
          ...(ref ? {} : { inheritedFromAutomation: true }),
        });
      }
    }
    const server = node.config?.mcpServer;
    if (typeof server === "string" && server && !dependencies.mcp.some((m) => m.serverSlug === server)) {
      dependencies.mcp.push({ serverSlug: server, requiredBy: [node.id] });
    }
  }

  if (blockers.length > 0) {
    return { blocked: true, blockers, findings };
  }

  const mutationNodes = nodes
    .filter((n) => reachesOutside(n))
    .map((n) => ({ nodeId: n.id, label: n.label || n.id }));

  const scrubbedGraph = { version: graph.version ?? 1, nodes, edges: graph.edges || [] };
  if (graph.budget) scrubbedGraph.budget = graph.budget;

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    slug: String(automation.name || "graph").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name: automation.name,
    version: input.version || "1.0.0",
    exportedAt: new Date().toISOString(),
    trigger: {
      kind: automation.trigger_type && automation.trigger_type !== "schedule" ? "input" : "cron",
      schedule: automation.schedule ?? null,
    },
    dependencies,
    vaultTemplate,
    modelPolicy: { binding: "runner-primary" },
    // 받는 사람이 설치 전에 알아야 하는 것 — 무엇이 바깥으로 나가는가.
    permissionsSummary: {
      mutationNodes,
      leasedAgents: dependencies.agents.filter((d) => d.source === "hub").map((d) => d.slug),
    },
    scrubReport: { rulesVersion: "scrub/1.0", scrubbedAt: new Date().toISOString(), findings },
  };
  manifest.integrity = { graphDigest: digestOf(scrubbedGraph), manifestDigest: null };
  manifest.integrity.manifestDigest = digestOf({ ...manifest, integrity: { graphDigest: manifest.integrity.graphDigest, manifestDigest: null } });

  return { blocked: false, blockers: [], findings, package: { manifest, graph: scrubbedGraph } };
}

/**
 * 패키지를 받았을 때 실행 전에 채워야 하는 것들.
 * "설치했으니 이제 돌아간다"가 아니라 "무엇이 비어 있는가"를 먼저 말한다.
 */
function bindingChecklist(pkg) {
  const manifest = pkg?.manifest || {};
  const items = [];
  for (const entry of manifest.vaultTemplate || []) {
    items.push({
      kind: "vault-key",
      key: entry.key,
      requiredBy: entry.requiredBy || [],
      done: false,
    });
  }
  for (const dep of manifest.dependencies?.agents || []) {
    items.push({ kind: "agent", slug: dep.slug, source: dep.source, nodeId: dep.nodeId, done: false });
  }
  for (const dep of manifest.dependencies?.mcp || []) {
    items.push({ kind: "mcp-server", serverSlug: dep.serverSlug, done: false });
  }
  return items;
}

function verifyPackage(pkg) {
  const problems = [];
  if (!pkg || typeof pkg !== "object") return ["패키지 형식이 아닙니다."];
  const { manifest, graph } = pkg;
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`이 버전이 읽을 수 없는 패키지 형식입니다(${manifest?.schemaVersion ?? "형식 없음"}).`);
  }
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    problems.push("그래프에 단계가 없습니다.");
  }
  if (manifest?.integrity?.graphDigest && graph) {
    if (digestOf(graph) !== manifest.integrity.graphDigest) {
      problems.push("그래프 내용이 매니페스트 지문과 다릅니다(전송 중 변형되었을 수 있습니다).");
    }
  }
  return problems;
}

module.exports = {
  SCHEMA_VERSION,
  buildPackage,
  bindingChecklist,
  verifyPackage,
  scrubNodeConfig,
  digestOf,
};
