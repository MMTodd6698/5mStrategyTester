import { fair_value, fee_formula, trade, TRADE_DELAY_MS } from "../main.js";
import { trimAged } from "./history.js";
import { okxVol } from "./okx.js";
import { currentMarket, polySnapshot } from "./polymarket.js";
import { chainlinkAt, currentBasis } from "./twap.js";
import { onQuote, serverNowUs } from "./tyo.js";

const points = [];
const trades = [];
const pending = [];
const listeners = new Set();
const tradeListeners = new Set();
let started = false;

export function startFair() {
  if (started) return;
  started = true;
  onQuote((tick) => {
    if (tick.market !== "binance-perps" || typeof tick.ts !== "number" || typeof tick.mid !== "number") return;
    const market = currentMarket();
    const strike = market ? chainlinkAt(market.windowStart * 1_000_000) : null;
    const vol = okxVol();
    const ttlMs = market ? market.windowEnd * 1000 - Date.now() : null;
    const basis = currentBasis();
    const price = basis == null ? null : tick.mid - basis;
    const value = fair_value(strike, vol, ttlMs, price);
    const slug = market?.slug ?? null;
    const last = points[points.length - 1];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // Gap the fair series (e.g. final 60s TTE) so the chart does not hold the last value.
      if (!last || last.value == null) return;
      publishFair({ ts: tick.ts, value: null, slug: last.slug ?? slug });
      return;
    }
    const book = polySnapshot();
    const bid = typeof book?.bid === "number" ? book.bid : null;
    const ask = typeof book?.ask === "number" ? book.ask : null;
    if (bid != null && ask != null) {
      trade(value, bid, ask, liveMarket({ market, strike }));
    }
    if (last && last.value === value && last.slug === slug) return;
    publishFair({ ts: tick.ts, value, slug });
  });
}

function publishFair(point) {
  points.push(point);
  trimAged(points, point.ts);
  for (const fn of listeners) {
    try {
      fn(point);
    } catch (err) {
      console.error(err);
    }
  }
}

export function onFair(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function fairHistory() {
  return points.slice();
}

export function onTrade(fn) {
  tradeListeners.add(fn);
  return () => tradeListeners.delete(fn);
}

export function tradeHistory() {
  return trades.slice();
}

export function clearFairHistory() {
  points.length = 0;
  trades.length = 0;
  for (const order of pending) {
    if (order.timer) clearTimeout(order.timer);
  }
  pending.length = 0;
}

function liveMarket({ market, strike }) {
  const windowStart = market?.windowStart;
  return {
    get inventory() {
      if (typeof windowStart !== "number") return 0;
      let net = 0;
      for (const mark of trades) {
        if (mark.windowStart !== windowStart) continue;
        net += mark.side === "up" ? mark.quantity : -mark.quantity;
      }
      for (const order of pending) {
        if (order.windowStart !== windowStart) continue;
        net += order.side === "up" ? order.quantity : -order.quantity;
      }
      return net;
    },
    trade_up(quantity = 5) {
      scheduleTrade("up", quantity, market, strike);
    },
    trade_down(quantity = 5) {
      scheduleTrade("down", quantity, market, strike);
    },
  };
}

function scheduleTrade(side, quantity, market, strike) {
  if (side !== "up" && side !== "down") return;
  if (typeof quantity !== "number" || !(quantity > 0)) return;
  if (!market || typeof market.windowStart !== "number" || typeof strike !== "number") return;

  const delayRaw = Number(TRADE_DELAY_MS);
  const delay = Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : 0;
  const order = { windowStart: market.windowStart, side, quantity, strike, timer: null };
  pending.push(order);

  const fill = () => {
    const index = pending.indexOf(order);
    if (index >= 0) pending.splice(index, 1);
    const live = currentMarket();
    if (!live || live.windowStart !== order.windowStart) return;
    const stillStrike = chainlinkAt(order.windowStart * 1_000_000);
    if (typeof stillStrike !== "number") return;
    noteTrade(serverNowUs(), order.side, order.quantity, polySnapshot(), live, stillStrike);
  };

  if (delay === 0) {
    fill();
    return;
  }
  order.timer = setTimeout(fill, delay);
  order.timer.unref?.();
}

function noteTrade(ts, side, quantity, book, market, strike) {
  if (side !== "up" && side !== "down") return;
  if (typeof quantity !== "number" || !(quantity > 0)) return;
  const price = side === "up" ? book?.ask : book?.bid;
  if (typeof price !== "number" || !Number.isFinite(price)) return;
  if (!market || typeof market.windowStart !== "number" || typeof strike !== "number") return;
  const feeRaw = fee_formula(quantity, price);
  const fee = typeof feeRaw === "number" && Number.isFinite(feeRaw) && feeRaw > 0 ? feeRaw : 0;
  const mark = { ts, windowStart: market.windowStart, strike, price, side, quantity, fee };
  trades.push(mark);
  trimAged(trades, ts);
  for (const fn of tradeListeners) {
    try {
      fn(mark);
    } catch (err) {
      console.error(err);
    }
  }
}
