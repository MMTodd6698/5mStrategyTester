import { MARKET_US } from "./chart.js";

export function markedPnl(bids, asks, trades, strikes) {
  const strikeAt = new Map();
  for (const strike of strikes) {
    if (strike.y != null) strikeAt.set(strike.t, strike.y);
  }

  const events = [];
  for (const point of bids) addBookEvent(events, point, "bid");
  for (const point of asks) addBookEvent(events, point, "ask");
  for (const trade of trades) {
    const end = trade.start * 1_000_000 + MARKET_US;
    const close = strikeAt.get(end);
    if (close != null) trade.settlement = close >= trade.strike ? 1 : 0;
    events.push({ t: trade.t, kind: "trade", trade });
    if (trade.settlement != null) events.push({ t: end, kind: "settle", trade });
  }
  events.sort((a, b) => a.t - b.t || rankBookEvent(a.kind) - rankBookEvent(b.kind));

  const books = new Map();
  const marks = new Map();
  const out = [];
  let index = 0;
  while (index < events.length) {
    const t = events[index].t;
    while (index < events.length && events[index].t === t) {
      applyMark(events[index], books, marks, trades);
      index += 1;
    }
    const pnl = totalPnl(marks);
    if (pnl == null) continue;
    const last = out[out.length - 1];
    if (!last || last.y !== pnl) out.push({ t, y: pnl });
  }
  return out;
}

export function lastPnl(series) {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].y != null) return series[i].y;
  }
  return null;
}

function addBookEvent(events, point, kind) {
  const start = windowStartSec(point.slug);
  if (start == null) return;
  events.push({ t: point.t, kind, y: point.y, start });
}

function applyMark(event, books, marks, trades) {
  if (event.kind === "bid" || event.kind === "ask") {
    let book = books.get(event.start);
    if (!book) {
      book = { bid: null, ask: null };
      books.set(event.start, book);
    }
    book[event.kind] = event.y;
    const mid = bookMid(book);
    const end = event.start * 1_000_000 + MARKET_US;
    if (mid == null || event.t >= end) return;
    for (const trade of trades) {
      if (trade.start === event.start && trade.t <= event.t) marks.set(trade, mid);
    }
    return;
  }
  if (event.kind === "trade") {
    const end = event.trade.start * 1_000_000 + MARKET_US;
    const mid = bookMid(books.get(event.trade.start));
    if (mid != null && event.t < end) marks.set(event.trade, mid);
    return;
  }
  marks.set(event.trade, event.trade.settlement);
}

function bookMid(book) {
  if (!book || book.bid == null || book.ask == null) return null;
  return (book.bid + book.ask) / 2;
}

function totalPnl(marks) {
  let pnl = 0;
  let any = false;
  for (const [trade, mark] of marks) {
    if (mark == null) continue;
    any = true;
    const diff = trade.side === "down" ? trade.price - mark : mark - trade.price;
    const fee = typeof trade.fee === "number" && trade.fee > 0 ? trade.fee : 0;
    pnl += diff * trade.quantity - fee;
  }
  return any ? pnl : null;
}

function windowStartSec(slug) {
  if (typeof slug !== "string") return null;
  const at = slug.lastIndexOf("-");
  if (at < 0) return null;
  const start = Number(slug.slice(at + 1));
  return Number.isFinite(start) ? start : null;
}

function rankBookEvent(kind) {
  if (kind === "settle") return 0;
  if (kind === "bid") return 1;
  if (kind === "ask") return 2;
  return 3;
}
