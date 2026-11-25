// btc, eth, sol, xrp, bnb, doge, hype
export const COIN = "btc";

export const TYO_API_KEY = "";

// contracts: size of the fill.
// price: execution price of the fill (0–1 for the up token).
// Returns the fee to subtract from that trade's PnL.
export function fee_formula(contracts, price) {
  return 0.05 * price * (1 - price) * contracts;
}

// Milliseconds after market.trade_up / trade_down before the fill is "executed".
// 0 = immediate. The fill uses the Polymarket bid/ask at fill time.
export const TRADE_DELAY_MS = 0;

// klines: last 30 minutes of OKX 1s bars, oldest first, each { t, c } with t in ms and c the close.
export function volatility_input(klines) {
  const windowMs = 30 * 60 * 1000;
  const secondsPerYear = 365 * 24 * 60 * 60;
  if (!Array.isArray(klines) || klines.length < 2) return null;
  const newest = klines[klines.length - 1]?.t;
  if (!Number.isFinite(newest)) return null;
  const start = newest - windowMs;
  const returns = [];
  let prev = null;
  for (const bar of klines) {
    if (!bar || !(bar.t > start) || !(bar.c > 0)) continue;
    if (prev && bar.t - prev.t === 1000 && prev.c > 0) returns.push(Math.log(bar.c / prev.c));
    prev = bar;
  }
  if (returns.length < 2) return null;
  let sum = 0;
  for (const value of returns) sum += value;
  const mean = sum / returns.length;
  let acc = 0;
  for (const value of returns) {
    const diff = value - mean;
    acc += diff * diff;
  }
  const std = Math.sqrt(acc / (returns.length - 1));
  return std * Math.sqrt(secondsPerYear);
}

// strike: Chainlink price at the market open, or null.
// vol: latest volatility_input value, or null.
// ttlMs: milliseconds until the market ends, or null.
// price: latest Binance perps mid minus the current basis, or null.
export function fair_value(strike, vol, ttlMs, price) {
  const minTtlMs = 60_000;
  const secondsPerYear = 365 * 24 * 60 * 60;

  function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const density = 0.3989422804014327 * Math.exp(-0.5 * x * x);
    const tail =
      density *
      t *
      (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
  }

  if (!(strike > 0) || !(vol > 0) || !(price > 0) || !(ttlMs >= minTtlMs)) return null;
  const years = ttlMs / 1000 / secondsPerYear;
  const width = vol * Math.sqrt(years);
  if (!(width > 0)) return null;
  const d2 = (Math.log(price / strike) - 0.5 * vol * vol * years) / width;
  return normalCdf(d2);
}

// fair: latest fair value, or null.
// bid: Polymarket up bid, or null.
// ask: Polymarket up ask, or null.
// market: live market handle for the current window.
//   market.inventory — net up exposure (up contracts minus down contracts).
//   market.trade_up(quantity?) — buy up contracts at the ask (default 5).
//   market.trade_down(quantity?) — sell / short at the bid (default 5).
export function trade(fair, bid, ask, market) {
  

  if (fair >= ask + 0.07) {
    if (market.inventory == 0) {
      market.trade_up(20)
    } else if (market.inventory == -20) {
      market.trade_up(40)
    }
    
  }
  
  
  if (fair <= bid - 0.07) {
    if (market.inventory == 0) {
      market.trade_down(20)
    } else if (market.inventory == 20) {
      market.trade_down(40)
    }
  }
  
}
