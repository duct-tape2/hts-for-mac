import { describe, expect, it } from "vitest";
import {
  CHART_TOOLS_STORAGE_KEY,
  chartAnnotationScopeKey,
  pushAnnotationUndo,
  readChartToolScope,
  undoAnnotations,
  writeChartToolScope,
} from "@/lib/chartAnnotations";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const appleDay = { environment: "fixture", market: "US", stkCd: "AAPL", listingVenue: "NASDAQ", quoteVenue: "ND", currency: "USD", interval: "D" };
const appleMinute = { ...appleDay, interval: "5" };
const samsungDay = { ...appleDay, market: "KR", stkCd: "005930", listingVenue: "KOSPI", quoteVenue: "KRX", currency: "KRW" };
const horizontal = { id: "line-1", kind: "horizontal" as const, start: { time: "20261024", price: 100 } };

describe("chart annotations storage", () => {
  it("keeps drawings isolated by instrument identity and timeframe", () => {
    const local = storage();
    expect(chartAnnotationScopeKey(appleDay)).not.toBe(chartAnnotationScopeKey(appleMinute));
    expect(chartAnnotationScopeKey(appleDay)).not.toBe(chartAnnotationScopeKey(samsungDay));
    expect(writeChartToolScope(local, appleDay, { drawings: [horizontal], templates: [] })).toBe(true);
    expect(readChartToolScope(local, appleDay).drawings).toEqual([horizontal]);
    expect(readChartToolScope(local, appleMinute).drawings).toEqual([]);
    expect(readChartToolScope(local, samsungDay).drawings).toEqual([]);
  });

  it("rejects corrupt or malformed local storage without leaking a prior scope", () => {
    const local = storage();
    local.setItem(CHART_TOOLS_STORAGE_KEY, "{not json");
    expect(readChartToolScope(local, appleDay)).toEqual({ drawings: [], templates: [] });
    local.setItem(CHART_TOOLS_STORAGE_KEY, JSON.stringify({ version: 1, scopes: { [chartAnnotationScopeKey(appleDay)]: { drawings: [{ ...horizontal, start: { time: "", price: 100 } }], templates: [] } } }));
    expect(readChartToolScope(local, appleDay)).toEqual({ drawings: [], templates: [] });
  });

  it("restores the exact previous drawing list through bounded undo snapshots", () => {
    const initial = [horizontal];
    const after = [...initial, { id: "line-2", kind: "vertical" as const, start: { time: "20261025", price: 0 } }];
    const undo = undoAnnotations(pushAnnotationUndo([], initial), after);
    expect(undo.drawings).toEqual(initial);
    expect(undo.history).toEqual([]);
  });

  it("round-trips a validated indicator template without persisting market data", () => {
    const local = storage();
    const template = {
      id: "template-1", name: "추세 확인",
      settings: { displayMode: "candles" as const, movingAverages: { "5": true, "20": true, "60": false, "120": false, "240": false }, showRsi: true, showMacd: false, showBollingerBands: true },
    };
    writeChartToolScope(local, appleDay, { drawings: [], templates: [template] });
    expect(readChartToolScope(local, appleDay).templates).toEqual([template]);
    expect(local.getItem(CHART_TOOLS_STORAGE_KEY)).not.toContain("receivedAt");
  });
});
