"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart } from "lightweight-charts";
import type { IChartApi, MouseEventParams, Time, UTCTimestamp } from "lightweight-charts";
import { MOVING_AVERAGE_COLORS, PRICE_MA_PERIODS, VOLUME_MA_PERIODS, formatChartIndexAxis, formatChartVolumeAxis, volumeMovingAverage, volumePaneStretchFactor } from "@/components/chartPresentation";
import { chartKeyboardAction, panLogicalRange, zoomLogicalRange } from "@/components/priceChartKeyboard";
import { captureTimestamp } from "@/lib/capture";
import type { CaptureBar } from "@/lib/capture";
import type { ChartInterval } from "@/lib/types";
import "../chartParity.css";

type CaptureChartProps = {
  bars: CaptureBar[];
  active: boolean;
  ariaLabel: string;
  /** Verified parent-owned sector label; unknown codes are deliberately shown as raw source codes. */
  label?: string;
  /** Parent-owned 0602 fetch period, displayed only. */
  interval?: ChartInterval;
};
export type NormalizedCaptureBar = CaptureBar & { time: Time; timestamp: number };
export type CaptureBarSummary = {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  previousCloseChange: string | null;
};

const PERIODS = PRICE_MA_PERIODS;
const RECEIVED_BAR_LIMITS = [50, 100, 160, 300, "all"] as const;
type ReceivedBarLimit = (typeof RECEIVED_BAR_LIMITS)[number];
const VOLUME_LEGEND_PERIODS = [5, 20, 60] as const;

function chartTime(value: string, timestamp: number): Time {
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return day ? { year: Number(day[1]), month: Number(day[2]), day: Number(day[3]) } : Math.floor(timestamp / 1000) as UTCTimestamp;
}

function captureTimeKey(time: Time) {
  if (typeof time === "number" || typeof time === "string") return String(time);
  return `${time.year}${String(time.month).padStart(2, "0")}${String(time.day).padStart(2, "0")}`;
}

/** The display control is restricted to bars already received in this response. */
export function captureReceivedBarsRange(receivedCount: number, limit: ReceivedBarLimit) {
  const total = Math.max(0, Math.floor(receivedCount));
  return limit === "all" || total <= limit ? null : { from: Math.max(0, total - limit), to: total + 3 };
}

export function captureReceivedBarIndexOnDate(bars: readonly Pick<CaptureBar, "t">[], date: string) {
  const compactDate = date.replaceAll("-", "");
  if (!/^\d{8}$/.test(compactDate)) return -1;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const timestamp = captureTimestamp(bars[index].t);
    if (timestamp !== null && new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "") === compactDate) return index;
  }
  return -1;
}

function focusedCaptureRange(index: number, receivedCount: number, limit: Exclude<ReceivedBarLimit, "all">) {
  const total = Math.max(0, Math.floor(receivedCount));
  const span = Math.min(total, limit);
  const from = Math.max(0, Math.min(Math.max(0, total - span), index - Math.floor(span * 0.7)));
  return { from, to: Math.min(total + 3, from + span + 3) };
}

function captureIntervalLabel(interval: ChartInterval | undefined) {
  if (!interval) return "수신 주기";
  if (interval === "D") return "일봉";
  if (interval === "W") return "주봉";
  if (interval === "M") return "월봉";
  if (interval === "Y") return "년봉";
  return `${interval}분`;
}

/** Prevent provider ordering or duplicate stamps from causing a chart-runtime failure. */
export function normalizeCaptureBars(bars: CaptureBar[]): NormalizedCaptureBar[] {
  const byTime = new Map<number, NormalizedCaptureBar>();
  for (const bar of bars) {
    const timestamp = captureTimestamp(bar.t);
    if (timestamp === null || bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c) || bar.l > bar.h || (bar.v !== null && bar.v < 0)) continue;
    // A later provider correction for a timestamp supersedes an earlier row.
    byTime.set(timestamp, { ...bar, timestamp, time: chartTime(bar.t, timestamp) });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function captureMovingAverage(bars: NormalizedCaptureBar[], period: number) {
  let sum = 0;
  return bars.flatMap((bar, index) => {
    sum += bar.c;
    if (index >= period) sum -= bars[index - period].c;
    return index >= period - 1 ? [{ time: bar.time, value: sum / period }] : [];
  });
}

function formatCaptureTimestamp(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2}))?/.exec(value);
  if (!match) return value;
  return match[4] ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : `${match[1]}-${match[2]}-${match[3]}`;
}

/** A rendered value is always sourced from the most recent valid provider bar. */
export function captureBarSummary(bars: readonly NormalizedCaptureBar[], index = bars.length - 1): CaptureBarSummary | null {
  const latest = bars[index];
  if (!latest) return null;
  const previous = index > 0 ? bars[index - 1] : null;
  const difference = previous ? latest.c - previous.c : null;
  return {
    timestamp: formatCaptureTimestamp(latest.t),
    open: formatChartIndexAxis(latest.o),
    high: formatChartIndexAxis(latest.h),
    low: formatChartIndexAxis(latest.l),
    close: formatChartIndexAxis(latest.c),
    volume: latest.v === null ? "—" : formatChartVolumeAxis(latest.v),
    previousCloseChange: difference === null ? null : `${difference >= 0 ? "+" : ""}${formatChartIndexAxis(difference)}`,
  };
}

export function CaptureChart({ bars, active, ariaLabel, label = "업종 지수", interval }: CaptureChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const chartBars = useMemo(() => normalizeCaptureBars(bars), [bars]);
  const chartTimeByStamp = useMemo(() => new Map(chartBars.map((bar) => [bar.t, bar.time])), [chartBars]);
  const chartBarByTime = useMemo(() => new Map(chartBars.map((bar) => [captureTimeKey(bar.time), bar])), [chartBars]);
  const [hoveredBar, setHoveredBar] = useState<NormalizedCaptureBar | null>(null);
  const activeBar = hoveredBar ?? chartBars.at(-1) ?? null;
  const activeSummary = useMemo(() => captureBarSummary(chartBars, activeBar ? chartBars.indexOf(activeBar) : -1), [activeBar, chartBars]);
  const [volumeRatio, setVolumeRatio] = useState(0.26);
  const [volumeLegendTop, setVolumeLegendTop] = useState<number | null>(null);
  const [visibleBarLimit, setVisibleBarLimit] = useState<ReceivedBarLimit>(160);
  const visibleBarLimitRef = useRef<ReceivedBarLimit>(visibleBarLimit);
  const [receivedDate, setReceivedDate] = useState("");

  useEffect(() => {
    setHoveredBar(null);
  }, [chartBars]);

  useEffect(() => {
    visibleBarLimitRef.current = visibleBarLimit;
  }, [visibleBarLimit]);

  const changeViewport = useCallback((kind: "pan" | "zoom", direction: "left" | "right" | "in" | "out") => {
    const chart = chartRef.current;
    if (!chart) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    const next = kind === "pan"
      ? panLogicalRange(range, chartBars.length, direction as "left" | "right", false)
      : zoomLogicalRange(range, chartBars.length, direction as "in" | "out");
    if (next) chart.timeScale().setVisibleLogicalRange(next);
  }, [chartBars.length]);

  const setReceivedBarLimit = useCallback((limit: ReceivedBarLimit) => {
    setVisibleBarLimit(limit);
    const chart = chartRef.current;
    if (!chart) return;
    const range = captureReceivedBarsRange(chartBars.length, limit);
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else chart.timeScale().fitContent();
  }, [chartBars.length]);

  const focusReceivedDate = useCallback(() => {
    const index = captureReceivedBarIndexOnDate(chartBars, receivedDate);
    const chart = chartRef.current;
    if (!chart || index < 0) return;
    const limit = visibleBarLimit === "all" ? 160 : visibleBarLimit;
    if (visibleBarLimit === "all") setVisibleBarLimit(limit);
    chart.timeScale().setVisibleLogicalRange(focusedCaptureRange(index, chartBars.length, limit));
  }, [chartBars, receivedDate, visibleBarLimit]);

  const exportChartCsv = useCallback(() => {
    if (!chartBars.length || typeof document === "undefined") return;
    const csv = ["시각,시가,고가,저가,종가,거래량", ...chartBars.map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v ?? ""].join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "sector-chart.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [chartBars]);

  const handleChartKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = chartKeyboardAction(event);
    if (!action || action.kind === "interval") return;
    event.preventDefault();
    if (action.kind === "fit") chartRef.current?.timeScale().fitContent();
    else if (action.kind === "pan") changeViewport("pan", action.direction);
    else changeViewport("zoom", action.direction);
  }, [changeViewport]);

  const focusChartHost = useCallback((event: ReactPointerEvent<HTMLDivElement>) => event.currentTarget.focus(), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active || !chartBars.length) return;
    const height = Math.max(120, host.clientHeight || 180);
    const chart = createChart(host, {
      width: Math.max(1, host.clientWidth),
      height,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#171717", fontSize: 11, fontFamily: "Consolas, 'Apple SD Gothic Neo', monospace", attributionLogo: true, panes: { enableResize: true, separatorColor: "#d0d0d0", separatorHoverColor: "#315e91" } },
      grid: { vertLines: { color: "#d0d0d0" }, horzLines: { color: "#d0d0d0" } },
      rightPriceScale: { borderColor: "#8f8f8f", minimumWidth: 62 },
      timeScale: { borderColor: "#8f8f8f", timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#ef1c0b", downColor: "#1457c0", borderUpColor: "#ef1c0b", borderDownColor: "#1457c0", wickUpColor: "#ef1c0b", wickDownColor: "#1457c0", priceLineVisible: false,
      priceFormat: { type: "custom", minMove: 0.01, formatter: formatChartIndexAxis },
    });
    candle.setData(chartBars.map((bar) => ({ time: bar.time, open: bar.o, high: bar.h, low: bar.l, close: bar.c })));
    chart.addPane();
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "custom", minMove: 1, formatter: formatChartVolumeAxis }, priceLineVisible: false, lastValueVisible: false }, 1);
    volume.setData(chartBars.flatMap((bar) => bar.v === null ? [] : [{ time: bar.time, value: bar.v, color: bar.c >= bar.o ? "#ef1c0baa" : "#1457c0aa" }]));
    PERIODS.forEach((period) => {
      const series = chart.addSeries(LineSeries, { color: MOVING_AVERAGE_COLORS[period], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: { type: "custom", minMove: 0.01, formatter: formatChartIndexAxis } });
      series.setData(captureMovingAverage(chartBars, period));
    });
    VOLUME_MA_PERIODS.forEach((period) => {
      const series = chart.addSeries(LineSeries, { color: MOVING_AVERAGE_COLORS[period], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: { type: "custom", minMove: 1, formatter: formatChartVolumeAxis } }, 1);
      series.setData(volumeMovingAverage(chartBars, period).flatMap((point) => {
        const time = chartTimeByStamp.get(point.t);
        return time === undefined ? [] : [{ time, value: point.value }];
      }));
    });
    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      setHoveredBar(param.time ? chartBarByTime.get(captureTimeKey(param.time)) ?? null : null);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);
    const initialRange = captureReceivedBarsRange(chartBars.length, visibleBarLimitRef.current);
    if (initialRange) chart.timeScale().setVisibleLogicalRange(initialRange);
    else chart.timeScale().fitContent();
    const applyVolumeRatio = () => {
      const panes = chart.panes();
      const volumePane = panes[1];
      if (!volumePane) return;
      const otherStretch = panes.reduce((sum, pane, index) => index === 1 ? sum : sum + pane.getStretchFactor(), 0);
      volumePane.setStretchFactor(volumePaneStretchFactor(volumeRatio, otherStretch));
    };
    let legendFrame: number | null = null;
    const syncVolumeLegendTop = () => {
      const pricePaneHeight = chart.panes()[0]?.getHeight();
      if (typeof pricePaneHeight === "number" && pricePaneHeight > 0) {
        setVolumeLegendTop((current) => current === pricePaneHeight + 3 ? current : pricePaneHeight + 3);
      }
    };
    const resize = () => {
      const nextHeight = Math.max(120, host.clientHeight || 180);
      chart.resize(Math.max(1, host.clientWidth), nextHeight);
      applyVolumeRatio();
      syncVolumeLegendTop();
      if (typeof window.requestAnimationFrame === "function") {
        if (legendFrame !== null) window.cancelAnimationFrame(legendFrame);
        legendFrame = window.requestAnimationFrame(syncVolumeLegendTop);
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(host);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      if (legendFrame !== null) window.cancelAnimationFrame(legendFrame);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      if (chartRef.current === chart) chartRef.current = null;
      chart.remove();
    };
  }, [active, chartBarByTime, chartBars, chartTimeByStamp, volumeRatio]);

  if (!chartBars.length) return <p className="classic-empty" role="status">유효한 차트 데이터가 없습니다.</p>;
  return <section className="hts-chart-parity hts-chart-0602" aria-label={ariaLabel}>
    <div className="chart-parity-capture-toolbar"><span><strong>{label}</strong> · 지수 · 종가 · 단순 {PERIODS.map((period) => <b key={period} style={{ color: MOVING_AVERAGE_COLORS[period], marginLeft: 4 }}>{period}</b>)}</span><span>{captureIntervalLabel(interval)}</span><label className="chart-parity-date-control" title="현재 응답에서 받은 봉 안에서만 날짜를 찾아 이동합니다.">수신봉 내 이동<input aria-label="수신봉 내 날짜 이동" type="date" value={receivedDate} onInput={(event) => setReceivedDate(event.currentTarget.value)} onChange={(event) => setReceivedDate(event.target.value)} /><button type="button" className="chart-parity-button" onClick={focusReceivedDate} disabled={captureReceivedBarIndexOnDate(chartBars, receivedDate) < 0}>이동</button></label><label className="chart-parity-volume-control">거래량 {Math.round(volumeRatio * 100)}%<input className="chart-parity-slider" aria-label="거래량 영역 비율" type="range" min="18" max="38" value={Math.round(volumeRatio * 100)} onChange={(event) => setVolumeRatio(Number(event.target.value) / 100)} /></label></div>
    <div className="chart-parity-summary" aria-live="polite">
      {activeSummary ? <><span>{activeSummary.timestamp}</span><span>시가 {activeSummary.open}</span><span style={{ color: "var(--hts-chart-up)" }}>고가 {activeSummary.high}</span><span style={{ color: "var(--hts-chart-down)" }}>저가 {activeSummary.low}</span><span>종가 {activeSummary.close}</span><span>받은 거래량 {activeSummary.volume}</span>{activeSummary.previousCloseChange !== null && <span>직전봉 대비 {activeSummary.previousCloseChange}</span>}</> : <span>OHLC 대기</span>}
    </div>
    <div className="chart-parity-plot"><div ref={hostRef} tabIndex={0} data-testid="capture-lightweight-chart" aria-label={`${ariaLabel}. 키보드: + 또는 위 화살표 확대, - 또는 아래 화살표 축소, 좌우 이동, 별표 전체`} onPointerDown={focusChartHost} onKeyDown={handleChartKeyDown} /><div className="chart-parity-volume-legend" style={volumeLegendTop === null ? { visibility: "hidden" } : { top: `${volumeLegendTop}px` }} aria-label="받은 거래량 범례"><span>받은 거래량</span><span>선택 {activeBar?.v === null || activeBar?.v === undefined ? "—" : formatChartVolumeAxis(activeBar.v)}</span>{VOLUME_LEGEND_PERIODS.map((period) => <span key={period} style={{ color: MOVING_AVERAGE_COLORS[period] }}>MA{period}</span>)}</div></div>
    <div className="chart-parity-tools" aria-label="차트 이동 및 확대">
      <button type="button" className="chart-parity-button" onClick={() => changeViewport("pan", "left")} title="이전 구간">◀ 이전</button>
      <button type="button" className="chart-parity-button" onClick={() => changeViewport("pan", "right")} title="다음 구간">다음 ▶</button>
      <button type="button" className="chart-parity-button" onClick={() => changeViewport("zoom", "out")} title="축소">−</button>
      <button type="button" className="chart-parity-button" onClick={() => changeViewport("zoom", "in")} title="확대">＋</button>
      <button type="button" className="chart-parity-button" onClick={exportChartCsv} title="현재 수신한 OHLCV를 CSV로 내보냅니다.">CSV</button>
      <label className="chart-parity-display-control">표시 봉 수<select className="chart-parity-select" aria-label="표시 봉 수" value={visibleBarLimit} onChange={(event) => setReceivedBarLimit(event.target.value === "all" ? "all" : Number(event.target.value) as Exclude<ReceivedBarLimit, "all">)}>{RECEIVED_BAR_LIMITS.map((limit) => <option key={limit} value={limit}>{limit === "all" ? "전체(수신)" : `${limit}봉`}</option>)}</select><span className="chart-parity-received-count" title="현재 응답에서 받은 봉 수입니다.">수신 {chartBars.length}봉</span></label>
    </div>
    <footer className="chart-parity-provenance"><span>거래량 MA5 · 20 · 60 · 120은 유효한 거래량 구간만 표시</span><a className="chart-parity-attribution" href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a></footer>
  </section>;
}
