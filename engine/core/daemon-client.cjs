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
const path = require("node:path");
const { userDataDir } = require("./paths.cjs");

/** 데몬 소켓 주소 — control-socket.ts 의 defaultControlSocketPath 와 같은 규칙. */
function daemonSocketPath() {
  const dir = userDataDir();
  if (process.platform === "win32") {
    const tag = Buffer.from(dir).toString("base64url").slice(-16);
    return `\\\\.\\pipe\\agentlas-daemon-${tag}`;
  }
  // ★유닉스 소켓 경로 ~104바이트 한계(sockaddr_un). 실측: 128바이트에서 bind 는
  // 조용히 지나가고 connect 만 EINVAL — 데몬 쪽(control-socket.ts)과 같은 폴백 규칙.
  const preferred = path.join(dir, "daemon.sock");
  if (Buffer.byteLength(preferred, "utf8") <= 100) return preferred;
  const tag = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 16);
  return path.join(require("node:os").tmpdir(), `agentlas-daemon-${tag}.sock`);
}

/** JSON-RPC 한 번. 데몬이 에러를 주면 그 문장 그대로 throw 한다. */
function callDaemon(method, params, timeoutMs) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(daemonSocketPath());
    const id = crypto.randomUUID();
    let buffer = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
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
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
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
    return Boolean(pong && pong.ok === true);
  } catch {
    return false;
  }
}

module.exports = { daemonSocketPath, callDaemon, daemonAvailable };
