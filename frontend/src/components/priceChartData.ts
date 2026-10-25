import type { ChartBar } from "@/lib/types";
import { BollingerBands, MACD, RSI, SMA } from "technicalindicators";

export type IndicatorPoint = { t: string; value: number };
export type BollingerBandPoint = { t: string; middle: number; upper: number; lower: number };
export type MacdPoint = { t: string; macd: number | null; signal: number | null; histogram: number | null };
export type RawChartTime = { year: number; month: number; day: number } | number;
export type SeriesBar = ChartBar & { time: RawChartTime };

/**
 * Formats the backend's exchange timestamp directly. Deliberately do not use
 * Date/Intl here: those APIs can move an exchange-local timestamp across a day
 * when the browser is in a different time zone.
 */
export function formatMarketTime(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 12) return `${digits.slice(4, 6)}/${digits.slice(6, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
  if (digits.length >= 8) return `${digits.slice(4, 6)}/${digits.slice(6, 8)}`;
  return raw;
}

/**
 * Converts a raw backend stamp into a UTC position for Lightweight Charts.
 * The UTC value is used only for ordering/spacing; labels always use raw t.
 */
export function rawStampToUnixSeconds(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 12) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

export function rawStampToChartTime(raw: string): RawChartTime | null {
  const digits = raw.replace(/\D/g, "");
  if (/^\d{8}$/.test(digits)) {
    return { year: Number(digits.slice(0, 4)), month: Number(digits.slice(4, 6)), day: Number(digits.slice(6, 8)) };
  }
  return rawStampToUnixSeconds(raw);
}

/** Converts backend OHLCV rows without changing their raw source timestamp. */
export function toSeriesBars(bars: ChartBar[]): SeriesBar[] {
  return bars.flatMap((bar) => {
    const time = rawStampToChartTime(bar.t);
    return time === null ? [] : [{ ...bar, time }];
  });
}

export function simpleMovingAverage(bars: ChartBar[], period: number): IndicatorPoint[] {
  if (!Number.isInteger(period) || period < 1 || bars.length < period) return [];
  return SMA.calculate({ period, values: bars.map((bar) => bar.c) }).map((value, index) => ({
    t: bars[index + period - 1].t,
    value,
  }));
}

/** Wilder's 14-period RSI (or a caller-specified period). */
export function relativeStrengthIndex(bars: ChartBar[], period = 14): IndicatorPoint[] {
  if (!Number.isInteger(period) || period < 1 || bars.length <= period) return [];
  return RSI.calculate({ period, values: bars.map((bar) => bar.c) }).map((value, index) => ({
    t: bars[index + period].t,
    value,
  }));
}

/** Standard 12/26/9 EMA MACD, aligned to the provider bar that produced it. */
export function macd(bars: ChartBar[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MacdPoint[] {
  if (!validPeriods(fastPeriod, slowPeriod, signalPeriod) || bars.length < slowPeriod) return [];
  const values = MACD.calculate({
    values: bars.map((bar) => bar.c),
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  return values.map((value, index) => ({
    // technicalindicators emits its first MACD point on the slow-period bar.
    t: bars[index + slowPeriod - 1].t,
    macd: finiteOrNull(value.MACD),
    signal: finiteOrNull(value.signal),
    histogram: finiteOrNull(value.histogram),
  }));
}

/** Standard 20-period, two-standard-deviation Bollinger bands. */
export function bollingerBands(bars: ChartBar[], period = 20, stdDev = 2): BollingerBandPoint[] {
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(stdDev) || stdDev < 0 || bars.length < period) return [];
  return BollingerBands.calculate({ period, stdDev, values: bars.map((bar) => bar.c) }).map((value, index) => ({
    t: bars[index + period - 1].t,
    middle: value.middle,
    upper: value.upper,
    lower: value.lower,
  }));
}

function validPeriods(fastPeriod: number, slowPeriod: number, signalPeriod: number) {
  return [fastPeriod, slowPeriod, signalPeriod].every((period) => Number.isInteger(period) && period > 0) && fastPeriod < slowPeriod;
}

function finiteOrNull(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
