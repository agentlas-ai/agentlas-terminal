"use strict";

const fs = require("node:fs");
const path = require("node:path");

const terminalRoot = path.resolve(__dirname, "..");
const compiledManifest = path.resolve(
  terminalRoot,
  "../agentlas_desktop/dist/electron/architecture/manifest.js",
);
if (!fs.existsSync(compiledManifest)) {
  throw new Error("Build Agentlas Desktop Electron first: npm run build:electron");
}

const source = require(compiledManifest);
const target = path.join(terminalRoot, "engine/architecture.data.json");
const current = JSON.parse(fs.readFileSync(target, "utf8"));
const bySlug = new Map(source.BUILTIN_AGENTS.map((agent) => [agent.slug, agent]));
const nextAgents = current.agents.map((stored) => {
  const canonical = bySlug.get(stored.slug);
  if (!canonical) throw new Error(`Desktop architecture no longer defines ${stored.slug}`);
  return {
    ...stored,
    name: canonical.name,
    nameEn: canonical.nameEn,
    tagline: canonical.tagline,
    taglineEn: canonical.taglineEn,
    role: canonical.role,
    visibility: canonical.visibility,
    tone: canonical.tone,
    systemPrompt: canonical.systemPrompt,
  };
});
const next = {
  ...current,
  version: source.ARCHITECTURE_VERSION,
  emitterBlock: source.MEMORY_EMITTER_BLOCK,
  eventsHeading: source.MEMORY_EVENTS_HEADING,
  agents: nextAgents,
};
fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
process.stdout.write(`Synced architecture ${next.version} (${nextAgents.length} built-ins)\n`);
