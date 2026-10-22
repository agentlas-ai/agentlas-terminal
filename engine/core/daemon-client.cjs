"use strict";
/*
 * core/daemon-client — 같은 머신의 Agentlas 데몬(agentlasd)에 일을 시키는 클라이언트.
 *
 * ★왜 있나 (데몬 Phase 3). 이 터미널은 지금 데스크탑 코어를 **자기 프로세스에서**
 * 돌린다 — 64MB 벤더 사본을 로드하고, 같은 DB 를 여는 두 번째 주인이 된다. 데몬이
 * 떠 있으면 그럴 이유가 없다: "이거 해 줘" 한 줄이면 되고, 코어는 한 곳에서만 돈다.
 *
 * 프로토콜은 데몬 쪽(electron/daemon/control-socket.ts)과 같은 줄 단위 JSON-RPC.
 * 주소 규칙도 같은 계산이다 — userDataDir()/daemon.sock (Windows 는 named pipe).
 * **이 두 파일의 주소 계산이 어긋나면 서로를 영영 못 찾는다.** 여기 경로는
 * core/paths.cjs 의 userDataDir 를 쓰므로, 데스크탑 앱과 같은 곳을 본다.
 *
 * 데몬이 없으면? 없다고 답할 뿐이다. 호출자는 예전처럼 벤더 코어로 폴백한다 —
 * 데몬은 빠른 길이지 유일한 길이 아니다(그게 유일한 길이 되는 순간, 데몬이 죽으면
 * 터미널 전체가 죽는다).
 */
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("./paths.cjs");

const DAEMON_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * The desktop daemon names its sockets from the canonical userData (desktop daemon/service-identity.ts
 * canonicalDaemonPath: realpath, resolving existing ancestors for a path not created yet). A userData reached
 * through a symlink or a Windows junction must resolve the same way here, or the hashed long-path name and the
 * Windows pipe name point somewhere the daemon never listens. A path with no link in it keeps its bytes.
 */
function canonicalUserDataDir(value) {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (!error || error.code !== "ENOENT") return absolute;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalUserDataDir(parent), path.basename(absolute));
  }
}

/** 데몬 소켓 주소 — control-socket.ts 의 defaultControlSocketPath 와 같은 규칙(정규 경로 기준). */
function daemonSocketPath() {
  const dir = canonicalUserDataDir(userDataDir());
  if (process.platform === "win32") {
    // Same rule as the desktop (control-socket.ts): sha256 of the whole canonical userData. Pipe names are
    // machine-global, so the old base64url(dir).slice(-16) ("…ing\Agentlas") was one name for every user.
    const tag = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\agentlas-daemon-${tag}`;
  }
  // ★유닉스 소켓 경로 ~104바이트 한계(sockaddr_un). 실측: 128바이트에서 bind 는
  // 조용히 지나가고 connect 만 EINVAL — 데몬 쪽(control-socket.ts)과 같은 폴백 규칙.
  const preferred = path.join(dir, "daemon.sock");
  const tag = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 16);
  const name = `agentlas-daemon-${tag}.sock`;
  // Match Desktop publication and its private .d-XXXXXX/s staging address.
  const fits = address => Buffer.byteLength(address, "utf8") <= 100
    && Buffer.byteLength(path.join(path.dirname(address), ".d-XXXXXX", "s"), "utf8") <= 100;
  for (const address of [preferred, path.join(require("node:os").tmpdir(), name)]) {
    if (fits(address)) return address;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("daemon_socket_owner_unavailable");
  const directory = path.join("/tmp", `agentlas-${uid}`);
  const address = path.join(directory, name);
  if (!fits(address)) throw new Error("daemon_socket_path_limit");
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const owner = fs.lstatSync(directory);
  if (owner.isSymbolicLink() || !owner.isDirectory() || owner.uid !== uid || (owner.mode & 0o7777) !== 0o700) {
    throw new Error("daemon_socket_directory_unsafe");
  }
  return address;
}

/** The pipe name a desktop daemon from before the full-path hash listens on (Windows only; kept one release). */
function legacyDaemonPipePath() {
  if (process.platform !== "win32") return null;
  const tag = Buffer.from(canonicalUserDataDir(userDataDir())).toString("base64url").slice(-16);
  return `\\\\.\\pipe\\agentlas-daemon-${tag}`;
}

/** JSON-RPC 한 번. 데몬이 에러를 주면 그 문장 그대로 throw 한다. */
function callDaemon(method, params, timeoutMs) {
  const primary = daemonSocketPath();
  const legacy = legacyDaemonPipePath();
  // ENOENT means nothing listens there, so nothing was sent: trying the old name once cannot run work twice.
  return callDaemonAt(primary, method, params, timeoutMs).catch((error) => {
    if (!legacy || legacy === primary || !error || error.code !== "ENOENT") throw error;
    return callDaemonAt(legacy, method, params, timeoutMs);
  });
}

function callDaemonAt(address, method, params, timeoutMs) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    const id = crypto.randomUUID();
    let buffer = Buffer.alloc(0);
    let responseBytes = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      buffer = Buffer.alloc(0);
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`daemon did not answer ${method} within ${limit}ms`))),
      limit,
    );
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      responseBytes += bytes.length;
      if (responseBytes > DAEMON_MAX_RESPONSE_BYTES) {
        const error = new Error(`daemon response exceeded ${DAEMON_MAX_RESPONSE_BYTES} bytes`);
        error.code = "DAEMON_RESPONSE_BODY_LIMIT";
        finish(() => reject(error));
        return;
      }
      buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
      let nl;
      while (!settled && (nl = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, nl).toString("utf8").trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        if (message.error) finish(() => reject(new Error(message.error.message || "daemon error")));
        else finish(() => resolve(message.result));
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
  });
}

/**
 * 데몬이 지금 떠서 답하는가. **접속이 아니라 응답**으로 판정한다 — 죽은 데몬이 남긴
 * 소켓 파일에는 접속 자체가 실패하고, 산 데몬이라도 멎어 있으면 쓸 수 없다.
 */
async function daemonAvailable() {
  try {
    const pong = await callDaemon("daemon.ping", undefined, 2000);
    if (!pong || pong.ok !== true) return false;
    return sharesOurStore(pong);
  } catch {
    return false;
  }
}

/**
 * 데몬이 **우리와 같은 DB** 를 열었는가.
 *
 * ★`AGENTLAS_STORE_PATH` 는 이 프로세스에만 있다 — 소켓 너머 데몬은 그 값을 모른다.
 *   그래서 사본을 지정해 놓고 일을 넘기면, 우리는 사본에 자동화를 만들고 데몬은
 *   **라이브에** 실행 기록·부수효과를 남긴다. 둘 다 "성공" 이라고 답하는데 결과는
 *   두 데이터베이스에 반씩 흩어진다. 넘기기 전에 물어보고, 다르면 넘기지 않는다.
 *
 *   경로를 못 받는 옛 데몬은 예전처럼 신뢰한다 — 그때는 양쪽 다 기본 경로였다.
 *   우리가 경로를 명시했는데 상대가 답을 못 하면, 그건 확인할 수 없는 상태이므로 거절한다.
 */
function sharesOurStore(pong) {
  const ours = String(process.env.AGENTLAS_STORE_PATH || "").trim();
  if (!ours) return true;
  const theirs = typeof pong.storePath === "string" ? pong.storePath.trim() : "";
  if (!theirs) {
    console.error(
      "[daemon] AGENTLAS_STORE_PATH is set here, but the daemon does not report which database it opened.\n"
      + "[daemon] Running the graph locally instead, so the work cannot land in a different store.",
    );
    return false;
  }
  let oursStat;
  let theirsStat;
  try {
    oursStat = fs.statSync(path.resolve(ours));
    theirsStat = fs.statSync(path.resolve(theirs));
  } catch {
    console.error(
      `[daemon] could not verify the database identity (${theirs}) against this command (${ours}).\n`
      + "[daemon] Running the graph locally instead, so the work cannot land in a different store.",
    );
    return false;
  }
  if (
    oursStat.isFile() && theirsStat.isFile() &&
    String(oursStat.dev) === String(theirsStat.dev) &&
    String(oursStat.ino) === String(theirsStat.ino)
  ) return true;
  console.error(
    `[daemon] the daemon opened a different database (${theirs}) than this command (${ours}).\n`
    + "[daemon] Running the graph locally instead, so the work cannot land in a different store.",
  );
  return false;
}

module.exports = { daemonSocketPath, callDaemon, daemonAvailable, sharesOurStore, DAEMON_MAX_RESPONSE_BYTES };
