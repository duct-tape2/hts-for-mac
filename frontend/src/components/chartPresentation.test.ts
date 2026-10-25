import { describe, expect, it } from "vitest";
import { MOVING_AVERAGE_COLORS, formatChartIndexAxis, formatChartPriceAxis, volumeMovingAverage, volumePaneStretchFactor } from "@/components/chartPresentation";

describe("chart presentation helpers", () => {
  it("keeps the HTS moving-average color identities shared by price and volume panes", () => {
    expect(MOVING_AVERAGE_COLORS).toMatchObject({
      5: "#df00be",
      20: "#ffc900",
      60: "#008423",
      120: "#5e00d6",
      240: "#626a9e",
    });
  });

  it("formats KR prices, US prices, and index values without losing their required precision", () => {
    expect(formatChartPriceAxis(1234567.8, "KRW")).toBe("1,234,568");
    expect(formatChartPriceAxis(1234.5, "USD")).toBe("1,234.50");
    expect(formatChartIndexAxis(751.6)).toBe("751.60");
  });

  it("emits a volume MA only for complete numeric windows", () => {
    const bars = [
      { t: "1", v: 10 }, { t: "2", v: 20 }, { t: "3", v: null }, { t: "4", v: 40 }, { t: "5", v: 50 }, { t: "6", v: 60 },
    ];
    expect(volumeMovingAverage(bars, 3)).toEqual([{ t: "6", value: 50 }]);
    expect(volumeMovingAverage(bars, 7)).toEqual([]);
  });

  it("derives an exact volume-pane proportion from all other pane stretch", () => {
    expect(volumePaneStretchFactor(0.26, 1)).toBeCloseTo(0.26 / 0.74);
    expect(volumePaneStretchFactor(0.26, 3)).toBeCloseTo(3 * 0.26 / 0.74);
  });
});
