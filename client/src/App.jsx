import { useEffect, useRef, useState } from "react";
import { hydrateChartCache, loadChartCache, loadPlotSeconds, saveChartCache, savePlotSeconds, syncTradeRowsFromRef } from "./cache.js";
import { MARKET_US, POLY_SERIES, SERIES, drawBook, plotWidth } from "./chart.js";
import {
  DEFAULT_SECONDS,
  MIN_SECONDS,
  formatFee,
  formatMarketCountdown,
  formatMid,
  formatPnl,
  formatPx,
  formatSeconds,
  formatSigned,
  formatTradeTime,
  formatVol,
  normalizeFeed,
  secondsFromSlider,
  sliderValue,
  tyoPlotNotice,
} from "./format.js";
import { lastPnl, markedPnl } from "./pnl.js";
import {
  blankLatest,
  blankPoints,
  blankShown,
  freezeBasis,
  lastPlotted,
  measureHistorySeconds,
  noteServerUs,
  noteStrike,
  nowUs,
  pushPoly,
  stampBasis,
} from "./series.js";

const PNL_SERIES = [{ id: "pnl", width: 2.2, signed: true, above: "#14F195", below: "#FF4B3A" }];
const INITIAL_SECONDS = loadPlotSeconds();

export function App() {
  const canvasRef = useRef(null);
  const midCanvasRef = useRef(null);
  const pnlCanvasRef = useRef(null);
  const pointsRef = useRef(blankPoints());
  const polyPointsRef = useRef({ bid: [], ask: [], fair: [] });
  const latestRef = useRef(blankLatest());
  const basisRef = useRef(null);
  const basisStepsRef = useRef([]);
  const strikesRef = useRef([]);
  const tradesRef = useRef([]);
  const shownRef = useRef(blankShown());
  const polyRef = useRef(null);
  const fairRef = useRef(null);
  const strikeRef = useRef(null);
  const windowRef = useRef(INITIAL_SECONDS * 1_000_000);
  const historyUsRef = useRef(Math.max(DEFAULT_SECONDS, INITIAL_SECONDS) * 1_000_000);
  const followRef = useRef(true);
  const viewEndRef = useRef(0);
  const drawRef = useRef(() => {});
  const [basis, setBasis] = useState(null);
  const [shown, setShown] = useState(blankShown);
  const [poly, setPoly] = useState(null);
  const [fair, setFair] = useState(null);
  const [vol, setVol] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [tradeRows, setTradeRows] = useState([]);
  const [strike, setStrike] = useState(null);
  const [seconds, setSeconds] = useState(INITIAL_SECONDS);
  const [maxSeconds, setMaxSeconds] = useState(() => Math.max(DEFAULT_SECONDS, INITIAL_SECONDS));
  const [following, setFollowing] = useState(true);
  const [feed, setFeed] = useState({ status: "connecting", error: "" });
  const feedRef = useRef(feed);
  const [coin, setCoin] = useState("BTC");
  const [awaitingMarket, setAwaitingMarket] = useState(true);
  const [marketCountdown, setMarketCountdown] = useState(() => formatMarketCountdown(nowUs()));
  feedRef.current = feed;

  useEffect(() => {
    const tick = () => setMarketCountdown(formatMarketCountdown(nowUs()));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const midCanvas = midCanvasRef.current;
    const pnlCanvas = pnlCanvasRef.current;
    const charts = [canvas, midCanvas, pnlCanvas].filter(Boolean);
    const points = pointsRef.current;
    const polyPoints = polyPointsRef.current;
    let raf = 0;
    let closed = false;
    let coinName = "BTC";
    let cacheTimer = 0;

    const cached = loadChartCache();
    if (cached) {
      coinName = cached.coin || coinName;
      setCoin(coinName);
      hydrateChartCache(cached, {
        points,
        polyPoints,
        tradesRef,
        strikesRef,
        basisStepsRef,
        latestRef,
        polyRef,
        fairRef,
        basisRef,
      });
      syncTradeRowsFromRef(tradesRef, setTradeRows);
    }

    const requestDraw = () => {
      if (raf || closed) return;
      raf = setTimeout(() => {
        raf = 0;
        if (closed) return;
        const now = nowUs();
        const viewEnd = followRef.current ? now : clampEnd(viewEndRef.current);
        drawBook(canvas, points, now, windowRef.current, viewEnd, {
          strikes: strikesRef.current,
        });
        if (midCanvas) {
          drawBook(midCanvas, polyPoints, now, windowRef.current, viewEnd, {
            series: POLY_SERIES,
            minSpan: 0.02,
            hold: true,
            trades: tradesRef.current,
            empty: "Waiting for the Polymarket book",
          });
        }
        const pnlSeries = markedPnl(polyPoints.bid, polyPoints.ask, tradesRef.current, strikesRef.current);
        if (pnlCanvas) {
          drawBook(pnlCanvas, { pnl: pnlSeries }, now, windowRef.current, viewEnd, {
            series: PNL_SERIES,
            minSpan: 1,
            hold: true,
            anchor: 0,
            empty: "Waiting for a trade",
          });
        }
      }, 16);
    };
    drawRef.current = requestDraw;

    const drag = { pointerId: null, startX: 0, originEnd: 0, moved: false };

    const placeView = (viewEnd, moved) => {
      const slop = (windowRef.current / plotWidth(canvas)) * 6;
      if (nowUs() - viewEnd <= slop) {
        followRef.current = true;
        viewEndRef.current = nowUs();
        if (moved) setFollowing(true);
        return;
      }
      followRef.current = false;
      viewEndRef.current = viewEnd;
      setFollowing(false);
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      drag.pointerId = event.pointerId;
      drag.startX = event.clientX;
      drag.originEnd = followRef.current ? nowUs() : viewEndRef.current;
      drag.moved = false;
      drag.canvas = event.currentTarget;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer can already be gone if the gesture ends immediately.
      }
    };

    const onPointerMove = (event) => {
      if (drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true;
      drag.canvas?.classList.add("panning");
      const usPerPx = windowRef.current / plotWidth(drag.canvas || canvas);
      placeView(clampEnd(drag.originEnd - dx * usPerPx), true);
      requestDraw();
    };

    const endDrag = (event) => {
      if (drag.pointerId !== event.pointerId) return;
      drag.pointerId = null;
      drag.canvas?.classList.remove("panning");
      drag.canvas = null;
    };

    const onWheel = (event) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
      if (!delta) return;
      event.preventDefault();
      const usPerPx = windowRef.current / plotWidth(event.currentTarget);
      const origin = followRef.current ? nowUs() : viewEndRef.current;
      placeView(clampEnd(origin + delta * usPerPx), true);
      requestDraw();
    };

    for (const node of charts) {
      node.addEventListener("pointerdown", onPointerDown);
      node.addEventListener("pointermove", onPointerMove);
      node.addEventListener("pointerup", endDrag);
      node.addEventListener("pointercancel", endDrag);
      node.addEventListener("wheel", onWheel, { passive: false });
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const node of charts) {
        const rect = node.parentElement.getBoundingClientRect();
        node.width = Math.max(1, Math.floor(rect.width * dpr));
        node.height = Math.max(1, Math.floor(rect.height * dpr));
      }
      requestDraw();
    };

    const applyQuote = (market, quote) => {
      if (!points[market] && SERIES.some((series) => series.id === market)) points[market] = [];
      const series = points[market];
      const meta = SERIES.find((item) => item.id === market);
      if (!series || !meta || !quote || typeof quote.ts !== "number" || typeof quote.mid !== "number") return;
      if (market !== "chainlink-twap") noteServerUs(quote.ts);
      const last = series[series.length - 1];
      if (last && quote.ts < last.t) return;
      let added = null;
      if (!last || last.t !== quote.ts || last.raw !== quote.mid) {
        added = { t: quote.ts, raw: quote.mid, y: quote.mid };
        series.push(added);
      }
      latestRef.current[market] = quote;
      if (market === "chainlink-twap") noteStrike(quote.ts, quote.mid, strikesRef.current);
      if (market === "chainlink-twap" || market === "binance-perps-twap") freezeBasis(points, basisStepsRef, basisRef);
      if (added && meta.adjust) stampBasis(added, basisStepsRef.current);
    };

    const applyPoly = (quote) => {
      if (!quote || !quote.slug || typeof quote.ts !== "number") return;
      if (quote.bid != null && typeof quote.bid !== "number") return;
      if (quote.ask != null && typeof quote.ask !== "number") return;
      if (quote.bid == null && quote.ask == null) return;
      noteServerUs(quote.ts);
      pushPoly(polyPoints.bid, quote.ts, quote.bid ?? null, quote.slug);
      pushPoly(polyPoints.ask, quote.ts, quote.ask ?? null, quote.slug);
      polyRef.current = quote;
    };

    const applyFair = (point) => {
      if (!point || typeof point.ts !== "number") return;
      const value = typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null;
      if (point.value != null && value == null) return;
      noteServerUs(point.ts);
      pushPoly(polyPoints.fair, point.ts, value, point.slug ?? "");
      fairRef.current = value;
    };

    const tradeKey = (mark) => `${mark.ts}-${mark.side}-${mark.price}-${mark.quantity}-${mark.windowStart}`;

    const applyTrade = (mark, { list = true } = {}) => {
      if (!mark || (mark.side !== "up" && mark.side !== "down")) return;
      if (typeof mark.ts !== "number" || typeof mark.price !== "number") return;
      if (typeof mark.windowStart !== "number" || typeof mark.strike !== "number") return;
      if (typeof mark.quantity !== "number" || !(mark.quantity > 0)) return;
      noteServerUs(mark.ts);
      const key = tradeKey(mark);
      if (tradesRef.current.some((row) => row.key === key)) return;
      tradesRef.current.push({
        key,
        t: mark.ts,
        y: mark.price,
        side: mark.side,
        start: mark.windowStart,
        strike: mark.strike,
        price: mark.price,
        quantity: mark.quantity,
        fee: typeof mark.fee === "number" && mark.fee > 0 ? mark.fee : 0,
      });
      if (!list) return;
      setTradeRows((rows) => [
        {
          key,
          price: mark.price,
          quantity: mark.quantity,
          side: mark.side,
          fee: typeof mark.fee === "number" && mark.fee > 0 ? mark.fee : 0,
          time: formatTradeTime(mark.ts),
        },
        ...rows,
      ]);
    };

    const syncTradeRows = () => syncTradeRowsFromRef(tradesRef, setTradeRows);

    const persistCache = () => {
      saveChartCache({
        coin: coinName,
        points: pointsRef.current,
        poly: polyPointsRef.current,
        trades: tradesRef.current,
        strikes: strikesRef.current,
        basisSteps: basisStepsRef.current,
      });
    };

    const applyReset = (message) => {
      for (const series of SERIES) {
        points[series.id] = [];
        latestRef.current[series.id] = null;
      }
      polyPoints.bid = [];
      polyPoints.ask = [];
      polyPoints.fair = [];
      polyRef.current = null;
      fairRef.current = null;
      tradesRef.current = [];
      basisStepsRef.current = [];
      basisRef.current = null;
      strikesRef.current = [];
      if (message?.strike && typeof message.strike.ts === "number" && typeof message.strike.mid === "number") {
        noteStrike(message.strike.ts, message.strike.mid, strikesRef.current);
      }
      shownRef.current = blankShown();
      setTradeRows([]);
      setPnl(null);
      setFair(null);
      setPoly(null);
      setShown(blankShown());
      setBasis(null);
      setStrike(message?.strike?.mid ?? null);
      historyUsRef.current = DEFAULT_SECONDS * 1_000_000;
      setMaxSeconds(DEFAULT_SECONDS);
      if (windowRef.current / 1_000_000 > DEFAULT_SECONDS) {
        windowRef.current = DEFAULT_SECONDS * 1_000_000;
        setSeconds(DEFAULT_SECONDS);
        savePlotSeconds(DEFAULT_SECONDS);
      }
      persistCache();
    };

    const applyHistory = (message) => {
      const ticks = Array.isArray(message.ticks) ? message.ticks : [];
      const poly = Array.isArray(message.poly) ? message.poly : [];
      const fair = Array.isArray(message.fair) ? message.fair : [];
      const trades = Array.isArray(message.trades) ? message.trades : [];
      // Server history is ordered oldest→newest. Replace hydrated cache so we never
      // append older points after newer ones (that drew the diagonal on refresh).
      if (ticks.length || poly.length || fair.length) {
        for (const series of SERIES) points[series.id] = [];
        polyPoints.bid = [];
        polyPoints.ask = [];
        polyPoints.fair = [];
        basisStepsRef.current = [];
        basisRef.current = null;
        strikesRef.current = [];
      }
      if (trades.length) tradesRef.current = [];
      for (const tick of ticks) applyQuote(tick.market, tick);
      for (const quote of poly) applyPoly(quote);
      for (const point of fair) applyFair(point);
      for (const mark of trades) applyTrade(mark, { list: false });
      syncTradeRows();
      persistCache();
    };

    const queueCache = () => {
      if (cacheTimer || closed) return;
      cacheTimer = setTimeout(() => {
        cacheTimer = 0;
        if (!closed) persistCache();
      }, 2000);
    };

    let readoutQueued = false;
    const queueReadout = () => {
      if (readoutQueued) return;
      readoutQueued = true;
      setTimeout(() => {
        readoutQueued = false;
        if (closed) return;
        const nextShown = {};
        for (const series of SERIES) {
          nextShown[series.id] = series.adjust
            ? lastPlotted(points[series.id])
            : latestRef.current[series.id]?.mid ?? null;
        }
        shownRef.current = nextShown;
        const now = nowUs();
        const windowStart = Math.floor(now / MARKET_US) * MARKET_US;
        let strikePx = null;
        let liveStrike = null;
        for (const row of strikesRef.current) {
          if (row.t <= now) strikePx = row.y;
          if (row.t === windowStart && row.y != null) liveStrike = row.y;
        }
        strikeRef.current = strikePx;
        setShown(nextShown);
        setBasis(basisRef.current);
        setStrike(strikePx);
        setPoly(polyRef.current);
        setFair(fairRef.current);
        setPnl(lastPnl(markedPnl(polyPoints.bid, polyPoints.ask, tradesRef.current, strikesRef.current)));
        setAwaitingMarket(liveStrike == null);
        const spanSeconds = measureHistorySeconds(points, polyPoints, tradesRef.current);
        historyUsRef.current = spanSeconds * 1_000_000;
        setMaxSeconds((current) => (current === spanSeconds ? current : spanSeconds));
        if (windowRef.current / 1_000_000 > spanSeconds) {
          windowRef.current = spanSeconds * 1_000_000;
          setSeconds(spanSeconds);
          savePlotSeconds(spanSeconds);
        }
      }, 16);
    };

    const source = new EventSource("/api/stream");
    source.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "hello") {
        if (message.coin) {
          coinName = message.coin;
          setCoin(message.coin);
        }
        setFeed({ status: normalizeFeed(message.feed), error: message.error || "" });
        if (typeof message.vol === "number" && Number.isFinite(message.vol)) setVol(message.vol);
        else if (message.vol == null) setVol(null);
        for (const series of SERIES) applyQuote(series.id, message.quotes?.[series.id]);
        if (message.poly) applyPoly(message.poly);
      } else if (message.type === "history") {
        applyHistory(message);
      } else if (message.type === "reset") {
        applyReset(message);
      } else if (message.type === "poly") {
        applyPoly(message);
      } else if (message.type === "fair") {
        applyFair(message);
      } else if (message.type === "vol") {
        if (typeof message.value === "number" && Number.isFinite(message.value)) setVol(message.value);
        else setVol(null);
      } else if (message.type === "trade") {
        applyTrade(message);
      } else if (message.type === "tick") {
        applyQuote(message.market, message);
      } else if (message.type === "status") {
        setFeed({ status: normalizeFeed(message.feed), error: message.error || "" });
      }
      queueReadout();
      queueCache();
      requestDraw();
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setFeed({ status: "error", error: "Update stream closed" });
      } else {
        setFeed((current) => ({ status: "connecting", error: current.error }));
      }
    };

    const observer = new ResizeObserver(resize);
    for (const node of charts) observer.observe(node.parentElement);
    resize();
    const aging = setInterval(requestDraw, 500);
    const onLeave = () => persistCache();
    window.addEventListener("pagehide", onLeave);

    return () => {
      closed = true;
      drawRef.current = () => {};
      for (const node of charts) {
        node.removeEventListener("pointerdown", onPointerDown);
        node.removeEventListener("pointermove", onPointerMove);
        node.removeEventListener("pointerup", endDrag);
        node.removeEventListener("pointercancel", endDrag);
        node.removeEventListener("wheel", onWheel);
      }
      source.close();
      observer.disconnect();
      clearInterval(aging);
      window.removeEventListener("pagehide", onLeave);
      if (raf) clearTimeout(raf);
      if (cacheTimer) clearTimeout(cacheTimer);
      persistCache();
    };
  }, []);

  function clampEnd(viewEnd) {
    const now = nowUs();
    const windowUs = windowRef.current;
    const minEnd = now - historyUsRef.current + windowUs;
    return Math.min(now, Math.max(minEnd, viewEnd));
  }

  function onWidth(event) {
    const next = secondsFromSlider(event.target.value, maxSeconds);
    windowRef.current = next * 1_000_000;
    if (!followRef.current) viewEndRef.current = clampEnd(viewEndRef.current);
    setSeconds(next);
    savePlotSeconds(next);
    drawRef.current();
  }

  function goLive() {
    followRef.current = true;
    viewEndRef.current = nowUs();
    setFollowing(true);
    drawRef.current();
  }

  async function hardRestart() {
    try {
      await fetch("/api/restart", { method: "POST" });
    } catch {
      // The open stream still receives the reset event when the request reaches the server.
    }
  }

  return (
    <div className="screen">
      <header className="bar">
        <p className="ticker">{coin}</p>
        <label className="slider">
          <span>Width</span>
          <input
            type="range"
            min="0"
            max="1000"
            step="1"
            value={sliderValue(seconds, maxSeconds)}
            aria-label="Plot width in seconds"
            aria-valuemin={MIN_SECONDS}
            aria-valuemax={maxSeconds}
            aria-valuenow={Number(formatSeconds(seconds).replace(/[smh]/, ""))}
            aria-valuetext={formatSeconds(seconds)}
            onChange={onWidth}
          />
          <span className="slider-value">{formatSeconds(seconds)}</span>
        </label>
        {!following ? (
          <button type="button" className="now" onClick={goLive}>
            Jump to front
          </button>
        ) : null}
        <button type="button" className="now is-here" onClick={hardRestart}>
          Hard restart
        </button>
        {awaitingMarket ? (
          <p className="market-wait" role="status">
            Waiting for next market strike price
          </p>
        ) : null}
        <p className="market-countdown" aria-label="Time until market end">
          <span className="market-countdown-label">market end in:</span>
          <span className="market-countdown-time">{marketCountdown}</span>
        </p>
      </header>
      {feed.error && !tyoPlotNotice(feed) ? <p className="banner">{feed.error}</p> : null}
      <div className="plots">
        <div className="stage">
          <p className="plot-tag">
            <span className="key">
              <i style={{ background: "#1d4e89", height: 2 }} />
              <span>{coin} perps</span>
              <b>{shown["binance-perps"] != null ? formatPx(shown["binance-perps"]) : "—"}</b>
            </span>
            <span className="key">
              <i style={{ background: "#7eb6ff", height: 4 }} />
              <span>{coin} 60s Twap</span>
              <b>{shown["binance-perps-twap"] != null ? formatPx(shown["binance-perps-twap"]) : "—"}</b>
            </span>
            <span className="key">
              <i style={{ background: "#6b3fa0", height: 4 }} />
              <span>Chainlink twap</span>
              <b>{shown["chainlink-twap"] != null ? formatPx(shown["chainlink-twap"]) : "—"}</b>
            </span>
            <span className="key">
              <span>Basis</span>
              <b>{basis ? formatSigned(basis.basis) : "—"}</b>
            </span>
            <span className="key">
              <i className="strike" />
              <span>Strike</span>
              <b>{strike != null ? formatPx(strike) : "—"}</b>
            </span>
          </p>
          <canvas ref={canvasRef} role="img" aria-label={`${coin} perps, ${coin} 60 second TWAP, Chainlink TWAP, basis, and strike`} />
          {tyoPlotNotice(feed) ? (
            <div className="plot-notice" role="status">
              <div className="plot-notice-box">{tyoPlotNotice(feed)}</div>
            </div>
          ) : null}
        </div>
        <div className="stage">
          <p className="plot-tag">
            <span className="key">Polymarket</span>
            <span className="key">
              <i className="bid" />
              <span>Bid</span>
              <b>{poly?.bid != null ? formatMid(poly.bid) : "—"}</b>
            </span>
            <span className="key">
              <i className="ask" />
              <span>Ask</span>
              <b>{poly?.ask != null ? formatMid(poly.ask) : "—"}</b>
            </span>
            <span className="key">
              <i className="fair" />
              <span>Fair</span>
              <b>{fair != null ? formatMid(fair) : "—"}</b>
            </span>
            <span className="key">
              <span>Vol</span>
              <b>{vol != null ? formatVol(vol) : "—"}</b>
            </span>
          </p>
          <canvas ref={midCanvasRef} role="img" aria-label={`Polymarket ${coin} 5 minute Up bid, ask, fair value, and volatility`} />
        </div>
        <div className="stage">
          <p className="plot-tag">
            <span className="key">PnL</span>
            <b className={pnl == null ? "" : pnl > 0 ? "up" : pnl < 0 ? "down" : ""}>{pnl != null ? formatPnl(pnl) : "—"}</b>
          </p>
          <canvas ref={pnlCanvasRef} role="img" aria-label="Profit and loss marked to the Polymarket mid" />
        </div>
        <section className="stage trades" aria-label="Trades">
          <p className="trades-title">Trades</p>
          <div className="trade-scroll">
            <table>
              <thead>
                <tr>
                  <th>Price</th>
                  <th>Quantity</th>
                  <th>Direction</th>
                  <th>Fee</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {tradeRows.length ? (
                  tradeRows.map((row) => (
                    <tr key={row.key}>
                      <td>{formatMid(row.price)}</td>
                      <td>{row.quantity}</td>
                      <td className={row.side}>{row.side}</td>
                      <td>{formatFee(row.fee)}</td>
                      <td>{row.time}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="trades-empty" colSpan={5}>
                      Waiting for a trade
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
