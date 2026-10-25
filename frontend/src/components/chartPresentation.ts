import type { ChartBar } from "@/lib/types";

/**
 * These are intentionally shared by the stock and capture charts.  In
 * particular 120 is purple and 240 is the muted blue/grey line used by the
 * desktop HTS; keeping one map prevents the two panes from silently swapping
 * them.
 */
export const PRICE_MA_PERIODS = [5, 20, 60, 120, 240] as const;
export type PriceMovingAveragePeriod = (typeof PRICE_MA_PERIODS)[number];
export const VOLUME_MA_PERIODS = [5, 20, 60, 120] as const;
export const MOVING_AVERAGE_COLORS: Record<PriceMovingAveragePeriod, string> = {
  5: "#df00be",
  20: "#ffc900",
  60: "#008423",
  120: "#5e00d6",
  240: "#626a9e",
};

export function formatChartPriceAxis(value: number, currency: "KRW" | "USD") {
  return new Intl.NumberFormat(currency === "KRW" ? "ko-KR" : "en-US", {
    minimumFractionDigits: currency === "KRW" ? 0 : 2,
    maximumFractionDigits: currency === "KRW" ? 0 : 2,
  }).format(value);
}

/** Index charts use two decimal places even though their source has no currency. */
export function formatChartIndexAxis(value: number) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function formatChartVolumeAxis(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * Lightweight Charts stores pane proportions as stretch factors.  Expressing
 * the volume pane this way, rather than as a transient pixel height, keeps a
 * 26% volume pane through the initial asynchronous layout and every resize.
 */
export function volumePaneStretchFactor(volumeRatio: number, otherPanesStretch: number) {
  const ratio = Number.isFinite(volumeRatio) ? Math.max(0.01, Math.min(0.99, volumeRatio)) : 0.26;
  const other = Number.isFinite(otherPanesStretch) && otherPanesStretch > 0 ? otherPanesStretch : 1;
  return other * ratio / (1 - ratio);
}

/**
 * A volume MA is omitted for every window containing missing volume.  Missing
 * provider data is not zero volume and must not create an invented trace.
 */
export function volumeMovingAverage<T extends Pick<ChartBar, "t" | "v">>(bars: readonly T[], period: number) {
  if (!Number.isInteger(period) || period < 1 || bars.length < period) return [] as Array<{ t: string; value: number }>;
  return bars.flatMap((bar, index) => {
    if (index < period - 1) return [];
    const window = bars.slice(index - period + 1, index + 1);
    if (window.some((entry) => entry.v === null)) return [];
    return [{ t: bar.t, value: window.reduce((sum, entry) => sum + (entry.v ?? 0), 0) / period }];
  });
}
