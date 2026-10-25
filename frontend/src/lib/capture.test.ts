import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureShapeError, captureQuery, fetchCaptureScreen, parseCapturePayload } from "@/lib/capture";
import { samsung } from "@/test/fixtures";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    screen: "0198",
    title: "실시간 종목 순위",
    source: "fixture",
    status: "fixture",
    environment: "fixture",
    receivedAt: "2026-10-24T01:02:03Z",
    asOf: null,
    note: "",
    complete: true,
    columns: [{ key: "rank", label: "순위", numeric: true }, { key: "name", label: "종목명" }, { key: "change", label: "대비", numeric: true, unit: "KRW" }],
    rows: [{ id: "KR/005930", rank: 1, name: "삼성전자", change: -100, currency: "KRW", sign: "down", instrument: samsung }],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("capture transport boundary", () => {
  it("retains signed numeric values and non-displayed scalar metadata while preserving an empty note", () => {
    const parsed = parseCapturePayload(payload({ rows: [{ id: "KR/005930", rank: 1, name: "삼성전자", change: -100, rankChange: 3, rankChangeSign: "1", currency: "KRW", sign: "down", instrument: samsung }] }), "0198");
    expect(parsed.note).toBe("");
    expect(parsed.rows[0].change).toBe(-100);
    expect(parsed.rows[0].rankChange).toBe(3);
    expect(parsed.rows[0].rankChangeSign).toBe("1");
    expect(parsed.rows[0].instrument).toEqual(samsung);
  });

  it("accepts bounded provider decimal precision and rejects invalid values", () => {
    const parsed = parseCapturePayload(payload({ columns: [
      { key: "name", label: "종목" }, { key: "last", label: "현재가", numeric: true, precision: 4 },
    ], rows: [{ id: "fx", name: "EUR/USD", last: 1.1204 }] }), "0198");
    expect(parsed.columns[1]).toMatchObject({ key: "last", precision: 4 });
    expect(() => parseCapturePayload(payload({ columns: [{ key: "last", label: "현재가", numeric: true, precision: 9 }], rows: [{ id: "bad", last: 1 }] }), "0198")).toThrow(CaptureShapeError);
    expect(() => parseCapturePayload(payload({ columns: [{ key: "last", label: "현재가", numeric: true, precision: 1.5 }], rows: [{ id: "bad", last: 1 }] }), "0198")).toThrow(CaptureShapeError);
  });

  it("accepts only the documented optional scope shape", () => {
    const parsed = parseCapturePayload(payload({ scope: {
      appliedFilters: { market: "KOSPI" }, effectiveStart: "20261001", effectiveEnd: "20261024", returnedRows: 1, limitedReason: "첫 페이지", unsupported: ["priceBand"],
    } }), "0198");
    expect(parsed.scope).toEqual(expect.objectContaining({ returnedRows: 1, unsupported: ["priceBand"] }));
    expect(() => parseCapturePayload(payload({ scope: { appliedFilters: {}, effectiveStart: null, effectiveEnd: null, returnedRows: 0, limitedReason: null, unsupported: [], extra: true } }), "0198")).toThrow(CaptureShapeError);
  });

  it("accepts only the explicit pending-selection signal", () => {
    expect(parseCapturePayload(payload({ selectionPending: true }), "0198").selectionPending).toBe(true);
    expect(() => parseCapturePayload(payload({ selectionPending: false }), "0198")).toThrow(CaptureShapeError);
  });

  it("keeps an undated news article while rejecting a malformed non-empty date", () => {
    const article = { id: "article-1", title: "제목", provider: "RSS", publishedAt: "", url: "https://example.test/article", summary: "요약" };
    expect(parseCapturePayload(payload({ news: [article] }), "0198").news[0]?.publishedAt).toBe("");
    expect(() => parseCapturePayload(payload({ news: [{ ...article, publishedAt: "not-a-date" }] }), "0198")).toThrow(CaptureShapeError);
  });

  it("rejects mismatched fixture provenance and malformed displayed cells", () => {
    expect(() => parseCapturePayload(payload({ source: "kiwoom" }), "0198")).toThrow(CaptureShapeError);
    expect(() => parseCapturePayload(payload(), "0198", "real")).toThrow("선택한 환경과 다른");
    expect(() => parseCapturePayload(payload({ rows: [{ id: "bad", rank: "1", name: "broken", change: false }] }), "0198")).toThrow(CaptureShapeError);
    expect(() => parseCapturePayload(payload({ bars: [{ t: "20261023153000", o: 10, h: 9, l: 8, c: 10, v: 1 }] }), "0198")).toThrow(CaptureShapeError);
  });

  it("does not send a request for a malformed query condition", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchCaptureScreen("0198", { market: "not-a-market" as "all" })).rejects.toThrow("조회 조건");
    expect(fetch).not.toHaveBeenCalled();
    expect(() => captureQuery({ query: "x".repeat(101) })).toThrow("조회 조건");
  });

  it("uses only the normalized screen endpoint and query", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await fetchCaptureScreen("0198", { market: "KOSPI", venue: "ALL", sort: "volume" });
    expect(fetch).toHaveBeenCalledWith("/api/hts/screens/0198?market=KOSPI&venue=ALL&sort=volume", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("serializes only documented upstream ranking conditions", () => {
    expect(captureQuery({ session: "afterMarket", stock: "excludeEtf", credit: "loan", volumeBand: "100k", priceBand: "over10k", valueBand: "1b", limitSort: "streak", managed: "include", direction: "previousUpLimit" })).toBe("direction=previousUpLimit&session=afterMarket&stock=excludeEtf&credit=loan&volumeBand=100k&priceBand=over10k&valueBand=1b&limitSort=streak&managed=include");
    expect(() => captureQuery({ stock: "unsupported" as "all" })).toThrow("조회 조건");
  });
});
