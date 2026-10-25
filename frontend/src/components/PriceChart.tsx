"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart } from "lightweight-charts";
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from "lightweight-charts";
import { api, isAbortError } from "@/lib/api";
import {
  chartAnnotationScopeKey,
  newChartToolId,
  pushAnnotationUndo,
  readChartToolScope,
  undoAnnotations,
  writeChartToolScope,
  type ChartAnnotation,
  type ChartAnnotationKind,
  type ChartAnnotationPoint,
  type ChartIndicatorSettings,
  type ChartIndicatorTemplate,
  type ChartToolScope,
} from "@/lib/chartAnnotations";
import { formatPrice } from "@/lib/format";
import { DEFAULT_EXTENDED_INDICATOR_PERIODS, extendedIndicators, latestExtendedIndicators, normalizeExtendedIndicatorPeriods } from "@/lib/extendedIndicators";
import type { ExtendedIndicatorPeriods } from "@/lib/extendedIndicators";
import { feedKeyOf, sameFeed } from "@/lib/types";
import { MOVING_AVERAGE_COLORS, PRICE_MA_PERIODS, formatChartPriceAxis, formatChartVolumeAxis, volumeMovingAverage, volumePaneStretchFactor } from "@/components/chartPresentation";
import { bollingerBands, formatMarketTime, macd, relativeStrengthIndex, simpleMovingAverage, toSeriesBars } from "@/components/priceChartData";
import { chartKeyboardAction, cycleChartInterval, panLogicalRange, zoomLogicalRange } from "@/components/priceChartKeyboard";
import type { ChartBar, ChartInterval, ChartPayload, Instrument, ObservedMinute, Quote } from "@/lib/types";
import "./chartParity.css";

export type PriceChartDisplayMode = "candles" | "line";
export type PriceChartMovingAverage = 5 | 20 | 60 | 120 | 240;

/** Panel-local state. The owner may persist it in the panel config; this component never uses localStorage. */
export type PriceChartPreferences = {
  interval: ChartInterval;
  displayMode: PriceChartDisplayMode;
  movingAverages: Record<PriceChartMovingAverage, boolean>;
  /** Fraction of the chart height reserved for the separate volume pane. */
  volumeRatio: number;
  showRsi: boolean;
  showMacd: boolean;
  showBollingerBands: boolean;
  /** Compact latest-value indicators; these never create additional chart panes. */
  extendedIndicatorPeriods: ExtendedIndicatorPeriods;
};

export type PriceChartPreferenceInput = Omit<Partial<PriceChartPreferences>, "extendedIndicatorPeriods"> & {
  extendedIndicatorPeriods?: Partial<ExtendedIndicatorPeriods>;
};

export type PriceChartProps = {
  instrument: Instrument;
  quote: Quote | null;
  onSelectPrice: (price: number) => void;
  refreshKey?: number;
  initialInterval?: ChartInterval;
  compact?: boolean;
  preferences?: PriceChartPreferenceInput;
  onPreferencesChange?: (preferences: PriceChartPreferences) => void;
  /** False for a hidden or unselected panel. It suppresses the 30-second REST refresh timer. */
  active?: boolean;
};

type Result = { requestKey: string; feedIdentity: string; payload: ChartPayload | null; error: string; loading: boolean };
type Runtime = {
  chart: IChartApi;
  dataBars: ChartBar[];
  priceSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">;
  volumeSeries: ISeriesApi<"Histogram">;
  volumeMovingAverageSeries: Partial<Record<Exclude<PriceChartMovingAverage, 240>, ISeriesApi<"Line">>>;
  movingAverageSeries: Partial<Record<PriceChartMovingAverage, ISeriesApi<"Line">>>;
  bollingerSeries: ISeriesApi<"Line">[];
  rsiSeries: ISeriesApi<"Line"> | null;
  macdHistogram: ISeriesApi<"Histogram"> | null;
  macdLine: ISeriesApi<"Line"> | null;
  macdSignal: ISeriesApi<"Line"> | null;
  referenceLines: IPriceLine[];
  liveTradeLine: IPriceLine | null;
};
type VisibleRange = { from: number; to: number };
type ChartPalette = { background: string; text: string; grid: string; up: string; down: string };
export type LiveCandleState = { bar: ChartBar; tradeSortKey: number };

const MA_PERIODS = PRICE_MA_PERIODS satisfies readonly PriceChartMovingAverage[];
const MA_COLORS = MOVING_AVERAGE_COLORS;
const CLASSIC_CHART_PALETTE: ChartPalette = {
  background: "#d8d8d8",
  text: "#171717",
  grid: "#f5f5f5",
  up: "#ee1c16",
  down: "#155fc5",
};
const CHART_UI_STYLE: CSSProperties = {};
const INTERVALS = [
  { id: "1", label: "1분" },
  { id: "3", label: "3분" },
  { id: "5", label: "5분" },
  { id: "10", label: "10분" },
  { id: "15", label: "15분" },
  { id: "30", label: "30분" },
  { id: "45", label: "45분" },
  { id: "60", label: "60분" },
  { id: "D", label: "일" },
  { id: "W", label: "주" },
  { id: "M", label: "월" },
  { id: "Y", label: "년" },
] as const satisfies ReadonlyArray<{ id: ChartInterval; label: string }>;
const EMPTY_BARS: ChartBar[] = [];
const REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_VOLUME_RATIO = 0.26;
const RECEIVED_BAR_LIMITS = [50, 100, 160, 300, "all"] as const;
type ReceivedBarLimit = (typeof RECEIVED_BAR_LIMITS)[number];
const VOLUME_LEGEND_PERIODS = [5, 20, 60] as const;
type DrawingTool = "idle" | "select" | ChartAnnotationKind;

function chartIdentity(instrument: Instrument, interval: ChartInterval) {
  return JSON.stringify({ ...feedKeyOf(instrument), interval });
}

function timeKey(time: Time) {
  if (typeof time === "number") return String(time);
  if (typeof time === "string") return time;
  return `${time.year}${String(time.month).padStart(2, "0")}${String(time.day).padStart(2, "0")}`;
}

function chartTime(time: ReturnType<typeof toSeriesBars>[number]["time"]) {
  return typeof time === "number" ? (time as UTCTimestamp) : time;
}

/** Range controls may navigate only the bars already returned by this response. */
export function receivedBarsRange(receivedCount: number, limit: ReceivedBarLimit): VisibleRange | null {
  const total = Math.max(0, Math.floor(receivedCount));
  if (limit === "all" || total <= limit) return null;
  return { from: Math.max(0, total - limit), to: total + 3 };
}

/** Finds the last received bar for the local date input; it never requests unavailable history. */
export function receivedBarIndexOnDate(bars: readonly Pick<ChartBar, "t">[], date: string, market: Instrument["market"] = "KR") {
  const compactDate = date.replaceAll("-", "");
  if (!/^\d{8}$/.test(compactDate)) return -1;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const timestamp = marketTimestamp(bars[index].t, market);
    if (timestamp && dayKey(timestamp) === compactDate) return index;
  }
  return -1;
}

function focusedReceivedRange(index: number, receivedCount: number, limit: Exclude<ReceivedBarLimit, "all">) {
  const total = Math.max(0, Math.floor(receivedCount));
  const span = Math.min(total, limit);
  const from = Math.max(0, Math.min(Math.max(0, total - span), index - Math.floor(span * 0.7)));
  return { from, to: Math.min(total + 3, from + span + 3) };
}

function pricePrecision(currency: Instrument["currency"]) {
  return currency === "KRW" ? 0 : 2;
}

function snapPrice(value: number, currency: Instrument["currency"]) {
  const factor = 10 ** pricePrecision(currency);
  return Math.round(value * factor) / factor;
}

function controlClass(active = false) {
  void active;
  return "chart-parity-button";
}

function controlStyle(active = false): CSSProperties {
  void active;
  return {};
}

function resolveChartPalette(host: HTMLElement): ChartPalette {
  const style = window.getComputedStyle(host);
  const tokenName = { background: "bg", text: "text", grid: "grid", up: "up", down: "down" } as const;
  const token = (name: keyof ChartPalette) =>
    style.getPropertyValue(`--hts-chart-${tokenName[name]}`).trim() || CLASSIC_CHART_PALETTE[name];
  return { background: token("background"), text: token("text"), grid: token("grid"), up: token("up"), down: token("down") };
}

/** A live book update must never alter the chart: only an explicit broker trade may. */
export function isUsableLiveTrade(instrument: Instrument, quote: Quote | null): quote is Quote & { last: number } {
  const receivedAt = quote?.priceReceivedAt ?? quote?.tradeReceivedAt;
  return Boolean(
    quote
    && sameFeed(instrument, quote)
    && quote.status === "live"
    && quote.priceLive !== false
    && typeof quote.last === "number"
    && Number.isFinite(quote.last)
    && quote.last > 0
    && typeof receivedAt === "string"
    && Number.isFinite(Date.parse(receivedAt)),
  );
}

type MarketTimestamp = { year: number; month: number; day: number; hour: number | null; minute: number | null; second: number; sortKey: number };

function validMarketTimestamp(year: number, month: number, day: number, hour: number | null, minute: number | null, second = 0): MarketTimestamp | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if ((hour === null) !== (minute === null) || (hour !== null && (hour < 0 || hour > 23 || minute === null || minute < 0 || minute > 59 || second < 0 || second > 59))) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const localHour = hour ?? 0, localMinute = minute ?? 0;
  return { year, month, day, hour, minute, second, sortKey: (((((year * 100 + month) * 100 + day) * 100 + localHour) * 100 + localMinute) * 100 + second) };
}

function marketTimeZone(market: Instrument["market"]) {
  return market === "KR" ? "Asia/Seoul" : "America/New_York";
}

function timestampFromInstant(raw: string, market: Instrument["market"]) {
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketTimeZone(market), year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epoch));
  const value = (kind: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === kind)?.value);
  return validMarketTimestamp(value("year"), value("month"), value("day"), value("hour"), value("minute"), value("second"));
}

/** Parses a broker source timestamp in the exchange's local calendar, or converts an offset-bearing ISO instant to that market. */
export function marketTimestamp(raw: string | null | undefined, market: Instrument["market"]): MarketTimestamp | null {
  if (!raw) return null;
  const value = raw.trim();
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/);
  if (compact) return validMarketTimestamp(Number(compact[1]), Number(compact[2]), Number(compact[3]), compact[4] === undefined ? null : Number(compact[4]), compact[5] === undefined ? null : Number(compact[5]), compact[6] === undefined ? 0 : Number(compact[6]));
  const localIso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (localIso) return validMarketTimestamp(Number(localIso[1]), Number(localIso[2]), Number(localIso[3]), localIso[4] === undefined ? null : Number(localIso[4]), localIso[5] === undefined ? null : Number(localIso[5]), localIso[6] === undefined ? 0 : Number(localIso[6]));
  // A source with an offset is an instant; convert it explicitly instead of assuming the browser's local time.
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return timestampFromInstant(value, market);
  return null;
}

function dayKey(timestamp: MarketTimestamp) {
  return `${timestamp.year}${String(timestamp.month).padStart(2, "0")}${String(timestamp.day).padStart(2, "0")}`;
}

function isoWeekKey(timestamp: MarketTimestamp) {
  const date = new Date(Date.UTC(timestamp.year, timestamp.month - 1, timestamp.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const weekYear = date.getUTCFullYear();
  const start = new Date(Date.UTC(weekYear, 0, 1));
  return `${weekYear}-W${String(Math.ceil((((date.getTime() - start.getTime()) / 86_400_000) + 1) / 7)).padStart(2, "0")}`;
}

function bucketForTimestamp(timestamp: MarketTimestamp, interval: ChartInterval) {
  if (interval === "D") return dayKey(timestamp);
  if (interval === "W") return isoWeekKey(timestamp);
  if (interval === "M") return `${timestamp.year}${String(timestamp.month).padStart(2, "0")}`;
  if (interval === "Y") return String(timestamp.year);
  if (timestamp.hour === null || timestamp.minute === null) return null;
  const size = Number(interval);
  if (!Number.isInteger(size) || size < 1) return null;
  const minute = timestamp.hour * 60 + timestamp.minute;
  return `${dayKey(timestamp)}-${String(Math.floor(minute / size) * size).padStart(4, "0")}`;
}

/** Returns an accumulated live candle only when source and final REST bar prove the same exchange-time bucket. */
export function nextLiveCandleState(current: LiveCandleState | null, bar: ChartBar | null, interval: ChartInterval, instrument: Instrument, quote: Quote | null): LiveCandleState | null {
  if (!bar || !isUsableLiveTrade(instrument, quote)) return null;
  const trade = marketTimestamp(quote.sourceTimestamp, instrument.market);
  const barTime = marketTimestamp(bar.t, instrument.market);
  if (!trade || !barTime || bucketForTimestamp(trade, interval) !== bucketForTimestamp(barTime, interval)) return null;
  if (current?.bar.t === bar.t) {
    // A later timestamp wins. With second-only provider precision, a changed
    // price is still a distinct observed trade; retaining it avoids dropping
    // a valid same-second high/low. An identical repeat is a no-op.
    if (trade.sortKey < current.tradeSortKey || (trade.sortKey === current.tradeSortKey && quote.last === current.bar.c)) return current;
    return { tradeSortKey: trade.sortKey, bar: { ...current.bar, h: Math.max(current.bar.h, quote.last), l: Math.min(current.bar.l, quote.last), c: quote.last } };
  }
  return { tradeSortKey: trade.sortKey, bar: { ...bar, h: Math.max(bar.h, quote.last), l: Math.min(bar.l, quote.last), c: quote.last } };
}

/**
 * A receipt-observed minute is deliberately a separate, incomplete local
 * observation. It is never merged into a provider REST OHLC bar. The marker
 * is shown only for a matching provider one-minute bar and a same-minute
 * receipt clock, without deriving a missing source timestamp or trade date.
 */
export function observedMinuteForCurrentRestBar(bar: ChartBar | null, interval: ChartInterval, instrument: Instrument, quote: Quote | null): ObservedMinute | null {
  const observed = quote?.observedMinute;
  if (!bar || interval !== "1" || !quote || !sameFeed(instrument, quote) || quote.priceLive !== true || !observed || observed.basis !== "receipt-time observations" || observed.complete !== false) return null;
  const restTime = marketTimestamp(bar.t, instrument.market);
  const observedTime = marketTimestamp(observed.bucketStart, instrument.market);
  const receiptTime = marketTimestamp(quote.priceReceivedAt ?? quote.tradeReceivedAt, instrument.market);
  if (!restTime || !observedTime || !receiptTime) return null;
  const currentBucket = bucketForTimestamp(restTime, "1");
  return currentBucket && currentBucket === bucketForTimestamp(observedTime, "1") && currentBucket === bucketForTimestamp(receiptTime, "1")
    ? observed
    : null;
}

function defaultPreferences(initialInterval: ChartInterval): PriceChartPreferences {
  return {
    interval: initialInterval,
    displayMode: "candles",
    movingAverages: { 5: true, 20: true, 60: true, 120: true, 240: true },
    volumeRatio: DEFAULT_VOLUME_RATIO,
    showRsi: false,
    showMacd: false,
    showBollingerBands: false,
    extendedIndicatorPeriods: DEFAULT_EXTENDED_INDICATOR_PERIODS,
  };
}

function applyPreferences(current: PriceChartPreferences, next: PriceChartPreferenceInput, initialInterval: ChartInterval) {
  return {
    interval: next.interval ?? current.interval ?? initialInterval,
    displayMode: next.displayMode ?? current.displayMode,
    movingAverages: { ...current.movingAverages, ...next.movingAverages },
    volumeRatio: normalizeVolumeRatio(next.volumeRatio ?? current.volumeRatio),
    showRsi: next.showRsi ?? current.showRsi,
    showMacd: next.showMacd ?? current.showMacd,
    showBollingerBands: next.showBollingerBands ?? current.showBollingerBands,
    extendedIndicatorPeriods: normalizeExtendedIndicatorPeriods(next.extendedIndicatorPeriods ?? current.extendedIndicatorPeriods),
  };
}

function samePreferences(a: PriceChartPreferences, b: PriceChartPreferences) {
  return a.interval === b.interval
    && a.displayMode === b.displayMode
    && a.volumeRatio === b.volumeRatio
    && a.showRsi === b.showRsi
    && a.showMacd === b.showMacd
    && a.showBollingerBands === b.showBollingerBands
    && a.extendedIndicatorPeriods.atr === b.extendedIndicatorPeriods.atr
    && a.extendedIndicatorPeriods.adx === b.extendedIndicatorPeriods.adx
    && a.extendedIndicatorPeriods.stochastic === b.extendedIndicatorPeriods.stochastic
    && a.extendedIndicatorPeriods.stochasticSignal === b.extendedIndicatorPeriods.stochasticSignal
    && a.extendedIndicatorPeriods.cci === b.extendedIndicatorPeriods.cci
    && a.movingAverages[5] === b.movingAverages[5]
    && a.movingAverages[20] === b.movingAverages[20]
    && a.movingAverages[60] === b.movingAverages[60]
    && a.movingAverages[120] === b.movingAverages[120]
    && a.movingAverages[240] === b.movingAverages[240];
}

export function normalizeVolumeRatio(value: number) {
  return Number.isFinite(value) ? Math.max(0.15, Math.min(0.45, value)) : DEFAULT_VOLUME_RATIO;
}

const TWO_POINT_DRAWINGS = new Set<ChartAnnotationKind>(["trend", "rectangle", "fibonacci", "measurement"]);

function annotationScope(instrument: Instrument, interval: ChartInterval) {
  return {
    market: instrument.market,
    stkCd: instrument.stkCd,
    listingVenue: instrument.listingVenue,
    quoteVenue: instrument.quoteVenue,
    currency: instrument.currency,
    environment: instrument.environment,
    interval,
  };
}

function indicatorSettings(preferences: PriceChartPreferences): ChartIndicatorSettings {
  return {
    displayMode: preferences.displayMode,
    movingAverages: {
      "5": preferences.movingAverages[5],
      "20": preferences.movingAverages[20],
      "60": preferences.movingAverages[60],
      "120": preferences.movingAverages[120],
      "240": preferences.movingAverages[240],
    },
    showRsi: preferences.showRsi,
    showMacd: preferences.showMacd,
    showBollingerBands: preferences.showBollingerBands,
  };
}

function preferencesFromIndicatorSettings(current: PriceChartPreferences, settings: ChartIndicatorSettings): PriceChartPreferences {
  return {
    ...current,
    displayMode: settings.displayMode,
    movingAverages: {
      5: settings.movingAverages["5"],
      20: settings.movingAverages["20"],
      60: settings.movingAverages["60"],
      120: settings.movingAverages["120"],
      240: settings.movingAverages["240"],
    },
    showRsi: settings.showRsi,
    showMacd: settings.showMacd,
    showBollingerBands: settings.showBollingerBands,
  };
}

function sameBars(a: ChartBar[], b: ChartBar[]) {
  return a === b || (a.length === b.length && a.every((bar, index) => {
    const other = b[index];
    return bar.t === other.t && bar.o === other.o && bar.h === other.h && bar.l === other.l && bar.c === other.c && bar.v === other.v;
  }));
}

function indicatorData(points: Array<{ t: string; value: number }>, timeByStamp: Map<string, ReturnType<typeof chartTime>>) {
  return points.flatMap((point) => {
    const time = timeByStamp.get(point.t);
    return time === undefined ? [] : [{ time, value: point.value }];
  });
}

type ExtendedPeriodKey = keyof ExtendedIndicatorPeriods;
const EXTENDED_PERIOD_CONTROLS: ReadonlyArray<{ key: ExtendedPeriodKey; label: string; min: number; max: number }> = [
  { key: "atr", label: "ATR", min: 2, max: 100 },
  { key: "adx", label: "ADX", min: 2, max: 100 },
  { key: "stochastic", label: "STO %K", min: 2, max: 100 },
  { key: "stochasticSignal", label: "STO %D", min: 1, max: 50 },
  { key: "cci", label: "CCI", min: 2, max: 100 },
];

function formatExtendedValue(value: number | null, digits = 2) {
  return value === null || !Number.isFinite(value)
    ? "— (워밍업)"
    : new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function rememberViewport(viewports: Map<string, VisibleRange>, identity: string, range: VisibleRange) {
  viewports.delete(identity);
  viewports.set(identity, range);
  if (viewports.size > 24) viewports.delete(viewports.keys().next().value as string);
}

function indicatorPaneHeight(hostHeight: number, paneCount: number, compact: boolean) {
  if (paneCount < 1) return 0;
  const preferred = compact ? 58 : 82;
  const minimumPricePane = compact ? 120 : 100;
  const availablePerPane = Math.floor(Math.max(30 * paneCount, hostHeight - minimumPricePane) / paneCount);
  return Math.max(30, Math.min(preferred, availablePerPane));
}

function applyVolumePaneRatio(chart: IChartApi, volumeRatio: number) {
  const panes = chart.panes();
  const volumePane = panes[1];
  if (!volumePane) return;
  const otherStretch = panes.reduce((sum, pane, index) => index === 1 ? sum : sum + pane.getStretchFactor(), 0);
  volumePane.setStretchFactor(volumePaneStretchFactor(volumeRatio, otherStretch));
}

export function PriceChart({
  instrument,
  quote,
  onSelectPrice,
  refreshKey = 0,
  initialInterval = "D",
  compact = false,
  preferences: incomingPreferences,
  onPreferencesChange,
  active = true,
}: PriceChartProps) {
  const [preferences, setPreferences] = useState<PriceChartPreferences>(() => applyPreferences(defaultPreferences(initialInterval), incomingPreferences ?? {}, initialInterval));
  const [referencePrices, setReferencePrices] = useState<number[]>([]);
  const [hoveredBar, setHoveredBar] = useState<ChartBar | null>(null);
  const [renderedLiveBar, setRenderedLiveBar] = useState<ChartBar | null>(null);
  const [visibleBarLimit, setVisibleBarLimit] = useState<ReceivedBarLimit>(160);
  const [receivedDate, setReceivedDate] = useState("");
  const [volumeLegendTop, setVolumeLegendTop] = useState<number | null>(null);
  const [chartVersion, setChartVersion] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [chartTools, setChartTools] = useState<ChartToolScope>({ drawings: [], templates: [] });
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("idle");
  const [pendingDrawingPoint, setPendingDrawingPoint] = useState<ChartAnnotationPoint | null>(null);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawingText, setDrawingText] = useState("메모");
  const [templateName, setTemplateName] = useState("");
  const [annotationHistory, setAnnotationHistory] = useState<ChartAnnotation[][]>([]);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const chartHostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const preferencesRef = useRef(preferences);
  const visibleBarLimitRef = useRef<ReceivedBarLimit>(visibleBarLimit);
  const pendingUserPreferencesRef = useRef<PriceChartPreferences | null>(null);
  const onSelectPriceRef = useRef(onSelectPrice);
  const onPreferencesChangeRef = useRef(onPreferencesChange);
  const viewportRef = useRef(new Map<string, VisibleRange>());
  const liveCandleRef = useRef<LiveCandleState | null>(null);
  const barsByStampRef = useRef(new Map<string, ChartBar>());
  const timeLabelsRef = useRef(new Map<string, string>());
  const toolScopeKeyRef = useRef("");
  const chartToolsRef = useRef(chartTools);

  useEffect(() => {
    onSelectPriceRef.current = onSelectPrice;
  }, [onSelectPrice]);

  useEffect(() => {
    onPreferencesChangeRef.current = onPreferencesChange;
  }, [onPreferencesChange]);

  useEffect(() => {
    setPreferences((current) => {
      const next = incomingPreferences
        ? applyPreferences(current, incomingPreferences, initialInterval)
        : { ...current, interval: initialInterval };
      return samePreferences(current, next) ? current : next;
    });
  }, [initialInterval, incomingPreferences?.displayMode, incomingPreferences?.interval, incomingPreferences?.movingAverages?.[5], incomingPreferences?.movingAverages?.[20], incomingPreferences?.movingAverages?.[60], incomingPreferences?.movingAverages?.[120], incomingPreferences?.movingAverages?.[240], incomingPreferences?.showBollingerBands, incomingPreferences?.showMacd, incomingPreferences?.showRsi, incomingPreferences?.volumeRatio, incomingPreferences?.extendedIndicatorPeriods?.atr, incomingPreferences?.extendedIndicatorPeriods?.adx, incomingPreferences?.extendedIndicatorPeriods?.stochastic, incomingPreferences?.extendedIndicatorPeriods?.stochasticSignal, incomingPreferences?.extendedIndicatorPeriods?.cci]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    chartToolsRef.current = chartTools;
  }, [chartTools]);

  useEffect(() => {
    visibleBarLimitRef.current = visibleBarLimit;
  }, [visibleBarLimit]);

  useEffect(() => {
    const pending = pendingUserPreferencesRef.current;
    if (!pending) return;
    if (!samePreferences(pending, preferences)) {
      pendingUserPreferencesRef.current = null;
      return;
    }
    pendingUserPreferencesRef.current = null;
    onPreferencesChangeRef.current?.(preferences);
  }, [preferences]);

  const updatePreferences = useCallback((change: (current: PriceChartPreferences) => PriceChartPreferences) => {
    const current = preferencesRef.current;
    const next = change(current);
    if (samePreferences(current, next)) return;
    preferencesRef.current = next;
    pendingUserPreferencesRef.current = next;
    setPreferences(next);
  }, []);

  const feedIdentity = chartIdentity(instrument, preferences.interval);
  const savedToolsScope = useMemo(() => annotationScope(instrument, preferences.interval), [instrument.currency, instrument.environment, instrument.listingVenue, instrument.market, instrument.quoteVenue, instrument.stkCd, preferences.interval]);
  const savedToolsScopeKey = chartAnnotationScopeKey(savedToolsScope);
  const requestKey = `${feedIdentity}:${refreshKey}:${refreshNonce}`;
  const [result, setResult] = useState<Result>(() => ({ requestKey, feedIdentity, payload: null, error: "", loading: true }));

  const triggerRefresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setResult((previous) => ({
      requestKey,
      feedIdentity,
      payload: previous.feedIdentity === feedIdentity ? previous.payload : null,
      error: "",
      loading: true,
    }));
    void api
      .chart(instrument, preferences.interval, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setResult((previous) => {
          if (previous.requestKey !== requestKey) return previous;
          const existing = previous.feedIdentity === feedIdentity ? previous.payload : null;
          return {
            requestKey,
            feedIdentity,
            payload: existing && sameBars(existing.bars, payload.bars) ? { ...payload, bars: existing.bars } : payload,
            error: "",
            loading: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setResult((previous) => previous.requestKey === requestKey ? {
          ...previous,
          error: error instanceof Error ? error.message : "차트를 불러오지 못했습니다.",
          loading: false,
        } : previous);
      });
    return () => controller.abort();
    // A request is always bound to the complete feed identity and generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, active]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") triggerRefresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, feedIdentity, triggerRefresh]);

  useEffect(() => {
    const storage = typeof window === "undefined" ? null : window.localStorage;
    setChartTools(readChartToolScope(storage, savedToolsScope));
    setAnnotationHistory([]);
    setSelectedDrawingId(null);
    setPendingDrawingPoint(null);
    setDrawingTool("idle");
    toolScopeKeyRef.current = "";
    // Scope contains full market, venue, currency, environment and interval;
    // a symbol or timeframe can never reuse another scope's records.
  }, [savedToolsScopeKey]);

  useEffect(() => {
    if (toolScopeKeyRef.current === "") {
      toolScopeKeyRef.current = savedToolsScopeKey;
      return;
    }
    if (toolScopeKeyRef.current !== savedToolsScopeKey) return;
    const storage = typeof window === "undefined" ? null : window.localStorage;
    writeChartToolScope(storage, savedToolsScope, chartTools);
  }, [chartTools, savedToolsScope, savedToolsScopeKey]);

  useEffect(() => {
    setHoveredBar(null);
    setRenderedLiveBar(null);
    setReferencePrices([]);
    liveCandleRef.current = null;
  }, [feedIdentity]);

  const payload = result.feedIdentity === feedIdentity && result.payload && sameFeed(result.payload, instrument) ? result.payload : null;
  const bars = payload?.bars ?? EMPTY_BARS;
  const seriesBars = useMemo(() => toSeriesBars(bars), [bars]);
  const chartTimesByStamp = useMemo(() => new Map(seriesBars.map((bar) => [bar.t, chartTime(bar.time)])), [seriesBars]);
  const timeLabels = useMemo(() => new Map(seriesBars.map((bar) => [timeKey(chartTime(bar.time)), bar.t])), [seriesBars]);
  const barsByStamp = useMemo(() => new Map(bars.map((bar) => [bar.t, bar])), [bars]);
  barsByStampRef.current = barsByStamp;
  timeLabelsRef.current = timeLabels;
  const activeBar = useMemo(() => {
    const selected = hoveredBar ?? bars[bars.length - 1] ?? null;
    if (!renderedLiveBar || renderedLiveBar.t !== selected?.t) return selected;
    // Live updates change OHLC only after same-bucket validation; volume remains the received-bar value.
    return { ...selected, o: renderedLiveBar.o, h: renderedLiveBar.h, l: renderedLiveBar.l, c: renderedLiveBar.c };
  }, [bars, hoveredBar, renderedLiveBar]);
  const hasVerifiedLiveCandle = useMemo(() => Boolean(nextLiveCandleState(null, bars[bars.length - 1] ?? null, preferences.interval, instrument, quote)), [bars, instrument, preferences.interval, quote]);
  const observedMinute = useMemo(() => observedMinuteForCurrentRestBar(bars[bars.length - 1] ?? null, preferences.interval, instrument, quote), [bars, instrument, preferences.interval, quote]);
  const volumeRatio = preferences.volumeRatio;
  const extendedValues = useMemo(
    () => extendedIndicators(bars, preferences.extendedIndicatorPeriods),
    [bars, preferences.extendedIndicatorPeriods.atr, preferences.extendedIndicatorPeriods.adx, preferences.extendedIndicatorPeriods.stochastic, preferences.extendedIndicatorPeriods.stochasticSignal, preferences.extendedIndicatorPeriods.cci],
  );
  const latestExtended = useMemo(() => latestExtendedIndicators(extendedValues), [extendedValues]);

  useEffect(() => {
    const host = chartHostRef.current;
    if (!host || seriesBars.length === 0) return;
    const palette = resolveChartPalette(host);

    const chart = createChart(host, {
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 1),
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
        fontSize: compact ? 10 : 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        attributionLogo: true,
        panes: { enableResize: true, separatorColor: palette.grid, separatorHoverColor: palette.text },
      },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderColor: palette.grid, minimumWidth: compact ? 52 : 62 },
      timeScale: {
        borderColor: palette.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        tickMarkFormatter: (time: Time) => {
          const raw = timeLabelsRef.current.get(timeKey(time));
          return raw ? formatMarketTime(raw) : null;
        },
      },
      localization: {
        timeFormatter: (time: Time) => {
          const raw = timeLabelsRef.current.get(timeKey(time));
          return raw ? formatMarketTime(raw) : "";
        },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: palette.text, width: 1, style: LineStyle.Dashed, labelBackgroundColor: palette.background },
        horzLine: { color: palette.text, width: 1, style: LineStyle.Dashed, labelBackgroundColor: palette.background },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const priceFormat = {
      type: "custom" as const,
      minMove: 1 / 10 ** pricePrecision(instrument.currency),
      formatter: (price: number) => formatChartPriceAxis(price, instrument.currency),
    };
    let priceSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">;
    if (preferences.displayMode === "candles") {
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: palette.up,
        downColor: palette.down,
        borderUpColor: palette.up,
        borderDownColor: palette.down,
        wickUpColor: palette.up,
        wickDownColor: palette.down,
        priceFormat,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      candles.setData(seriesBars.map((bar) => ({ time: chartTime(bar.time), open: bar.o, high: bar.h, low: bar.l, close: bar.c })));
      priceSeries = candles;
    } else {
      const line = chart.addSeries(LineSeries, { color: "#e5ad39", lineWidth: 2, priceFormat, priceLineVisible: false, lastValueVisible: true });
      line.setData(seriesBars.map((bar) => ({ time: chartTime(bar.time), value: bar.c })));
      priceSeries = line;
    }

    chart.addPane();
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "custom", minMove: 1, formatter: formatChartVolumeAxis },
      lastValueVisible: false,
      priceLineVisible: false,
    }, 1);
    volume.setData(seriesBars.map((bar) => ({ time: chartTime(bar.time), value: bar.v ?? 0, color: bar.c >= bar.o ? palette.up : palette.down })));
    const volumeMovingAverageSeries: Runtime["volumeMovingAverageSeries"] = {};
    MA_PERIODS.filter((period) => period !== 240).forEach((period) => {
      const series = chart.addSeries(LineSeries, {
        color: MA_COLORS[period], lineWidth: 1, priceFormat: { type: "custom", minMove: 1, formatter: formatChartVolumeAxis },
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      }, 1);
      series.setData(indicatorData(volumeMovingAverage(bars, period), chartTimesByStamp));
      volumeMovingAverageSeries[period] = series;
    });

    const movingAverageSeries: Runtime["movingAverageSeries"] = {};
    MA_PERIODS.forEach((period) => {
      if (!preferences.movingAverages[period]) return;
      const series = chart.addSeries(LineSeries, { color: MA_COLORS[period], lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      series.setData(indicatorData(simpleMovingAverage(bars, period), chartTimesByStamp));
      movingAverageSeries[period] = series;
    });

    const bollingerSeries: ISeriesApi<"Line">[] = [];
    if (preferences.showBollingerBands) {
      const bands = bollingerBands(bars);
      ([
        ["upper", "#6ba8d9"],
        ["middle", "#8b9bb0"],
        ["lower", "#6ba8d9"],
      ] as const).forEach(([band, color]) => {
        const series = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: band === "middle" ? LineStyle.Dotted : LineStyle.Solid, priceFormat, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        series.setData(bands.flatMap((point) => {
          const time = chartTimesByStamp.get(point.t);
          return time === undefined ? [] : [{ time, value: point[band] }];
        }));
        bollingerSeries.push(series);
      });
    }

    // Pane 1 is the dedicated volume pane; optional indicators start below it.
    let nextPaneIndex = 2;
    const indicatorPaneIndexes: number[] = [];
    let rsiSeries: ISeriesApi<"Line"> | null = null;
    if (preferences.showRsi) {
      const paneIndex = nextPaneIndex++;
      indicatorPaneIndexes.push(paneIndex);
      const rsi = chart.addSeries(LineSeries, { color: "#c59cff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, paneIndex);
      rsi.setData(indicatorData(relativeStrengthIndex(bars), chartTimesByStamp));
      rsiSeries = rsi;
      rsi.createPriceLine({ price: 70, color: "#845b64", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "70" });
      rsi.createPriceLine({ price: 30, color: "#365b87", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "30" });
    }

    let macdHistogram: ISeriesApi<"Histogram"> | null = null;
    let macdLine: ISeriesApi<"Line"> | null = null;
    let macdSignal: ISeriesApi<"Line"> | null = null;
    if (preferences.showMacd) {
      const paneIndex = nextPaneIndex;
      indicatorPaneIndexes.push(paneIndex);
      const values = macd(bars);
      const histogram = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, base: 0 }, paneIndex);
      histogram.setData(values.flatMap((point) => {
        const time = chartTimesByStamp.get(point.t);
        return time === undefined || point.histogram === null ? [] : [{ time, value: point.histogram, color: point.histogram >= 0 ? palette.up : palette.down }];
      }));
      macdHistogram = histogram;
      const macdLineSeries = chart.addSeries(LineSeries, { color: "#e5ad39", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, paneIndex);
      macdLineSeries.setData(values.flatMap((point) => {
        const time = chartTimesByStamp.get(point.t);
        return time === undefined || point.macd === null ? [] : [{ time, value: point.macd }];
      }));
      macdLine = macdLineSeries;
      const signalSeries = chart.addSeries(LineSeries, { color: "#9dce74", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, paneIndex);
      signalSeries.setData(values.flatMap((point) => {
        const time = chartTimesByStamp.get(point.t);
        return time === undefined || point.signal === null ? [] : [{ time, value: point.signal }];
      }));
      macdSignal = signalSeries;
    }

    liveCandleRef.current = null;
    runtimeRef.current = { chart, dataBars: bars, priceSeries, volumeSeries: volume, volumeMovingAverageSeries, movingAverageSeries, bollingerSeries, rsiSeries, macdHistogram, macdLine, macdSignal, referenceLines: [], liveTradeLine: null };
    setChartVersion((version) => version + 1);

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const raw = param.time ? timeLabelsRef.current.get(timeKey(param.time)) : undefined;
      setHoveredBar(raw ? barsByStampRef.current.get(raw) ?? null : null);
    };
    const onClick = (param: MouseEventParams<Time>) => {
      if (!param.point || param.paneIndex !== 0) return;
      const price = priceSeries.coordinateToPrice(param.point.y);
      if (price === null) return;
      const selected = snapPrice(Number(price), instrument.currency);
      setReferencePrices((current) => (current.some((value) => value === selected) ? current : [...current, selected].slice(-12)));
      onSelectPriceRef.current(selected);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);
    chart.subscribeClick(onClick);
    const restoredViewport = viewportRef.current.get(feedIdentity);
    if (restoredViewport) chart.timeScale().setVisibleLogicalRange(restoredViewport);
    else {
      const range = receivedBarsRange(seriesBars.length, visibleBarLimitRef.current);
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      else chart.timeScale().fitContent();
    }

    let legendFrame: number | null = null;
    const syncVolumeLegendTop = () => {
      const pricePaneHeight = chart.panes()[0]?.getHeight();
      if (typeof pricePaneHeight === "number" && pricePaneHeight > 0) {
        setVolumeLegendTop((current) => current === pricePaneHeight + 3 ? current : pricePaneHeight + 3);
      }
    };
    const resize = () => {
      const height = Math.max(host.clientHeight, 1);
      chart.resize(Math.max(host.clientWidth, 1), height);
      const paneHeight = indicatorPaneHeight(height, indicatorPaneIndexes.length, compact);
      indicatorPaneIndexes.forEach((paneIndex) => chart.panes()[paneIndex]?.setHeight(paneHeight));
      applyVolumePaneRatio(chart, volumeRatio);
      syncVolumeLegendTop();
      setOverlayVersion((version) => version + 1);
      if (typeof window.requestAnimationFrame === "function") {
        if (legendFrame !== null) window.cancelAnimationFrame(legendFrame);
        legendFrame = window.requestAnimationFrame(syncVolumeLegendTop);
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(host);
    resize();

    return () => {
      observer?.disconnect();
      if (legendFrame !== null) window.cancelAnimationFrame(legendFrame);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.unsubscribeClick(onClick);
      const range = chart.timeScale().getVisibleLogicalRange();
      if (range) rememberViewport(viewportRef.current, feedIdentity, range);
      chart.remove();
      if (runtimeRef.current?.chart === chart) runtimeRef.current = null;
    };
  // Structure changes recreate Lightweight Charts; ordinary REST bar refreshes
  // are applied below with public setData APIs so viewport and tools survive.
  }, [compact, feedIdentity, instrument.currency, preferences.displayMode, preferences.movingAverages, preferences.showBollingerBands, preferences.showMacd, preferences.showRsi, seriesBars.length, volumeRatio]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || seriesBars.length === 0) return;
    if (sameBars(runtime.dataBars, bars)) return;
    const visibleRange = runtime.chart.timeScale().getVisibleLogicalRange();
    if (preferences.displayMode === "candles") {
      (runtime.priceSeries as ISeriesApi<"Candlestick">).setData(seriesBars.map((bar) => ({ time: chartTime(bar.time), open: bar.o, high: bar.h, low: bar.l, close: bar.c })));
    } else {
      (runtime.priceSeries as ISeriesApi<"Line">).setData(seriesBars.map((bar) => ({ time: chartTime(bar.time), value: bar.c })));
    }
    runtime.volumeSeries.setData(seriesBars.map((bar) => ({ time: chartTime(bar.time), value: bar.v ?? 0, color: bar.c >= bar.o ? CLASSIC_CHART_PALETTE.up : CLASSIC_CHART_PALETTE.down })));
    for (const period of MA_PERIODS) {
      const priceMa = runtime.movingAverageSeries[period];
      if (priceMa) priceMa.setData(indicatorData(simpleMovingAverage(bars, period), chartTimesByStamp));
      if (period !== 240) runtime.volumeMovingAverageSeries[period]?.setData(indicatorData(volumeMovingAverage(bars, period), chartTimesByStamp));
    }
    if (runtime.bollingerSeries.length) {
      const values = bollingerBands(bars);
      (["upper", "middle", "lower"] as const).forEach((band, index) => {
        runtime.bollingerSeries[index]?.setData(values.flatMap((point) => {
          const time = chartTimesByStamp.get(point.t);
          return time === undefined ? [] : [{ time, value: point[band] }];
        }));
      });
    }
    runtime.rsiSeries?.setData(indicatorData(relativeStrengthIndex(bars), chartTimesByStamp));
    if (runtime.macdHistogram || runtime.macdLine || runtime.macdSignal) {
      const values = macd(bars);
      runtime.macdHistogram?.setData(values.flatMap((point) => {
        const time = chartTimesByStamp.get(point.t);
        return time === undefined || point.histogram === null ? [] : [{ time, value: point.histogram, color: point.histogram >= 0 ? CLASSIC_CHART_PALETTE.up : CLASSIC_CHART_PALETTE.down }];
      }));
      runtime.macdLine?.setData(values.flatMap((point) => {
        const time = chartTimesByStamp.get(point.t);
        return time === undefined || point.macd === null ? [] : [{ time, value: point.macd }];
      }));
      runtime.macdSignal?.setData(values.flatMap((point) => {
        const time = chartTimesByStamp.get(point.t);
        return time === undefined || point.signal === null ? [] : [{ time, value: point.signal }];
      }));
    }
    liveCandleRef.current = null;
    setRenderedLiveBar(null);
    runtime.dataBars = bars;
    if (visibleRange) runtime.chart.timeScale().setVisibleLogicalRange(visibleRange);
    setOverlayVersion((version) => version + 1);
  }, [bars, chartTimesByStamp, preferences.displayMode, seriesBars]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const seriesBar = seriesBars[seriesBars.length - 1];
    if (!runtime) return;
    if (!isUsableLiveTrade(instrument, quote)) {
      if (runtime.liveTradeLine) runtime.priceSeries.removePriceLine(runtime.liveTradeLine);
      runtime.liveTradeLine = null;
      liveCandleRef.current = null;
      setRenderedLiveBar(null);
      return;
    }
    const next = nextLiveCandleState(liveCandleRef.current, bars[bars.length - 1] ?? null, preferences.interval, instrument, quote);
    const price = next?.bar.c ?? quote.last;
    const liveTitle = next ? "동일 봉 체결" : "수신 체결 · REST 봉";
    if (runtime.liveTradeLine) {
      runtime.liveTradeLine.applyOptions({ price, title: liveTitle });
    } else {
      runtime.liveTradeLine = runtime.priceSeries.createPriceLine({
        id: "live-trade",
        price,
        color: "#d61f2c",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: liveTitle,
      });
    }
    if (!next || next === liveCandleRef.current || !seriesBar) return;
    liveCandleRef.current = next;
    setRenderedLiveBar(next.bar);
    const time = chartTime(seriesBar.time);
    if (preferences.displayMode === "candles") {
      (runtime.priceSeries as ISeriesApi<"Candlestick">).update({ time, open: next.bar.o, high: next.bar.h, low: next.bar.l, close: next.bar.c });
    } else {
      (runtime.priceSeries as ISeriesApi<"Line">).update({ time, value: next.bar.c });
    }
    for (const period of MA_PERIODS) {
      const series = runtime.movingAverageSeries[period];
      if (!series || bars.length < period) continue;
      const closes = bars.slice(-period).map((bar) => bar.c);
      closes[closes.length - 1] = next.bar.c;
      const value = closes.reduce((sum, close) => sum + close, 0) / period;
      series.update({ time, value });
    }
  }, [bars, instrument, preferences.displayMode, preferences.interval, quote, seriesBars]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.referenceLines.forEach((line) => runtime.priceSeries.removePriceLine(line));
    runtime.referenceLines = referencePrices.map((price, index) => runtime.priceSeries.createPriceLine({
      id: `reference-${index}`,
      price,
      color: "#e5ad39",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `기준 ${formatPrice(price, instrument.currency)}`,
    }));
  }, [chartVersion, instrument.currency, referencePrices]);

  const replaceDrawings = useCallback((next: ChartAnnotation[]) => {
    const current = chartToolsRef.current;
    if (JSON.stringify(current.drawings) === JSON.stringify(next)) return;
    setAnnotationHistory((history) => pushAnnotationUndo(history, current.drawings));
    const nextScope = { ...current, drawings: next };
    chartToolsRef.current = nextScope;
    setChartTools(nextScope);
  }, []);

  const deleteSelectedDrawing = useCallback(() => {
    if (!selectedDrawingId) return;
    replaceDrawings(chartToolsRef.current.drawings.filter((drawing) => drawing.id !== selectedDrawingId));
    setSelectedDrawingId(null);
  }, [replaceDrawings, selectedDrawingId]);

  const undoDrawing = useCallback(() => {
    const undone = undoAnnotations(annotationHistory, chartToolsRef.current.drawings);
    if (undone.history.length === annotationHistory.length) return;
    const nextScope = { ...chartToolsRef.current, drawings: undone.drawings };
    chartToolsRef.current = nextScope;
    setChartTools(nextScope);
    setAnnotationHistory(undone.history);
    setSelectedDrawingId(null);
  }, [annotationHistory]);

  const pointAtPointer = useCallback((event: ReactPointerEvent<SVGSVGElement>): ChartAnnotationPoint | null => {
    const runtime = runtimeRef.current;
    const host = chartHostRef.current;
    if (!runtime || !host) return null;
    const rect = host.getBoundingClientRect();
    const time = runtime.chart.timeScale().coordinateToTime(event.clientX - rect.left);
    const price = runtime.priceSeries.coordinateToPrice(event.clientY - rect.top);
    const raw = time === null ? undefined : timeLabelsRef.current.get(timeKey(time));
    return raw && typeof price === "number" && Number.isFinite(price)
      ? { time: raw, price: snapPrice(price, instrument.currency) }
      : null;
  }, [instrument.currency]);

  const addDrawingPoint = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (drawingTool === "idle") return;
    if (drawingTool === "select") {
      setSelectedDrawingId(null);
      return;
    }
    const point = pointAtPointer(event);
    if (!point) return;
    if (TWO_POINT_DRAWINGS.has(drawingTool)) {
      if (!pendingDrawingPoint) {
        setPendingDrawingPoint(point);
        return;
      }
      replaceDrawings([...chartToolsRef.current.drawings, {
        id: newChartToolId(drawingTool), kind: drawingTool, start: pendingDrawingPoint, end: point,
      }]);
      setPendingDrawingPoint(null);
      return;
    }
    replaceDrawings([...chartToolsRef.current.drawings, {
      id: newChartToolId(drawingTool), kind: drawingTool, start: point,
      ...(drawingTool === "text" && drawingText.trim() ? { text: drawingText.trim().slice(0, 120) } : {}),
    }]);
  }, [drawingText, drawingTool, pendingDrawingPoint, pointAtPointer, replaceDrawings]);

  const saveIndicatorTemplate = useCallback(() => {
    const name = templateName.trim().slice(0, 40);
    if (!name) return;
    const current = chartToolsRef.current;
    const existing = current.templates.find((template) => template.name === name);
    const template: ChartIndicatorTemplate = { id: existing?.id ?? newChartToolId("template"), name, settings: indicatorSettings(preferencesRef.current) };
    const templates = [...current.templates.filter((item) => item.name !== name), template].slice(-16);
    const next = { ...current, templates };
    chartToolsRef.current = next;
    setChartTools(next);
    setTemplateName("");
  }, [templateName]);

  const setReceivedBarLimit = useCallback((limit: ReceivedBarLimit) => {
    setVisibleBarLimit(limit);
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const range = receivedBarsRange(seriesBars.length, limit);
    if (range) runtime.chart.timeScale().setVisibleLogicalRange(range);
    else runtime.chart.timeScale().fitContent();
  }, [seriesBars.length]);

  const focusReceivedDate = useCallback(() => {
    const index = receivedBarIndexOnDate(bars, receivedDate, instrument.market);
    const runtime = runtimeRef.current;
    if (!runtime || index < 0) return;
    const limit = visibleBarLimit === "all" ? 160 : visibleBarLimit;
    if (visibleBarLimit === "all") setVisibleBarLimit(limit);
    runtime.chart.timeScale().setVisibleLogicalRange(focusedReceivedRange(index, bars.length, limit));
  }, [bars, instrument.market, receivedDate, visibleBarLimit]);

  const changeViewport = useCallback((kind: "zoom" | "pan", direction: "in" | "out" | "left" | "right") => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const range = runtime.chart.timeScale().getVisibleLogicalRange();
    const next = kind === "zoom"
      ? zoomLogicalRange(range, seriesBars.length, direction as "in" | "out")
      : panLogicalRange(range, seriesBars.length, direction as "left" | "right", false);
    if (next) runtime.chart.timeScale().setVisibleLogicalRange(next);
  }, [seriesBars.length]);

  const exportChartCsv = useCallback(() => {
    if (!payload || bars.length === 0 || typeof URL.createObjectURL !== "function") return;
    const csv = [
      "time,open,high,low,close,volume",
      ...bars.map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v ?? ""].join(",")),
    ].join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${instrument.market}-${instrument.stkCd}-${preferences.interval}-ohlcv.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [bars, instrument.market, instrument.stkCd, payload, preferences.interval]);

  const focusChartHost = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.focus({ preventScroll: true });
  }, []);

  const handleChartKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || document.activeElement !== event.currentTarget) return;
    const action = chartKeyboardAction({
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    if (!action) return;

    if (action.kind === "interval") {
      const next = cycleChartInterval(preferencesRef.current.interval, INTERVALS.map((timeframe) => timeframe.id), action.direction);
      if (next === preferencesRef.current.interval) return;
      event.preventDefault();
      updatePreferences((current) => ({ ...current, interval: next }));
      return;
    }

    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (action.kind === "fit") {
      event.preventDefault();
      runtime.chart.timeScale().fitContent();
      return;
    }
    const range = runtime.chart.timeScale().getVisibleLogicalRange();
    const next = action.kind === "zoom"
      ? zoomLogicalRange(range, seriesBars.length, action.direction)
      : panLogicalRange(range, seriesBars.length, action.direction, action.singleBar);
    if (!next) return;
    event.preventDefault();
    if (action.kind === "pan" && action.singleBar) event.stopPropagation();
    runtime.chart.timeScale().setVisibleLogicalRange(next);
  }, [seriesBars.length, updatePreferences]);

  const sourceLabel = payload?.source === "fixture" ? "TEST · fixture" : payload?.source === "kiwoom" ? "Kiwoom" : "대기";
  const integrityLabel = payload ? `${payload.complete ? "완결" : "일부"} · ${payload.status}${result.error ? " · 새로고침 오류" : ""}` : "대기";
  const intervalLabel = INTERVALS.find((timeframe) => timeframe.id === preferences.interval)?.label ?? preferences.interval;
  const compactProvenance = [
    `${instrument.market} · ${instrument.currency} · ${intervalLabel}`,
    payload?.range ? `${payload.range.start}–${payload.range.end}` : "",
    payload ? `DATA ${sourceLabel} · ${integrityLabel}` : "",
    payload?.sourceTimestamp ? `원본 ${payload.sourceTimestamp}` : "",
    payload?.receivedAt ? `수신 ${payload.receivedAt}` : "",
  ].filter(Boolean).join(" · ");
  const quoteTone = quote?.change === null || quote?.change === undefined || quote.change === 0
    ? "var(--hts-chart-text)"
    : quote.change > 0 ? "var(--hts-chart-up)" : "var(--hts-chart-down)";
  const indicatorControls = (
    <>
      {MA_PERIODS.map((period) => (
        <button key={period} type="button" className={controlClass(preferences.movingAverages[period])} style={controlStyle(preferences.movingAverages[period])} onClick={() => updatePreferences((current) => ({ ...current, movingAverages: { ...current.movingAverages, [period]: !current.movingAverages[period] } }))} aria-pressed={preferences.movingAverages[period]}>
          MA{period}
        </button>
      ))}
      <button type="button" className={controlClass(preferences.showBollingerBands)} style={controlStyle(preferences.showBollingerBands)} onClick={() => updatePreferences((current) => ({ ...current, showBollingerBands: !current.showBollingerBands }))} aria-label="BB(20,2)" aria-pressed={preferences.showBollingerBands} title="Bollinger Bands (20, 2)">BB</button>
      <button type="button" className={controlClass(preferences.showRsi)} style={controlStyle(preferences.showRsi)} onClick={() => updatePreferences((current) => ({ ...current, showRsi: !current.showRsi }))} aria-label="RSI14" aria-pressed={preferences.showRsi}>RSI</button>
      <button type="button" className={controlClass(preferences.showMacd)} style={controlStyle(preferences.showMacd)} onClick={() => updatePreferences((current) => ({ ...current, showMacd: !current.showMacd }))} aria-label="MACD(12,26,9)" aria-pressed={preferences.showMacd} title="MACD (12, 26, 9)">MACD</button>
    </>
  );
  const extendedIndicatorSummary = (
    <details className="chart-extended-indicators">
      <summary title="ATR, ADX, Stochastic, OBV, CCI는 수신 OHLCV에서 계산한 최신 유효값만 보여 줍니다.">확장 지표 · 최신값</summary>
      <div className="chart-extended-indicator-content" data-testid="extended-indicator-summary">
        <table aria-label="확장 보조지표 최신값">
          <thead><tr><th>지표</th><th>최신 유효값</th><th>기간</th></tr></thead>
          <tbody>
            <tr><th scope="row">ATR</th><td>{latestExtended.atr ? formatPrice(latestExtended.atr.value, instrument.currency) : "— (워밍업)"}</td><td>{preferences.extendedIndicatorPeriods.atr}</td></tr>
            <tr><th scope="row">ADX</th><td>{latestExtended.adx ? `${formatExtendedValue(latestExtended.adx.adx)} · +DI ${formatExtendedValue(latestExtended.adx.pdi)} · −DI ${formatExtendedValue(latestExtended.adx.mdi)}` : "— (워밍업)"}</td><td>{preferences.extendedIndicatorPeriods.adx}</td></tr>
            <tr><th scope="row">Stochastic</th><td>{latestExtended.stochastic ? `%K ${formatExtendedValue(latestExtended.stochastic.k)} · %D ${formatExtendedValue(latestExtended.stochastic.d)}` : "— (워밍업)"}</td><td>{preferences.extendedIndicatorPeriods.stochastic}/{preferences.extendedIndicatorPeriods.stochasticSignal}</td></tr>
            <tr><th scope="row">OBV</th><td>{latestExtended.obv ? latestExtended.obv.value.toLocaleString() : "— (거래량/워밍업)"}</td><td>누적</td></tr>
            <tr><th scope="row">CCI</th><td>{latestExtended.cci ? formatExtendedValue(latestExtended.cci.value) : "— (워밍업)"}</td><td>{preferences.extendedIndicatorPeriods.cci}</td></tr>
          </tbody>
        </table>
        <div className="chart-extended-period-controls" role="group" aria-label="확장 보조지표 기간">
          {EXTENDED_PERIOD_CONTROLS.map((control) => <label key={control.key}>{control.label}
            <input aria-label={`${control.label} 기간`} type="number" min={control.min} max={control.max} step="1" value={preferences.extendedIndicatorPeriods[control.key]} onChange={(event) => updatePreferences((current) => ({
              ...current,
              extendedIndicatorPeriods: normalizeExtendedIndicatorPeriods({ ...current.extendedIndicatorPeriods, [control.key]: Number(event.currentTarget.value) }),
            }))} />
          </label>)}
        </div>
      </div>
    </details>
  );

  const annotationShapes = useMemo(() => {
    const runtime = runtimeRef.current;
    const host = chartHostRef.current;
    if (!runtime || !host) return null;
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(runtime.chart.panes()[0]?.getHeight() ?? host.clientHeight, 1);
    const coordinate = (point: ChartAnnotationPoint) => {
      const time = chartTimesByStamp.get(point.time);
      const x = time === undefined ? null : runtime.chart.timeScale().timeToCoordinate(time);
      const y = runtime.priceSeries.priceToCoordinate(point.price);
      return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? { x, y } : null;
    };
    return chartTools.drawings.map((drawing) => {
      const start = coordinate(drawing.start);
      const end = drawing.end ? coordinate(drawing.end) : null;
      if (!start || (TWO_POINT_DRAWINGS.has(drawing.kind) && !end)) return null;
      const selected = drawing.id === selectedDrawingId;
      const color = selected ? "#315e91" : "#a56b00";
      const select = (event: ReactPointerEvent<SVGGElement>) => {
        if (drawingTool !== "select") return;
        event.stopPropagation();
        setSelectedDrawingId(drawing.id);
      };
      const common = { stroke: color, strokeWidth: selected ? 2 : 1, fill: "none", onPointerDown: select, className: "chart-annotation-shape" };
      if (drawing.kind === "horizontal") return <g key={drawing.id} {...common}><line x1={0} y1={start.y} x2={width} y2={start.y} /><title>수평선 {formatPrice(drawing.start.price, instrument.currency)}</title></g>;
      if (drawing.kind === "vertical") return <g key={drawing.id} {...common}><line x1={start.x} y1={0} x2={start.x} y2={height} /><title>수직선 {drawing.start.time}</title></g>;
      if (!end) return null;
      if (drawing.kind === "trend") return <g key={drawing.id} {...common}><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} /><title>추세선</title></g>;
      if (drawing.kind === "rectangle") return <g key={drawing.id} {...common}><rect x={Math.min(start.x, end.x)} y={Math.min(start.y, end.y)} width={Math.abs(start.x - end.x)} height={Math.abs(start.y - end.y)} fill={selected ? "rgba(49,94,145,.08)" : "rgba(165,107,0,.06)"} /><title>사각형</title></g>;
      if (drawing.kind === "fibonacci") {
        const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
        const ratios = [0, 0.236, 0.382, 0.5, 0.618, 1];
        return <g key={drawing.id} {...common}>{ratios.map((ratio) => {
          const y = start.y + (end.y - start.y) * ratio;
          return <g key={ratio}><line x1={left} y1={y} x2={right} y2={y} /><text x={right + 3} y={y - 2} fill={color}>{Math.round(ratio * 100)}%</text></g>;
        })}<title>피보나치 되돌림</title></g>;
      }
      if (drawing.kind === "measurement") {
        const difference = (drawing.end?.price ?? drawing.start.price) - drawing.start.price;
        return <g key={drawing.id} {...common}><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} /><circle cx={start.x} cy={start.y} r={2} fill={color} /><circle cx={end.x} cy={end.y} r={2} fill={color} /><text x={(start.x + end.x) / 2 + 4} y={(start.y + end.y) / 2 - 4} fill={color}>Δ {formatPrice(Math.abs(difference), instrument.currency)}</text><title>측정</title></g>;
      }
      return <g key={drawing.id} {...common}><circle cx={start.x} cy={start.y} r={2} fill={color} /><text x={start.x + 4} y={start.y - 4} fill={color}>{drawing.text || "메모"}</text><title>메모</title></g>;
    });
  }, [chartTools.drawings, chartTimesByStamp, drawingTool, instrument.currency, overlayVersion, selectedDrawingId]);

  return (
    <section className="hts-chart-parity hts-chart-0601" aria-label="가격 차트">
      <div className="chart-parity-toolbar" data-testid="chart-toolbar">
        <h2 className="chart-parity-title" title={`${instrument.stkNm} · ${instrument.market} · ${instrument.listingVenue} · ${instrument.currency}`}>{instrument.stkCd}<small>{instrument.stkNm} · {instrument.market} · {instrument.currency}</small></h2>
        <div className="chart-parity-periods" aria-label="차트 기간 및 분 주기">
          <>
            <span className="chart-parity-period-caption">기간</span>
            {INTERVALS.filter((timeframe) => ["D", "W", "M", "Y"].includes(timeframe.id)).map((timeframe) => <button key={timeframe.id} type="button" className={controlClass(preferences.interval === timeframe.id)} style={controlStyle(preferences.interval === timeframe.id)} onClick={() => updatePreferences((current) => ({ ...current, interval: timeframe.id }))} aria-pressed={preferences.interval === timeframe.id}>{timeframe.label}</button>)}
            <span className="chart-parity-period-caption">분</span>
            {INTERVALS.filter((timeframe) => !["D", "W", "M", "Y"].includes(timeframe.id)).map((timeframe) => <button key={timeframe.id} type="button" className={controlClass(preferences.interval === timeframe.id)} style={controlStyle(preferences.interval === timeframe.id)} onClick={() => updatePreferences((current) => ({ ...current, interval: timeframe.id }))} aria-pressed={preferences.interval === timeframe.id}>{timeframe.label}</button>)}
          </>
        </div>
        <div className="chart-parity-type-group" aria-label="차트 유형">
          <button type="button" className={controlClass(preferences.displayMode === "candles")} style={controlStyle(preferences.displayMode === "candles")} onClick={() => updatePreferences((current) => ({ ...current, displayMode: "candles" }))} aria-pressed={preferences.displayMode === "candles"}>캔들</button>
          <button type="button" className={controlClass(preferences.displayMode === "line")} style={controlStyle(preferences.displayMode === "line")} onClick={() => updatePreferences((current) => ({ ...current, displayMode: "line" }))} aria-pressed={preferences.displayMode === "line"}>라인</button>
          <button type="button" className={controlClass()} style={controlStyle()} onClick={triggerRefresh} disabled={result.loading} title="선택한 종목의 OHLCV를 다시 요청합니다.">{compact ? "새로" : "새로고침"}</button>
        </div>
        <label className="chart-parity-date-control" title="현재 응답에서 받은 봉 안에서만 날짜를 찾아 이동합니다.">수신봉 내 이동
          <input aria-label="수신봉 내 날짜 이동" type="date" value={receivedDate} onInput={(event) => setReceivedDate(event.currentTarget.value)} onChange={(event) => setReceivedDate(event.target.value)} />
          <button type="button" className={controlClass()} onClick={focusReceivedDate} disabled={receivedBarIndexOnDate(bars, receivedDate, instrument.market) < 0}>이동</button>
        </label>
      </div>

      <div className="chart-parity-summary" aria-live="polite">
        {activeBar ? (
          <>
            <span>{formatMarketTime(activeBar.t)}</span>
            <span>시가 {formatPrice(activeBar.o, instrument.currency)}</span>
            <span style={{ color: "var(--hts-chart-up)" }}>고가 {formatPrice(activeBar.h, instrument.currency)}</span>
            <span style={{ color: "var(--hts-chart-down)" }}>저가 {formatPrice(activeBar.l, instrument.currency)}</span>
            <span>종가 {formatPrice(activeBar.c, instrument.currency)}</span>
            <span>거래량 {activeBar.v?.toLocaleString() ?? "—"}</span>
          </>
        ) : <span>OHLC 대기</span>}
        {quote?.last !== null && quote?.last !== undefined && <span style={{ color: quoteTone }}>{isUsableLiveTrade(instrument, quote) ? hasVerifiedLiveCandle ? "동일 봉 체결" : "수신 체결 · REST 봉" : "현재가"} {formatPrice(quote.last, instrument.currency)}</span>}
        {observedMinute && <span title="수신 시각을 기준으로 수집한 불완전 관찰 범위입니다. 공급자 REST OHLC를 바꾸지 않습니다.">수신 기준 관찰 {formatPrice(observedMinute.low, instrument.currency)}–{formatPrice(observedMinute.high, instrument.currency)} · {observedMinute.count}건 · 불완전</span>}
      </div>

      {compact ? <details className="shrink-0 border-b" style={CHART_UI_STYLE}>
        <summary className="cursor-pointer px-1 py-0.5 font-mono text-[10px] marker:content-none focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brass-400" title="차트 영역에 포커스: +/↑ 확대, -/↓ 축소, ←/→ 이동, Ctrl+←/→ 한 봉, * 전체, Shift+1/2 주기">지표 · 보기 · 키 ↑↓←→*</summary>
        <div className="chart-parity-indicators" aria-label="차트 보조지표">{indicatorControls}</div>
      </details> : <div className="chart-parity-indicators" aria-label="차트 보조지표">{indicatorControls}</div>}

      {extendedIndicatorSummary}

      <details className="chart-annotation-tools" style={CHART_UI_STYLE}>
        <summary title="저장 작도와 지표 템플릿은 이 기기, 현재 종목·시장·주기에만 저장됩니다.">작도 · 지표 템플릿</summary>
        <div className="chart-annotation-tool-row" aria-label="차트 작도 도구">
          {(["select", "horizontal", "vertical", "trend", "rectangle", "fibonacci", "measurement", "text"] as const).map((tool) => {
            const labels: Record<Exclude<DrawingTool, "idle">, string> = { select: "선택", horizontal: "수평", vertical: "수직", trend: "추세", rectangle: "사각", fibonacci: "피보", measurement: "측정", text: "메모" };
            return <button key={tool} type="button" className={controlClass(drawingTool === tool)} aria-pressed={drawingTool === tool} onClick={() => { setDrawingTool((current) => current === tool ? "idle" : tool); setPendingDrawingPoint(null); }} title={tool === "select" ? "작도를 클릭해 선택" : `${labels[tool]}: 차트에서 ${TWO_POINT_DRAWINGS.has(tool) ? "두 점" : "한 점"}을 선택`}>
              {labels[tool]}
            </button>;
          })}
          <button type="button" className={controlClass()} onClick={undoDrawing} disabled={annotationHistory.length === 0}>되돌리기</button>
          <button type="button" className={controlClass()} onClick={deleteSelectedDrawing} disabled={!selectedDrawingId}>삭제</button>
          <button type="button" className={controlClass()} onClick={() => { replaceDrawings([]); setSelectedDrawingId(null); }} disabled={chartTools.drawings.length === 0}>전체 지움</button>
          {pendingDrawingPoint && <span className="chart-annotation-pending" role="status">두 번째 점 선택</span>}
        </div>
        <div className="chart-annotation-tool-row">
          <label className="chart-annotation-text">메모
            <input aria-label="차트 메모 문구" value={drawingText} maxLength={120} onChange={(event) => setDrawingText(event.target.value)} />
          </label>
          <label className="chart-annotation-text">템플릿
            <input aria-label="지표 템플릿 이름" value={templateName} maxLength={40} onChange={(event) => setTemplateName(event.target.value)} placeholder="현재 지표 저장" />
          </label>
          <button type="button" className={controlClass()} onClick={saveIndicatorTemplate} disabled={!templateName.trim()}>저장</button>
          {chartTools.templates.map((template) => <button key={template.id} type="button" className={controlClass()} title="저장한 표시 모드와 MA/BB/RSI/MACD를 적용합니다." onClick={() => updatePreferences((current) => preferencesFromIndicatorSettings(current, template.settings))}>{template.name}</button>)}
        </div>
        {chartTools.drawings.length > 0 && <div className="chart-annotation-saved" aria-label="저장된 작도">
          {chartTools.drawings.map((drawing) => <button key={drawing.id} type="button" aria-pressed={selectedDrawingId === drawing.id} onClick={() => { setDrawingTool("select"); setSelectedDrawingId(drawing.id); }}>
            {drawing.kind === "horizontal" ? "수평" : drawing.kind === "vertical" ? "수직" : drawing.kind === "trend" ? "추세" : drawing.kind === "rectangle" ? "사각" : drawing.kind === "fibonacci" ? "피보" : drawing.kind === "measurement" ? "측정" : drawing.text || "메모"}
          </button>)}
        </div>}
      </details>

      <div className="chart-parity-plot">
        {payload && seriesBars.length > 0 ? <>
          <div ref={chartHostRef} tabIndex={0} aria-label={`${instrument.stkCd} 가격 차트. 키보드: + 또는 위 화살표 확대, - 또는 아래 화살표 축소, 좌우 이동, 별표 전체, Shift+1/2 주기`} onPointerDown={focusChartHost} onKeyDown={handleChartKeyDown} className="cursor-crosshair" data-testid="lightweight-chart" />
          <svg className={`chart-annotation-layer ${drawingTool === "idle" ? "chart-annotation-layer-idle" : ""}`} aria-label={drawingTool === "idle" ? "저장된 차트 작도" : "차트 작도 영역"} onPointerDown={addDrawingPoint}>
            <rect className="chart-annotation-capture" x="0" y="0" width="100%" height="100%" />
            {annotationShapes}
          </svg>
          <div className="chart-parity-legend" data-testid="chart-indicator-legend">
            <span>{instrument.stkNm}</span><span>종가 · 단순</span>
            {MA_PERIODS.filter((period) => preferences.movingAverages[period]).map((period) => <span key={period} style={{ color: MA_COLORS[period] }}>{period}</span>)}
          </div>
          <div className="chart-parity-volume-legend" style={volumeLegendTop === null ? { visibility: "hidden" } : { top: `${volumeLegendTop}px` }} aria-label="거래량 범례">
            <span>거래량(주)</span><span>선택 {activeBar?.v?.toLocaleString() ?? "—"}</span>
            {VOLUME_LEGEND_PERIODS.map((period) => <span key={period} style={{ color: MA_COLORS[period] }}>MA{period}</span>)}
          </div>
        </> : (
          <p className="chart-parity-note" role={result.error ? "alert" : "status"}>{result.error || payload?.note || "차트를 불러오는 중…"}</p>
        )}
      </div>

      <div className="chart-parity-tools" aria-label="차트 이동 및 확대">
        <button type="button" className={controlClass()} onClick={() => changeViewport("pan", "left")} title="이전 구간">◀ 이전</button>
        <button type="button" className={controlClass()} onClick={() => changeViewport("pan", "right")} title="다음 구간">다음 ▶</button>
        <button type="button" className={controlClass()} onClick={() => changeViewport("zoom", "out")} title="축소">−</button>
        <button type="button" className={controlClass()} onClick={() => changeViewport("zoom", "in")} title="확대">＋</button>
        <button type="button" className={controlClass()} onClick={() => setReferencePrices([])} disabled={referencePrices.length === 0}>기준선</button>
        <button type="button" className={controlClass()} onClick={exportChartCsv} disabled={!payload || bars.length === 0} title="현재 수신한 OHLCV를 CSV로 내보냅니다.">CSV</button>
        <label className="chart-parity-display-control">표시 봉 수
          <select className="chart-parity-select" aria-label="표시 봉 수" value={visibleBarLimit} onChange={(event) => setReceivedBarLimit(event.target.value === "all" ? "all" : Number(event.target.value) as Exclude<ReceivedBarLimit, "all">)}>
            {RECEIVED_BAR_LIMITS.map((limit) => <option key={limit} value={limit}>{limit === "all" ? "전체(수신)" : `${limit}봉`}</option>)}
          </select>
          <span className="chart-parity-received-count" title="현재 응답에서 받은 봉 수입니다.">수신 {bars.length}봉</span>
        </label>
        <label className="chart-parity-volume-control">거래량 {Math.round(volumeRatio * 100)}%
          <input className="chart-parity-slider" aria-label="거래량 영역 비율" type="range" min="15" max="45" value={Math.round(volumeRatio * 100)} onChange={(event) => updatePreferences((current) => ({ ...current, volumeRatio: normalizeVolumeRatio(Number(event.target.value) / 100) }))} />
        </label>
      </div>

      <footer className={`chart-parity-provenance ${compact ? "chart-parity-provenance-compact" : ""}`}>
        {compact ? <>
          <span className="chart-parity-provenance-compact-text" title={compactProvenance || undefined}>{compactProvenance || "차트 데이터 대기"}</span>
          <details className="chart-parity-provenance-details">
            <summary aria-label="데이터 출처 및 갱신 정보">출처</summary>
            <div>
              <span>{instrument.market} · {instrument.currency} · 주기 {intervalLabel}</span>
              {payload?.range && <span>기간 {payload.range.start}–{payload.range.end} ({payload.range.basis})</span>}
              {payload && <span>DATA {sourceLabel} · {integrityLabel} · {payload.adjusted ? "수정주가" : "비수정"}</span>}
              {payload?.sourceTimestamp && <span>원본 {payload.sourceTimestamp}</span>}
              {payload?.receivedAt && <span>수신 {payload.receivedAt}</span>}
              {result.error && payload && <span role="alert">새로고침: {result.error}</span>}
              {payload?.note && <span className="chart-parity-provenance-note" title={payload.note}>비고: {payload.note}</span>}
            </div>
          </details>
        </> : <>
          <span>{instrument.market} · {instrument.currency} · 주기 {intervalLabel}</span>
          {payload?.range && <span>{payload.range.start}–{payload.range.end} ({payload.range.basis})</span>}
          {payload && <span>DATA {sourceLabel} · {integrityLabel} · {payload.adjusted ? "수정주가" : "비수정"}</span>}
          {payload?.sourceTimestamp && <span title="공급자가 반환한 원본 시각">원본 {payload.sourceTimestamp}</span>}
          {payload?.receivedAt && <span title="응답 수신 시각">수신 {payload.receivedAt}</span>}
          {result.error && payload && <span style={{ color: "var(--hts-chart-down, #155fc5)" }} role="alert">새로고침: {result.error}</span>}
          {payload?.note && <span className="chart-parity-provenance-note" title={payload.note}>{payload.note}</span>}
        </>}
        <a className="chart-parity-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer" title="TradingView Lightweight Charts™ Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/">Powered by TradingView</a>
      </footer>
    </section>
  );
}
