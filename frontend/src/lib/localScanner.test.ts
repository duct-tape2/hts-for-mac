import { describe, expect, it, vi } from "vitest";
import {
  collectLocalScannerQuotes,
  filterLocalScannerRows,
  localScannerCounts,
  localScannerCsv,
  localScannerRows,
  localScannerUniverse,
  parseLocalScannerFilters,
} from "@/lib/localScanner";
import { apple, fixtureQuote, samsung } from "@/test/fixtures";
import type { WatchlistItem } from "@/lib/types";

function item(instrument = samsung, id = instrument.stkCd): WatchlistItem {
  return { ...instrument, id, watchlistId: "local", enabled: true, last: null, prevClose: null, open: null, changePct: null };
}

describe("local watchlist scanner", () => {
  it("uses only enabled matching-market items in the selected saved group", () => {
    const disabled = { ...item(samsung, "disabled"), enabled: false };
    const otherGroup = { ...item(samsung, "other"), watchlistId: "other" };
    const universe = localScannerUniverse([item(), { ...item(), id: "duplicate" }, disabled, otherGroup, item(apple)], "local", samsung, "fixture");
    expect(universe).toEqual([samsung]);
  });

  it("keeps stale and missing values out of matches instead of treating them as zero", () => {
    const second = { ...samsung, stkCd: "000660", stkNm: "SK하이닉스" };
    const third = { ...samsung, stkCd: "035420", stkNm: "NAVER" };
    const rows = localScannerRows([samsung, second, third], [
      { instrument: samsung, quote: fixtureQuote(samsung, { last: 70000, changePct: 1.2, volume: 50 }) },
      { instrument: second, quote: fixtureQuote(second, { status: "stale", last: 90000 }) },
      { instrument: third, quote: fixtureQuote(third, { last: null, changePct: null, volume: null }) },
    ]);
    const filters = parseLocalScannerFilters({ minPrice: "0", minChangePct: "0", minVolume: "0" });
    expect(filters.error).toBeNull();
    expect(filterLocalScannerRows(rows, filters.values).map((row) => row.instrument.stkCd)).toEqual(["005930"]);
    expect(localScannerCounts(rows)).toEqual({ ready: 2, stale: 1, unavailable: 0 });
  });

  it("does not manufacture a match for an unavailable response and protects CSV formula cells", () => {
    const rows = localScannerRows([samsung], [{ instrument: samsung, error: "network" }]);
    expect(localScannerCounts(rows)).toEqual({ ready: 0, stale: 0, unavailable: 1 });
    expect(filterLocalScannerRows(rows, parseLocalScannerFilters({ minPrice: "", minChangePct: "", minVolume: "" }).values)).toEqual([]);
    const csv = localScannerCsv([{ ...rows[0], instrument: { ...samsung, stkNm: "=FORMULA" } }]);
    expect(csv).toContain('"\'=FORMULA"');
  });

  it("starts no more than two requests and stops queued work when cancelled", async () => {
    const instruments = [samsung, { ...samsung, stkCd: "000660" }, { ...samsung, stkCd: "035420" }];
    const controller = new AbortController();
    const load = vi.fn((_instrument, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const work = collectLocalScannerQuotes(instruments, load, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
