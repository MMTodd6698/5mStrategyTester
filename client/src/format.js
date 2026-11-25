import { MARKET_US } from "./chart.js";

export const MIN_SECONDS = 0.5;
export const DEFAULT_SECONDS = 300;

export function formatMarketCountdown(now) {
  const end = Math.floor(now / MARKET_US) * MARKET_US + MARKET_US;
  const tenths = Math.max(0, Math.floor((end - now) / 100_000));
  const minutes = Math.floor(tenths / 600);
  const rem = tenths % 600;
  const sec = Math.floor(rem / 10);
  return `${minutes}:${String(sec).padStart(2, "0")}.${rem % 10}`;
}

export function sliderValue(seconds, maxSeconds) {
  const max = Math.max(maxSeconds, MIN_SECONDS * 2);
  const t = Math.log(seconds / MIN_SECONDS) / Math.log(max / MIN_SECONDS);
  return Math.round(Math.min(1, Math.max(0, t)) * 1000);
}

export function secondsFromSlider(value, maxSeconds) {
  const max = Math.max(maxSeconds, MIN_SECONDS * 2);
  const t = Number(value) / 1000;
  const seconds = MIN_SECONDS * (max / MIN_SECONDS) ** t;
  return Math.min(max, Math.max(MIN_SECONDS, seconds));
}

export function formatSeconds(seconds) {
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  return `${Math.round(seconds)}s`;
}

export function formatPnl(value) {
  const text = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}

export function formatMid(value) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

export function formatVol(value) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

export function formatFee(value) {
  if (!(value > 0)) return "0";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function formatTradeTime(ts) {
  const date = new Date(ts / 1000);
  return [
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join(":");
}

export function formatPx(value) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatSigned(value) {
  const text = formatPx(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}

export function normalizeFeed(feed) {
  if (feed === "live" || feed === "error") return feed;
  return "connecting";
}

export function tyoPlotNotice(feed) {
  if (!feed || feed.status !== "error") return null;
  if (feed.error === "missing_key") return "Insert TYO Connect API Key into main.js";
  if (feed.error === "invalid_key") return "Invalid key. Create a valid key at TYOConnect.com";
  return null;
}
