import { describe, expect, it } from "vitest";
import { alignComparisonSeries, comparisonDay, comparisonInstrumentKey } from "@/lib/chartComparison";
import { apple, samsung } from "@/test/fixtures";
import type { ChartPayload, Instrument } from "@/lib/types";

function payload(instrument: Instrument, bars: ChartPayload["bars"]): ChartPayload {
  return { ...instrument, interval: "D", bars, source: "fixture", status: "snapshot", receivedAt: "2026-10-24T00:00:00Z", sourceTimestamp: null, range: null, note: "", complete: true, adjusted: false };
}

describe("chart comparison alignment", () => {
  it("rebases actual closes at the first shared date and never fills missing received days", () => {
    const result = alignComparisonSeries([
      { instrument: samsung, payload: payload(samsung, [{ t: "20261020", o: 90, h: 101, l: 89, c: 100, v: 1 }, { t: "20261021", o: 100, h: 121, l: 99, c: 120, v: 1 }, { t: "20261023", o: 120, h: 131, l: 119, c: 130, v: 1 }]) },
      { instrument: apple, payload: payload(apple, [{ t: "20261021", o: 45, h: 51, l: 44, c: 50, v: 1 }, { t: "20261022", o: 50, h: 56, l: 49, c: 55, v: 1 }, { t: "20261023", o: 55, h: 61, l: 54, c: 60, v: 1 }]) },
    ]);
    expect(result.baseDate).toBe("20261021");
    expect(result.series[0].points).toEqual([{ date: "20261021", value: 100 }, { date: "20261023", value: 108.33333333333333 }]);
    expect(result.series[1].points).toEqual([{ date: "20261021", value: 100 }, { date: "20261022", value: 110.00000000000001 }, { date: "20261023", value: 120 }]);
    expect(result.series[0].missingDates).toEqual(["20261022"]);
  });

  it("has no base when a selected history has no overlapping received day", () => {
    const result = alignComparisonSeries([
      { instrument: samsung, payload: payload(samsung, [{ t: "20261020", o: 1, h: 1, l: 1, c: 1, v: 1 }]) },
      { instrument: apple, payload: payload(apple, [{ t: "20261021", o: 1, h: 1, l: 1, c: 1, v: 1 }]) },
    ]);
    expect(result.baseDate).toBeNull();
    expect(result.series).toEqual([]);
    expect(comparisonDay("2026-10-24")).toBe("20261024");
    expect(comparisonDay("bad-date")).toBeNull();
  });

  it("records missing/error selections instead of treating their bars as comparable prices", () => {
    const missing = { ...payload(apple, [{ t: "20261020", o: 1, h: 1, l: 1, c: 1, v: 1 }]), status: "missing" as const, note: "provider missing" };
    const result = alignComparisonSeries([
      { instrument: samsung, payload: payload(samsung, [{ t: "20261020", o: 1, h: 1, l: 1, c: 1, v: 1 }]) },
      { instrument: apple, payload: missing },
    ]);

    expect(result.receivedKeys).toEqual([comparisonInstrumentKey(samsung)]);
    expect(result.series.map((series) => series.instrument.stkCd)).toEqual(["005930"]);
  });
});
