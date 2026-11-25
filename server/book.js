// Exact decimal order book. Prices and sizes stay strings, so levels are not
// rounded through floating point. A snapshot replaces one asset. A price
// change sets the new aggregate size at one level, and size 0 removes it.

export class MarketBook {
  constructor(market) {
    this.conditionId = market.conditionId;
    this.assets = new Map();
    for (const token of market.tokens) {
      this.assets.set(token.assetId, emptyAsset(token, market.tickSize));
    }
  }

  synced() {
    if (this.assets.size === 0) return false;
    for (const asset of this.assets.values()) {
      if (!asset.synced) return false;
    }
    return true;
  }

  ingest(msg) {
    if (!msg || typeof msg !== "object") return { applied: false };
    if (msg.market && msg.market !== this.conditionId) return { applied: false };

    if (msg.event_type === "book") return this.#book(msg);
    if (msg.event_type === "price_change") return this.#priceChange(msg);
    if (msg.event_type === "tick_size_change") return this.#tick(msg);
    if (msg.event_type === "last_trade_price") return this.#trade(msg);
    return { applied: false };
  }

  top(outcome) {
    let asset = null;
    for (const row of this.assets.values()) {
      if (row.outcome === outcome) asset = row;
    }
    if (!asset?.synced) return null;
    let bid = null;
    let ask = null;
    for (const price of asset.bids.keys()) {
      if (bid === null || cmp(price, bid) > 0) bid = price;
    }
    for (const price of asset.asks.keys()) {
      if (ask === null || cmp(price, ask) < 0) ask = price;
    }
    if (bid == null && ask == null) return null;
    return { outcome, bid, ask, mid: bid != null && ask != null ? decimalAvg(bid, ask) : null };
  }

  #book(msg) {
    const asset = this.assets.get(msg.asset_id);
    if (!asset) return { applied: false };
    const ts = Number(msg.timestamp);
    if (!Number.isFinite(ts)) return { applied: false };
    if (asset.synced && ts < asset.timestamp) return { applied: false };
    if (asset.synced && ts === asset.timestamp && msg.hash && msg.hash === asset.hash) {
      return { applied: false };
    }

    asset.bids = toMap(msg.bids);
    asset.asks = toMap(msg.asks);
    asset.timestamp = ts;
    asset.hash = msg.hash ?? null;
    if (msg.tick_size) asset.tickSize = canonical(msg.tick_size);
    asset.synced = true;
    if (msg.last_trade_price && !asset.lastTrade) {
      asset.lastTrade = {
        price: canonical(msg.last_trade_price),
        size: null,
        side: null,
        timestamp: msg.timestamp,
      };
    }

    const pending = asset.pending;
    asset.pending = [];
    for (const change of pending) {
      if (change.ts > ts) applyLevel(asset, change);
    }
    return { applied: true, assetId: asset.assetId };
  }

  #priceChange(msg) {
    const ts = Number(msg.timestamp);
    if (!Number.isFinite(ts)) return { applied: false };
    let applied = false;
    let assetId = null;

    for (const change of msg.price_changes ?? []) {
      const asset = this.assets.get(change.asset_id);
      if (!asset) continue;
      const item = {
        ts,
        price: change.price,
        size: change.size,
        side: change.side,
        bestBid: change.best_bid,
        bestAsk: change.best_ask,
      };
      if (!asset.synced) {
        asset.pending.push(item);
        if (asset.pending.length > 20000) asset.pending.shift();
        continue;
      }
      if (ts < asset.timestamp) continue;
      if (!applyLevel(asset, item)) continue;
      applied = true;
      assetId = asset.assetId;
    }

    return { applied, assetId };
  }

  #tick(msg) {
    const asset = this.assets.get(msg.asset_id);
    if (!asset) return { applied: false };
    const tick = canonical(msg.new_tick_size);
    if (!tick || tick === asset.tickSize) return { applied: false };
    asset.tickSize = tick;
    return { applied: true, assetId: asset.assetId };
  }

  #trade(msg) {
    const asset = this.assets.get(msg.asset_id);
    if (!asset) return { applied: false };
    asset.lastTrade = {
      price: canonical(msg.price),
      size: canonical(msg.size),
      side: msg.side ?? null,
      timestamp: msg.timestamp ?? null,
    };
    return { applied: true, assetId: asset.assetId };
  }
}

function emptyAsset(token, tickSize) {
  return {
    outcome: token.outcome,
    assetId: token.assetId,
    bids: new Map(),
    asks: new Map(),
    timestamp: 0,
    hash: null,
    tickSize: tickSize ? canonical(tickSize) : null,
    synced: false,
    pending: [],
    lastTrade: null,
  };
}

function applyLevel(asset, change) {
  const price = canonical(change.price);
  const size = canonical(change.size);
  const side = change.side === "BUY" ? asset.bids : change.side === "SELL" ? asset.asks : null;
  if (!price || size === null || !side) return false;
  if (size === "0") side.delete(price);
  else side.set(price, size);
  // A trade clears the other side before that side's size-0 message arrives.
  // Only drop levels this order traded through, and only once the exchange
  // best has moved past the trade price. Levels inside the new spread stay.
  if (size !== "0" && change.side === "BUY") clearThrough(asset.asks, price, change.bestAsk, "ask");
  if (size !== "0" && change.side === "SELL") clearThrough(asset.bids, price, change.bestBid, "bid");
  asset.timestamp = change.ts;
  return true;
}

function clearThrough(levels, price, reportedBest, role) {
  const best = canonical(reportedBest);
  if (!best || best === "0") return;
  const tradedPast = role === "ask" ? cmp(best, price) > 0 : cmp(best, price) < 0;
  if (!tradedPast) return;
  for (const level of levels.keys()) {
    const taken = role === "ask" ? cmp(level, price) <= 0 : cmp(level, price) >= 0;
    if (taken) levels.delete(level);
  }
}

function toMap(levels) {
  const map = new Map();
  if (!Array.isArray(levels)) return map;
  for (const level of levels) {
    const price = canonical(level?.price);
    const size = canonical(level?.size);
    if (!price || !size || size === "0") continue;
    map.set(price, size);
  }
  return map;
}

function canonical(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (!text) return null;
  let neg = false;
  if (text[0] === "+") text = text.slice(1);
  else if (text[0] === "-") {
    neg = true;
    text = text.slice(1);
  }
  if (!/^\d*\.?\d+$/.test(text) || text === ".") return null;
  let [whole, frac = ""] = text.split(".");
  if (!whole) whole = "0";
  whole = whole.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  if (whole === "0" && !frac) return "0";
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}

function decimalAvg(a, b) {
  const left = canonical(a);
  const right = canonical(b);
  if (!left || !right) return null;
  const scale = Math.max(fractionLength(left), fractionLength(right));
  const sum = toScaled(left, scale) + toScaled(right, scale);
  if (sum % 2n === 0n) return fromScaled(sum / 2n, scale);
  return fromScaled(sum * 5n, scale + 1);
}

function cmp(a, b) {
  const scale = Math.max(fractionLength(a), fractionLength(b));
  const left = toScaled(a, scale);
  const right = toScaled(b, scale);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fractionLength(value) {
  const body = value.startsWith("-") ? value.slice(1) : value;
  return body.split(".")[1]?.length ?? 0;
}

function toScaled(value, scale) {
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const [whole, frac = ""] = body.split(".");
  const digits = `${whole}${frac.padEnd(scale, "0")}`;
  const n = BigInt(digits || "0");
  return neg ? -n : n;
}

function fromScaled(value, scale) {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(scale);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(scale, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole.toString();
  if (body === "0") return "0";
  return neg ? `-${body}` : body;
}
