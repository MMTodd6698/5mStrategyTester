import { settings } from "./settings.js";
import { fairHistory, onFair, onTrade, tradeHistory } from "./fair.js";
import { okxVol, onVol } from "./okx.js";
import { onPoly, polyHistory, polySnapshot } from "./polymarket.js";
import { onRestart } from "./restart.js";
import { onPerpsTwap, onTwap, perpsTwapHistory, twapHistory } from "./twap.js";
import { feedSnapshot, onQuote, onStatus, quoteHistory } from "./tyo.js";

export function openBookStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 1000\n\n");

  let closed = false;
  const send = (payload) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: "hello", coin: settings.upper, ...feedSnapshot(), poly: polySnapshot(), vol: okxVol() });
  send({
    type: "history",
    ticks: [...twapHistory(), ...perpsTwapHistory(), ...quoteHistory()],
    poly: polyHistory(),
    fair: fairHistory(),
    trades: tradeHistory(),
  });
  const offQuote = onQuote((tick) => send({ type: "tick", ...tick }));
  const offTwap = onTwap((point) => send({ type: "tick", ...point }));
  const offPerpsTwap = onPerpsTwap((point) => send({ type: "tick", ...point }));
  const offFair = onFair((point) => send({ type: "fair", ...point }));
  const offTrade = onTrade((mark) => send({ type: "trade", ...mark }));
  const offPoly = onPoly((quote) => send({ type: "poly", ...quote }));
  const offStatus = onStatus((status) => send({ type: "status", ...status }));
  const offVol = onVol((value) => send({ type: "vol", value }));
  const offRestart = onRestart((payload) => send({ type: "reset", ...payload }));
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15000);
  ping.unref?.();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    offQuote();
    offTwap();
    offPerpsTwap();
    offFair();
    offTrade();
    offPoly();
    offStatus();
    offVol();
    offRestart();
  };

  req.on("close", close);
  res.on("error", close);
}
