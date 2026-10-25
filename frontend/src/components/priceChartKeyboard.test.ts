import { describe, expect, it } from "vitest";
import { chartKeyboardAction, cycleChartInterval, panLogicalRange, zoomLogicalRange } from "@/components/priceChartKeyboard";

describe("price chart keyboard helpers", () => {
  it("zooms around the current center without going below five bars or beyond history padding", () => {
    expect(zoomLogicalRange({ from: 10, to: 30 }, 100, "in")).toEqual({ from: 12, to: 28 });
    expect(zoomLogicalRange({ from: 10, to: 15 }, 100, "in")).toBeNull();
    expect(zoomLogicalRange({ from: -3, to: 103 }, 100, "out")).toBeNull();
  });

  it("pans twenty percent normally, one bar with Ctrl, and clamps at loaded-history bounds", () => {
    expect(panLogicalRange({ from: 20, to: 30 }, 100, "left", false)).toEqual({ from: 18, to: 28 });
    expect(panLogicalRange({ from: 20, to: 30 }, 100, "right", true)).toEqual({ from: 21, to: 31 });
    expect(panLogicalRange({ from: -3, to: 7 }, 100, "left", false)).toBeNull();
  });

  it("recognizes only documented chart shortcuts and cycles periods at the ends", () => {
    expect(chartKeyboardAction({ key: "ArrowUp", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })).toEqual({ kind: "zoom", direction: "in" });
    expect(chartKeyboardAction({ key: "ArrowRight", shiftKey: false, ctrlKey: true, altKey: false, metaKey: false })).toEqual({ kind: "pan", direction: "right", singleBar: true });
    expect(chartKeyboardAction({ key: "1", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false })).toEqual({ kind: "interval", direction: "previous" });
    expect(chartKeyboardAction({ key: "1", shiftKey: false, ctrlKey: true, altKey: false, metaKey: false })).toBeNull();
    expect(cycleChartInterval("1", ["1", "3", "D"] as const, "previous")).toBe("D");
    expect(cycleChartInterval("D", ["1", "3", "D"] as const, "next")).toBe("1");
  });
});
