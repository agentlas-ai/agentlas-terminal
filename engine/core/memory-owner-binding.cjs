"use strict";
// Account identity comes from the current authenticated Hub session, never a
// model packet or the opaque MCP OAuth subject. One owns lineage resolution.
const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const auth = require("../cloud/auth.cjs");
const scope = new AsyncLocalStorage();
const proxies = new WeakMap();
const installed = new WeakSet();
// Desktop's independent-worker AsyncResource clears foreground ALS. It may
// use only this already verified, still fresh host lane; it cannot mint one.
let hostLane = null;
const root = () => {
  const value = process.env.AGENTLAS_MEMORY_ROOT?.trim() || path.join(process.env.AGENTLAS_HOME?.trim() || path.join(os.homedir(), ".agentlas"), "memory");
  if (!path.isAbsolute(value)) fail("memory_root_must_be_absolute");
  return path.resolve(value);
};
const credential = () => auth.cloudSessionCookie();
function fail(reason) { throw Object.assign(new Error(reason), { code: reason }); }
function check(value = scope.getStore() || hostLane) {
  if (!value || value.reason) fail(value?.reason || "memory_account_binding_unavailable");
  if (value.root !== root() || value.cookie !== credential() || value.base !== auth.webBaseUrl()) fail("memory_host_binding_changed");
  if (value.expires <= Date.now()) fail("memory_host_binding_expired");
  if (value.file) {
    if (fs.existsSync(`${value.file}.revoked.${value.revision}`)) fail("memory_host_binding_revoked");
    const descriptor = JSON.parse(fs.readFileSync(value.file, "utf8"));
    if (descriptor.state !== "active" || descriptor.binding_revision !== value.revision || descriptor.expires_at <= Date.now()) fail("memory_host_binding_revoked");
    if (descriptor.memory_root !== value.root || descriptor.owner_namespace !== value.owner || descriptor.revocation_epoch !== value.epoch
      || descriptor.user_id !== value.userId || descriptor.workspace_id !== value.workspaceId) fail("memory_host_binding_changed");
  }
  if (value.owner && value.info && !value.checking) {
    value.checking = true;
    try { const info = value.info(); if (info.ownerNamespace !== value.owner || info.revocationEpoch !== value.epoch) fail("memory_worker_custody_changed"); }
    finally { value.checking = false; }
  }
  return value;
}
async function verify(value) {
  if (!value.cookie) return null;
  const response = await fetch(`${value.base}/api/auth/session`, { headers: { cookie: value.cookie }, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) fail("memory_account_binding_unavailable");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16384) fail("memory_account_binding_unavailable"); chunks.push(Buffer.from(part.value)); } }
  finally { await reader.cancel().catch(() => {}); }
  const body = Buffer.concat(chunks).toString("utf8");
  const session = JSON.parse(body);
  if (session.authenticated !== true || typeof session.user?.id !== "string" || !session.user.id) fail("memory_account_binding_unavailable");
  check(value);
  return { userId: session.user.id, workspaceId: typeof session.workspace?.id === "string" ? session.workspace.id : null };
}
function atomic(file, body) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) fail("memory_host_binding_path_invalid");
    if (path.dirname(dir) === dir) break;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(body), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function revoke(value) {
  if (value.file) try { fs.writeFileSync(`${value.file}.revoked.${value.revision}`, "revoked", { flag: "wx", mode: 0o600 }); } catch {}
  value.reason = "memory_host_binding_revoked";
}
// Guard every held DB/statement/iterator, including after account switches.
// Rollback and close remain unconditional. Proxy identity is stable per scope.
function guarded(target, value) {
  if (!target || !["object", "function"].includes(typeof target)) return target;
  let byScope = proxies.get(target); if (!byScope) proxies.set(target, byScope = new WeakMap());
  if (byScope.has(value)) return byScope.get(value);
  const proxy = new Proxy(target, { get(object, key) {
    const member = Reflect.get(object, key, object);
    if (typeof member !== "function") return member;
    if (key === "close" || key === "rollback") return member.bind(object);
    return (...args) => {
      check(value);
      if (key === "transaction" && typeof args[0] === "function") {
        const callback = args[0]; args[0] = (...values) => { check(value); const out = callback(...values); check(value); return out; };
      }
      const result = member.apply(object, args); check(value);
      return guarded(result, value);
    };
  }, apply(fn, receiver, args) { check(value); const result = Reflect.apply(fn, receiver, args); check(value); return guarded(result, value); } });
  byScope.set(value, proxy); return proxy;
}
function install(core) {
  if (installed.has(core)) return core;
  const profile = core.require("store/one-profile");
  if (typeof profile.setOneProfileAccountResolver !== "function") fail("memory_account_resolver_unavailable");
  profile.setOneProfileAccountResolver(() => check().userId);
  const rawInfo = core.getMemoryStoreInfo;
  const rawDb = core.getMemoryDb;
  core._memoryOwnerInfo = rawInfo;
  core.getMemoryStoreInfo = () => {
    const value = check(), info = rawInfo();
    if (value.owner && (value.owner !== info.ownerNamespace || value.epoch !== info.revocationEpoch)) fail("memory_worker_custody_changed");
    // Also pin the credential-free one-shot reader at its first actual access.
    value.owner ??= info.ownerNamespace; value.epoch ??= info.revocationEpoch; value.info ??= rawInfo;
    return info;
  };
  core.getMemoryDb = () => { const value = check(); core.getMemoryStoreInfo(); return guarded(rawDb(), value); };
  // Imported context/curator/source modules use this same exported facade.
  // Guarding only the loader object would leave their direct imports unfenced.
  const database = core.require("memory/database");
  database.getMemoryStoreInfo = core.getMemoryStoreInfo;
  database.getMemoryDb = core.getMemoryDb;
  for (const name of ["recordAutomaticMemoryTurn", "registerAutomaticMemoryRuntime", "processAutomaticMemoryCuration"]) {
    const original = core[name]; if (typeof original !== "function") continue;
    core[name] = (...args) => { const value = check(); core.getMemoryStoreInfo(); const result = original(...args); return result?.then ? result.then(out => { check(value); return out; }) : (check(value), result); };
  }
  // Credential-free one-shot local readers need no server identity. Known
  // credentials cannot use this lane; they await the asynchronous host check.
  if (!hostLane) {
    try {
      if (!credential()) hostLane = { root: root(), base: auth.webBaseUrl(), cookie: null, userId: null, workspaceId: null,
        expires: Date.now() + 30000 };
    } catch { /* unsafe/unknown credentials remain unavailable */ }
  }
  installed.add(core); return core;
}
async function withBinding(core, callback, captured = null) {
  install(core);
  const value = { root: root(), base: auth.webBaseUrl(), cookie: credential(), expires: Date.now() + 30000, userId: null, workspaceId: null };
  try {
    if (captured && (captured.root !== value.root || captured.base !== value.base || captured.cookie !== value.cookie)) fail("memory_host_binding_changed");
    const session = await verify(value); Object.assign(value, session || {});
  } catch (error) { value.reason = error.code || "memory_account_binding_unavailable"; }
  return scope.run(value, async () => {
    hostLane = value;
    let timer;
    try {
      if (!value.reason) {
        const info = core.getMemoryStoreInfo(); value.owner = info.ownerNamespace; value.epoch = info.revocationEpoch; value.info = core._memoryOwnerInfo;
        if (captured) {
          value.file = captured.file; value.revision = captured.revision; check(value);
          if (captured.owner !== value.owner || captured.epoch !== value.epoch) fail("memory_worker_custody_changed");
        } else {
          const registry = JSON.parse(fs.readFileSync(path.join(value.root, "registry.json"), "utf8"));
          value.revision = crypto.randomUUID(); value.file = path.join(value.root, "runtime-bindings", `terminal-${value.revision}.json`);
          value.descriptor = { schema_version: "agentlas.memory-owner-binding.v1", source_id: `terminal-native:${registry.deviceCustodyId}`,
            binding_revision: value.revision, state: "active", memory_root: value.root, owner_namespace: value.owner,
            device_custody_id: registry.deviceCustodyId, revocation_epoch: value.epoch, auth_binding_id: crypto.createHash("sha256").update(value.cookie || "signed-out").digest("hex"),
            user_id: value.userId, workspace_id: value.workspaceId, expires_at: value.expires };
          atomic(value.file, value.descriptor);
          let renewing = false;
          timer = setInterval(async () => {
            if (renewing || value.reason) return; renewing = true;
            try { check(value); const next = await verify(value); if ((next?.userId || null) !== value.userId || (next?.workspaceId || null) !== value.workspaceId) fail("memory_host_binding_changed"); core.getMemoryStoreInfo(); value.expires = Date.now() + 30000; atomic(value.file, { ...value.descriptor, expires_at: value.expires }); }
            catch { revoke(value); } finally { renewing = false; }
          }, 5000); timer.unref();
        }
      }
      return await callback({ available: !value.reason, reason: value.reason || null });
    } finally { clearInterval(timer); /* detached child may finish within this bounded lease */ }
  });
}
function workerBinding() { const value = check(); return { root: value.root, base: value.base, cookie: value.cookie, file: value.file, revision: value.revision, owner: value.owner, epoch: value.epoch }; }
async function revalidate() {
  const value = check();
  try {
    const session = await verify(value);
    if ((session?.userId || null) !== value.userId || (session?.workspaceId || null) !== value.workspaceId) fail("memory_host_binding_changed");
    check(value);
  } catch (error) { revoke(value); throw error; }
}
module.exports = { install, withBinding, workerBinding, assertFresh: check, revalidate };
