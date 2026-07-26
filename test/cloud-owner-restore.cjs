#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function cloudFile(filePath, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path: filePath,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

function packageHash(files) {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-owner-cloud-"));
  const files = [cloudFile("AGENTS.md", "# Owned Agent\n"), cloudFile("skills/core/SKILL.md", "# Core\n")];
  const aggregate = packageHash(files);
  const updatedAt = "2026-07-11T00:00:00.000Z";
  const descriptorFor = (slug) => ({
    cloudId: `cloud-${slug}`,
    slug,
    scope: "owner-private",
    packageHash: aggregate,
    packageHashVersion: "path-sha256-v1",
    revision: `rev-${slug}-001`,
    etag: `"rev-${slug}-001"`,
    updatedAt,
  });
  const calls = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const name = body?.params?.name;
      const requestedSlug = body?.params?.arguments?.slug;
      calls.push({ name, cookie: request.headers.cookie || "" });
      let result;
      if (name === "cargo.search_agents") {
        result = {
          schema: "agentlas.agent_cloud.search.v1",
          source: "cloud",
          status: "ok",
          count: 1,
          total: 1,
          results: [{ ...descriptorFor("owned-agent"), name: "Owned Agent", entityKind: "agent" }],
        };
      } else if (name === "cargo.restore_package") {
        const responseSlug = requestedSlug === "cross-slug" ? "different-agent" : (requestedSlug || "owned-agent");
        const descriptor = descriptorFor(responseSlug);
        result = {
          schema: "agentlas.agent_cloud.restore.v1",
          source: "cloud",
          owner: true,
          ...descriptor,
          name: "Owned Agent",
          cloudPackage: {
            ...descriptor,
            etag: undefined,
            agentKind: "agent",
            fileCount: files.length,
            totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
            files,
          },
        };
        if (requestedSlug === "mismatched-envelope") result.packageHash = "0".repeat(64);
      } else if (name === "marketplace.get_manifest") {
        result = {
          slug: "call-only-agent",
          name: "Call Only Agent",
          delivery: {
            mode: "call_only",
            sourceDownload: false,
            runtimeTool: "agentlas.get_runtime_bundle",
            runtimeVersion: aggregate,
          },
        };
      } else {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `unexpected tool: ${name}` } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
    });
  });

  try {
    const address = await listen(server);
    const env = {
      ...process.env,
      AGENTLAS_USER_DATA_DIR: userData,
      AGENTLAS_MCP_BASE_URL: `http://127.0.0.1:${address.port}/api/mcp/v1`,
      AGENTLAS_SESSION: "owner-session-fixture",
    };
    const bin = path.join(__dirname, "..", "bin", "agentlas.cjs");

    const listed = await execFileAsync(process.execPath, [bin, "cloud", "list"], { env });
    assert.match(listed.stdout, /owned-agent/);
    const observedState = JSON.parse(fs.readFileSync(path.join(userData, "cloud-asset-state.v1.json"), "utf8"));
    assert.equal(observedState.assets["owner-private:owned-agent"].descriptor.revision, "rev-owned-agent-001");

    const restored = await execFileAsync(process.execPath, [bin, "cloud", "restore", "owned-agent", "--json"], { env });
    const receipt = JSON.parse(restored.stdout);
    assert.equal(receipt.source, "cloud");
    assert.equal(receipt.packageHash, aggregate);
    assert.equal(receipt.packageHashVersion, "path-sha256-v1");
    assert.equal(receipt.revision, "rev-owned-agent-001");
    assert.equal(receipt.etag, '"rev-owned-agent-001"');
    const installRoot = path.join(userData, "cloud-agent-installs", "owned-agent");
    assert.equal(fs.readFileSync(path.join(installRoot, "AGENTS.md"), "utf8"), "# Owned Agent\n");
    const marker = JSON.parse(fs.readFileSync(path.join(installRoot, ".agentlas-cloud-package.json"), "utf8"));
    assert.equal(marker.packageHash, aggregate);
    assert.equal(marker.revision, "rev-owned-agent-001");
    assert.equal(marker.cloudAssets["owner-private"].cloudId, "cloud-owned-agent");
    await assert.rejects(
      execFileAsync(process.execPath, [bin, "cloud", "restore", "cross-slug", "--json"], { env }),
      (error) => /restore_slug_mismatch/.test(String(error.stderr || error)),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [bin, "cloud", "restore", "mismatched-envelope", "--json"], { env }),
      (error) => /invalid_restore_contract/.test(String(error.stderr || error)),
    );
    assert.equal(fs.existsSync(path.join(userData, "cloud-agent-installs", "cross-slug")), false);
    assert.equal(fs.existsSync(path.join(userData, "cloud-agent-installs", "mismatched-envelope")), false);
    await assert.rejects(
      execFileAsync(process.execPath, [bin, "install", "call-only-agent"], { env }),
      (error) => /call-only.*agentlas call call-only-agent/s.test(String(error.stderr || error)),
      "direct install must route invoke-only assets to the runtime call path",
    );
    assert.deepEqual(calls.map((call) => call.name), [
      "cargo.search_agents",
      "cargo.restore_package",
      "cargo.restore_package",
      "cargo.restore_package",
      "marketplace.get_manifest",
    ]);
    assert.ok(calls.every((call) => call.cookie === "agentlas_session=owner-session-fixture"));
    console.log("cloud owner list/restore: PASS");
  } finally {
    await close(server);
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
