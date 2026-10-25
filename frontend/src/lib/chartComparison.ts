import type { ChartBar, ChartPayload, Instrument } from "@/lib/types";

export type ComparisonPoint = { date: string; value: number };
export type ComparisonSeries = {
  key: string;
  instrument: Instrument;
  baseClose: number;
  points: ComparisonPoint[];
  missingDates: string[];
};
export type ComparisonAlignment = {
  baseDate: string | null;
  series: ComparisonSeries[];
  unionDates: string[];
  sharedDates: string[];
  /** Selected feeds which supplied an eligible received daily-close series. */
  receivedKeys: string[];
};

function keyFor(instrument: Instrument) {
  return [instrument.environment, instrument.market, instrument.stkCd, instrument.listingVenue, instrument.quoteVenue].join("|");
}

/** Accepts only daily calendar labels; no missing calendar or FX values are manufactured. */
export function comparisonDay(value: string) {
  const compact = value.trim().replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(compact) ? compact : null;
}

function dailyCloses(bars: readonly ChartBar[]) {
  const rows = new Map<string, number>();
  for (const bar of bars) {
    const date = comparisonDay(bar.t);
    if (date && Number.isFinite(bar.c) && bar.c > 0) rows.set(date, bar.c);
  }
  return rows;
}

/**
 * Rebase each received close to 100 at the earliest day shared by every
 * successful selected series. Later missing dates stay absent rather than
 * being forward-filled; the caller can display them as received-data gaps.
 */
export function alignComparisonSeries(inputs: readonly { instrument: Instrument; payload: ChartPayload | null }[]): ComparisonAlignment {
  const sources = inputs
    .map(({ instrument, payload }) => ({
      instrument,
      // Explicit missing/error responses are not price series, even if an
      // malformed response happens to include bars.
      closes: payload && payload.status !== "missing" && payload.status !== "error" ? dailyCloses(payload.bars) : new Map<string, number>(),
    }))
    .filter((item) => item.closes.size > 0);
  const receivedKeys = sources.map(({ instrument }) => keyFor(instrument));
  if (!sources.length) return { baseDate: null, series: [], unionDates: [], sharedDates: [], receivedKeys };

  const shared = [...sources[0].closes.keys()].filter((date) => sources.every((item) => item.closes.has(date))).sort();
  const baseDate = shared[0] ?? null;
  const unionDates = [...new Set(sources.flatMap((item) => [...item.closes.keys()]))].filter((date) => !baseDate || date >= baseDate).sort();
  if (!baseDate) return { baseDate: null, series: [], unionDates, sharedDates: shared, receivedKeys };

  return {
    baseDate,
    unionDates,
    sharedDates: shared,
    receivedKeys,
    series: sources.map(({ instrument, closes }) => {
      const baseClose = closes.get(baseDate)!;
      const points = [...closes.entries()]
        .filter(([date]) => date >= baseDate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, close]) => ({ date, value: (close / baseClose) * 100 }));
      return { key: keyFor(instrument), instrument, baseClose, points, missingDates: unionDates.filter((date) => !closes.has(date)) };
    }),
  };
}

export function comparisonInstrumentKey(instrument: Instrument) {
  return keyFor(instrument);
}
