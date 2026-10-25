import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComparisonChart } from "@/components/ComparisonChart";
import { api } from "@/lib/api";
import { apple, samsung } from "@/test/fixtures";
import type { ChartPayload, Instrument } from "@/lib/types";

const lightweightCharts = vi.hoisted(() => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({ setData: vi.fn() })),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    resize: vi.fn(), remove: vi.fn(),
  })),
}));

vi.mock("lightweight-charts", () => ({ ColorType: { Solid: "solid" }, LineSeries: Symbol("LineSeries"), createChart: lightweightCharts.createChart }));
vi.mock("@/components/TickerSearch", () => ({ TickerSearch: ({ onPick, disabled }: { onPick: (instrument: Instrument) => void; disabled?: boolean }) => <button type="button" disabled={disabled} onClick={() => onPick(apple)}>검증 검색 AAPL</button> }));

function chart(instrument: Instrument, close = 100, overrides: Partial<ChartPayload> = {}): ChartPayload {
  return {
    ...instrument, interval: "D", bars: [
      { t: "20261020", o: close, h: close, l: close, c: close, v: 1 },
      { t: "20261021", o: close, h: close * 1.1, l: close, c: close * 1.1, v: 1 },
    ], source: "fixture", status: "snapshot", receivedAt: "2026-10-24T00:00:00Z", sourceTimestamp: null, range: null, note: "daily", complete: true, adjusted: false, ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("ComparisonChart", () => {
  it("does not request daily histories while the panel is inactive", async () => {
    const chartSpy = vi.spyOn(api, "chart").mockResolvedValue(chart(samsung));
    render(createElement(ComparisonChart, { instrument: samsung, active: false }));
    await act(async () => {});
    expect(chartSpy).not.toHaveBeenCalled();
  });

  it("adds only a searched instrument and renders actual aligned daily series with no FX-conversion claim", async () => {
    const chartSpy = vi.spyOn(api, "chart").mockImplementation(async (item) => chart(item, item.market === "KR" ? 100 : 200));
    render(createElement(ComparisonChart, { instrument: samsung, active: true }));
    await waitFor(() => expect(chartSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "검증 검색 AAPL" }));
    await waitFor(() => expect(chartSpy).toHaveBeenCalledWith(apple, "D", expect.any(AbortSignal)));
    await screen.findByText(/AAPL Apple Inc/);
    expect(screen.getByText(/KRW\/USD는 환산하지 않으며/)).toBeInTheDocument();
    expect(lightweightCharts.createChart).toHaveBeenCalled();
  });

  it("replaces its local comparison set when saved companions change externally", async () => {
    const chartSpy = vi.spyOn(api, "chart").mockImplementation(async (item) => chart(item, item.market === "KR" ? 100 : 200));
    const view = render(createElement(ComparisonChart, { instrument: samsung, active: true, companions: [] }));
    await waitFor(() => expect(chartSpy).toHaveBeenCalledTimes(1));

    view.rerender(createElement(ComparisonChart, { instrument: samsung, active: true, companions: [apple] }));
    await waitFor(() => expect(chartSpy).toHaveBeenCalledWith(apple, "D", expect.any(AbortSignal)));
    expect(await screen.findByText(/AAPL Apple Inc/)).toBeInTheDocument();

    view.rerender(createElement(ComparisonChart, { instrument: samsung, active: true, companions: [] }));
    await waitFor(() => expect(screen.queryByText(/AAPL Apple Inc/)).not.toBeInTheDocument());
  });

  it("aborts and ignores a stale instrument request after the primary instrument changes", async () => {
    const kr = deferred<ChartPayload>();
    const us = deferred<ChartPayload>();
    vi.spyOn(api, "chart").mockImplementation((item) => item.stkCd === samsung.stkCd ? kr.promise : us.promise);
    const view = render(createElement(ComparisonChart, { instrument: samsung, active: true }));
    await waitFor(() => expect(api.chart).toHaveBeenCalledTimes(1));
    view.rerender(createElement(ComparisonChart, { instrument: apple, active: true }));
    await waitFor(() => expect(api.chart).toHaveBeenCalledTimes(2));
    await act(async () => { us.resolve(chart(apple, 200)); });
    await screen.findByText(/AAPL Apple Inc/);
    await act(async () => { kr.resolve(chart(samsung, 100)); });
    await waitFor(() => expect(screen.queryByText(/005930 삼성전자/)).not.toBeInTheDocument());
  });

  it("shows a missing companion's received status and note instead of presenting a one-line comparison", async () => {
    vi.spyOn(api, "chart").mockImplementation(async (item) => item.stkCd === samsung.stkCd
      ? chart(item)
      : chart(item, 200, { bars: [], status: "missing", complete: false, note: "provider returned no daily history" }));
    render(createElement(ComparisonChart, { instrument: samsung, active: true, companions: [apple] }));

    expect(await screen.findByText("수신 상태: 미수신")).toBeInTheDocument();
    expect(screen.getByText("provider returned no daily history")).toBeInTheDocument();
    expect(screen.getByText(/선택 2종목 중 1종목만 비교 가능한 일별 종가를 수신했습니다/)).toBeInTheDocument();
    expect(screen.queryByTestId("comparison-lightweight-chart")).not.toBeInTheDocument();
  });

  it("labels partial data and a failed refresh that retains the prior received payload", async () => {
    const chartSpy = vi.spyOn(api, "chart")
      .mockResolvedValueOnce(chart(samsung, 100, { complete: false, note: "pagination capped at 5 pages" }))
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    const view = render(createElement(ComparisonChart, { instrument: samsung, active: true, refreshKey: 0 }));
    expect(await screen.findByText("수신 상태: 스냅샷 · 일부 수신")).toBeInTheDocument();
    expect(screen.getByText("pagination capped at 5 pages")).toBeInTheDocument();

    view.rerender(createElement(ComparisonChart, { instrument: samsung, active: true, refreshKey: 1 }));
    await waitFor(() => expect(chartSpy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("수신 상태: 이전 수신 자료 · 갱신 실패")).toBeInTheDocument();
    expect(screen.getByText("갱신 실패: refresh unavailable")).toBeInTheDocument();
    expect(screen.getByText(/일부 수신 자료 포함: 005930/)).toBeInTheDocument();
    expect(screen.getByText(/갱신 실패 뒤 이전 수신 자료 표시: 005930/)).toBeInTheDocument();
    expect(screen.getByTestId("comparison-lightweight-chart")).toBeInTheDocument();
  });
});
