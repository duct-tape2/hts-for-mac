import { describe, expect, it } from "vitest";
import { extendedIndicators, latestExtendedIndicators, normalizeExtendedIndicatorPeriods } from "@/lib/extendedIndicators";
import type { ChartBar } from "@/lib/types";

function bars(count: number, volume: number | null = 10): ChartBar[] {
  return Array.from({ length: count }, (_, index) => {
    const close = index + 10;
    return { t: `202601${String(index + 1).padStart(2, "0")}`, o: close, h: close + 2, l: close - 1, c: close, v: volume };
  });
}

describe("extended chart indicators", () => {
  it("aligns ATR, ADX, Stochastic, OBV, and CCI with their completed input bars", () => {
    const values = extendedIndicators(bars(40), { atr: 5, adx: 5, stochastic: 5, stochasticSignal: 3, cci: 5 });

    expect(values.atr[0]).toEqual({ t: "20260106", value: 3 });
    expect(values.adx[0]).toMatchObject({ t: "20260110", adx: 100, pdi: 33.333333333333336, mdi: 0 });
    expect(values.stochastic.slice(0, 3)).toEqual([
      { t: "20260105", k: 71.42857142857143, d: null },
      { t: "20260106", k: 71.42857142857143, d: null },
      { t: "20260107", k: 71.42857142857143, d: 71.42857142857143 },
    ]);
    expect(values.obv[0]).toEqual({ t: "20260102", value: 10 });
    expect(values.obv.at(-1)).toEqual({ t: "20260140", value: 390 });
    expect(values.cci[0]).toEqual({ t: "20260105", value: 111.11111111111111 });
    expect(latestExtendedIndicators(values).adx).toMatchObject({ t: "20260140", adx: 100 });
  });

  it("keeps all warmup values unavailable and never makes a missing volume into an OBV zero", () => {
    expect(extendedIndicators(bars(14), { atr: 14, adx: 14, stochastic: 14, cci: 20 })).toEqual({ atr: [], adx: [], stochastic: [{ t: "20260114", k: 87.5, d: null }], obv: expect.any(Array), cci: [] });
    const missingVolume = bars(20);
    missingVolume[6] = { ...missingVolume[6], v: null };
    expect(extendedIndicators(missingVolume).obv).toEqual([]);
  });

  it("does not present a library fallback zero when an oscillator denominator is zero", () => {
    const flat = Array.from({ length: 20 }, (_, index) => ({ t: `202602${String(index + 1).padStart(2, "0")}`, o: 10, h: 10, l: 10, c: 10, v: 0 }));
    const values = extendedIndicators(flat, { atr: 5, adx: 5, stochastic: 5, stochasticSignal: 3, cci: 5 });

    expect(values.stochastic).toEqual([]);
    expect(values.adx).toEqual([]);
    expect(values.cci).toEqual([]);
    expect(values.atr.every((point) => point.value === 0)).toBe(true); // A zero true range is a real ATR result, not a denominator fallback.
  });

  it("bounds malformed configured periods before calculation", () => {
    expect(normalizeExtendedIndicatorPeriods({ atr: 0, adx: 101.4, stochastic: Number.NaN, stochasticSignal: 0, cci: 3.7 })).toEqual({ atr: 2, adx: 100, stochastic: 14, stochasticSignal: 1, cci: 4 });
  });
});
