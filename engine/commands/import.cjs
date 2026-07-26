"use strict";
/* import — 로컬 에이전트/팀 폴더 임포트 (데스크탑 폴더 드래그와 동일 규칙). */
const { importLocalFolder } = require("../agents/import-local.cjs");

function run(ctx, args) {
  const ko = ctx.lang === "ko";
  const absPath = args[0];
  if (!absPath) {
    ctx.err(ko ? "사용법: agentlas import <폴더-경로>" : "Usage: agentlas import <folder-path>");
    return 1;
  }
  let r;
  try {
    r = importLocalFolder(ctx.db(), absPath);
  } catch (e) {
    ctx.err(String((e && e.message) || e));
    return 1;
  }
  ctx.out(`${r.updated ? (ko ? "업데이트됨" : "Updated") : (ko ? "가져옴" : "Imported")}: ${r.name}  (${r.kind})`);
  ctx.out(`  ${ko ? "슬러그" : "slug"}:    ${ctx.ui.accent(r.slug)}`);
  ctx.out(`  ${ko ? "런타임" : "runtime"}: ${r.runtime}  [${r.labels.join(", ")}]`);
  ctx.out(`  ${ko ? "경로" : "path"}:    ${r.path}`);
  if (r.firmSlug) {
    ctx.out(ko
      ? `  회사:    ${r.firmSlug}  (회사로 등록됨 — Desktop 사이드바 + 'agentlas firm ${r.firmSlug}')`
      : `  firm:    ${r.firmSlug}  (registered in Firms — Desktop sidebar + 'agentlas firm ${r.firmSlug}')`);
  }
  ctx.out("");
  ctx.out(ctx.ui.dim(ko
    ? `실행: agentlas ${r.slug} "..."   ·   agentlas run ${r.slug} "..."   (대상 프로젝트 폴더에서 실행)`
    : `Run: agentlas ${r.slug} "..."   ·   agentlas run ${r.slug} "..."   (run from the target project folder)`));
  return 0;
}

module.exports = { run };
