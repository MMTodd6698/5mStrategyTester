import { LOCAL_CACHE_US, MARKET_US, SERIES } from "./chart.js";
import { DEFAULT_SECONDS, MIN_SECONDS, formatTradeTime } from "./format.js";

const CACHE_KEY = "market-chart-cache-v1";
const WIDTH_KEY = "market-chart-width-v1";

export function loadPlotSeconds() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    if (!Number.isFinite(value)) return DEFAULT_SECONDS;
    return Math.max(MIN_SECONDS, value);
  } catch {
    return DEFAULT_SECONDS;
  }
}

export function savePlotSeconds(seconds) {
  try {
    localStorage.setItem(WIDTH_KEY, String(seconds));
  } catch {
    // Ignore private-mode / quota failures.
  }
}

export function loadChartCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const savedAt = Number(parsed.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > LOCAL_CACHE_US / 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveChartCache(payload) {
  try {
    const now = Date.now();
    const cutoff = now * 1000 - LOCAL_CACHE_US;
    const points = {};
    for (const series of SERIES) {
      const rows = Array.isArray(payload.points?.[series.id]) ? payload.points[series.id] : [];
      points[series.id] = rows.filter((point) => point && point.t >= cutoff);
    }
    const poly = {
      bid: (payload.poly?.bid || []).filter((point) => point && point.t >= cutoff),
      ask: (payload.poly?.ask || []).filter((point) => point && point.t >= cutoff),
      fair: (payload.poly?.fair || []).filter((point) => point && point.t >= cutoff),
    };
    const trades = (payload.trades || []).filter((mark) => mark && mark.t >= cutoff);
    const strikes = (payload.strikes || []).filter((row) => row && row.end >= cutoff);
    const basisSteps = (payload.basisSteps || []).filter((row) => row && row.t >= cutoff);
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        coin: payload.coin,
        savedAt: now,
        points,
        poly,
        trades,
        strikes,
        basisSteps,
      }),
    );
  } catch {
    // Quota or private mode — live server history still covers refresh while the process is up.
  }
}

export function hydrateChartCache(cached, refs) {
  const { points, polyPoints, tradesRef, strikesRef, basisStepsRef, latestRef, polyRef, fairRef, basisRef } = refs;
  for (const series of SERIES) {
    const rows = Array.isArray(cached.points?.[series.id]) ? cached.points[series.id] : [];
    points[series.id] = rows
      .filter((point) => point && typeof point.t === "number" && typeof point.y === "number")
      .map((point) => ({ t: point.t, raw: point.raw ?? point.y, y: point.y }))
      .sort((a, b) => a.t - b.t);
    const last = points[series.id][points[series.id].length - 1];
    if (last) latestRef.current[series.id] = { mid: last.raw ?? last.y, ts: last.t };
  }
  for (const id of ["bid", "ask", "fair"]) {
    const rows = Array.isArray(cached.poly?.[id]) ? cached.poly[id] : [];
    polyPoints[id] = rows
      .filter((point) => point && typeof point.t === "number")
      .map((point) => ({ t: point.t, y: point.y ?? null, slug: point.slug ?? "" }))
      .sort((a, b) => a.t - b.t);
  }
  const lastBid = polyPoints.bid[polyPoints.bid.length - 1];
  const lastAsk = polyPoints.ask[polyPoints.ask.length - 1];
  if (lastBid || lastAsk) {
    polyRef.current = {
      ts: Math.max(lastBid?.t || 0, lastAsk?.t || 0),
      bid: lastBid?.y ?? null,
      ask: lastAsk?.y ?? null,
      slug: lastBid?.slug || lastAsk?.slug || "",
    };
  }
  const lastFair = polyPoints.fair[polyPoints.fair.length - 1];
  if (lastFair && lastFair.y != null) fairRef.current = lastFair.y;
  tradesRef.current = (cached.trades || [])
    .filter((mark) => mark && typeof mark.t === "number" && typeof mark.price === "number")
    .map((mark) => ({
      key: mark.key || `${mark.t}-${mark.side}-${mark.price}-${mark.quantity}-${mark.start}`,
      t: mark.t,
      y: mark.y ?? mark.price,
      side: mark.side,
      start: mark.start,
      strike: mark.strike,
      price: mark.price,
      quantity: mark.quantity,
      fee: typeof mark.fee === "number" && mark.fee > 0 ? mark.fee : 0,
    }))
    .sort((a, b) => a.t - b.t);
  strikesRef.current = (cached.strikes || [])
    .filter((row) => row && typeof row.t === "number" && row.y != null)
    .map((row) => ({ t: row.t, end: row.end ?? row.t + MARKET_US, y: row.y }))
    .sort((a, b) => a.t - b.t);
  basisStepsRef.current = (cached.basisSteps || [])
    .filter((row) => row && typeof row.t === "number" && typeof row.basis === "number")
    .map((row) => ({ t: row.t, basis: row.basis }))
    .sort((a, b) => a.t - b.t);
  const latestBasis = basisStepsRef.current[basisStepsRef.current.length - 1];
  basisRef.current = latestBasis ? { basis: latestBasis.basis, ts: latestBasis.t } : null;
}

export function syncTradeRowsFromRef(tradesRef, setTradeRows) {
  const rows = [...tradesRef.current]
    .sort((a, b) => b.t - a.t)
    .map((mark) => ({
      key: mark.key,
      price: mark.price,
      quantity: mark.quantity,
      side: mark.side,
      fee: mark.fee ?? 0,
      time: formatTradeTime(mark.t),
    }));
  setTradeRows(rows);
}
