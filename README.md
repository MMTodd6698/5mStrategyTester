# Live Polymarket 5-minute Strategy Tester

## Setup

```bash
npm install
```
Edit [`main.js`](main.js).
In `main.js`, set your coin and TYO Connect Crypto Books API key:

```js
// btc, eth, sol, xrp, bnb, doge, hype
export const COIN = "btc";

export const TYO_API_KEY = "";
```

Then start:

```bash
npm run dev
```

If you're on a server open port **8080** (bound on all interfaces).

## Sample strategy

These are the sample `volatility_input`, `fair_value`, and `trade` implementations you can use or replace in `main.js`.

### `volatility_input`

Annualized vol from the last 30 minutes of OKX 1-second closes.

```js
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
```

### `fair_value`

Black–Scholes-style probability the price finishes above strike. Returns `null` in the last 60 seconds of the market.

```js
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
```

### `trade`

Paper trades when fair is 7¢ away from Polymarket mid price. Flips a flat book or doubles out of an opposite 20-lot.

```js
export function trade(fair, bid, ask, market) {
  if (fair >= ask + 0.07) {
    if (market.inventory == 0) {
      market.trade_up(20);
    } else if (market.inventory == -20) {
      market.trade_up(40);
    }
  }

  if (fair <= bid - 0.07) {
    if (market.inventory == 0) {
      market.trade_down(20);
    } else if (market.inventory == 20) {
      market.trade_down(40);
    }
  }
}
```

`market.inventory` is net up exposure. `market.trade_up(qty)` / `market.trade_down(qty)` book paper fills (default qty `5`).
