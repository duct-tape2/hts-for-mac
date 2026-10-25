import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveQuote, useLiveQuotes, quoteKey } from "./useLiveQuote";
import { QuoteStream, quoteStream } from "./quoteStream";
import { apple, fixtureQuote, samsung } from "@/test/fixtures";
import type { Instrument } from "./types";

function responseStream() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "text/event-stream" } });
  const sendEvent = (event: string, value: unknown) => stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
  return { response, send: (value: unknown) => sendEvent("quote", value), sendEvent };
}

afterEach(() => { quoteStream.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("shared market stream", () => {
  it("binds visibility lazily and detaches it on dispose before reusable subscriptions", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const stream = new QuoteStream();
    const listener = vi.fn();
    const first = stream.subscribe([], listener);
    expect(add.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(1);
    first();
    stream.dispose();
    expect(remove.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(1);
    const second = stream.subscribe([], listener);
    expect(add.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(2);
    second();
    stream.dispose();
  });

  it("shares the same subscription between chart and watchlist; removes only the final consumer", async () => {
    const stream = responseStream(), fetcher = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetcher);
    const first = renderHook(() => useLiveQuote(samsung));
    const second = renderHook(() => useLiveQuotes([samsung, apple]));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:8010/api/market/stream");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).instruments).toHaveLength(2);
    act(() => stream.send(fixtureQuote(samsung)));
    await waitFor(() => expect(first.result.current.quote?.stkCd).toBe("005930"));
    expect(second.result.current.quotes[quoteKey(samsung)].last).toBe(first.result.current.quote?.last);
    first.unmount();
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(fetcher).toHaveBeenCalledTimes(1);
    second.unmount();
    await waitFor(() => expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true));
  });

  it("clears a prior instrument immediately and ignores delayed frames from the cancelled stream", async () => {
    const kr = responseStream(), us = responseStream();
    const fetcher = vi.fn().mockResolvedValueOnce(kr.response).mockResolvedValueOnce(us.response);
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ instrument }) => useLiveQuote(instrument), { initialProps: { instrument: samsung as Instrument } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => kr.send(fixtureQuote(samsung)));
    await waitFor(() => expect(result.current.quote?.market).toBe("KR"));
    rerender({ instrument: apple });
    expect(result.current.quote).toBeNull();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => { kr.send(fixtureQuote(samsung)); us.send(fixtureQuote(apple)); });
    await waitFor(() => expect(result.current.quote?.stkCd).toBe("AAPL"));
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("suspends a hidden tab, keeps its last quote stale, and requests a fresh stream on return", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const first = responseStream(), resumed = responseStream();
    const fetcher = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(resumed.response);
    vi.stubGlobal("fetch", fetcher);
    const realSamsung = { ...samsung, environment: "real" as const };
    const hook = renderHook(() => useLiveQuote(realSamsung));
    try {
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      act(() => first.send(fixtureQuote(realSamsung, { source: "kiwoom", status: "live", bookLive: true })));
      await waitFor(() => expect(hook.result.current.quote?.status).toBe("live"));
      visibility = "hidden";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(hook.result.current.quote?.status).toBe("stale"));
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      visibility = "visible";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      act(() => resumed.send(fixtureQuote(realSamsung, { source: "kiwoom", status: "live", bookLive: true, last: 70100 })));
      await waitFor(() => expect(hook.result.current.quote?.last).toBe(70100));
    } finally {
      hook.unmount();
      delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
  });

  it("rotates promptly when the server's stream lease asks for a retry", async () => {
    const first = responseStream(), replacement = responseStream();
    const fetcher = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(replacement.response);
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useLiveQuote(samsung));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => first.sendEvent("stream-retry", { retryAfterMs: 0 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    hook.unmount();
  });
});
