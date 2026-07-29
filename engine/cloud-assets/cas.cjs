"use strict";
/*
 * cloud-assets/cas — Agent Cloud 조건부(Compare-And-Swap) 등록/삭제 클라이언트.
 *
 * 멀티 호스트 계약 (약화 금지 — v1 cloud-cas-client가 지키던 속성):
 *  - 새 자산 생성은 If-None-Match: "*" — 다른 PC가 먼저 만든 자산을 절대 덮지 않는다.
 *  - 갱신/삭제는 관측한 베이스 리비전의 If-Match + x-agentlas-cloud-id 를 함께 보낸다.
 *    관측한 베이스가 없으면 갱신을 시도조차 하지 않는다 (조용한 덮어쓰기 금지).
 *  - 412(cloud_agent_revision_conflict)는 "다른 PC가 먼저 변경"의 정직한 신호:
 *    서버 리비전을 자동 채택하지 않고 restore→병합을 안내한다.
 *  - 503 + cloud_mutations_maintenance(WRITE_MODE blocked)는 fail-closed 거절.
 *    서버가 그 코드를 줄 때만 maintenance 문구를 쓴다 — 일반 503을 "점검"으로
 *    추측 번역하지 않고 서버 error 본문을 그대로 전달한다.
 *  - 2xx라도 영수증(schema/operation/scope/hash/revision/ETag/no-store)이 전부
 *    맞아야 성공이다. 어긋나면 합성 성공으로 승격하지 않는다.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { fetchHub, parseHubJson, cloudSessionCookie, webBaseUrl } = require("../cloud/hub-client.cjs");
const { cloudRevisionEtag, normalizeCloudAssetDescriptor } = require("../hub/install.cjs");
const state = require("./state.cjs");

function cloudScopeForVisibility(visibility) {
  return visibility === "marketplace" ? "hub-public" : "owner-private";
}

/**
 * 같은 논리 변이의 재시도는 같은 키를 공유하도록 결정론적으로 만든다.
 * (scope/slug/패키지 정체성/베이스 리비전이 같으면 같은 요청이다 —
 *  네트워크 재시도가 서버에서 이중 커밋되는 것을 막는 멱등성 힌트.)
 */
function cloudIdempotencyKey(kind, scope, slug, packageHash, packageHashVersion, baseRevision) {
  return crypto.createHash("sha256")
    .update(`agentlas-cloud-${kind}:${scope}:${slug}:${packageHash}:${packageHashVersion}:${baseRevision || "*"}`)
    .digest("hex");
}

function cloudCasResponseError(response, label) {
  let body = null;
  try { body = JSON.parse(response.text || "null"); } catch { /* generic below */ }
  const code = body && typeof body.code === "string" ? body.code : "cloud_request_failed";
  let message = `${label} failed with HTTP ${response.status}`;
  if (response.status === 412 && code === "cloud_agent_revision_conflict") {
    const current = body && body.current ? body.current : body && body.conflict && body.conflict.current;
    // 서버가 알려준 사실만 사람 말로 전달한다. 내부 개념(precondition, base, 연결)은
    // 사용자에게 아무 의미가 없다 — 기준은 "이 이름이 내 계정 것인가" 하나다.
    message = current
      ? `업로드하지 않았습니다. "${current.slug || "이 이름"}"의 서버 버전이 지금 보낸 것과 맞지 않습니다` +
        `${current.updatedAt ? ` (서버 쪽 마지막 저장: ${current.updatedAt})` : ""}.\n` +
        `  내 계정 자산이면: agentlas cloud restore ${current.slug || "<slug>"} 로 받아서 확인한 뒤 다시 저장하세요.\n` +
        `  (서버 cloudId ${current.cloudId || "?"} · revision ${current.revision || "?"})`
      : "업로드하지 않았습니다. 이 이름의 자산이 삭제됐거나 다른 계정 소유입니다. `agentlas cloud list`로 내 자산을 확인하세요.";
  } else if (response.status === 428 && code === "client_upgrade_required") {
    message = "No base revision is available to safely update the existing Cloud asset. The server revision will not be copied automatically. Check `agentlas cloud list`, restore with `agentlas cloud restore <slug>`, then save again.";
  } else if (response.status === 503 && code === "cloud_mutations_maintenance") {
    const retryAfter = response.headers && typeof response.headers.get === "function" ? response.headers.get("retry-after") : null;
    message = `Agent Cloud save/delete is temporarily under maintenance${retryAfter ? ` (retry in about ${retryAfter} seconds)` : ""}. Read, list, and restore remain available.`;
  } else if (body && typeof body.error === "string") {
    // WRITE_MODE=blocked 등 서버의 fail-closed 거절 — 문구를 그대로 중계한다.
    message = `${label} failed with HTTP ${response.status}: ${body.error.slice(0, 300)}`;
  }
  const error = new Error(message);
  error.code = code;
  error.status = response.status;
  if (body && body.current) error.current = body.current;
  if (body && body.conflict) error.conflict = body.conflict;
  return error;
}

/** 등록(생성/갱신). 성공 시 검증된 리비전 디스크립터(+operation/url)를 반환한다. */
async function registerCloudAgent(manifest, bundlePath, review, visibility, options = {}) {
  const cookie = await cloudSessionCookie();
  if (!cookie) throw new Error("Agent Cloud sign-in is required. Sign in through Desktop or set AGENTLAS_SESSION.");
  if (typeof fetch !== "function") throw new Error("fetch is unavailable in this runtime (run through the app runtime).");
  const base = webBaseUrl();
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const expectedScope = cloudScopeForVisibility(visibility);
  const baseDescriptor = options.baseDescriptor
    ? normalizeCloudAssetDescriptor(options.baseDescriptor, "base revision")
    : null;
  if (baseDescriptor && (baseDescriptor.slug !== manifest.slug || baseDescriptor.scope !== expectedScope)) {
    throw new Error("Agent Cloud base revision does not match the requested slug/scope.");
  }
  const headers = {
    "content-type": "application/json",
    cookie,
    origin: base,
    "idempotency-key": cloudIdempotencyKey(
      "register", expectedScope, manifest.slug, manifest.packageHash, manifest.packageHashVersion,
      baseDescriptor && baseDescriptor.revision,
    ),
  };
  if (baseDescriptor) {
    headers["if-match"] = baseDescriptor.etag;
    headers["x-agentlas-cloud-id"] = baseDescriptor.cloudId;
  } else {
    headers["if-none-match"] = "*";
  }
  const resp = await fetchHub(`${base}/api/cloud-agents/v1/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ manifest, bundle, review, visibility, billing: { modelCallsPaidBy: review.costOwner, localRuntime: review.runtimeLabel || null } }),
  });
  if (!resp.ok) throw cloudCasResponseError(resp, "Agentlas Cloud 등록");
  const json = parseHubJson(resp, "Agentlas Cloud 등록");
  const expectedSource = visibility === "marketplace" ? "hub" : "agent-cloud";
  const expectedVisibility = visibility === "marketplace" ? "marketplace" : "owner-private";
  const etag = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("etag") : null;
  const cacheControl = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("cache-control") : null;
  const expectedOperations = baseDescriptor ? new Set(["updated", "unchanged"]) : new Set(["created"]);
  if (
    json.schema !== "agentlas.agent_cloud.registration.v1" ||
    !expectedOperations.has(json.operation) ||
    json.source !== expectedSource ||
    json.visibility !== expectedVisibility ||
    json.scope !== expectedScope ||
    json.owner !== true ||
    json.publicHubPublished !== (visibility === "marketplace") ||
    json.dryRun !== false ||
    typeof json.cloudId !== "string" || !json.cloudId.trim() ||
    json.slug !== manifest.slug ||
    json.packageHash !== manifest.packageHash ||
    json.packageHashVersion !== manifest.packageHashVersion ||
    typeof json.revision !== "string" || etag !== cloudRevisionEtag(json.revision) ||
    typeof json.registeredAt !== "string" || !Number.isFinite(Date.parse(json.registeredAt)) ||
    !String(cacheControl || "").toLowerCase().includes("no-store") ||
    (baseDescriptor && json.cloudId !== baseDescriptor.cloudId)
  ) {
    throw new Error("Agentlas Cloud register returned an invalid or mismatched registration receipt.");
  }
  const descriptor = normalizeCloudAssetDescriptor({
    cloudId: json.cloudId,
    slug: json.slug,
    scope: json.scope,
    packageHash: json.packageHash,
    packageHashVersion: json.packageHashVersion,
    revision: json.revision,
    etag,
    updatedAt: json.savedAt || json.registeredAt,
  }, "registration receipt");
  return {
    ...descriptor,
    operation: json.operation,
    ...(typeof json.url === "string" ? { url: json.url } : {}),
    ...(typeof json.marketplaceUrl === "string" ? { marketplaceUrl: json.marketplaceUrl } : {}),
    registeredAt: json.registeredAt,
    dryRun: false,
  };
}

/** 관측한 정확한 리비전 하나만 조건부 삭제. 성공 시 상태 저널/마커에서 베이스를 걷어낸다. */
async function deleteCloudAgent(slug, options = {}) {
  // cloudSlug()의 "agentlas-cloud-agent" 폴백을 쓰면 빈 인자가 실존 슬러그로 위장된다 — 인라인 정규화 유지(v1 동일).
  const safeSlug = String(slug || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!safeSlug) throw new Error("usage: agentlas cloud delete <slug> [--json]");
  const cookie = await cloudSessionCookie();
  if (!cookie) throw new Error("Agent Cloud sign-in is required. Sign in through Desktop or set AGENTLAS_SESSION.");
  if (typeof fetch !== "function") throw new Error("fetch is unavailable in this runtime (run through the app runtime).");
  const scope = options.scope == null ? null : state.normalizeCloudScopeFlag(options.scope);
  if (options.scope != null && !scope) throw new Error("--scope must be owner-private or hub-public");
  const localEntry = state.findCloudAssetDescriptor(safeSlug, scope);
  if (!localEntry) {
    // 베이스 리비전을 관측한 적 없으면 삭제하지 않는다 — 다른 PC의 자산 오폭 방지.
    throw new Error(`No observed base revision for ${safeSlug}${scope ? ` (${scope})` : ""}. Run \`agentlas cloud list\` first, then retry the exact asset deletion.`);
  }
  const descriptor = localEntry.descriptor;
  const base = webBaseUrl();
  const query = new URLSearchParams({ slug: safeSlug, scope: descriptor.scope, cloudId: descriptor.cloudId });
  const resp = await fetchHub(`${base}/api/cloud-agents/v1/register?${query.toString()}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: base,
      "if-match": descriptor.etag,
      "x-agentlas-cloud-id": descriptor.cloudId,
      "idempotency-key": cloudIdempotencyKey(
        "delete", descriptor.scope, descriptor.slug, descriptor.packageHash, descriptor.packageHashVersion, descriptor.revision,
      ),
    },
  });
  if (!resp.ok) throw cloudCasResponseError(resp, "Agentlas Cloud 삭제");
  const json = parseHubJson(resp, "Agentlas Cloud 삭제");
  const responseEtag = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("etag") : null;
  const cacheControl = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("cache-control") : null;
  const expectedSource = descriptor.scope === "hub-public" ? "hub" : "agent-cloud";
  const expectedVisibility = descriptor.scope === "hub-public" ? "marketplace" : "owner-private";
  const deletionTimestamp = descriptor.scope === "hub-public" ? json.unpublishedAt : json.deletedAt;
  if (
    json.schema !== "agentlas.agent_cloud.delete.v1" || json.ok !== true ||
    json.source !== expectedSource || json.visibility !== expectedVisibility ||
    json.scope !== descriptor.scope || json.cloudId !== descriptor.cloudId || json.slug !== descriptor.slug ||
    json.packageHash !== descriptor.packageHash || json.packageHashVersion !== descriptor.packageHashVersion ||
    json.revision !== descriptor.revision ||
    responseEtag !== descriptor.etag || !String(cacheControl || "").toLowerCase().includes("no-store") ||
    (descriptor.scope === "hub-public" && json.operation !== "unpublished") ||
    typeof deletionTimestamp !== "string" || !Number.isFinite(Date.parse(deletionTimestamp))
  ) {
    throw new Error("Agentlas Cloud delete returned an invalid or mismatched deletion receipt.");
  }
  const stateValue = state.readCloudAssetState();
  const key = state.cloudDescriptorKey(descriptor);
  const roots = stateValue.assets[key]?.sourceRoots || [];
  const warnings = [];
  for (const rootPath of roots) {
    // 톰스톤: 삭제된 베이스는 재저장 시 절대 If-Match 베이스로 재사용되지 않는다.
    stateValue.deletedBases.push({ rootPath, slug: descriptor.slug, scope: descriptor.scope, cloudId: descriptor.cloudId, revision: descriptor.revision });
  }
  delete stateValue.assets[key];
  stateValue.deletedBases = stateValue.deletedBases.slice(-256);
  try {
    state.writeCloudAssetState(stateValue);
  } catch (error) {
    const stateError = new Error(
      `Cloud delete committed on the server, but this machine could not persist the deletion tombstone. ` +
      "Run `agentlas cloud list` before saving this slug again. " +
      `Local state error: ${error.message || error}`,
    );
    stateError.code = "AGENTLAS_CLOUD_LOCAL_STATE_COMMIT_FAILED";
    stateError.receipt = json;
    throw stateError;
  }
  for (const rootPath of roots) {
    try {
      const marker = state.readCloudSourceMarker(rootPath);
      if (marker) state.writeCloudSourceMarker(rootPath, null, null, { previousMarker: marker, removeDescriptor: descriptor });
    } catch (error) {
      warnings.push(`Could not clear ${rootPath}: ${error.message || error}`);
    }
  }
  return { ...json, ...(warnings.length ? { localStateWarnings: warnings } : {}) };
}

module.exports = {
  cloudScopeForVisibility,
  cloudIdempotencyKey,
  cloudCasResponseError,
  registerCloudAgent,
  deleteCloudAgent,
};
