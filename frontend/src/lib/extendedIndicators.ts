import { ADX, ATR, CCI, OBV, Stochastic } from "technicalindicators";
import type { ChartBar } from "@/lib/types";

export type ExtendedIndicatorPeriods = {
  atr: number;
  adx: number;
  stochastic: number;
  stochasticSignal: number;
  cci: number;
};

export type ExtendedIndicatorPoint = { t: string; value: number };
export type AdxPoint = { t: string; adx: number; pdi: number; mdi: number };
export type StochasticPoint = { t: string; k: number; d: number | null };
export type ExtendedIndicators = {
  atr: ExtendedIndicatorPoint[];
  adx: AdxPoint[];
  stochastic: StochasticPoint[];
  obv: ExtendedIndicatorPoint[];
  cci: ExtendedIndicatorPoint[];
};

export const DEFAULT_EXTENDED_INDICATOR_PERIODS: ExtendedIndicatorPeriods = {
  atr: 14,
  adx: 14,
  stochastic: 14,
  stochasticSignal: 3,
  cci: 20,
};

const EMPTY: ExtendedIndicators = { atr: [], adx: [], stochastic: [], obv: [], cci: [] };

function boundedPeriod(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/** Normalizes stored control values before they reach technicalindicators. */
export function normalizeExtendedIndicatorPeriods(value: Partial<ExtendedIndicatorPeriods> | null | undefined): ExtendedIndicatorPeriods {
  return {
    atr: boundedPeriod(value?.atr, DEFAULT_EXTENDED_INDICATOR_PERIODS.atr, 2, 100),
    adx: boundedPeriod(value?.adx, DEFAULT_EXTENDED_INDICATOR_PERIODS.adx, 2, 100),
    stochastic: boundedPeriod(value?.stochastic, DEFAULT_EXTENDED_INDICATOR_PERIODS.stochastic, 2, 100),
    stochasticSignal: boundedPeriod(value?.stochasticSignal, DEFAULT_EXTENDED_INDICATOR_PERIODS.stochasticSignal, 1, 50),
    cci: boundedPeriod(value?.cci, DEFAULT_EXTENDED_INDICATOR_PERIODS.cci, 2, 100),
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasUsableOhlc(bars: readonly ChartBar[]) {
  return bars.every((bar) => finite(bar.o) && finite(bar.h) && finite(bar.l) && finite(bar.c));
}

function hasUsableVolume(bars: readonly ChartBar[]) {
  return bars.every((bar) => finite(bar.v));
}

function series(values: number[], bars: readonly ChartBar[], startIndex: number): ExtendedIndicatorPoint[] {
  return values.flatMap((value, index) => finite(value) && bars[index + startIndex] ? [{ t: bars[index + startIndex].t, value }] : []);
}

/**
 * Returns only library-produced values, aligned with the source bar that
 * completed each lookback. A missing volume makes OBV unavailable instead of
 * silently turning that bar into zero volume.
 */
export function extendedIndicators(bars: readonly ChartBar[], periodsInput?: Partial<ExtendedIndicatorPeriods>): ExtendedIndicators {
  const periods = normalizeExtendedIndicatorPeriods(periodsInput);
  if (!hasUsableOhlc(bars)) return EMPTY;
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const closes = bars.map((bar) => bar.c);
  const atr = bars.length > periods.atr
    ? series(ATR.calculate({ high: highs, low: lows, close: closes, period: periods.atr }), bars, periods.atr)
    : [];
  const adx = bars.length >= periods.adx * 2
    ? ADX.calculate({ high: highs, low: lows, close: closes, period: periods.adx }).flatMap((value, index) => {
      const bar = bars[index + periods.adx * 2 - 1];
      return bar && finite(value.adx) && finite(value.pdi) && finite(value.mdi)
        ? [{ t: bar.t, adx: value.adx, pdi: value.pdi, mdi: value.mdi }]
        : [];
    })
    : [];
  const stochasticRaw = bars.length >= periods.stochastic
    ? Stochastic.calculate({ high: highs, low: lows, close: closes, period: periods.stochastic, signalPeriod: periods.stochasticSignal })
    : [];
  // technicalindicators represents a zero high-low denominator as %K=0.
  // That is not a measured oscillator value, so leave it unavailable instead.
  const stochasticRanges = stochasticRaw.map((_, index) => {
    const completedIndex = index + periods.stochastic - 1;
    const windowHigh = Math.max(...highs.slice(completedIndex - periods.stochastic + 1, completedIndex + 1));
    const windowLow = Math.min(...lows.slice(completedIndex - periods.stochastic + 1, completedIndex + 1));
    return windowHigh > windowLow;
  });
  const stochastic = stochasticRaw.flatMap((value, index) => {
    const bar = bars[index + periods.stochastic - 1];
    if (!bar || !stochasticRanges[index] || !finite(value.k)) return [];
    const dReady = index >= periods.stochasticSignal - 1
      && stochasticRanges.slice(index - periods.stochasticSignal + 1, index + 1).every(Boolean);
    return [{ t: bar.t, k: value.k, d: dReady && finite(value.d) ? value.d : null }];
  });
  const cci = bars.length >= periods.cci
    ? series(CCI.calculate({ high: highs, low: lows, close: closes, period: periods.cci }), bars, periods.cci - 1)
    : [];
  const obv = hasUsableVolume(bars) && bars.length >= 2
    ? series(OBV.calculate({ close: closes, volume: bars.map((bar) => bar.v as number) }), bars, 1)
    : [];
  return { atr, adx, stochastic, obv, cci };
}

export function latestExtendedIndicators(values: ExtendedIndicators) {
  return {
    atr: values.atr.at(-1) ?? null,
    adx: values.adx.at(-1) ?? null,
    stochastic: values.stochastic.at(-1) ?? null,
    obv: values.obv.at(-1) ?? null,
    cci: values.cci.at(-1) ?? null,
  };
}
