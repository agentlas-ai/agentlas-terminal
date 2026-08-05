// 결정적 좌→우 그래프 배치. **데스크탑 `shared/graph-layout.ts`의 미러다.**
//
// 왜 사본이 있나: 터미널은 독립 패키지라 데스크탑 소스를 임포트할 수 없다. 이 저장소는
// 같은 이유로 `interview.cjs`(청사진 컴파일러)도 이미 미러로 두고, **패리티 게이트**가
// 두 벌이 같은 판단을 하는지 대조한다(`test/graph-interview-parity.cjs`). 배치도 같은 규율:
// 여기서 바꾸면 데스크탑도 바꾸고, 게이트가 그 둘을 붙잡는다.
//
// ★규칙이 갈라지면 같은 그래프가 표면마다 다르게 그려지고, 사용자는 자기 자동화를
//   어느 쪽이 맞는지 알 수 없게 된다.
"use strict";

const COL_W = 280;
const ROW_H = 120;
const NODE_ORIGIN_X = 0;
const NODE_ORIGIN_Y = 120;

/** 노드 카드의 실측 크기 — 이보다 가까우면 화면에서 겹쳐 글자를 못 읽는다. */
const NODE_W = 230;
const NODE_H = 90;

/** 위상 순서로 각 노드에 컬럼 depth를 매긴다(진입 엣지 없는 노드 = depth 0). */
function computeDepths(graph) {
  const indeg = new Map();
  const adj = new Map();
  for (const n of graph.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges || []) {
    if (!indeg.has(e.target) || !adj.has(e.source)) continue; // dangling edge 방어
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
    adj.get(e.source).push(e.target);
  }
  const depth = new Map();
  const frontier = graph.nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  for (const id of frontier) depth.set(id, 0);
  const remaining = new Map(indeg);
  const queue = [...frontier];
  while (queue.length) {
    const id = queue.shift();
    const d = depth.get(id) || 0;
    for (const next of adj.get(id) || []) {
      depth.set(next, Math.max(depth.get(next) || 0, d + 1));
      const left = (remaining.get(next) == null ? 1 : remaining.get(next)) - 1;
      remaining.set(next, left);
      if (left <= 0) queue.push(next);
    }
  }
  // 사이클(반복 그래프) 등으로 depth 미할당된 노드는 순서 인덱스로 폴백.
  graph.nodes.forEach((n, i) => {
    if (!depth.has(n.id)) depth.set(n.id, i);
  });
  return depth;
}

/** 한 띠(band)에 넣을 컬럼 수 — 데스크탑 columnsPerBand와 같은 식. */
function columnsPerBand(totalCols) {
  if (totalCols <= 4) return totalCols;
  return Math.max(4, Math.ceil(Math.sqrt(totalCols * 2)));
}

/**
 * 그래프를 결정적 사행(蛇行) 배치로 재배치한 새 노드 배열.
 * 긴 사슬은 띠로 접어 좌→우 / 우→좌로 번갈아 흐르고(뱀 모양), 같은 컬럼은 세로 분산.
 * (일직선은 14단계에서 폭 4,000px가 되어 아무도 못 읽었다 — 실측 항목 3.)
 */
function layoutGraph(graph) {
  const depth = computeDepths(graph);
  const byCol = new Map();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) || 0;
    if (!byCol.has(d)) byCol.set(d, []);
    byCol.get(d).push(n);
  }
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  const colOrder = new Map(cols.map((c, i) => [c, i]));
  const totalCols = cols.length;
  const perBand = columnsPerBand(totalCols);

  const bandCount = Math.ceil(totalCols / perBand);
  const bandHeight = [];
  for (let b = 0; b < bandCount; b += 1) {
    let maxRows = 1;
    for (const [c, i] of colOrder) {
      if (Math.floor(i / perBand) === b) maxRows = Math.max(maxRows, byCol.get(c).length);
    }
    bandHeight.push(maxRows * ROW_H + ROW_H);
  }
  const bandTop = [];
  let acc = 0;
  for (let b = 0; b < bandCount; b += 1) { bandTop.push(acc); acc += bandHeight[b]; }

  const out = [];
  for (const [col, nodes] of byCol) {
    const i = colOrder.get(col) || 0;
    const band = Math.floor(i / perBand);
    let c = i % perBand;
    if (band % 2 === 1) c = perBand - 1 - c;
    const count = nodes.length;
    nodes.forEach((n, row) => {
      const offset = (row - (count - 1) / 2) * ROW_H;
      out.push({
        ...n,
        position: {
          x: NODE_ORIGIN_X + c * COL_W,
          y: NODE_ORIGIN_Y + bandTop[band] + (bandHeight[band] - ROW_H) / 2 + offset,
        },
      });
    });
  }
  // 원래 순서 보존(렌더러 key 안정).
  const orderIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));
  out.sort((a, b) => (orderIndex.get(a.id) || 0) - (orderIndex.get(b.id) || 0));
  return out;
}

/**
 * 재배치가 필요한가 — **실제로 겹치는가**로 판단한다.
 * ★예전에는 좌표가 완전히 같을 때만 재배치해서, 검증을 +70·갈림길을 +140만 띄운
 *   그래프(노드 폭 230)가 "다른 좌표"라 통과했고 카드가 서로 가렸다(실측 2026-08-05).
 */
function needsLayout(graph) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length <= 1) return false;
  const placed = graph.nodes.map((n) => ({
    x: Math.round((n.position && n.position.x) || 0),
    y: Math.round((n.position && n.position.y) || 0),
  }));
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (Math.abs(placed[i].x - placed[j].x) < NODE_W
        && Math.abs(placed[i].y - placed[j].y) < NODE_H) return true;
    }
  }
  return false;
}

module.exports = { layoutGraph, needsLayout, columnsPerBand, COL_W, ROW_H, NODE_W, NODE_H };
