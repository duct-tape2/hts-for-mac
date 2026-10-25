import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalScanner } from "@/components/LocalScanner";
import { api } from "@/lib/api";
import { StoreProvider } from "@/lib/store";
import { fixtureQuote, samsung } from "@/test/fixtures";
import type { ReadonlyState } from "@/lib/types";

function state(): ReadonlyState {
  return {
    mode: "fixture", kiwoom: "disconnected", kiwoomError: "",
    watchlists: [{ id: "local", name: "내 스캔", source: "app" }],
    items: [{ ...samsung, id: "item", watchlistId: "local", enabled: true, last: null, prevClose: null, open: null, changePct: null }],
  };
}

function harness(active: boolean, onPick?: (instrument: typeof samsung) => void) {
  return <StoreProvider><LocalScanner instrument={samsung} active={active} onPick={onPick} /></StoreProvider>;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("LocalScanner", () => {
  it("does not request quotes while hidden", () => {
    vi.spyOn(api, "state").mockResolvedValue(state());
    const quote = vi.spyOn(api, "quote");
    render(harness(false));
    expect(quote).not.toHaveBeenCalled();
    expect(screen.getByText("비활성 패널입니다. 로컬 스캔을 중지했습니다.")).toBeInTheDocument();
  });

  it("cancels an active bounded scan when its panel becomes hidden", async () => {
    vi.spyOn(api, "state").mockResolvedValue(state());
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "quote").mockImplementation((_instrument, nextSignal) => {
      signal = nextSignal;
      return new Promise((_, reject) => nextSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    });
    const view = render(harness(true));
    await waitFor(() => expect(api.quote).toHaveBeenCalledTimes(1));
    view.rerender(harness(false));
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("filters already received rows locally without a new quote request", async () => {
    vi.spyOn(api, "state").mockResolvedValue(state());
    const quote = vi.spyOn(api, "quote").mockResolvedValue(fixtureQuote(samsung, { last: 70000, changePct: 1.2, volume: 1234 }));
    render(harness(true));
    await screen.findByRole("grid", { name: "로컬 관심종목 스캔 결과" });
    expect(quote).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("최소 현재가"), { target: { value: "80000" } });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(screen.getByText("수신된 로컬 시세 중 조건과 일치하는 종목이 없습니다.")).toBeInTheDocument();
  });

  it("does not open the first row when Enter is used on a sortable column button", async () => {
    vi.spyOn(api, "state").mockResolvedValue(state());
    vi.spyOn(api, "quote").mockResolvedValue(fixtureQuote(samsung));
    const onPick = vi.fn();
    render(harness(true, onPick));
    await screen.findByRole("grid", { name: "로컬 관심종목 스캔 결과" });

    fireEvent.keyDown(screen.getByRole("button", { name: "종목명" }), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });
});
