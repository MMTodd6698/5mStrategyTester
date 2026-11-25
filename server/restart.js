import { clearFairHistory } from "./fair.js";
import { markPlotRestart } from "./history.js";
import { clearPolyHistory, currentMarket } from "./polymarket.js";
import { clearTwapHistory } from "./twap.js";
import { clearQuoteHistory, serverNowUs } from "./tyo.js";

const listeners = new Set();

export function onRestart(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hardRestart() {
  const now = serverNowUs();
  markPlotRestart(now);
  const market = currentMarket();
  const keepTs = market && typeof market.windowStart === "number" ? market.windowStart * 1_000_000 : null;
  const strike = clearTwapHistory(keepTs, now);
  clearQuoteHistory(now);
  clearPolyHistory();
  clearFairHistory();
  const payload = { strike };
  for (const fn of listeners) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
  return payload;
}
