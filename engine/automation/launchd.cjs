"use strict";
/*
 * automation/launchd — 앱/창이 꺼져 있어도 자동화를 돌리는 macOS 영속성 (2026-08-06).
 *
 * 배경(오너: "터미널인데 모든 기능이 다 돼야"): 터미널 automation daemon 은 포그라운드
 * setInterval 이라 셸 창을 닫으면 멈춘다 — "데스크탑 없이 자동화가 발동"이 실제론 안 됐다.
 * 데스크탑 electron/launchd/agent.ts 와 같은 방식으로 ~/Library/LaunchAgents 에 plist 를 써서
 * launchctl 로 로드한다. plist 는 coarse StartInterval(기본 300s)마다 `agentlas automation tick`
 * (1회 due 스윕 후 종료)을 poke 한다. DB 가 스케줄 권위이고 plist 는 poke 만 하므로 자동화별
 * plist 동기화가 필요 없다 — 데스크탑과 정확히 같은 계약.
 *
 * ★Label 은 데스크탑("ai.agentlas.automations")과 다르게 둔다("ai.agentlas.cli.automations").
 *   둘 다 설치돼 있어도 공유 DB 의 lease(claimDue)가 이중 실행을 막으므로 공존은 안전하고,
 *   서로의 plist 를 install/uninstall 로 덮지 않게 하려는 것.
 *
 * macOS 전용(launchd). 다른 OS 는 supported:false 로 정직하게 알린다(자동화는 포그라운드
 * `automation daemon` 으로만 — 조용히 안 되는 척하지 않는다).
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");

const LABEL = "ai.agentlas.cli.automations";

function isSupported() { return process.platform === "darwin"; }
function plistPath() { return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`); }
function domainTarget() { return `gui/${os.userInfo().uid}`; }

/** launchd 가 poke 할 CLI 진입점(절대경로). 전역 설치본이든 체크아웃이든 이 파일 기준으로 해석. */
function cliEntry() { return path.resolve(__dirname, "..", "..", "bin", "agentlas.cjs"); }

function logPath() {
  const dir = path.join(userDataDir(), "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return path.join(dir, "launchd-automations.log");
}

function plistXml(intervalSec = 300) {
  const node = process.execPath;
  const entry = cliEntry();
  const log = logPath();
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${esc(node)}</string>`,
    `    <string>${esc(entry)}</string>`,
    "    <string>automation</string>",
    "    <string>tick</string>",
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${Math.max(30, Math.floor(intervalSec))}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>LowPriorityIO</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${esc(log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${esc(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** launchctl 실행 — throw 하지 않고 {code, stderr} 반환(상태 함수가 판정). */
function launchctl(args) {
  const res = spawnSync("launchctl", args, { encoding: "utf8" });
  return { code: res.status ?? -1, stderr: (res.stderr || "").trim() };
}

function isLoaded() {
  if (!isSupported()) return false;
  return launchctl(["print", `${domainTarget()}/${LABEL}`]).code === 0;
}

function launchdStatus() {
  const supported = isSupported();
  return {
    supported,
    installed: supported && fs.existsSync(plistPath()),
    loaded: supported && isLoaded(),
    plistPath: plistPath(),
    label: LABEL,
    entry: cliEntry(),
  };
}

/** plist 작성 + launchctl bootstrap 로드(멱등 — 이미 로드면 bootout 후 재로드). */
function enableLaunchd({ intervalSec = 300 } = {}) {
  if (!isSupported()) return { ...launchdStatus(), error: "launchd persistence is macOS-only." };
  const p = plistPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, plistXml(intervalSec), "utf8");
  } catch (err) {
    return { ...launchdStatus(), error: `failed to write plist: ${String(err)}` };
  }
  if (isLoaded()) launchctl(["bootout", `${domainTarget()}/${LABEL}`]);
  const res = launchctl(["bootstrap", domainTarget(), p]);
  if (res.code !== 0 && !isLoaded()) {
    return { ...launchdStatus(), error: res.stderr || "launchctl bootstrap failed." };
  }
  return launchdStatus();
}

/** launchctl bootout + plist 삭제. */
function disableLaunchd() {
  if (!isSupported()) return launchdStatus();
  if (isLoaded()) launchctl(["bootout", `${domainTarget()}/${LABEL}`]);
  const p = plistPath();
  try { if (fs.existsSync(p)) fs.rmSync(p); }
  catch (err) { return { ...launchdStatus(), error: `failed to remove plist: ${String(err)}` }; }
  return launchdStatus();
}

module.exports = {
  LABEL, plistPath, plistXml, cliEntry, isSupported,
  launchdStatus, enableLaunchd, disableLaunchd,
};
