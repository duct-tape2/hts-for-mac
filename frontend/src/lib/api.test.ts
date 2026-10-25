import { describe, expect, it, vi } from "vitest";
import { ApiShapeError, api, parseQuote } from "@/lib/api";
import { fixtureQuote, samsung } from "@/test/fixtures";

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("read-only API validation", () => {
  it("keeps receipt observations separate from an unknown exchange timestamp", () => {
    const observedMinute = { basis: "receipt-time observations", bucketStart: "2026-10-25T01:00:00Z", open: 100, high: 103, low: 99, close: 102, count: 4, firstSequence: 1, lastSequence: 4, complete: false };
    const parsed = parseQuote({ ...fixtureQuote(samsung), observedMinute, sourceTimestamp: null, priceLive: true, volumeLive: false });
    expect(parsed.observedMinute).toEqual(observedMinute);
    expect(parsed.sourceTimestamp).toBeNull();
    expect(() => parseQuote({ ...fixtureQuote(samsung), observedMinute: { ...observedMinute, complete: true } })).toThrow(ApiShapeError);
    expect(() => parseQuote({ ...fixtureQuote(samsung), observedMinute: { ...observedMinute, high: 98 } })).toThrow(ApiShapeError);
  });
  it("preserves the complete feed identity for a fixture quote", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(fixtureQuote(samsung)));
    vi.stubGlobal("fetch", fetchMock);

    const quote = await api.quote(samsung);

    expect(quote.stkCd).toBe("005930");
    expect(quote.environment).toBe("fixture");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("market=KR"), expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("listing_venue=KOSPI"), expect.any(Object));
  });

  it("rejects a semantically impossible KR response instead of coercing it", () => {
    const invalid = { ...fixtureQuote(samsung), currency: "USD", quoteVenue: "ND", stexTp: "ND" };
    expect(() => parseQuote(invalid)).toThrow(ApiShapeError);
  });
});

it("shares chart requests while one consumer cancels independently", async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal("fetch", fetchMock);
  const first = new AbortController(), second = new AbortController();
  const a = api.chart(samsung, "W", first.signal);
  const b = api.chart(samsung, "W", second.signal);
  const cancelled = expect(a).rejects.toMatchObject({ name: "AbortError" });
  first.abort();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  resolve(json({ ...samsung, interval: "W", bars: [], source: "fixture", status: "missing", receivedAt: null, sourceTimestamp: null, range: null, note: "", complete: true, adjusted: true }));
  await cancelled;
  expect((await b).interval).toBe("W");
});
