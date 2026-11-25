import WebSocket from "ws";
import { settings } from "./settings.js";
import { MarketBook } from "./book.js";
import { trimAged } from "./history.js";
import { serverNowUs } from "./tyo.js";

const GAMMA = "https://gamma-api.polymarket.com/events";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const WINDOW_SEC = 300;

const cache = new Map();
let market = null;
let books = null;
let socket = null;
let generation = 0;
let status = "connecting";
let switching = false;
let watchTimer = null;
let boundaryTimer = null;
let pingTimer = null;
let prefetchSlug = null;
let latestQuote = null;
let sampleTimer = null;
const history = [];
const quoteListeners = new Set();

export function startPolymarket() {
  armBoundary();
  watchTimer = setInterval(() => {
    prefetchNext();
    void follow();
  }, 1000);
  watchTimer.unref?.();
  scheduleSample();
  void follow();
}

export function onPoly(fn) {
  quoteListeners.add(fn);
  return () => quoteListeners.delete(fn);
}

export function polySnapshot() {
  return latestQuote;
}

export function polyHistory() {
  return history.slice();
}

export function clearPolyHistory() {
  history.length = 0;
}

export function currentMarket() {
  if (!market) return null;
  return {
    slug: market.slug,
    windowStart: market.windowStart,
    windowEnd: market.windowEnd,
  };
}

function armBoundary() {
  clearTimeout(boundaryTimer);
  const nextMs = (windowStartSec() + WINDOW_SEC) * 1000;
  boundaryTimer = setTimeout(() => {
    void follow();
    armBoundary();
  }, Math.max(0, nextMs - Date.now()) + 20);
  boundaryTimer.unref?.();
}

async function follow() {
  if (switching) return;
  const start = windowStartSec();
  if (sameMarket(start) && socketOpen()) return;

  switching = true;
  try {
    const next = await resolveMarket(start);
    if (windowStartSec() !== next.windowStart) return;
    if (sameMarket(next.windowStart) && socketOpen() && market.conditionId === next.conditionId) return;
    openSocket(next);
  } catch (err) {
    if (err?.code === "ROLLED") return;
    setStatus("error");
  } finally {
    switching = false;
  }
}

function sameMarket(start) {
  return market?.windowStart === start;
}

function socketOpen() {
  return socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
}

function openSocket(next) {
  const gen = ++generation;
  closeSocket();
  market = next;
  books = new MarketBook(next);
  latestQuote = null;
  setStatus("connecting");

  const ws = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });
  socket = ws;

  ws.on("open", () => {
    if (gen !== generation) return;
    ws.send(JSON.stringify({
      type: "market",
      assets_ids: next.tokens.map((token) => token.assetId),
      initial_dump: true,
      custom_feature_enabled: true,
    }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10_000);
    pingTimer.unref?.();
  });

  ws.on("message", (data) => {
    const receivedUs = serverNowUs();
    if (gen !== generation) return;
    const text = data.toString();
    if (text === "PONG" || text === "PING") return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    let touched = false;
    for (const frame of frames) {
      if (frame?.event_type === "new_market") {
        rememberNewMarket(frame);
        continue;
      }
      if (!books) continue;
      const result = books.ingest(frame);
      if (result.applied) touched = true;
    }
    if (touched && books?.synced()) {
      setStatus("live");
      publishQuote(receivedUs, false);
    }
  });

  ws.on("error", () => {
    if (gen !== generation) return;
  });

  ws.on("close", () => {
    if (gen !== generation) return;
    socket = null;
    clearPing();
    if (status !== "error") setStatus("connecting");
  });
}

function closeSocket() {
  clearPing();
  const ws = socket;
  socket = null;
  if (!ws) return;
  ws.removeAllListeners();
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
}

function clearPing() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

function prefetchNext() {
  const start = windowStartSec() + WINDOW_SEC;
  const slug = marketSlug(start);
  if (cache.has(slug) || prefetchSlug === slug) return;
  if (start * 1000 - Date.now() > 20_000) return;
  prefetchSlug = slug;
  fetchMarket(start)
    .then((next) => remember(next))
    .catch(() => {})
    .finally(() => {
      if (prefetchSlug === slug) prefetchSlug = null;
    });
}

async function resolveMarket(start) {
  const slug = marketSlug(start);
  const cached = cache.get(slug);
  if (cached) return cached;

  let last = new Error(`No ${settings.upper} 5m market for ${slug}`);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (windowStartSec() !== start) {
      const rolled = new Error("window rolled");
      rolled.code = "ROLLED";
      throw rolled;
    }
    try {
      const next = await fetchMarket(start);
      remember(next);
      return next;
    } catch (err) {
      last = err;
      await delay(300 * (attempt + 1));
    }
  }
  throw last;
}

async function fetchMarket(start) {
  const slug = marketSlug(start);
  const response = await fetch(`${GAMMA}?slug=${slug}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Polymarket events responded ${response.status}`);
  const data = await response.json();
  const event = Array.isArray(data) ? data[0] : null;
  const row = event?.markets?.[0];
  if (!row) throw new Error(`No ${settings.upper} 5m market for ${slug}`);
  return marketFromParts({
    slug,
    conditionId: row.conditionId,
    windowStart: start,
    tickSize: row.orderPriceMinTickSize,
    outcomes: parseList(row.outcomes),
    assetIds: parseList(row.clobTokenIds),
  });
}

function rememberNewMarket(msg) {
  const slug = msg.slug;
  const prefix = `${settings.slugPrefix}-`;
  if (typeof slug !== "string" || !slug.startsWith(prefix)) return;
  const start = Number(slug.slice(prefix.length));
  if (!Number.isFinite(start)) return;
  try {
    remember(marketFromParts({
      slug,
      conditionId: msg.market,
      windowStart: start,
      tickSize: msg.order_price_min_tick_size,
      outcomes: msg.outcomes,
      assetIds: msg.assets_ids ?? msg.clob_token_ids,
    }));
  } catch {
    // A partial new_market frame is ignored. Gamma is the fallback.
  }
}

function marketFromParts({ slug, conditionId, windowStart, tickSize, outcomes, assetIds }) {
  const names = Array.isArray(outcomes) ? outcomes.map(String) : [];
  const ids = Array.isArray(assetIds) ? assetIds.map(String) : [];
  if (!conditionId || names.length === 0 || names.length !== ids.length) {
    throw new Error(`Token ids missing for ${slug}`);
  }
  return {
    slug,
    conditionId,
    windowStart,
    windowEnd: windowStart + WINDOW_SEC,
    tickSize: tickSize == null ? null : String(tickSize),
    tokens: names.map((outcome, index) => ({ outcome, assetId: ids[index] })),
  };
}

function remember(next) {
  cache.set(next.slug, next);
  while (cache.size > 6) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}

function marketSlug(start) {
  return `${settings.slugPrefix}-${start}`;
}

function windowStartSec(now = Date.now()) {
  const sec = Math.floor(now / 1000);
  return sec - (sec % WINDOW_SEC);
}

function scheduleSample() {
  clearTimeout(sampleTimer);
  sampleTimer = setTimeout(() => publishQuote(serverNowUs(), true), 50);
  sampleTimer.unref?.();
}

function publishQuote(ts, repeat) {
  if (!books?.synced() || !market) {
    if (repeat) scheduleSample();
    return;
  }
  const top = books.top("Up");
  if (!top || (top.bid == null && top.ask == null)) {
    if (repeat) scheduleSample();
    return;
  }
  const bid = top.bid == null ? null : Number(top.bid);
  const ask = top.ask == null ? null : Number(top.ask);
  const same = latestQuote
    && latestQuote.slug === market.slug
    && latestQuote.bid === bid
    && latestQuote.ask === ask;
  if (same && !repeat) return;
  latestQuote = {
    ts,
    bid,
    ask,
    slug: market.slug,
    outcome: top.outcome,
  };
  if (!same) {
    history.push(latestQuote);
    trimAged(history, ts);
  }
  for (const fn of quoteListeners) {
    try {
      fn(latestQuote);
    } catch (err) {
      console.error(err);
    }
  }
  scheduleSample();
}

function setStatus(next) {
  status = next;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
