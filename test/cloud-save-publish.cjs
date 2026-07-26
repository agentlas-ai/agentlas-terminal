#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-save-publish-"));
process.env.AGENTLAS_USER_DATA_DIR = path.join(tempDir, "user-data");
process.env.AGENTLAS_SESSION = "test-owner-session";

// v2: 모놀리스(engine/agentlas.cjs) 대신 모듈 경계에서 같은 이름을 가져온다. 단언은 v1 그대로.
const { cloudHashPackage, cloudPortablePathConflict } = require("../engine/hub/install.cjs");
const {
  cloudPortableExecutableForFile,
  packageCloudAgent: packageCloudAgentCli,
} = require("../engine/cloud-assets/package.cjs");
const {
  cloudActionForTopLevelUpload,
  cloudVisibilityForAction,
} = require("../engine/cloud-assets/commands.cjs");

function writePrivateNotes(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "notes.md"), "Owner-private agent working notes.\n", "utf8");
  fs.writeFileSync(path.join(root, "asset.bin"), Buffer.from([0x00, 0xff, 0x81, 0x41, 0x00]));
  fs.writeFileSync(path.join(root, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(path.join(root, "run.sh"), 0o700);
  fs.writeFileSync(path.join(root, ".agentlas-cloud-package.json"), JSON.stringify({
    packageHash: "local-only-marker",
    packageHashVersion: "path-sha256-executable-v2",
    executablePaths: ["run.sh"],
  }));
}

function writePublicAgent(root) {
  writePrivateNotes(root);
  fs.mkdirSync(path.join(root, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Public Test Agent\n\nRun the public test task.\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".agentlas", "routing-card.json"),
    JSON.stringify({
      schemaVersion: "routing-card/2.0",
      id: "public-test-agent",
      type: "agent",
      name: "Public Test Agent",
      summary: "Routes public test requests.",
      capabilities: ["public_test"],
      routing_status: "routing_ready",
    }, null, 2) + "\n",
    "utf8",
  );
  // 데스크탑 package.ts:435-449 동형 게이트: 공개 Hub 발행은 검증된 EN/KO 메타데이터 필수.
  fs.writeFileSync(
    path.join(root, ".agentlas", "agent-card.json"),
    JSON.stringify({
      name: "Public Test Agent",
      localized: {
        titleEn: "Public Test Agent",
        titleKo: "공개 테스트 에이전트",
        descriptionEn: "Runs the public test task.",
        descriptionKo: "공개 테스트 작업을 실행합니다.",
      },
    }, null, 2) + "\n",
    "utf8",
  );
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

(async () => {
  const requests = [];
  const requestHeaders = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requestHeaders.push(req.headers);
      if (requests.at(-1).manifest.slug === "invalid-receipt-agent") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cloudId: "synthetic-success-must-not-be-accepted" }));
        return;
      }
      const revision = `rev-${requests.length}-${requests.at(-1).manifest.packageHash.slice(0, 16)}`;
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        etag: `"${revision}"`,
      });
      res.end(JSON.stringify({
        schema: "agentlas.agent_cloud.registration.v1",
        operation: "created",
        source: requests.at(-1).visibility === "marketplace" ? "hub" : "agent-cloud",
        visibility: requests.at(-1).visibility === "marketplace" ? "marketplace" : "owner-private",
        scope: requests.at(-1).visibility === "marketplace" ? "hub-public" : "owner-private",
        owner: true,
        publicHubPublished: requests.at(-1).visibility === "marketplace",
        cloudId: `cloud-test-${requests.length}`,
        slug: requests.at(-1).manifest.slug,
        packageHash: requests.at(-1).manifest.packageHash,
        packageHashVersion: requests.at(-1).manifest.packageHashVersion,
        revision,
        url: `http://agent-cloud.test/owned/${requests.at(-1).manifest.slug}`,
        marketplaceUrl: requests.at(-1).visibility === "marketplace"
          ? `http://agent-cloud.test/hub/${requests.at(-1).manifest.slug}`
          : undefined,
        registeredAt: new Date().toISOString(),
        dryRun: false,
      }));
    });
  });

  try {
    const address = await listen(server);
    process.env.AGENTLAS_WEB_BASE_URL = `http://127.0.0.1:${address.port}`;

    assert.equal(cloudVisibilityForAction("package", { _: [] }), "private-link");
    assert.equal(cloudVisibilityForAction("save", { _: [] }), "private-link");
    assert.equal(cloudVisibilityForAction("save", { _: [], visibility: "private-link" }), "private-link");
    assert.equal(cloudVisibilityForAction("publish", { _: [] }), "marketplace");
    assert.equal(cloudVisibilityForAction("publish", { _: [], visibility: "marketplace" }), "marketplace");
    assert.throws(
      () => cloudVisibilityForAction("save", { _: [], visibility: "marketplace" }),
      /owner-private/,
    );
    assert.throws(
      () => cloudVisibilityForAction("publish", { _: [], visibility: "private-link" }),
      /public Hub publication/,
    );
    assert.equal(cloudActionForTopLevelUpload(["/tmp/agent"]), "save");
    assert.equal(cloudActionForTopLevelUpload(["/tmp/agent", "--visibility", "private-link"]), "save");
    assert.equal(cloudActionForTopLevelUpload(["/tmp/agent", "--visibility", "marketplace"]), "publish");

    const privateRoot = path.join(tempDir, "private-notes-only");
    writePrivateNotes(privateRoot);
    const privateDryRun = await packageCloudAgentCli(null, privateRoot, {
      dryRun: true,
      llmReview: true,
    });
    assert.equal(privateDryRun.status, "dry-run");
    assert.equal(privateDryRun.manifest.visibility, "private-link");
    assert.equal(privateDryRun.review.mode, "static-only");
    assert.equal(privateDryRun.review.costOwner, "none");
    assert.equal(privateDryRun.review.verdict, "pass");
    assert.equal(privateDryRun.review.findings.some((finding) => finding.id === "missing-agent-definition"), false);
    assert.equal(privateDryRun.review.findings.some((finding) => finding.id.startsWith("routing-card")), false);
    const privateBundle = JSON.parse(fs.readFileSync(privateDryRun.bundlePath, "utf8"));
    assert.equal(privateBundle.manifest.packageHashVersion, "path-sha256-executable-v2");
    assert.equal(
      privateBundle.manifest.packageHash,
      cloudHashPackage(privateBundle.files, privateBundle.manifest.packageHashVersion),
    );
    assert.equal(
      privateBundle.manifest.rootFingerprint,
      crypto.createHash("sha256").update(`agentlas-package-root:${privateBundle.manifest.packageHash}`).digest("hex"),
      "root fingerprint must be content-derived and match Desktop",
    );
    const binary = privateBundle.files.find((file) => file.path === "asset.bin");
    assert.deepEqual(Buffer.from(binary.contentBase64, "base64"), Buffer.from([0x00, 0xff, 0x81, 0x41, 0x00]));
    assert.equal(binary.executable, false);
    assert.equal(privateBundle.files.find((file) => file.path === "run.sh")?.executable, true);
    assert.equal(privateBundle.files.some((file) => file.path === ".agentlas-cloud-package.json"), false);

    // Experience lineage is local, rebuildable, and owned separately from the
    // immutable base Agent package. Canonical, backup, and crash-safe hidden
    // temp siblings must neither ship nor perturb the base package hash.
    const lineageDir = path.join(privateRoot, ".agentlas");
    fs.mkdirSync(lineageDir, { recursive: true });
    const lineagePaths = [
      "experience-relations.jsonl",
      "experience-relations.jsonl.previous",
      ".experience-relations.jsonl.1234.tmp",
      ".experience-relations.jsonl.tmp-recovery",
    ];
    for (const [index, name] of lineagePaths.entries()) {
      fs.writeFileSync(path.join(lineageDir, name), `private-lineage-${index}\n`, "utf8");
    }
    const lineageExcluded = await packageCloudAgentCli(null, privateRoot, { dryRun: true, llmReview: false });
    const lineageBundle = JSON.parse(fs.readFileSync(lineageExcluded.bundlePath, "utf8"));
    assert.equal(lineageBundle.manifest.packageHash, privateBundle.manifest.packageHash, "local lineage must not change the base hash");
    for (const name of lineagePaths) {
      assert.equal(lineageBundle.files.some((file) => file.path === `.agentlas/${name}`), false, `${name} must not ship`);
      assert.equal(lineageExcluded.files.find((file) => file.path === `.agentlas/${name}`)?.reason, "experience-lineage-separate-asset");
      fs.appendFileSync(path.join(lineageDir, name), "changed-without-base-release\n", "utf8");
    }
    const lineageChanged = await packageCloudAgentCli(null, privateRoot, { dryRun: true, llmReview: false });
    assert.equal(lineageChanged.manifest.packageHash, privateBundle.manifest.packageHash, "lineage mutation must not create a new base release identity");
    assert.equal(
      cloudHashPackage([...privateBundle.files, {
        path: ".agentlas/experience-relations.jsonl.previous",
        sha256: "f".repeat(64),
        executable: false,
      }], privateBundle.manifest.packageHashVersion),
      privateBundle.manifest.packageHash,
      "hash helper must defensively omit local Experience lineage siblings",
    );
    assert.equal(
      cloudPortablePathConflict(["Skills/writer/SKILL.md", "skills/reviewer/SKILL.md"])?.code,
      "path-alias-collision",
    );
    assert.equal(
      cloudPortablePathConflict(["Caf\u00e9/a.md", "Cafe\u0301/b.md"])?.code,
      "path-alias-collision",
    );
    assert.equal(
      cloudPortableExecutableForFile("run.sh", 0, new Set(["run.sh"]), "win32"),
      true,
      "Windows re-save must recover the portable bit from restore metadata",
    );

    const symlinkRoot = path.join(tempDir, "private-symlink-agent");
    writePrivateNotes(symlinkRoot);
    const outsideFile = path.join(tempDir, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "must not follow this link\n", "utf8");
    fs.symlinkSync(outsideFile, path.join(symlinkRoot, "outside-link.txt"));
    const symlinkBlocked = await packageCloudAgentCli(null, symlinkRoot, {
      dryRun: true,
      llmReview: false,
    });
    assert.equal(symlinkBlocked.status, "blocked");
    assert.ok(symlinkBlocked.review.findings.some((finding) => finding.id.startsWith("symlink-")));

    const rootSymlink = path.join(tempDir, "private-root-link");
    try {
      fs.symlinkSync(privateRoot, rootSymlink, "dir");
      await assert.rejects(
        packageCloudAgentCli(null, rootSymlink, { dryRun: true, llmReview: false }),
        /Not a real directory/,
      );
    } catch (error) {
      if (!error || !["EPERM", "EACCES"].includes(error.code)) throw error;
    }

    const outsideRaceSecret = path.join(tempDir, "outside-race-secret.txt");
    fs.writeFileSync(outsideRaceSecret, "glpat-abcdefghijklmnopqrstuvwxyz123456\n", "utf8");
    const swapRoot = path.join(tempDir, "file-swap-agent");
    writePrivateNotes(swapRoot);
    const swapTarget = path.join(swapRoot, "zz-race.txt");
    fs.writeFileSync(swapTarget, "safe captured bytes\n", "utf8");
    const originalOpenSync = fs.openSync;
    let fileSwapped = false;
    fs.openSync = function patchedOpenSync(file, flags, ...rest) {
      if (!fileSwapped && String(file).endsWith(`${path.sep}zz-race.txt`)) {
        fileSwapped = true;
        fs.renameSync(swapTarget, `${swapTarget}.original`);
        fs.symlinkSync(outsideRaceSecret, swapTarget);
      }
      return originalOpenSync.call(fs, file, flags, ...rest);
    };
    let swapBlocked;
    try {
      swapBlocked = await packageCloudAgentCli(null, swapRoot, { dryRun: true, llmReview: false });
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(swapBlocked.status, "blocked", JSON.stringify(swapBlocked.review.findings));
    assert.ok(swapBlocked.review.findings.some((finding) => finding.id.startsWith("unstable-file")));
    const swapBundle = JSON.parse(fs.readFileSync(swapBlocked.bundlePath, "utf8"));
    assert.equal(JSON.stringify(swapBundle).includes(Buffer.from("glpat-abcdefghijklmnopqrstuvwxyz123456\n").toString("base64")), false);

    const growthRoot = path.join(tempDir, "file-growth-agent");
    writePrivateNotes(growthRoot);
    const growthTarget = path.join(growthRoot, "zz-growth.txt");
    fs.writeFileSync(growthTarget, "stable start\n", "utf8");
    const originalReadSync = fs.readSync;
    let growthFd = null;
    let grew = false;
    fs.openSync = function captureGrowthFd(file, flags, ...rest) {
      const fd = originalOpenSync.call(fs, file, flags, ...rest);
      if (String(file).endsWith(`${path.sep}zz-growth.txt`) && (Number(flags) & 3) === fs.constants.O_RDONLY) growthFd = fd;
      return fd;
    };
    fs.readSync = function growAfterFirstRead(fd, ...args) {
      const read = originalReadSync.call(fs, fd, ...args);
      if (!grew && fd === growthFd && read > 0) {
        grew = true;
        const appendFd = originalOpenSync(growthTarget, fs.constants.O_WRONLY | fs.constants.O_APPEND);
        try { fs.writeSync(appendFd, Buffer.from("changed during scan\n")); } finally { fs.closeSync(appendFd); }
      }
      return read;
    };
    let growthBlocked;
    try {
      growthBlocked = await packageCloudAgentCli(null, growthRoot, { dryRun: true, llmReview: false });
    } finally {
      fs.openSync = originalOpenSync;
      fs.readSync = originalReadSync;
    }
    assert.equal(growthBlocked.status, "blocked");
    assert.ok(growthBlocked.review.findings.some((finding) => finding.id.startsWith("unstable-file")));

    const directorySwapRoot = path.join(tempDir, "directory-swap-agent");
    writePrivateNotes(directorySwapRoot);
    const nested = path.join(directorySwapRoot, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "safe.txt"), "safe\n", "utf8");
    const outsideDirectory = path.join(tempDir, "outside-directory");
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(outsideDirectory, "safe.txt"), "outside must not enter\n", "utf8");
    const originalReadDirSync = fs.readdirSync;
    let directorySwapped = false;
    fs.readdirSync = function swapDirectoryAfterListing(dir, options) {
      const entries = originalReadDirSync.call(fs, dir, options);
      if (!directorySwapped && String(dir).endsWith(`${path.sep}directory-swap-agent`)) {
        directorySwapped = true;
        fs.renameSync(nested, `${nested}.original`);
        fs.symlinkSync(outsideDirectory, nested, "dir");
      }
      return entries;
    };
    let directoryBlocked;
    try {
      directoryBlocked = await packageCloudAgentCli(null, directorySwapRoot, { dryRun: true, llmReview: false });
    } finally {
      fs.readdirSync = originalReadDirSync;
    }
    assert.equal(directoryBlocked.status, "blocked");
    assert.ok(directoryBlocked.review.findings.some((finding) => /unsafe-directory|unstable-directory/.test(finding.id)));

    if (process.platform !== "win32") {
      const fifoRoot = path.join(tempDir, "fifo-agent");
      writePrivateNotes(fifoRoot);
      execFileSync("mkfifo", [path.join(fifoRoot, "blocked.pipe")]);
      const fifoBlocked = await packageCloudAgentCli(null, fifoRoot, { dryRun: true, llmReview: false });
      assert.equal(fifoBlocked.status, "blocked");
      assert.ok(fifoBlocked.review.findings.some((finding) => finding.id.startsWith("unsupported-entry")));
    }

    const requestsBeforeSecretGates = requests.length;
    const unquotedSecretRoot = path.join(tempDir, "unquoted-secret-agent");
    writePrivateNotes(unquotedSecretRoot);
    fs.writeFileSync(path.join(unquotedSecretRoot, "config.yaml"), "password: hunter2secret\n", "utf8");
    const unquotedSecret = await packageCloudAgentCli(null, unquotedSecretRoot, { dryRun: false, llmReview: false });
    assert.equal(unquotedSecret.status, "blocked");
    assert.ok(unquotedSecret.review.findings.some((finding) => finding.id.startsWith("generic-unquoted-secret")));

    const utf16SecretRoot = path.join(tempDir, "utf16-secret-agent");
    writePrivateNotes(utf16SecretRoot);
    fs.writeFileSync(
      path.join(utf16SecretRoot, "settings.ps1"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("api_key=unquoted-secret-value-123456\r\n", "utf16le")]),
    );
    const utf16Secret = await packageCloudAgentCli(null, utf16SecretRoot, { dryRun: false, llmReview: false });
    assert.equal(utf16Secret.status, "blocked");

    const bomlessUtf16SecretRoot = path.join(tempDir, "bomless-utf16-secret-agent");
    writePrivateNotes(bomlessUtf16SecretRoot);
    fs.writeFileSync(
      path.join(bomlessUtf16SecretRoot, "opaque.payload"),
      Buffer.from(`${"A".repeat(5000)}\napi_key=unquoted-secret-value-123456\n`, "utf16le"),
    );
    const bomlessUtf16Secret = await packageCloudAgentCli(null, bomlessUtf16SecretRoot, { dryRun: false, llmReview: false });
    assert.equal(bomlessUtf16Secret.status, "blocked");

    const binarySecretRoot = path.join(tempDir, "binary-secret-agent");
    writePrivateNotes(binarySecretRoot);
    fs.writeFileSync(path.join(binarySecretRoot, "opaque.payload"), Buffer.from([0x00, ...Buffer.from("glpat-abcdefghijklmnopqrstuvwxyz123456"), 0xff]));
    const binarySecret = await packageCloudAgentCli(null, binarySecretRoot, { dryRun: false, llmReview: false });
    assert.equal(binarySecret.status, "blocked");
    assert.ok(binarySecret.review.findings.some((finding) => finding.id.startsWith("gitlab-token")));
    assert.equal(requests.length, requestsBeforeSecretGates, "blocked secret packages must perform zero registration fetches");

    const placeholderRoot = path.join(tempDir, "placeholder-agent");
    writePrivateNotes(placeholderRoot);
    fs.writeFileSync(path.join(placeholderRoot, "config.yaml"), "password: configure_on_this_machine\napi_key: ${API_KEY}\n", "utf8");
    const placeholderPackage = await packageCloudAgentCli(null, placeholderRoot, { dryRun: true, llmReview: false });
    assert.equal(placeholderPackage.status, "dry-run");

    const privateSaved = await packageCloudAgentCli(null, privateRoot, {
      dryRun: false,
      llmReview: false,
    });
    assert.equal(privateSaved.status, "registered");
    assert.match(privateSaved.summary, /Saved .* privately in Agent Cloud/);

    const invalidReceiptRoot = path.join(tempDir, "invalid-receipt-agent");
    writePrivateNotes(invalidReceiptRoot);
    await assert.rejects(
      packageCloudAgentCli(null, invalidReceiptRoot, {
        slug: "invalid-receipt-agent",
        dryRun: false,
        llmReview: false,
      }),
      /invalid or mismatched registration receipt/,
      "malformed HTTP 2xx must never become synthetic registration success",
    );

    const publicWithoutRoutingRoot = path.join(tempDir, "public-without-routing");
    fs.mkdirSync(publicWithoutRoutingRoot, { recursive: true });
    fs.writeFileSync(path.join(publicWithoutRoutingRoot, "AGENTS.md"), "# Missing Routing\n", "utf8");
    const publicBlocked = await packageCloudAgentCli(null, publicWithoutRoutingRoot, {
      visibility: "marketplace",
      dryRun: true,
      llmReview: false,
    });
    assert.equal(publicBlocked.status, "blocked");
    assert.ok(publicBlocked.review.findings.some((finding) => finding.id === "routing-card-required"));
    // 데스크탑 package.ts:435-449 동형: EN/KO 메타데이터 없는 공개 발행은 blocker.
    const localizedFinding = publicBlocked.review.findings.find((finding) => finding.id === "localized-metadata-required");
    assert.ok(localizedFinding, "public publish without bilingual metadata must be blocked");
    assert.match(localizedFinding.message, /Public Hub metadata needs verified English and Korean fields/);

    const publicRoot = path.join(tempDir, "public-agent");
    writePublicAgent(publicRoot);
    const publicPublished = await packageCloudAgentCli(null, publicRoot, {
      visibility: "marketplace",
      dryRun: false,
      llmReview: false,
    });
    assert.equal(publicPublished.status, "registered");
    assert.match(publicPublished.summary, /Published .* publicly to Agentlas Hub/);

    const publicCareerRoot = path.join(tempDir, "public-career-agent");
    writePublicAgent(publicCareerRoot);
    const rawCareerCard = {
      kind: "agentlas-public-career-card",
      schemaVersion: "1",
      projectName: "Career fixture",
      privacy: {
        rawLocalPathsIncluded: false,
        rawPromptsIncluded: false,
        rawTranscriptsIncluded: false,
        sourceTextIncluded: false,
      },
      counts: { evidence: 3 },
      generatorInternal: { rawSourceId: "must-not-leave-host" },
    };
    fs.writeFileSync(
      path.join(publicCareerRoot, ".agentlas", "public-career-card.json"),
      JSON.stringify(rawCareerCard, null, 2) + "\n",
      "utf8",
    );
    const publicCareer = await packageCloudAgentCli(null, publicCareerRoot, {
      visibility: "marketplace",
      dryRun: true,
      llmReview: false,
    });
    assert.equal(publicCareer.status, "dry-run");
    const publicCareerBundle = JSON.parse(fs.readFileSync(publicCareer.bundlePath, "utf8"));
    const sanitizedCareerFile = publicCareerBundle.files.find((file) => file.path === ".agentlas/public-career-card.json");
    assert.ok(sanitizedCareerFile);
    const sanitizedCareer = JSON.parse(Buffer.from(sanitizedCareerFile.contentBase64, "base64").toString("utf8"));
    assert.equal("generatorInternal" in sanitizedCareer, false);
    assert.deepEqual(sanitizedCareer, publicCareerBundle.manifest.careerGraph);
    assert.deepEqual(sanitizedCareer, publicCareerBundle.careerGraph);

    const requestsBeforeLeakyCareer = requests.length;
    const leakyCareerRoot = path.join(tempDir, "leaky-career-agent");
    writePublicAgent(leakyCareerRoot);
    fs.writeFileSync(
      path.join(leakyCareerRoot, ".agentlas", "public-career-card.json"),
      JSON.stringify({ ...rawCareerCard, generatorInternal: { sourcePath: "/Users/private/career.sqlite" } }, null, 2) + "\n",
      "utf8",
    );
    const leakyCareer = await packageCloudAgentCli(null, leakyCareerRoot, {
      visibility: "marketplace",
      dryRun: false,
      llmReview: false,
    });
    assert.equal(leakyCareer.status, "blocked");
    assert.ok(leakyCareer.review.findings.some((finding) => finding.id === "career-card-local-path"));
    const leakyCareerBundle = JSON.parse(fs.readFileSync(leakyCareer.bundlePath, "utf8"));
    assert.equal(leakyCareerBundle.files.some((file) => file.path === ".agentlas/public-career-card.json"), false);
    assert.equal(requests.length, requestsBeforeLeakyCareer, "blocked Career Graph packages must perform zero registration fetches");

    const secretRoot = path.join(tempDir, "secret-agent");
    writePrivateNotes(secretRoot);
    fs.writeFileSync(path.join(secretRoot, ".env"), "TOKEN=not-a-real-secret-for-tests\n", "utf8");
    const secretBlocked = await packageCloudAgentCli(null, secretRoot, {
      dryRun: true,
      llmReview: false,
    });
    assert.equal(secretBlocked.status, "blocked");
    assert.ok(secretBlocked.review.findings.some((finding) => finding.category === "secret"));

    assert.equal(requests.length, 3);
    assert.equal(requests[0].visibility, "private-link");
    assert.equal(requests[0].manifest.visibility, "private-link");
    assert.equal(requests[0].manifest.packageHashVersion, "path-sha256-executable-v2");
    assert.equal(requests[0].manifest.routingCard, undefined);
    assert.equal(requestHeaders[0]["if-none-match"], "*");
    assert.equal(requestHeaders[0]["if-match"], undefined);
    assert.equal(requests[2].visibility, "marketplace");
    assert.equal(requests[2].manifest.visibility, "marketplace");
    assert.equal(requests[2].manifest.routingCard.schemaVersion, "routing-card/2.0");

    console.log("cloud private-save/public-publish: PASS");
  } finally {
    await close(server).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
