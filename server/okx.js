import WebSocket from "ws";
import { volatility_input } from "../main.js";
import { settings } from "./settings.js";

const REST = "https://www.okx.com/api/v5/market/history-candles";
const WS_URL = "wss://ws.okx.com/ws/v5/business";
const INST = settings.okxInst;
const CHANNEL = "candle1s";
const OKX_WINDOW_MS = 30 * 60 * 1000;
const PAGE = 300;
const MAX_PAGES = 8;

const closes = [];
const volListeners = new Set();
let feed = "connecting";
let feedError = null;
let history = "loading";
let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let trimTimer = null;
let historyTimer = null;
let backoff = 1000;
let stopped = false;
let started = false;
let filling = false;
let vol = null;

export function startOkx() {
  if (started) return;
  started = true;
  stopped = false;
  void backfill();
  connect();
  trimTimer = setInterval(() => {
    popOld(closes, Date.now());
  }, 1000);
  trimTimer.unref?.();
}

export function okxVol() {
  return vol;
}

export function onVol(fn) {
  volListeners.add(fn);
  return () => volListeners.delete(fn);
}

function pushClose(list, t, c, now = Date.now()) {
  if (!Number.isFinite(t) || !Number.isFinite(c)) return false;
  const last = list[list.length - 1];
  if (last && t < last.t) return false;
  let changed = false;
  if (last && t === last.t) {
    if (last.c !== c) {
      last.c = c;
      changed = true;
    }
  } else {
    list.push({ t, c });
    changed = true;
  }
  popOld(list, now);
  return changed;
}

function popOld(list, now) {
  const newest = list.length ? list[list.length - 1].t : now;
  const cutoff = Math.max(now, newest) - OKX_WINDOW_MS;
  let drop = 0;
  while (drop < list.length && list[drop].t <= cutoff) drop += 1;
  if (drop) list.splice(0, drop);
  return drop;
}

async function backfill() {
  if (filling || history === "ready" || stopped) return;
  filling = true;
  try {
    const rows = await fetchHistory();
    mergeHistory(rows);
    history = "ready";
  } catch {
    history = "error";
    scheduleHistory();
  } finally {
    filling = false;
  }
}

async function fetchHistory() {
  const cutoff = Date.now() - OKX_WINDOW_MS;
  let after = "";
  const out = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      instId: INST,
      bar: "1s",
      limit: String(PAGE),
    });
    if (after) params.set("after", after);
    const response = await fetch(`${REST}?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`OKX history responded ${response.status}`);
    const body = await response.json();
    if (body.code !== "0") throw new Error(body.msg || "OKX history failed");
    const data = body.data;
    if (!Array.isArray(data) || data.length === 0) break;
    let oldest = Infinity;
    for (const row of data) {
      const parsed = parseCandle(row);
      if (!parsed) continue;
      if (parsed.t < oldest) oldest = parsed.t;
      if (parsed.t >= cutoff) out.push(parsed);
    }
    if (!Number.isFinite(oldest) || oldest <= cutoff) break;
    after = String(oldest);
  }
  return out;
}

function mergeHistory(rows) {
  const byT = new Map();
  for (const row of rows) byT.set(row.t, row.c);
  for (const point of closes) byT.set(point.t, point.c);
  const ordered = [...byT.entries()].sort((a, b) => a[0] - b[0]);
  closes.length = 0;
  for (const [t, c] of ordered) closes.push({ t, c });
  popOld(closes, Date.now());
  measureVol();
}

function connect() {
  if (stopped) return;
  clearTimers();
  const ws = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });
  socket = ws;

  ws.on("open", () => {
    if (ws !== socket) return;
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [{ channel: CHANNEL, instId: INST }],
    }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 20_000);
    pingTimer.unref?.();
  });

  ws.on("message", (data) => {
    if (ws !== socket) return;
    const text = data.toString();
    if (!text || text === "pong") return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.event === "notice") return;
    if (msg.event === "subscribe") {
      backoff = 1000;
      setFeed("live", null);
      return;
    }
    if (msg.event === "error") {
      setFeed("error", msg.msg || "OKX kline stream failed");
      return;
    }
    if (msg.arg?.channel !== CHANNEL || msg.arg?.instId !== INST || !Array.isArray(msg.data)) return;
    for (const row of msg.data) {
      const parsed = parseCandle(row);
      if (!parsed) continue;
      if (!pushClose(closes, parsed.t, parsed.c)) continue;
      measureVol();
    }
  });

  ws.on("error", () => {
    if (ws !== socket) return;
  });

  ws.on("close", () => {
    if (ws !== socket) return;
    socket = null;
    clearPing();
    if (feed !== "error") setFeed("connecting", feedError);
    scheduleReconnect();
  });
}

function measureVol() {
  const next = volatility_input(closes.map((point) => ({ t: point.t, c: point.c })));
  if (next === vol) return;
  vol = next;
  for (const fn of volListeners) {
    try {
      fn(vol);
    } catch (err) {
      console.error(err);
    }
  }
}

function parseCandle(row) {
  if (!Array.isArray(row)) return null;
  const t = Number(row[0]);
  const c = Number(row[4]);
  if (!Number.isFinite(t) || !Number.isFinite(c)) return null;
  return { t, c };
}

function setFeed(status, error) {
  if (status === feed && error === feedError) return;
  feed = status;
  feedError = error;
}

function scheduleHistory() {
  if (stopped || historyTimer || history === "ready") return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    void backfill();
  }, 5000);
  historyTimer.unref?.();
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
