import { COIN, TYO_API_KEY } from "../main.js";

const COINS = ["btc", "eth", "sol", "xrp", "bnb", "doge", "hype"];

const coin = String(COIN).trim().toLowerCase();
if (!COINS.includes(coin)) {
  throw new Error(`COIN must be one of: ${COINS.join(", ")}`);
}

const upper = coin.toUpperCase();

export const settings = {
  coin,
  upper,
  tyoKey: String(TYO_API_KEY || "").trim(),
  tyoSymbol: `${coin}usdt`,
  chainlink: `${coin}/usd`,
  slugPrefix: `${coin}-updown-5m`,
  okxInst: `${upper}-USDT-SWAP`,
};
