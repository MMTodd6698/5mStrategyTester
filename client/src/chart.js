export const MARKET_US = 300_000_000;
/** Soft cap for browser localStorage only — server history is unbounded. */
export const LOCAL_CACHE_US = 20 * 60 * 1_000_000;
const PLOT_PAD_LEFT = 16;
const PLOT_PAD_RIGHT = 92;

export function plotWidth(canvas) {
  return Math.max(1, canvas.clientWidth - PLOT_PAD_LEFT - PLOT_PAD_RIGHT);
}

export const SERIES = [
  { id: "binance-perps", color: "#1d4e89", width: 1.6, adjust: true },
  { id: "binance-perps-twap", color: "#7eb6ff", width: 2.6, adjust: true },
  { id: "chainlink-twap", color: "#6b3fa0", width: 2.2, exact: true },
];

export const POLY_SERIES = [
  { id: "bid", color: "#0c6b52", width: 2.2 },
  { id: "ask", color: "#a33b32", width: 1.6 },
  { id: "fair", color: "#1a1814", width: 2.6 },
];

export function drawBook(canvas, points, now, windowUs, viewEnd = now, options = {}) {
  const seriesList = options.series ?? SERIES;
  const minSpan = options.minSpan ?? 1;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const dpr = width / Math.max(canvas.clientWidth, 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#faf8f4";
  ctx.fillRect(0, 0, width, height);

  const plot = {
    x: PLOT_PAD_LEFT * dpr,
    y: 16 * dpr,
    w: width - (PLOT_PAD_LEFT + PLOT_PAD_RIGHT) * dpr,
    h: height - 46 * dpr,
  };
  if (plot.w < 20 || plot.h < 20) return false;

  const end = viewEnd;
  const start = end - windowUs;
  for (const series of seriesList) {
    if (!Array.isArray(points[series.id])) points[series.id] = [];
  }
  const hold = options.hold !== false;
  const visible = seriesList.map((series) => {
    const sliced = segment(points[series.id], start, end);
    return {
      series,
      data: series.exact ? sliced : holdLast(stair(sliced), end, hold),
    };
  });
  const strikes = (options.strikes ?? []).filter((strike) => strike.end > start && strike.t < end && strike.y != null);
  const trades = (options.trades ?? []).filter((mark) => mark.t >= start && mark.t <= end && mark.y != null);
  const values = visible.flatMap((entry) => entry.data.map((point) => point.y).filter((value) => value != null));
  for (const strike of strikes) values.push(strike.y);
  for (const mark of trades) values.push(mark.y);
  const hasPoints = values.length > 0;
  if (hasPoints && options.anchor != null) values.push(options.anchor);

  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!hasPoints) {
    min = 0;
    max = 1;
  } else {
    const span = Math.max(max - min, minSpan);
    const mid = (min + max) / 2;
    const padded = Math.max(span, max - min) * 0.1;
    const half = span / 2 + padded;
    min = mid - half;
    max = mid + half;
  }

  const xOf = (ts) => plot.x + ((ts - start) / windowUs) * plot.w;
  const yOf = (price) => plot.y + ((max - price) / (max - min)) * plot.h;

  drawGrid(ctx, plot, min, max, end, windowUs, dpr, yOf, xOf);
  if (hasPoints && options.anchor != null) drawAnchor(ctx, options.anchor, yOf, dpr, plot);
  if (options.strikes) drawStrikes(ctx, strikes, start, end, xOf, yOf, dpr, plot);
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  const painted = [...visible].sort((a, b) => a.series.width - b.series.width);
  for (const entry of painted) {
    ctx.lineWidth = entry.series.width * dpr;
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";
    for (const run of runs(entry.data)) {
      if (!run.length) continue;
      const pieces = entry.series.signed
        ? splitAtZero(run, entry.series.above, entry.series.below)
        : [{ color: entry.series.color, points: run }];
      for (const piece of pieces) {
        ctx.strokeStyle = piece.color;
        ctx.beginPath();
        piece.points.forEach((point, index) => {
          const x = xOf(point.t);
          const y = yOf(point.y);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }
  }
  ctx.restore();
  if (options.strikes) drawChangeovers(ctx, start, end, xOf, plot, dpr);
  if (options.trades) drawTrades(ctx, trades, xOf, yOf, dpr, plot);

  if (!hasPoints) {
    drawNotice(ctx, options.empty ?? "Waiting for book updates", plot, dpr);
  }

  return hasPoints;
}

function drawNotice(ctx, text, plot, dpr) {
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  ctx.fillStyle = "#6f685e";
  ctx.font = `${13 * dpr}px "Avenir Next", "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
}

function drawStrikes(ctx, strikes, start, end, xOf, yOf, dpr, plot) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.strokeStyle = "#1a1814";
  ctx.lineWidth = 1.6 * dpr;
  ctx.setLineDash([7 * dpr, 5 * dpr]);
  for (const strike of strikes) {
    const x0 = xOf(Math.max(strike.t, start));
    const x1 = xOf(Math.min(strike.end, end));
    if (x1 <= x0) continue;
    const y = yOf(strike.y);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAnchor(ctx, value, yOf, dpr, plot) {
  const y = yOf(value);
  if (y < plot.y || y > plot.y + plot.h) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.strokeStyle = "rgba(26, 24, 20, 0.28)";
  ctx.lineWidth = dpr;
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(plot.x, y);
  ctx.lineTo(plot.x + plot.w, y);
  ctx.stroke();
  ctx.restore();
}

function drawTrades(ctx, trades, xOf, yOf, dpr, plot) {
  const length = 22 * dpr;
  const head = 9 * dpr;
  const half = 7 * dpr;
  const neck = 2.6 * dpr;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const mark of trades) {
    const x = xOf(mark.t);
    if (x < plot.x || x > plot.x + plot.w) continue;
    const y = yOf(mark.y);
    const up = mark.side === "up";
    ctx.beginPath();
    if (up) {
      ctx.moveTo(x, y);
      ctx.lineTo(x - half, y + head);
      ctx.lineTo(x - neck, y + head);
      ctx.lineTo(x - neck, y + length);
      ctx.lineTo(x + neck, y + length);
      ctx.lineTo(x + neck, y + head);
      ctx.lineTo(x + half, y + head);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x - half, y - head);
      ctx.lineTo(x - neck, y - head);
      ctx.lineTo(x - neck, y - length);
      ctx.lineTo(x + neck, y - length);
      ctx.lineTo(x + neck, y - head);
      ctx.lineTo(x + half, y - head);
    }
    ctx.closePath();
    ctx.fillStyle = up ? "#14F195" : "#FF4B3A";
    ctx.fill();
    ctx.strokeStyle = "#1a1814";
    ctx.lineWidth = 0.8 * dpr;
    ctx.stroke();
  }
  ctx.restore();
}

function drawChangeovers(ctx, start, end, xOf, plot, dpr) {
  const startUs = Math.floor(start);
  const endUs = Math.ceil(end);
  let t = startUs - (startUs % MARKET_US);
  if (t < startUs) t += MARKET_US;
  const bar = 5 * dpr;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.fillStyle = "#111111";
  for (; t <= endUs; t += MARKET_US) {
    const x = xOf(t);
    ctx.fillRect(x - bar / 2, plot.y, bar, plot.h);
  }
  ctx.restore();
}

function drawGrid(ctx, plot, min, max, now, windowUs, dpr, yOf, xOf) {
  ctx.font = `${11 * dpr}px "SF Mono", ui-monospace, Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = dpr;

  const yStep = niceStep(max - min, 5);
  const yStart = Math.ceil(min / yStep) * yStep;
  const span = max - min;
  const digits = span < 0.2 ? 3 : span < 100 ? 2 : span < 500 ? 1 : 0;
  ctx.textAlign = "left";
  for (let value = yStart; value <= max + yStep * 0.01; value += yStep) {
    const y = yOf(value);
    if (y < plot.y || y > plot.y + plot.h) continue;
    ctx.strokeStyle = "rgba(26, 24, 20, 0.08)";
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = "#6f685e";
    ctx.fillText(formatPrice(value, digits), plot.x + plot.w + 8 * dpr, y);
  }

  const xStep = timeStep(windowUs);
  const xStart = Math.ceil((now - windowUs) / xStep) * xStep;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let lastLabelRight = plot.x;
  for (let ts = xStart; ts <= now + xStep * 0.01; ts += xStep) {
    const x = xOf(ts);
    if (x < plot.x || x > plot.x + plot.w) continue;
    ctx.strokeStyle = "rgba(26, 24, 20, 0.06)";
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    const label = formatClock(ts, xStep);
    const labelWidth = ctx.measureText(label).width;
    if (x - labelWidth / 2 < lastLabelRight + 8 * dpr) continue;
    if (x + labelWidth / 2 > plot.x + plot.w) continue;
    ctx.fillStyle = "#6f685e";
    ctx.fillText(label, x, plot.y + plot.h + 8 * dpr);
    lastLabelRight = x + labelWidth / 2;
  }
}

function stair(data) {
  if (data.length < 2) return data;
  const out = [data[0]];
  for (let i = 1; i < data.length; i += 1) {
    const prev = out[out.length - 1];
    const next = data[i];
    if (prev.y != null && next.y != null && prev.y !== next.y && next.t > prev.t + 1) {
      out.push({ ...prev, t: next.t - 1 });
    }
    out.push(next);
  }
  return out;
}

function holdLast(data, end, hold) {
  if (!hold || !data.length) return data;
  const last = data[data.length - 1];
  if (last.y == null || last.t >= end) return data;
  return data.concat([{ t: end, y: last.y }]);
}

function splitAtZero(run, above, below) {
  const pieces = [];
  const push = (color, a, b) => {
    const last = pieces[pieces.length - 1];
    if (last && last.color === color) {
      last.points.push(b);
      return;
    }
    pieces.push({ color, points: [a, b] });
  };

  for (let i = 1; i < run.length; i += 1) {
    const a = run[i - 1];
    const b = run[i];
    const sa = Math.sign(a.y);
    const sb = Math.sign(b.y);
    if (sa === 0 && sb === 0) continue;
    if (sa >= 0 && sb >= 0) {
      push(above, a, b);
      continue;
    }
    if (sa <= 0 && sb <= 0) {
      push(below, a, b);
      continue;
    }
    const frac = (0 - a.y) / (b.y - a.y);
    const zero = { t: a.t + (b.t - a.t) * frac, y: 0 };
    push(sa > 0 ? above : below, a, zero);
    push(sb > 0 ? above : below, zero, b);
  }
  return pieces;
}

function runs(data) {
  const out = [];
  let run = [];
  for (const point of data) {
    if (point.y == null) {
      if (run.length) out.push(run);
      run = [];
    } else {
      run.push(point);
    }
  }
  if (run.length) out.push(run);
  return out;
}

function segment(data, start, end) {
  let begin = 0;
  while (begin < data.length && data[begin].t < start) begin += 1;
  if (begin > 0) begin -= 1;
  const out = [];
  for (let i = begin; i < data.length; i += 1) {
    out.push(data[i]);
    if (data[i].t > end) break;
  }
  return out;
}

function niceStep(range, target) {
  const rough = range / Math.max(target, 1);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / pow;
  const nice = fraction >= 7.5 ? 10 : fraction >= 3.5 ? 5 : fraction >= 1.5 ? 2 : 1;
  return nice * pow;
}

function timeStep(windowUs) {
  const rough = windowUs / 4;
  const steps = [
    100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 15_000_000,
    30_000_000, 60_000_000, 120_000_000, 300_000_000, 600_000_000, 1_800_000_000, 3_600_000_000,
  ];
  return steps.find((step) => step >= rough) ?? steps[steps.length - 1];
}

function formatPrice(value, digits) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatClock(ts, step) {
  const date = new Date(ts / 1000);
  const clock = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
  if (step >= 1_000_000) return clock;
  return `${clock}.${Math.floor(date.getMilliseconds() / 100)}`;
}
