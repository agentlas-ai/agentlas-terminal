"use strict";
/*
 * core/keychain-read — 키체인 읽기를 "죽일 수 있는 곳"에서 한다.
 *
 * ★이 저장소는 이 함정을 이미 한 번 만났다: telegram/connect.cjs 는 "standalone Node 에서
 *   keytar 는 macOS 키체인에 막혀 멈추므로" 라며 keytar 를 아예 쓰지 않고 0600 파일로 갔다.
 *   그런데 그 회피는 그 한 곳에만 있었고, 나머지는 `.catch(() => null)` 로 "거부는 없는 키로
 *   본다" 는 가정을 들고 있었다. **거부가 아니라 정지가 실제 실패 모양이다.**
 *
 *   macOS 키체인 항목에는 그것을 만든 프로그램의 ACL 이 붙는다. 다른 실행 파일이 읽으려 하면
 *   OS 가 승인 창을 띄우고, 띄울 화면이 없는 호스트에서는 답할 사람이 없어 호출이 안 돌아온다.
 *   그리고 그건 **이벤트 루프 정지**다 — 같은 프로세스의 25초 setTimeout 조차 발화하지 않는
 *   것을 측정했다(2026-08-19). 그래서 `Promise.race([call, timeout])` 은 원리적으로 못 막는다.
 *   상한이 실제로 동작하려면 호출이 **다른 프로세스**에 있어야 한다.
 *
 * 데스크탑 쪽 같은 계약: agentlas_desktop/electron/secrets/keychain-host.ts.
 */
const { execFile } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;

function keychainTimeoutMs() {
  const raw = Number(process.env.AGENTLAS_KEYCHAIN_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
  return DEFAULT_TIMEOUT_MS;
}

/**
 * 키체인 값 하나를 상한 안에서 읽는다. 못 읽으면 `null` — 호출부는 "키 없음" 갈래를 이미 갖고
 * 있고, 멈춰 서는 것보다 그 갈래가 낫다. 값은 stdout(파이프)으로만 오고 argv 에는 안 실린다.
 */
function readKeychainPassword(service, account) {
  return new Promise((resolve) => {
    let keytarPath;
    try {
      keytarPath = require.resolve("keytar");
    } catch {
      resolve(null);
      return;
    }
    const script = `
const [modPath, service, account] = process.argv.slice(1);
const keytar = require(modPath);
keytar.getPassword(service, account)
  .then((v) => { process.stdout.write(JSON.stringify({ value: v ?? null })); process.exit(0); })
  .catch(() => { process.stdout.write(JSON.stringify({ value: null })); process.exit(0); });
`;
    execFile(
      process.execPath,
      ["-e", script, keytarPath, String(service), String(account)],
      { timeout: keychainTimeoutMs(), killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || "{}"));
          resolve(typeof parsed.value === "string" ? parsed.value : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

module.exports = { readKeychainPassword, keychainTimeoutMs };
