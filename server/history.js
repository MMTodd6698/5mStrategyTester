export const SEED_US = 60_000_000;

let plotSinceUs = 0;

export function markPlotRestart(nowUs) {
  if (typeof nowUs === "number" && Number.isFinite(nowUs)) plotSinceUs = nowUs;
}

export function plotSince() {
  return plotSinceUs;
}

export function visibleHistory(points, key = "ts") {
  if (!plotSinceUs) return points.slice();
  return points.filter((point) => point && point[key] >= plotSinceUs);
}

export function keepRecent(points, nowTs, windowUs = SEED_US, key = "ts") {
  if (!points.length) return;
  const cutoff = nowTs - windowUs;
  let drop = 0;
  while (drop < points.length && points[drop][key] < cutoff) drop += 1;
  if (drop) points.splice(0, drop);
}

// History is unbounded until a hard restart.
export function trimAged() {}
