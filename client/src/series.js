import { MARKET_US, SERIES } from "./chart.js";
import { DEFAULT_SECONDS } from "./format.js";

const serverClock = { offset: 0, synced: false };

export function blankLatest() {
  return Object.fromEntries(SERIES.map((series) => [series.id, null]));
}

export function blankShown() {
  return Object.fromEntries(SERIES.map((series) => [series.id, null]));
}

export function blankPoints() {
  return Object.fromEntries(SERIES.map((series) => [series.id, []]));
}

function browserNowUs() {
  return (performance.timeOrigin + performance.now()) * 1000;
}

export function noteServerUs(ts) {
  const sample = ts - browserNowUs();
  if (!serverClock.synced || sample > serverClock.offset) {
    serverClock.offset = sample;
    serverClock.synced = true;
  }
}

export function nowUs() {
  return browserNowUs() + serverClock.offset;
}

export function measureHistorySeconds(points, polyPoints, trades) {
  let minT = Infinity;
  let maxT = -Infinity;
  const note = (t) => {
    if (typeof t !== "number" || !Number.isFinite(t)) return;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  };
  for (const series of SERIES) {
    for (const point of points[series.id] || []) note(point.t);
  }
  for (const id of ["bid", "ask", "fair"]) {
    for (const point of polyPoints[id] || []) note(point.t);
  }
  for (const mark of trades || []) note(mark.t);
  if (!(maxT > minT)) return DEFAULT_SECONDS;
  return Math.max(DEFAULT_SECONDS, (maxT - minT) / 1_000_000);
}

export function pushPoly(series, ts, y, slug) {
  let last = series[series.length - 1];
  if (last && ts < last.t) return;
  if (last && last.slug !== slug && last.y != null) {
    series.push({ t: ts, y: null, slug });
    last = series[series.length - 1];
  }
  if (y == null) {
    if (!last || last.y != null) series.push({ t: ts, y: null, slug });
  } else if (!last || last.t !== ts || last.y !== y || last.slug !== slug) {
    series.push({ t: ts, y, slug });
  }
}

export function freezeBasis(points, stepsRef, basisRef) {
  const chain = points["chainlink-twap"];
  const perps = points["binance-perps-twap"];
  const steps = stepsRef.current;
  if (!chain?.length || !perps?.length) return;
  const firstPerps = perps[0].t;
  const lastPerps = perps[perps.length - 1].t;
  const lastFrozen = steps.length ? steps[steps.length - 1].t : -Infinity;
  let lo = 0;
  let hi = chain.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chain[mid].t <= lastFrozen) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < chain.length; i += 1) {
    const link = chain[i];
    if (link.t < firstPerps) continue;
    if (link.t > lastPerps) break;
    const match = closestByTime(perps, link.t);
    const perpsMid = match?.raw ?? match?.y;
    if (perpsMid == null) break;
    steps.push({ t: link.t, basis: perpsMid - link.y });
  }
  let drop = 0;
  while (drop + 1 < steps.length && steps[drop + 1].t <= firstPerps) drop += 1;
  if (drop) steps.splice(0, drop);
  const latest = steps[steps.length - 1];
  basisRef.current = latest ? { basis: latest.basis, ts: latest.t } : null;
}

export function noteStrike(ts, mid, strikes) {
  if (ts % MARKET_US !== 0) return;
  const found = strikes.find((strike) => strike.t === ts);
  if (found) {
    found.y = mid;
    return;
  }
  strikes.push({ t: ts, end: ts + MARKET_US, y: mid });
  strikes.sort((a, b) => a.t - b.t);
}

export function stampBasis(point, steps) {
  const basis = basisAsOf(steps, point.t);
  point.y = basis == null ? null : point.raw - basis;
}

export function lastPlotted(series) {
  if (!series?.length) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].y != null) return series[i].y;
  }
  return null;
}

function basisAsOf(steps, t) {
  if (!steps?.length) return null;
  let lo = 0;
  let hi = steps.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? null : steps[found].basis;
}

function closestByTime(series, t) {
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const next = series[lo];
  const prev = lo > 0 ? series[lo - 1] : null;
  if (!prev) return next;
  return Math.abs(prev.t - t) <= Math.abs(next.t - t) ? prev : next;
}
