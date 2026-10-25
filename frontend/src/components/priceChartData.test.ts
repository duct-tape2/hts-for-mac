import { describe, expect, it } from "vitest";
import { bollingerBands, formatMarketTime, macd, rawStampToUnixSeconds, relativeStrengthIndex, simpleMovingAverage, toSeriesBars } from "@/components/priceChartData";
import type { ChartBar } from "@/lib/types";

function bars(closes: number[]): ChartBar[] {
  return closes.map((c, index) => ({ t: `202601${String(index + 1).padStart(2, "0")}`, o: c, h: c, l: c, c, v: index }));
}

describe("price chart data", () => {
  it("calculates simple moving averages on known close values", () => {
    expect(simpleMovingAverage(bars([1, 2, 3, 4, 5]), 3)).toEqual([
      { t: "20260103", value: 2 },
      { t: "20260104", value: 3 },
      { t: "20260105", value: 4 },
    ]);
  });

  it("does not invent MA120 or MA240 values before their full warmup windows", () => {
    const source = bars(Array.from({ length: 239 }, (_, index) => index + 1));
    expect(simpleMovingAverage(source.slice(0, 119), 120)).toEqual([]);
    expect(simpleMovingAverage(source, 240)).toEqual([]);
    expect(simpleMovingAverage([...source, { t: "202601240", o: 240, h: 240, l: 240, c: 240, v: 240 }], 240)).toEqual([
      { t: "202601240", value: 120.5 },
    ]);
  });

  it("calculates Wilder RSI and handles a persistent gain", () => {
    const result = relativeStrengthIndex(bars(Array.from({ length: 16 }, (_, index) => index + 1)));
    expect(result).toHaveLength(2);
    expect(result.map((point) => point.value)).toEqual([100, 100]);
  });

  it("aligns technicalindicators Bollinger Bands and MACD output to their producing bars", () => {
    const source = bars(Array.from({ length: 40 }, (_, index) => index + 1));
    const bands = bollingerBands(source);
    expect(bands).toHaveLength(21);
    expect(bands[0]).toMatchObject({ t: "20260120", middle: 10.5, upper: 22.032562594670797, lower: -1.0325625946707966 });

    const values = macd(source);
    expect(values).toHaveLength(15);
    expect(values[0]).toEqual({ t: "20260126", macd: 7, signal: null, histogram: null });
    expect(values[8]).toEqual({ t: "20260134", macd: 7, signal: 7, histogram: 0 });
    expect(macd(source.slice(0, 26))).toEqual([values[0]]);
  });

  it("keeps raw market timestamps intact in labels and uses UTC only for plotting", () => {
    expect(formatMarketTime("202610240930")).toBe("10/24 09:30");
    expect(formatMarketTime("20261024")).toBe("10/24");
    expect(rawStampToUnixSeconds("202610240930")).toBe(Date.UTC(2026, 9, 24, 9, 30) / 1000);
    expect(toSeriesBars([{ t: "202610240930", o: 1, h: 3, l: 1, c: 2, v: 4 }])).toEqual([
      { t: "202610240930", time: Date.UTC(2026, 9, 24, 9, 30) / 1000, o: 1, h: 3, l: 1, c: 2, v: 4 },
    ]);
  });
});
