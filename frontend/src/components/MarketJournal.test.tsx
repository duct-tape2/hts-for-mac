import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketJournal, marketJournalCsvCell, mergeMarketJournalEvents, parseMarketJournal, replayMarketJournal } from "@/components/MarketJournal";
import type { MarketJournalEvent } from "@/components/MarketJournal";
import { apple, samsung } from "@/test/fixtures";
import type { Instrument } from "@/lib/types";

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function payload(instrument: Instrument, entries: MarketJournalEvent[] = []) {
  return {
    identity: { ...instrument },
    events: entries,
    oldestSequence: entries.length ? entries[0].sequence : null,
    latestSequence: entries.length ? entries.at(-1)?.sequence : 0,
    gap: false,
    truncated: false,
    transportGap: null,
    retention: 256,
    sequenceSemantics: "local process arrival order; not provider or exchange order",
  };
}

function trade(sequence: number, last: number, volume = 10): MarketJournalEvent {
  return {
    sequence,
    kind: "trade",
    eventType: "0B",
    receivedAt: `2026-10-25T00:00:0${sequence}Z`,
    sourceTime: { rawTradeDate: "20261025", rawTradeTime: `09000${sequence}`, rawLocalTradeTime: null, timestampStatus: "unverified" },
    connectionEpoch: 1,
    last,
    change: 1,
    changePct: 0.5,
    volume,
    asks: [],
    bids: [],
    gapBefore: null,
  };
}

function book(sequence: number, ask: number, bid: number): MarketJournalEvent {
  return {
    sequence,
    kind: "book",
    eventType: "0D",
    receivedAt: `2026-10-25T00:00:0${sequence}Z`,
    sourceTime: null,
    connectionEpoch: 1,
    asks: [{ price: ask, qty: 2 }],
    bids: [{ price: bid, qty: 3 }],
    last: null,
    change: null,
    changePct: null,
    volume: null,
    gapBefore: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarketJournal", () => {
  it("accepts the bounded arrival schema, exposes gaps, and replays only received values", () => {
    const received = { ...payload(samsung, [trade(1, 70000, 10), book(2, 70100, 69900)]), gap: true, transportGap: { reason: "transport reconnect or failure" } };
    const journal = parseMarketJournal(received, samsung);

    expect(journal?.gap).toBe(true);
    expect(journal?.transportGap).toBe("transport reconnect or failure");
    const deduped = mergeMarketJournalEvents(journal?.events ?? [], [trade(1, 70000, 10)]);
    expect(deduped).toHaveLength(2);
    expect(replayMarketJournal(deduped, 1)).toMatchObject({ sequence: 2, last: 70000, volume: 10, asks: [{ price: 70100, qty: 2 }], bids: [{ price: 69900, qty: 3 }] });
  });

  it("rejects another symbol's journal rather than leaking it into this panel", () => {
    expect(parseMarketJournal(payload(samsung, [trade(1, 70000)]), apple)).toBeNull();
  });

  it("makes a retention or reconnect gap prominent without treating it as market history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...payload(samsung, [trade(5, 70000)]), gap: true, truncated: true, transportGap: { reason: "transport reconnect or failure" } })));
    render(createElement(MarketJournal, { instrument: samsung, active: true }));

    expect(await screen.findByRole("alert")).toHaveTextContent("누락된 이벤트를 복원하거나 과거 시장 이력으로 해석하지 않습니다.");
  });

  it("uses the closest received ask and bid instead of the provider array order", async () => {
    const receivedBook = {
      ...book(1, 71000, 69000),
      asks: [{ price: 71000, qty: 1 }, { price: 70000, qty: 2 }],
      bids: [{ price: 69000, qty: 3 }, { price: 68000, qty: 4 }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload(samsung, [receivedBook]))));
    render(createElement(MarketJournal, { instrument: samsung, active: true }));

    expect(await screen.findByText("매도 70,000/2 / 매수 69,000/3")).toBeInTheDocument();
  });

  it("escapes whitespace-prefixed spreadsheet formulas in journal CSV cells", () => {
    expect(marketJournalCsvCell("  =HYPERLINK(\"https://example.invalid\")")).toBe("\"'  =HYPERLINK(\"\"https://example.invalid\"\")\"");
  });

  it("ignores an older identity response after the selected instrument changes", async () => {
    const samsungResponse = deferred<Response>();
    const appleResponse = deferred<Response>();
    const fetcher = vi.fn((url: string) => url.includes("005930") ? samsungResponse.promise : appleResponse.promise);
    vi.stubGlobal("fetch", fetcher);

    const view = render(createElement(MarketJournal, { instrument: samsung, active: true }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    view.rerender(createElement(MarketJournal, { instrument: apple, active: true }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => { appleResponse.resolve(response(payload(apple, [trade(1, 200, 20)]))); });
    await screen.findByText("$200.00");

    await act(async () => { samsungResponse.resolve(response(payload(samsung, [trade(1, 70000, 10)]))); });
    await waitFor(() => expect(screen.queryByText("70,000원")).not.toBeInTheDocument());
    expect(screen.getByText(/AAPL · Apple Inc\./)).toBeInTheDocument();
  });
});
