import { describe, expect, it } from "vitest";
import { captureBarSummary, captureMovingAverage, captureReceivedBarIndexOnDate, captureReceivedBarsRange, normalizeCaptureBars } from "@/components/capture/CaptureChart";

describe("CaptureChart normalization", () => {
  it("parses compact 14-digit times, sorts them, and keeps the latest duplicate correction", () => {
    const bars = normalizeCaptureBars([
      { t: "20261023153000", o: 10, h: 12, l: 9, c: 11, v: 3 },
      { t: "20261023090000", o: 8, h: 10, l: 7, c: 9, v: null },
      { t: "20261023153000", o: 10, h: 13, l: 9, c: 12, v: 4 },
      { t: "bad", o: 1, h: 2, l: 0, c: 1, v: 1 },
    ]);
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.t)).toEqual(["20261023090000", "20261023153000"]);
    expect(bars[1].c).toBe(12);
    expect(bars[0].timestamp).toBe(Date.UTC(2026, 9, 23, 9, 0, 0));
  });

  it("does not emit moving averages before their valid warm-up period", () => {
    const bars = normalizeCaptureBars(Array.from({ length: 5 }, (_, index) => ({
      t: `2026102${index + 1}`,
      o: index + 1,
      h: index + 2,
      l: index,
      c: index + 1,
      v: index === 2 ? null : 1,
    })));
    expect(captureMovingAverage(bars, 5)).toEqual([{ time: bars[4].time, value: 3 }]);
    expect(captureMovingAverage(bars, 6)).toEqual([]);
  });

  it("shows precise OHLC and an explicitly-labelled previous-bar change without inventing a turnover", () => {
    const bars = normalizeCaptureBars([
      { t: "20261023090000", o: 100.2, h: 101.6, l: 99.8, c: 100.25, v: null },
      { t: "20261023153000", o: 101, h: 103.4, l: 100.6, c: 102.5, v: 123456 },
    ]);
    expect(captureBarSummary(bars)).toEqual({
      timestamp: "2026-10-23 15:30",
      open: "101.00",
      high: "103.40",
      low: "100.60",
      close: "102.50",
      volume: "123,456",
      previousCloseChange: "+2.25",
    });
    expect(captureBarSummary(bars, 0)).toMatchObject({ timestamp: "2026-10-23 09:00", volume: "—", previousCloseChange: null });
  });

  it("limits and finds only received sector bars for local navigation", () => {
    expect(captureReceivedBarsRange(300, 100)).toEqual({ from: 200, to: 303 });
    expect(captureReceivedBarsRange(100, 100)).toBeNull();
    expect(captureReceivedBarsRange(300, "all")).toBeNull();
    expect(captureReceivedBarIndexOnDate([{ t: "20261023090000" }, { t: "20261023153000" }, { t: "20261024090000" }], "2026-10-23")).toBe(1);
    expect(captureReceivedBarIndexOnDate([{ t: "20261023090000" }], "2026-10-25")).toBe(-1);
    expect(captureReceivedBarIndexOnDate([{ t: "2026-10-23T09:00:00Z" }], "2026-10-23")).toBe(0);
  });
});
