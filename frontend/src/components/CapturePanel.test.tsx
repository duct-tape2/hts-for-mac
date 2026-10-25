import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturePanel, sectorChartLabel } from "@/components/CapturePanel";
import { samsung } from "@/test/fixtures";

function response(screenCode = "0198", name = "삼성전자") {
  return new Response(JSON.stringify({
    screen: screenCode,
    title: `${screenCode} 화면`,
    source: "fixture",
    status: "fixture",
    environment: "fixture",
    receivedAt: "2026-10-24T01:02:03Z",
    asOf: null,
    note: "fixture response",
    complete: true,
    columns: [{ key: "rank", label: "순위", numeric: true }, { key: "name", label: "종목명" }],
    rows: [
      { id: `${screenCode}-1`, rank: 1, name, instrument: samsung },
      { id: `${screenCode}-2`, rank: 2, name: "다음 종목", instrument: { ...samsung, stkCd: "035720", stkNm: "다음 종목", listingVenue: "KOSDAQ" } },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function pendingSelectionResponse() {
  return new Response(JSON.stringify({
    screen: "0186",
    title: "0186 화면",
    source: "fixture",
    status: "fixture",
    environment: "fixture",
    receivedAt: "2026-10-24T01:02:03Z",
    asOf: null,
    note: "종목 선택 정보가 준비 중이며 잠시 후 다시 확인합니다.",
    complete: true,
    selectionPending: true,
    columns: [{ key: "rank", label: "순위", numeric: true }, { key: "name", label: "종목명" }],
    rows: [{ id: "0186-1", rank: 1, name: "삼성전자" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function rankingResponse() {
  return new Response(JSON.stringify({
    screen: "0187", title: "0187 화면", source: "fixture", status: "fixture", environment: "fixture", receivedAt: "2026-10-24T01:02:03Z", asOf: null, note: "fixture response", complete: false,
    columns: [{ key: "rank", label: "순위", numeric: true }, { key: "name", label: "종목명" }, { key: "price", label: "현재가", numeric: true }, { key: "volume", label: "거래량", numeric: true }, { key: "marketCap", label: "시가총액(억원)", numeric: true }, { key: "tradingValue", label: "거래대금", numeric: true }],
    rows: [
      { id: "005930", rank: 1, name: "삼성전자", code: "005930", price: 71500, volume: 1200000, marketCap: 4270000, tradingValue: 85800, instrument: samsung },
      { id: "035720", rank: 2, name: "다음 종목", code: "035720", price: 50000, volume: 900000, marketCap: 2100000, tradingValue: 42000, instrument: { ...samsung, stkCd: "035720", stkNm: "다음 종목", listingVenue: "KOSDAQ" } },
    ],
    scope: { appliedFilters: {}, effectiveStart: null, effectiveEnd: null, returnedRows: 2, limitedReason: "partial response", unsupported: [] },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("CapturePanel", () => {
  it("does not send a network request while inactive", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<CapturePanel screen="0198" instrument={samsung} active={false} refreshKey={0} onPick={vi.fn()} />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("비활성 패널입니다. 조회를 중지했습니다.")).toBeInTheDocument();
  });

  it("selects validated rows with Arrow keys and confirms selection on Enter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    const onPick = vi.fn();
    render(<CapturePanel screen="0198" instrument={samsung} active refreshKey={0} onPick={onPick} />);
    const grid = await screen.findByRole("grid", { name: "0198 화면" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await act(async () => {});
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await act(async () => {});
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ stkCd: "035720", stkNm: "다음 종목" }));
  });

  it("manually refreshes the same capture query once after its current result settles", async () => {
    const fetch = vi.fn().mockResolvedValue(response("0187"));
    vi.stubGlobal("fetch", fetch);
    render(<CapturePanel screen="0187" instrument={samsung} active refreshKey={0} onPick={vi.fn()} />);
    await screen.findByRole("grid", { name: "0187 화면" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const refresh = screen.getByRole("button", { name: "새로고침" });
    expect(refresh).toBeEnabled();
    fireEvent.click(refresh);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("retries cold selection metadata after visibility resumes and stops when it hydrates", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetch = vi.fn().mockResolvedValueOnce(pendingSelectionResponse()).mockResolvedValueOnce(response("0186"));
    vi.stubGlobal("fetch", fetch);
    render(<CapturePanel screen="0186" instrument={samsung} active refreshKey={0} onPick={vi.fn()} />);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts and isolates an old screen response during a racing screen switch", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let firstSignal: AbortSignal | undefined;
    const fetch = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => { firstSignal = init.signal as AbortSignal; return first.promise; })
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetch);
    const view = render(<CapturePanel screen="0198" instrument={samsung} active refreshKey={0} onPick={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<CapturePanel screen="0187" instrument={samsung} active refreshKey={0} onPick={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => second.resolve(response("0187", "새 화면")));
    expect(await screen.findByText("새 화면")).toBeInTheDocument();
    await act(async () => first.resolve(response("0198", "이전 화면")));
    expect(screen.queryByText("이전 화면")).not.toBeInTheDocument();
  });

  it("does not restart an in-flight request when callback or instrument identities change", async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return pending.promise; });
    vi.stubGlobal("fetch", fetch);
    const view = render(<CapturePanel screen="0700" instrument={samsung} active refreshKey={0} onPick={vi.fn()} onPreferences={vi.fn()} onSector={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<CapturePanel screen="0700" instrument={{ ...samsung }} active refreshKey={0} onPick={vi.fn()} onPreferences={vi.fn()} onSector={vi.fn()} />);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve(response("0700", "안정 응답")));
    expect(await screen.findByText(/테스트 데이터/)).toBeInTheDocument();
  });

  it("aborts stale 0184 data when a verified upstream condition changes", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let firstSignal: AbortSignal | undefined;
    const fetch = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => { firstSignal = init.signal as AbortSignal; return first.promise; })
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetch);
    render(<CapturePanel screen="0184" instrument={samsung} active refreshKey={0} onPick={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("세션"), { target: { value: "afterMarket" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    expect(fetch.mock.calls[1]?.[0]).toContain("session=afterMarket");
    await act(async () => second.resolve(response("0184", "새 조건")));
    expect(await screen.findByText("새 조건")).toBeInTheDocument();
    await act(async () => first.resolve(response("0184", "이전 조건")));
    expect(screen.queryByText("이전 조건")).not.toBeInTheDocument();
  });

  it("filters only received ranking rows without refetching and persists only valid local bounds", async () => {
    const fetch = vi.fn().mockResolvedValue(rankingResponse());
    const onPreferences = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<CapturePanel screen="0187" instrument={samsung} active refreshKey={0} onPick={vi.fn()} onPreferences={onPreferences} />);
    await screen.findByRole("grid", { name: "0187 화면" });
    fireEvent.change(screen.getByLabelText("수신 자료 종목 또는 코드"), { target: { value: "다음" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("삼성전자")).not.toBeInTheDocument();
    expect(screen.getByText("다음 종목")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("최소 현재가"), { target: { value: "1e3" } });
    expect(onPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ localMinPrice: "", localNameOrCode: "다음" }));
    expect(screen.getByText("수신 2행에서만 필터링")).toBeInTheDocument();
  });

  it("names 0198 query periods separately from its actual refresh cadence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    render(<CapturePanel screen="0198" instrument={samsung} active refreshKey={0} onPick={vi.fn()} preferences={{ period: "5" }} />);
    await screen.findByRole("grid", { name: "0198 화면" });
    expect(screen.getByText("조회 구간")).toBeInTheDocument();
    expect(screen.getByText("ETF 구분: API 미지원")).toBeInTheDocument();
    expect(screen.getByText("자동 30초")).toBeInTheDocument();
  });

  it("uses only verified 0602 sector labels and routes quick choices through the shared sector callback", async () => {
    const fetch = vi.fn().mockResolvedValue(response("0602"));
    vi.stubGlobal("fetch", fetch);
    const onSector = vi.fn();
    const onPreferences = vi.fn();
    render(<CapturePanel screen="0602" instrument={samsung} active refreshKey={0} onPick={vi.fn()} onSector={onSector} onPreferences={onPreferences} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "101 종합(KOSDAQ)" }));
    expect(onSector).toHaveBeenCalledWith("101");
    expect(onPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ sector: "101" }));
    expect(sectorChartLabel("001")).toBe("종합(KOSPI)");
    expect(sectorChartLabel("201")).toBe("KOSPI 200");
    expect(sectorChartLabel("999")).toBe("원본 코드 999");
  });
});
