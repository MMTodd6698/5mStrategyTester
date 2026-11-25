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

}

// strike: Chainlink price at the market open, or null.
// vol: latest volatility_input value, or null.
// ttlMs: milliseconds until the market ends, or null.
// price: latest Binance perps mid minus the current basis, or null.
export function fair_value(strike, vol, ttlMs, price) {

}

// fair: latest fair value, or null.
// bid: Polymarket up bid, or null.
// ask: Polymarket up ask, or null.
// market: live market handle for the current window.
//   market.inventory — net up exposure (up contracts minus down contracts).
//   market.trade_up(quantity?) — buy up contracts at the ask (default 5).
//   market.trade_down(quantity?) — sell / short at the bid (default 5).
export function trade(fair, bid, ask, market) {
  
}
