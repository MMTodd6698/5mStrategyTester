import { startFair } from "./fair.js";
import { startOkx } from "./okx.js";
import { startPolymarket } from "./polymarket.js";
import { startTwap } from "./twap.js";
import { startTyo } from "./tyo.js";

export function startFeeds() {
  startPolymarket();
  startTwap();
  startOkx();
  startFair();
  startTyo();
}
