import WebSocket from "ws";
import { keepRecent, SEED_US, trimAged, visibleHistory } from "./history.js";
import { settings } from "./settings.js";

const DEFAULT_URL = "wss://london.tyoconnect.com/ws";
const VENUES = ["binance"];
const BOOKS = ["perps"];
const STREAMS = Object.fromEntries(
  VENUES.flatMap((exchange) => BOOKS.map((market) => {
    const id = `${exchange}-${market}`;
    return [id, `${settings.tyoSymbol}.${exchange}.${market}.bookTicker`];
  })),
);
const BASES = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "ZEC"];
const EXCHANGES = ["", "binance", "okx", "bybit"];
const MARKETS = ["", "spot", "perps"];
const FATAL = new Set(["unauthorized", "inactive", "period_ended", "wrong_product"]);
const clockOriginNs = process.hrtime.bigint();
const clockOriginUs = BigInt(Date.now()) * 1000n;

const quotes = Object.fromEntries(Object.keys(STREAMS).map((id) => [id, null]));
const history = [];
let feedStatus = "idle";
let feedError = null;
let socket = null;
let reconnectTimer = null;
let watchdog = null;
let lastMessageAt = 0;
let backoff = 1000;
let stopped = false;
const quoteListeners = new Set();
const statusListeners = new Set();

export function startTyo() {
  stopped = false;
  armWatchdog();
  connect();
}

export function onQuote(fn) {
  quoteListeners.add(fn);
  return () => quoteListeners.delete(fn);
}

export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function feedSnapshot() {
  return {
    feed: feedStatus,
    error: feedError,
    quotes: Object.fromEntries(Object.keys(quotes).map((id) => [id, publicQuote(quotes[id])])),
  };
}

export function quoteHistory() {
  return visibleHistory(history);
}

export function clearQuoteHistory(nowUs) {
  const now = typeof nowUs === "number" ? nowUs : arrivedAtUs();
  keepRecent(history, now, SEED_US);
}

function connect() {
  if (stopped) return;
  const key = settings.tyoKey;
  if (!key) {
    setFeed("error", "missing_key");
    return;
  }

  clearTimer();
  lastMessageAt = Date.now();
  setFeed("connecting", null);
  const url = process.env.TYO_WS_URL || DEFAULT_URL;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 10_000,
  });
  socket = ws;

  ws.on("message", (data, isBinary) => {
    if (ws !== socket) return;
    lastMessageAt = Date.now();
    try {
      if (!isBinary) handleText(ws, data.toString());
      else handleBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
    } catch (err) {
      setFeed("error", scrub(err instanceof Error ? err.message : "Could not read the book"));
    }
  });

  ws.on("unexpected-response", (_req, res) => {
    if (ws !== socket) return;
    if (res.statusCode === 401 || res.statusCode === 403) setFeed("error", "invalid_key");
    else setFeed("error", `TYO Connect responded HTTP ${res.statusCode}`);
    res.resume();
  });

  ws.on("error", (err) => {
    if (ws !== socket) return;
    setFeed("error", scrub(err instanceof Error ? err.message : "WebSocket error"));
  });

  ws.on("close", (code, reason) => {
    if (ws !== socket) return;
    socket = null;
    const why = reason?.length ? reason.toString() : `Socket closed (${code})`;
    if (!feedError) setFeed("error", scrub(why));
    scheduleReconnect();
  });
}

function handleText(ws, text) {
  const msg = JSON.parse(text);
  if (msg.event === "welcome") {
    ws.send(JSON.stringify({ op: "subscribe", streams: Object.values(STREAMS) }));
    return;
  }
  if (msg.event === "subscribed") {
    const rejected = Array.isArray(msg.rejected) ? msg.rejected : [];
    const reason = scrub(rejected.map((row) => row.reason || row.stream).filter(Boolean).join("; "));
    if (rejected.length >= Object.keys(STREAMS).length) {
      setFeed("error", isInvalidKey(msg, reason) ? "invalid_key" : reason || "TYO Connect rejected the book streams");
      return;
    }
    backoff = 1000;
    setFeed("live", rejected.length ? reason : null);
    return;
  }
  if (msg.event === "error") {
    if (isInvalidKey(msg)) setFeed("error", "invalid_key");
    else setFeed("error", scrub(msg.message || msg.code || "TYO Connect error"));
    if (FATAL.has(msg.code)) {
      stopped = true;
      ws.close();
    }
  }
}

function isInvalidKey(msg, reason = "") {
  const code = String(msg?.code || "").toLowerCase();
  const text = `${msg?.message || ""} ${reason}`.toLowerCase();
  if (code === "unauthorized" || code === "inactive" || code === "period_ended") return true;
  return /unauthor|invalid.?key|forbidden|not.?allowed|api.?key/.test(text);
}

function handleBinary(buf) {
  if (buf.length < 5 || buf[0] !== 1) return;
  const exchange = EXCHANGES[buf[1] >> 4];
  const market = MARKETS[buf[1] & 0x0f];
  const base = BASES[buf[2]];
  const id = `${exchange}-${market}`;
  if (!STREAMS[id] || base !== settings.upper) return;

  let offset = 4;
  const values = [];
  for (let i = 0; i < 4; i += 1) {
    const next = readVarint(buf, offset);
    offset = next.offset;
    values.push(zigzag(next.value));
  }

  const [bidPx, bidQty, askPx, askQty] = values;
  const midPx = (bidPx + askPx) / 2n;
  const ts = arrivedAtUs();
  quotes[id] = {
    bidN: toNumber(bidPx),
    askN: toNumber(askPx),
    midN: toNumber(midPx),
    bidQtyN: toNumber(bidQty),
    askQtyN: toNumber(askQty),
    ts,
  };
  const point = { market: id, ...publicQuote(quotes[id]) };
  const last = history[history.length - 1];
  if (!last || last.market !== id || last.mid !== point.mid || last.ts !== point.ts) {
    history.push(point);
    trimAged(history, ts);
  }
  emit(quoteListeners, point);
}

function setFeed(status, error) {
  const changed = status !== feedStatus || error !== feedError;
  feedStatus = status;
  feedError = error;
  if (!changed) return;
  emit(statusListeners, { feed: feedStatus, error: feedError });
}

function armWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (stopped || !socket) return;
    if (Date.now() - lastMessageAt < 8000) return;
    socket.terminate();
  }, 2000);
  watchdog.unref?.();
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}

function clearTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && shift <= 63n) {
    const byte = BigInt(buf[i]);
    i += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value, offset: i };
    shift += 7n;
  }
  throw new Error("Truncated book ticker");
}

function zigzag(n) {
  return (n >> 1n) ^ -(n & 1n);
}

export function serverNowUs() {
  return arrivedAtUs();
}

function arrivedAtUs() {
  const elapsedUs = (process.hrtime.bigint() - clockOriginNs) / 1000n;
  return Number(clockOriginUs + elapsedUs);
}

function publicQuote(quote) {
  if (!quote) return null;
  return {
    bid: quote.bidN,
    ask: quote.askN,
    mid: quote.midN,
    bidQty: quote.bidQtyN,
    askQty: quote.askQtyN,
    ts: quote.ts,
  };
}

function toNumber(n) {
  const neg = n < 0n;
  const value = Number(neg ? -n : n) / 1e8;
  return neg ? -value : value;
}

function emit(set, payload) {
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
}

function scrub(message) {
  const key = settings.tyoKey;
  if (!message) return "TYO Connect connection failed";
  if (!key) return message;
  return message.split(key).join("[redacted]");
}
