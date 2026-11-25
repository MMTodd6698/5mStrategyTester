import WebSocket from "ws";
import { settings } from "./settings.js";
import { keepRecent, SEED_US, trimAged, visibleHistory } from "./history.js";
import { onQuote } from "./tyo.js";

const WS_URL = "wss://ws-live-data.polymarket.com";
const TOPIC = "crypto_prices_twap_sixty";
const SYMBOL = settings.chainlink;

const points = [];
const listeners = new Set();
let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let backoff = 1000;
let stopped = false;

const PERPS_WINDOW_US = 60_000_000;
const perpsSamples = [];
const perpsPoints = [];
const perpsListeners = new Set();
let perpsStarted = false;

export function startTwap() {
  stopped = false;
  startPerpsTwap();
  connect();
}

export function startPerpsTwap() {
  if (perpsStarted) return;
  perpsStarted = true;
  onQuote((tick) => {
    if (tick.market !== "binance-perps" || typeof tick.ts !== "number" || typeof tick.mid !== "number") return;
    const last = perpsSamples[perpsSamples.length - 1];
    if (last && tick.ts < last.ts) return;
    if (last && tick.ts === last.ts) {
      if (last.mid === tick.mid) return;
      last.mid = tick.mid;
    } else {
      perpsSamples.push({ ts: tick.ts, mid: tick.mid });
    }
    while (perpsSamples.length > 1 && perpsSamples[1].ts <= tick.ts - PERPS_WINDOW_US) perpsSamples.shift();
    const mid = stepTwap(perpsSamples, tick.ts, PERPS_WINDOW_US);
    if (mid == null) return;
    const point = { market: "binance-perps-twap", mid, ts: tick.ts };
    perpsPoints.push(point);
    trimAged(perpsPoints, tick.ts);
    for (const fn of perpsListeners) {
      try {
        fn(point);
      } catch (err) {
        console.error(err);
      }
    }
  });
}

export function onPerpsTwap(fn) {
  perpsListeners.add(fn);
  return () => perpsListeners.delete(fn);
}

export function perpsTwapHistory() {
  return visibleHistory(perpsPoints);
}

function stepTwap(samples, end, windowUs) {
  const start = end - windowUs;
  let anchor = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].ts <= start) anchor = i;
    else break;
  }
  if (anchor < 0) return null;
  let sum = 0;
  let cursor = start;
  let price = samples[anchor].mid;
  for (let i = anchor + 1; i < samples.length; i += 1) {
    const sample = samples[i];
    if (sample.ts > end) break;
    sum += price * (sample.ts - cursor);
    cursor = sample.ts;
    price = sample.mid;
  }
  if (end < cursor) return null;
  sum += price * (end - cursor);
  return sum / windowUs;
}

export function onTwap(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function twapHistory() {
  return visibleHistory(points);
}

export function clearTwapHistory(keepTs, nowUs) {
  const strike = typeof keepTs === "number" ? points.find((point) => point.ts === keepTs) : null;
  const now = typeof nowUs === "number" ? nowUs : Date.now() * 1000;
  // Keep the last minute of Chainlink / perps TWAP for basis, but hide it from the plot.
  keepRecent(points, now, SEED_US);
  keepRecent(perpsPoints, now, SEED_US);
  if (strike && !points.some((point) => point.ts === strike.ts)) {
    let i = 0;
    while (i < points.length && points[i].ts < strike.ts) i += 1;
    points.splice(i, 0, strike);
  }
  return strike ? { ts: strike.ts, mid: strike.mid } : null;
}

export function chainlinkAt(ts) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid];
    if (point.ts === ts) return point.mid;
    if (point.ts < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export function currentBasis() {
  const link = points[points.length - 1];
  if (!link || !perpsPoints.length) return null;
  const match = closestByTime(perpsPoints, link.ts);
  if (!match) return null;
  return match.mid - link.mid;
}

function closestByTime(series, ts) {
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  const next = series[lo];
  const prev = lo > 0 ? series[lo - 1] : null;
  if (!prev) return next;
  return Math.abs(prev.ts - ts) <= Math.abs(next.ts - ts) ? prev : next;
}

function connect() {
  if (stopped) return;
  clearTimers();
  const ws = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });
  socket = ws;

  ws.on("open", () => {
    if (ws !== socket) return;
    backoff = 1000;
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [{
        topic: TOPIC,
        type: "*",
        filters: JSON.stringify({ symbol: SYMBOL }),
      }],
    }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 5000);
    pingTimer.unref?.();
  });

  ws.on("message", (data) => {
    if (ws !== socket) return;
    const text = data.toString();
    if (!text || text === "PONG" || text === "PING") return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.topic !== TOPIC) return;
    if (msg.type === "subscribe" && Array.isArray(msg.payload?.data)) {
      for (const row of msg.payload.data) publish(row);
      return;
    }
    if (msg.type === "update") publish(msg.payload);
  });

  ws.on("error", () => {
    if (ws !== socket) return;
  });

  ws.on("close", () => {
    if (ws !== socket) return;
    socket = null;
    clearPing();
    scheduleReconnect();
  });
}

function publish(row) {
  if (!row || (row.symbol && row.symbol !== SYMBOL)) return;
  if (row.window_s != null && row.window_s !== 60) return;
  const mid = Number(row.value);
  const tsMs = Number(row.timestamp);
  if (!Number.isFinite(mid) || !Number.isFinite(tsMs)) return;
  const ts = tsMs * 1000;
  const last = points[points.length - 1];
  if (last && ts < last.ts) return;
  if (last && last.ts === ts && last.mid === mid) return;
  const point = { market: "chainlink-twap", mid, ts };
  if (last && last.ts === ts) points[points.length - 1] = point;
  else points.push(point);
  trimAged(points, ts);
  for (const fn of listeners) {
    try {
      fn(point);
    } catch (err) {
      console.error(err);
    }
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, 30_000);
  reconnectTimer = setTimeout(connect, delay);
  reconnectTimer.unref?.();
}

function clearPing() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

function clearTimers() {
  clearPing();
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}
