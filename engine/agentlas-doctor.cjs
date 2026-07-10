"use strict";
/*
 * agentlas-doctor: 런타임 CLI 실패의 "시스템 원인"을 결정론적으로 진단·수리한다.
 *
 * 데스크탑 앱 electron/system-agents/runtime-doctor.ts 와 로직 패리티를 유지해야 한다
 * (3제품 싱크: 데스크탑 TS ↔ 터미널 CJS ↔ system-optimizer 패키지 플레이북).
 * 패리티는 Agentlas_F/scripts/sync-runtime-doctor.sh 가 공유 픽스처로 검증한다 —
 * 이 파일의 분류/수리 규칙을 바꾸면 반드시 그 스크립트를 PASS 시켜라.
 *
 * 사례(2026-07-08): codex CLI 업데이트가 openai-curated 플러그인(notion/figma)을 자동
 * 활성화 → 미인증 OAuth 원격 MCP가 매 실행 AuthRequired fatal → codex exit 1.
 * 수리: 에러 stderr의 호스트와 플러그인 캐시 .mcp.json url 호스트를 대조해 "정확히 그
 * 플러그인만" config.toml에서 enabled=false (백업 필수, 인증돼 잘 도는 플러그인 오폭 금지).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * 에러 텍스트에서 OAuth 자원 메타데이터로 명시된 호스트만 추출한다.
 * stderr의 모든 URL을 수집하면 도움말·문서 링크와 관련된 정상 플러그인까지
 * 수리 대상이 될 수 있다. 자동 수리는 구조화된 증거가 있을 때만 실행한다.
 */
function extractHosts(error) {
  const hosts = new Set();
  const addUrlHost = (rawUrl) => {
    try {
      hosts.add(new URL(rawUrl.replace(/[\]}>),.;]+$/g, "")).hostname.toLowerCase());
    } catch {
      /* 잘못된 메타데이터 URL은 자동 수리 증거로 쓰지 않음 */
    }
  };
  const patterns = [
    /resource_metadata(?:_url)?\s*[:=]\s*\\?["']?(https?:\/\/[^\s"'\\)>,]+)/gi,
    /(https?:\/\/[^\s"'\\)>,]+\/\.well-known\/oauth-protected-resource(?:[/?#][^\s"'\\)>,]*)?)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(error || "")) !== null) addUrlHost(m[1]);
  }
  return [...hosts];
}

/** 에러 텍스트에서 config.toml 스키마 위반이 지목한 mcp_servers 이름을 뽑는다. */
function extractBadMcpServer(error) {
  // 예: Error loading config.toml: url is not supported for stdio in "mcp_servers.agentlas"
  const m = /mcp_servers\.([a-z0-9_.-]+)/i.exec(error || "");
  return m ? m[1] : null;
}

/** kind: mcp-oauth-unauthenticated | codex-config-invalid | timeout | cli-exit | unknown (데스크탑 TS와 동일 규칙) */
function classifyFailure(error) {
  const text = error || "";
  if (/authrequired|invalid_token|oauth-protected-resource|www_authenticate/i.test(text)) {
    return { kind: "mcp-oauth-unauthenticated", hosts: extractHosts(text) };
  }
  // codex config.toml 파싱 실패(예: stdio 서버에 url 키) → CLI가 아예 기동 못 함.
  if (/error loading config\.toml|url is not supported for stdio|invalid config/i.test(text)) {
    return { kind: "codex-config-invalid", hosts: [], badServer: extractBadMcpServer(text) };
  }
  if (/no response for \d+s|auto-aborted/i.test(text)) return { kind: "timeout", hosts: [] };
  if (/(?:CLI exit|exited with code)\s+[1-9]\d*/i.test(text)) return { kind: "cli-exit", hosts: extractHosts(text) };
  return { kind: "unknown", hosts: [] };
}

/** 실패 호스트와 일치하는 OAuth MCP를 실은 플러그인 찾기(호스트가 에러에 등장한 것만). */
function findOauthPluginsByHost(hosts) {
  if (!hosts.length) return [];
  const cacheRoot = path.join(codexHome(), "plugins", "cache");
  const hits = [];
  let marketplaces = [];
  try {
    marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  for (const marketplace of marketplaces) {
    let plugins = [];
    try {
      plugins = fs.readdirSync(path.join(cacheRoot, marketplace), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      let versions = [];
      try {
        versions = fs.readdirSync(path.join(cacheRoot, marketplace, plugin), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        continue;
      }
      for (const ver of versions) {
        const mcpJson = path.join(cacheRoot, marketplace, plugin, ver, ".mcp.json");
        if (!fs.existsSync(mcpJson)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(mcpJson, "utf8"));
          for (const server of Object.values(parsed.mcpServers || {})) {
            if (!server || !server.url) continue;
            let host = "";
            try {
              host = new URL(server.url).hostname.toLowerCase();
            } catch {
              continue;
            }
            // 호스트가 정확히 같을 때만 자동 수리한다. 부모/자식 도메인 관계만으로는
            // 어느 플러그인이 실패했는지 증명할 수 없다.
            if (hosts.includes(host)) {
              // cache 디렉토리 "openai-curated-remote"는 config 키에선 "openai-curated".
              hits.push({ pluginKey: `${plugin}@${marketplace.replace(/-remote$/, "")}`, host });
            }
          }
        } catch {
          /* 손상된 .mcp.json은 건너뜀 */
        }
      }
    }
  }
  const seen = new Set();
  return hits.filter((h) => (seen.has(h.pluginKey) ? false : (seen.add(h.pluginKey), true)));
}

/** config.toml에서 해당 플러그인을 enabled=false로 내린다(백업 필수). 반환: 실제 변경 여부. */
function disableCodexPlugin(pluginKey) {
  const configPath = path.join(codexHome(), "config.toml");
  if (!fs.existsSync(configPath)) return false;
  const original = fs.readFileSync(configPath, "utf8");
  const header = `[plugins."${pluginKey}"]`;
  let next;
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerMatch = new RegExp(`^[ \\t]*${escapeRegExp(header)}[ \\t]*(?:#.*)?\\r?$`, "m").exec(original);
  if (headerMatch) {
    const headerLineEnd = headerMatch.index + headerMatch[0].length;
    const newlineIndex = original.indexOf("\n", headerLineEnd);
    const bodyStart = newlineIndex === -1 ? original.length : newlineIndex + 1;
    const remaining = original.slice(bodyStart);
    const nextSection = /^[ \t]*\[[^\r\n]+\][ \t]*(?:#.*)?\r?$/m.exec(remaining);
    const sectionEnd = nextSection ? bodyStart + nextSection.index : original.length;
    const section = original.slice(headerMatch.index, sectionEnd);
    const replacedSection = section.replace(
      /^([ \t]*enabled[ \t]*=[ \t]*)true([ \t]*(?:#.*)?)(?=\r?$)/m,
      "$1false$2",
    );
    if (replacedSection === section) return false; // 이미 false거나 해당 섹션에 enabled=true가 없음
    next = original.slice(0, headerMatch.index) + replacedSection + original.slice(sectionEnd);
  } else {
    next = `${original.trimEnd()}\n\n${header}\nenabled = false\n`;
  }
  const backup = `${configPath}.bak-doctor-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(configPath, backup);
  fs.writeFileSync(configPath, next);
  return true;
}

/**
 * 진단 + (아는 계열이면) 즉시 수리. 반환: { kind, summary, repaired, actions[] }
 * 데스크탑 runtime-doctor.ts 의 runRuntimeDoctor 와 동일 계약.
 */
function runRuntimeDoctor(errorMessage) {
  const { kind, hosts, badServer } = classifyFailure(errorMessage);
  const actions = [];

  if (kind === "codex-config-invalid") {
    // 진단만 한다(자동 수리 안 함): 원격 MCP 항목이라 안전한 무손실 수리가 없고,
    // 사용자가 어느 항목을 어떻게 고칠지 알아야 한다. 명확한 조치를 안내한다.
    const where = badServer ? `[mcp_servers.${badServer}]` : "일부 [mcp_servers.*] 항목";
    return {
      kind,
      summary: `codex의 ~/.codex/config.toml ${where} 이(가) 잘못돼 codex가 기동하지 못합니다(예: stdio 서버에 url 키). 다른 런타임(--runtime claude-code)으로 우회하거나 그 항목을 고치세요.`,
      repaired: false,
      actions,
    };
  }

  if (kind === "mcp-oauth-unauthenticated") {
    const hitList = findOauthPluginsByHost(hosts);
    let repairedAny = false;
    for (const hit of hitList) {
      try {
        if (disableCodexPlugin(hit.pluginKey)) {
          repairedAny = true;
          actions.push({
            title: `codex plugin disabled: ${hit.pluginKey}`,
            detail: `미인증 OAuth MCP(${hit.host})가 런타임을 죽여서 ~/.codex/config.toml에서 비활성화했습니다(백업 생성). 이 서비스를 쓰려면 인증 후 다시 켜세요.`,
          });
        }
      } catch (err) {
        actions.push({ title: `repair failed: ${hit.pluginKey}`, detail: err && err.message ? err.message : String(err) });
      }
    }
    return {
      kind,
      summary: hitList.length
        ? `런타임에 미인증 OAuth MCP 플러그인(${hitList.map((h) => h.pluginKey).join(", ")})이 붙어 있어 CLI가 죽었습니다.`
        : `미인증 OAuth MCP(${hosts.join(", ") || "unknown host"})가 런타임을 죽였지만 어떤 플러그인인지 특정하지 못했습니다.`,
      repaired: repairedAny,
      actions,
    };
  }

  if (kind === "timeout") {
    return {
      kind,
      summary: "실행이 장시간 무응답이라 자동 중단됐습니다. 대화형 인증 대기·stdin 블록·원격 MCP 행이 흔한 원인입니다.",
      repaired: false,
      actions,
    };
  }

  if (kind === "cli-exit") {
    return {
      kind,
      summary: "런타임 CLI가 비정상 종료했지만 아는 수리 계열이 아닙니다.",
      repaired: false,
      actions,
    };
  }

  return { kind: "unknown", summary: "", repaired: false, actions };
}

module.exports = { classifyFailure, extractHosts, findOauthPluginsByHost, disableCodexPlugin, runRuntimeDoctor };
