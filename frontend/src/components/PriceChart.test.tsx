import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apple, fixtureQuote, samsung } from "@/test/fixtures";
import type { ChartPayload, Instrument } from "@/lib/types";

const lightweightCharts = vi.hoisted(() => {
  type Handler = (param: { point?: { x: number; y: number }; paneIndex?: number; time?: unknown }) => void;
  type PaneRecord = { setHeight: ReturnType<typeof vi.fn>; setStretchFactor: ReturnType<typeof vi.fn>; getStretchFactor: ReturnType<typeof vi.fn>; getHeight: ReturnType<typeof vi.fn> };
  type ChartRecord = { series: ReturnType<typeof series>[]; panes: PaneRecord[]; click?: Handler; crosshair?: Handler; timeScale: { fitContent: ReturnType<typeof vi.fn>; resetTimeScale: ReturnType<typeof vi.fn>; setVisibleLogicalRange: ReturnType<typeof vi.fn>; getVisibleLogicalRange: ReturnType<typeof vi.fn>; coordinateToTime: ReturnType<typeof vi.fn>; timeToCoordinate: ReturnType<typeof vi.fn> } };
  const charts: ChartRecord[] = [];
  function series() {
    return {
      setData: vi.fn(),
      update: vi.fn(),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn(), options: vi.fn() })),
      removePriceLine: vi.fn(),
      coordinateToPrice: vi.fn(() => 123.45),
      priceToCoordinate: vi.fn(() => 40),
    };
  }
  function pane(): PaneRecord {
    return { setHeight: vi.fn(), setStretchFactor: vi.fn(), getStretchFactor: vi.fn(() => 1), getHeight: vi.fn(() => 144) };
  }
  const createChart = vi.fn(() => {
    const chart: ChartRecord = {
      series: [] as ReturnType<typeof series>[],
      panes: [pane(), pane()],
      timeScale: { fitContent: vi.fn(), resetTimeScale: vi.fn(), setVisibleLogicalRange: vi.fn(), getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 10 })), coordinateToTime: vi.fn(() => ({ year: 2026, month: 10, day: 24 })), timeToCoordinate: vi.fn(() => 20) },
    };
    charts.push(chart);
    return {
      addSeries: vi.fn((_type: unknown, _options: unknown, paneIndex?: number) => {
        if (paneIndex !== undefined && paneIndex >= 2) chart.panes[0].getHeight.mockReturnValue(102);
        const next = series();
        chart.series.push(next);
        return next;
      }),
      addPane: vi.fn(() => chart.panes[1]),
      panes: vi.fn(() => chart.panes),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      timeScale: vi.fn(() => chart.timeScale),
      subscribeClick: vi.fn((handler: Handler) => { chart.click = handler; }),
      unsubscribeClick: vi.fn(),
      subscribeCrosshairMove: vi.fn((handler: Handler) => { chart.crosshair = handler; }),
      unsubscribeCrosshairMove: vi.fn(),
      resize: vi.fn(),
      remove: vi.fn(),
    };
  });
  return { charts, createChart };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: Symbol("CandlestickSeries"),
  HistogramSeries: Symbol("HistogramSeries"),
  LineSeries: Symbol("LineSeries"),
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Dashed: 2 },
  createChart: lightweightCharts.createChart,
}));

import { isUsableLiveTrade, nextLiveCandleState, normalizeVolumeRatio, observedMinuteForCurrentRestBar, PriceChart, receivedBarIndexOnDate, receivedBarsRange } from "@/components/PriceChart";
import type { PriceChartPreferences } from "@/components/PriceChart";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function chart(instrument: Instrument, note: string): ChartPayload {
  return {
    ...instrument,
    interval: "D",
    bars: [
      { t: "20261023", o: 1, h: 3, l: 1, c: 2, v: 10 },
      { t: "20261024", o: 2, h: 4, l: 2, c: 3, v: 20 },
    ],
    source: "fixture",
    status: "snapshot",
    receivedAt: "2026-10-24T01:02:03Z",
    sourceTimestamp: "2026-10-24T01:02:02Z",
    range: { basis: "fixture", start: "20261001", end: "20261020" },
    note,
    complete: true,
    adjusted: false,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  lightweightCharts.charts.splice(0);
});

describe("PriceChart", () => {
  it("bounds the persisted separate-volume pane ratio", () => {
    expect(normalizeVolumeRatio(0.26)).toBe(0.26);
    expect(normalizeVolumeRatio(0.02)).toBe(0.15);
    expect(normalizeVolumeRatio(0.8)).toBe(0.45);
    expect(normalizeVolumeRatio(Number.NaN)).toBe(0.26);
  });

  it("limits and seeks only bars already received by the chart response", () => {
    expect(receivedBarsRange(300, 50)).toEqual({ from: 250, to: 303 });
    expect(receivedBarsRange(50, 50)).toBeNull();
    expect(receivedBarsRange(300, "all")).toBeNull();
    expect(receivedBarIndexOnDate([{ t: "202610230900" }, { t: "202610231500" }, { t: "202610240900" }], "2026-10-23")).toBe(1);
    expect(receivedBarIndexOnDate([{ t: "202610230900" }], "2026-10-25")).toBe(-1);
    expect(receivedBarIndexOnDate([{ t: "2026-10-24T01:00:00Z" }], "2026-10-23", "US")).toBe(0);
  });

  it("sets the volume pane to the persisted stretch ratio instead of its transient initial pixel height", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(chart(apple, "volume pane ratio"))));
    render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true, preferences: { volumeRatio: 0.26 } }));
    await screen.findByText(/volume pane ratio/);
    expect(lightweightCharts.charts[0].panes[1].setStretchFactor).toHaveBeenLastCalledWith(expect.closeTo(0.26 / 0.74));
  });

  it("updates the final bar only from a valid, same-bucket live trade, never a mid-price or snapshot", async () => {
    const payload = chart(apple, "live trade chart");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload)));
    const snapshot = fixtureQuote(apple, { last: 101, midPrice: 999, status: "snapshot" });
    const view = render(createElement(PriceChart, { instrument: apple, quote: snapshot, onSelectPrice: vi.fn(), active: true }));
    await screen.findByText(/live trade chart/);
    const runtime = lightweightCharts.charts[0];
    expect(runtime.series[0].update).not.toHaveBeenCalled();
    expect(isUsableLiveTrade(apple, snapshot)).toBe(false);

    const unbucketedTrade = fixtureQuote(apple, { last: 101, midPrice: 999, status: "live", tradeReceivedAt: "2026-10-24T01:02:03Z", sourceTimestamp: null });
    view.rerender(createElement(PriceChart, { instrument: apple, quote: unbucketedTrade, onSelectPrice: vi.fn(), active: true }));
    await waitFor(() => expect(runtime.series[0].createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 101, title: "수신 체결 · REST 봉" })));
    expect(runtime.series[0].update).not.toHaveBeenCalled();

    const liveTrade = fixtureQuote(apple, { last: 101, midPrice: 999, status: "live", tradeReceivedAt: "2026-10-24T01:02:03Z", sourceTimestamp: "202610240930" });
    expect(isUsableLiveTrade(apple, liveTrade)).toBe(true);
    view.rerender(createElement(PriceChart, { instrument: apple, quote: liveTrade, onSelectPrice: vi.fn(), active: true }));
    await waitFor(() => expect(runtime.series[0].update).toHaveBeenCalledWith(expect.objectContaining({ close: 101 })));
    expect(await screen.findByText("고가 $101.00")).toBeInTheDocument();
  });

  it("does not merge a new-day or expired-minute trade into the final REST candle", () => {
    const dailyBar = { t: "20261024", o: 100, h: 102, l: 98, c: 101, v: 10 };
    const minuteBar = { t: "202610240930", o: 100, h: 102, l: 98, c: 101, v: 10 };
    const newDayTrade = fixtureQuote(apple, { status: "live", last: 110, tradeReceivedAt: "2026-10-24T01:02:03Z", sourceTimestamp: "202610251000" });
    const expiredMinuteTrade = fixtureQuote(apple, { status: "live", last: 110, tradeReceivedAt: "2026-10-24T01:02:03Z", sourceTimestamp: "202610240935" });

    expect(nextLiveCandleState(null, dailyBar, "D", apple, newDayTrade)).toBeNull();
    expect(nextLiveCandleState(null, minuteBar, "5", apple, expiredMinuteTrade)).toBeNull();
  });

  it("keeps accumulated live extremes and ignores out-of-order source trades", () => {
    const bar = { t: "202610240930", o: 100, h: 102, l: 98, c: 101, v: 10 };
    const trade = (last: number, sourceTimestamp: string) => fixtureQuote(apple, { status: "live", last, tradeReceivedAt: "2026-10-24T01:02:03Z", sourceTimestamp });
    const first = nextLiveCandleState(null, bar, "5", apple, trade(110, "202610240930"));
    const lower = nextLiveCandleState(first, bar, "5", apple, trade(95, "202610240931"));
    const latest = nextLiveCandleState(lower, bar, "5", apple, trade(105, "202610240932"));
    const outOfOrder = nextLiveCandleState(latest, bar, "5", apple, trade(99, "202610240931"));

    expect(latest?.bar).toMatchObject({ h: 110, l: 95, c: 105 });
    expect(outOfOrder).toBe(latest);
  });

  it("retains a distinct updated price in the same provider second while treating an identical repeat as a duplicate", () => {
    const bar = { t: "202610240930", o: 100, h: 101, l: 99, c: 100, v: 10 };
    const trade = (last: number) => fixtureQuote(apple, { status: "live", last, tradeReceivedAt: "2026-10-24T01:02:03Z", sourceTimestamp: "20261024093000" });
    const first = nextLiveCandleState(null, bar, "5", apple, trade(101));
    const distinctSameSecond = nextLiveCandleState(first, bar, "5", apple, trade(102));
    const duplicate = nextLiveCandleState(distinctSameSecond, bar, "5", apple, trade(102));

    expect(distinctSameSecond?.bar).toMatchObject({ h: 102, l: 99, c: 102 });
    expect(duplicate).toBe(distinctSameSecond);
  });

  it("labels a receipt-observed range separately only when it anchors the current REST minute", () => {
    const bar = { t: "202610240930", o: 100, h: 102, l: 99, c: 101, v: 10 };
    const quote = fixtureQuote(apple, {
      status: "live", last: 101, priceLive: true, priceReceivedAt: "2026-10-24T13:30:20Z",
      observedMinute: { basis: "receipt-time observations", bucketStart: "2026-10-24T13:30:00Z", open: 100, high: 103, low: 98, close: 101, count: 3, firstSequence: 1, lastSequence: 3, complete: false },
    });
    expect(observedMinuteForCurrentRestBar(bar, "1", apple, quote)).toMatchObject({ high: 103, low: 98, complete: false });
    expect(observedMinuteForCurrentRestBar(bar, "5", apple, quote)).toBeNull();
    expect(observedMinuteForCurrentRestBar(bar, "1", apple, fixtureQuote(apple, { ...quote, priceReceivedAt: "2026-10-24T13:31:20Z" }))).toBeNull();
  });

  it("opens long history at recent bars without discarding older data", async () => {
    const payload = chart(samsung, "long history");
    payload.bars = Array.from({ length: 1000 }, (_, i) => ({ t: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10).replaceAll("-", ""), o: 1, h: 3, l: 1, c: 2, v: 10 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload)));
    render(createElement(PriceChart, { instrument: samsung, quote: null, onSelectPrice: vi.fn() }));
    await screen.findByText(/long history/);
    await waitFor(() => expect(lightweightCharts.charts.at(-1)?.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 840, to: 1003 }));
    expect(lightweightCharts.charts.at(-1)?.series[0].setData.mock.calls[0][0]).toHaveLength(1000);
    fireEvent.change(screen.getByRole("combobox", { name: "표시 봉 수" }), { target: { value: "50" } });
    expect(lightweightCharts.charts.at(-1)?.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 950, to: 1003 });
  });
  it("does not retain an old chart after a symbol switch and converts daily bars for the series", async () => {
    const kr = deferred<Response>();
    const us = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => (url.includes("005930") ? kr.promise : us.promise)));
    const onSelectPrice = vi.fn();
    const view = render(createElement(PriceChart, { instrument: samsung, quote: null, onSelectPrice }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    view.rerender(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    us.resolve(json(chart(apple, "US 최신 차트")));
    await waitFor(() => expect(screen.getByText(/US 최신 차트/)).toBeInTheDocument());
    expect(screen.getByText(/20261001–20261020 \(fixture\)/)).toBeInTheDocument();
    expect(screen.getByText(/DATA TEST · fixture/)).toBeInTheDocument();
    expect(lightweightCharts.charts.at(-1)?.series[0].setData).toHaveBeenCalledWith([
      expect.objectContaining({ time: { year: 2026, month: 10, day: 23 }, open: 1, high: 3, low: 1, close: 2 }),
      expect.objectContaining({ time: { year: 2026, month: 10, day: 24 }, open: 2, high: 4, low: 2, close: 3 }),
    ]);

    kr.resolve(json(chart(samsung, "KR 이전 차트")));
    await waitFor(() => expect(screen.queryByText(/KR 이전 차트/)).not.toBeInTheDocument());
    expect(screen.getByText(/AAPL/)).toBeInTheDocument();
  });

  it("cancels superseded interval data and keeps the newest interval response", async () => {
    const daily = deferred<Response>();
    const threeMinute = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => (url.includes("interval=3") ? threeMinute.promise : daily.promise)));
    render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn() }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "3분" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    threeMinute.resolve(json({ ...chart(apple, "3분 최신 차트"), interval: "3" }));
    await screen.findByText(/3분 최신 차트/);

    daily.resolve(json(chart(apple, "일봉 이전 차트")));
    await waitFor(() => expect(screen.queryByText(/일봉 이전 차트/)).not.toBeInTheDocument());
  });

  it("clears the former series and exposes a current-symbol request error", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(chart(samsung, "삼성 차트")))
      .mockResolvedValueOnce(json({ detail: "AAPL 차트 일시 오류" }, 503)));
    const view = render(createElement(PriceChart, { instrument: samsung, quote: null, onSelectPrice: vi.fn() }));
    await screen.findByText(/삼성 차트/);

    view.rerender(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn() }));
    expect(screen.queryByText(/삼성 차트/)).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("AAPL 차트 일시 오류");
    await waitFor(() => expect(screen.queryByTestId("lightweight-chart")).not.toBeInTheDocument());
  });

  it("keeps its viewport when callbacks or reference lines change", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(chart(apple, "AAPL 차트"))));
    const firstCallback = vi.fn();
    const view = render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: firstCallback }));
    await screen.findByText(/AAPL 차트/);
    await waitFor(() => expect(lightweightCharts.createChart).toHaveBeenCalledTimes(1));
    const runtime = lightweightCharts.charts[0];

    const replacementCallback = vi.fn();
    view.rerender(createElement(PriceChart, { instrument: apple, quote: fixtureQuote(apple, { last: 124.56 }), onSelectPrice: replacementCallback }));
    await waitFor(() => expect(lightweightCharts.createChart).toHaveBeenCalledTimes(1));
    act(() => runtime.click?.({ point: { x: 20, y: 40 }, paneIndex: 0 }));

    await waitFor(() => expect(replacementCallback).toHaveBeenCalledWith(123.45));
    expect(lightweightCharts.createChart).toHaveBeenCalledTimes(1);
    expect(runtime.series[0].createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 123.45 }));
    expect(runtime.timeScale.fitContent).toHaveBeenCalledTimes(1);
  });

  it("adds working Bollinger and MACD series and reports panel-local preferences", async () => {
    const payload = chart(apple, "indicator chart");
    payload.bars = Array.from({ length: 40 }, (_, index) => ({ t: `202601${String(index + 1).padStart(2, "0")}`, o: index + 1, h: index + 2, l: index, c: index + 1, v: 10 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload)));
    const onPreferencesChange = vi.fn();
    render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), onPreferencesChange }));
    await screen.findByText(/indicator chart/);
    expect(lightweightCharts.charts.at(-1)?.series).toHaveLength(11); // price, separate volume, price MA5/20/60/120/240, volume MA5/20/60/120

    fireEvent.click(screen.getByRole("button", { name: "BB(20,2)" }));
    await waitFor(() => expect(lightweightCharts.charts.at(-1)?.series).toHaveLength(14));
    expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ showBollingerBands: true }));

    fireEvent.click(screen.getByRole("button", { name: "RSI14" }));
    await waitFor(() => expect(screen.getByLabelText("거래량 범례")).toHaveStyle({ top: "105px" }));

    fireEvent.click(screen.getByRole("button", { name: "MACD(12,26,9)" }));
    await waitFor(() => expect(lightweightCharts.charts.at(-1)?.series).toHaveLength(18));
    expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ showBollingerBands: true, showMacd: true }));
  });

  it("keeps the five extended indicators in a collapsed latest-value summary and persists bounded periods", async () => {
    const payload = chart(apple, "extended indicators");
    payload.bars = Array.from({ length: 40 }, (_, index) => {
      const close = index + 10;
      return { t: `202601${String(index + 1).padStart(2, "0")}`, o: close, h: close + 2, l: close - 1, c: close, v: 10 };
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload)));
    const onPreferencesChange = vi.fn();
    render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true, onPreferencesChange }));
    await screen.findByText(/extended indicators/);
    expect(lightweightCharts.charts.at(-1)?.series).toHaveLength(11);

    const toggle = screen.getByText("확장 지표 · 최신값");
    const details = toggle.closest("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(toggle);
    expect(screen.getByTestId("extended-indicator-summary")).toHaveTextContent("ATR");
    expect(screen.getByTestId("extended-indicator-summary")).toHaveTextContent("$3.00");
    expect(screen.getByTestId("extended-indicator-summary")).toHaveTextContent("OBV");

    fireEvent.change(screen.getByRole("spinbutton", { name: "ATR 기간" }), { target: { value: "1" } });
    await waitFor(() => expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({
      extendedIndicatorPeriods: expect.objectContaining({ atr: 2, adx: 14, stochastic: 14, stochasticSignal: 3, cci: 20 }),
    })));
    expect(lightweightCharts.createChart).toHaveBeenCalledTimes(1);
  });

  it("notifies once after a controlled panel-preferences round trip", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(chart(apple, "controlled preferences"))));
    const onPreferencesChange = vi.fn();
    function ControlledChart() {
      const [preferences, setPreferences] = useState<Partial<PriceChartPreferences>>({ interval: "D" });
      return createElement(PriceChart, {
        instrument: apple,
        quote: null,
        onSelectPrice: vi.fn(),
        preferences,
        onPreferencesChange: (next) => {
          onPreferencesChange(next);
          setPreferences(next);
        },
      });
    }

    render(createElement(ControlledChart));
    await screen.findByText(/controlled preferences/);
    fireEvent.click(screen.getByRole("button", { name: "BB(20,2)" }));
    await waitFor(() => expect(onPreferencesChange).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(onPreferencesChange).toHaveBeenCalledTimes(1);
    expect(onPreferencesChange).toHaveBeenCalledWith(expect.objectContaining({ showBollingerBands: true }));
  });

  it("applies a ratio-only parent preference update without reporting a user preference change", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(chart(apple, "external volume ratio"))));
    const onPreferencesChange = vi.fn();
    const view = render(createElement(PriceChart, {
      instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true,
      preferences: { interval: "D", volumeRatio: 0.26 }, onPreferencesChange,
    }));
    await screen.findByText(/external volume ratio/);
    expect(screen.getByRole("slider", { name: "거래량 영역 비율" })).toHaveValue("26");
    expect(onPreferencesChange).not.toHaveBeenCalled();

    view.rerender(createElement(PriceChart, {
      instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true,
      preferences: { interval: "D", volumeRatio: 0.36 }, onPreferencesChange,
    }));

    await waitFor(() => expect(screen.getByRole("slider", { name: "거래량 영역 비율" })).toHaveValue("36"));
    expect(lightweightCharts.createChart).toHaveBeenCalledTimes(2);
    expect(lightweightCharts.charts.at(-1)?.panes[1].setStretchFactor).toHaveBeenLastCalledWith(expect.closeTo(0.36 / 0.64));
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it("accepts a persisted extended-period-only parent update without emitting a user change", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(chart(apple, "external extended periods"))));
    const onPreferencesChange = vi.fn();
    const view = render(createElement(PriceChart, {
      instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true,
      preferences: { extendedIndicatorPeriods: { atr: 14 } }, onPreferencesChange,
    }));
    await screen.findByText(/external extended periods/);
    fireEvent.click(screen.getByText("확장 지표 · 최신값"));
    expect(screen.getByRole("spinbutton", { name: "ATR 기간" })).toHaveValue(14);
    expect(onPreferencesChange).not.toHaveBeenCalled();

    view.rerender(createElement(PriceChart, {
      instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true,
      preferences: { extendedIndicatorPeriods: { atr: 7 } }, onPreferencesChange,
    }));
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "ATR 기간" })).toHaveValue(7));
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it("keeps direct supported period, indicator, and viewport controls visible in compact panels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(chart(apple, "compact chart")));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), compact: true, active: true }));
    await screen.findByTestId("lightweight-chart");
    expect(screen.getByTitle("compact chart")).toBeInTheDocument();

    expect(screen.queryByRole("combobox", { name: "차트 주기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1분" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "일" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MACD(12,26,9)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "표시 봉 수" })).toHaveValue("160");
    const dateInput = screen.getByLabelText("수신봉 내 날짜 이동");
    expect(dateInput).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^이동$/ })).toBeDisabled();
    fireEvent.input(dateInput, { target: { value: "2026-10-23" } });
    expect(screen.getByRole("button", { name: /^이동$/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^이동$/ }));
    expect(lightweightCharts.charts.at(-1)?.timeScale.setVisibleLogicalRange).toHaveBeenCalled();
    fireEvent.input(dateInput, { target: { value: "2020-01-01" } });
    expect(screen.getByRole("button", { name: /^이동$/ })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "거래량 영역 비율" })).toHaveValue("26");

    const provenanceToggle = screen.getByText("출처");
    const provenanceDetails = provenanceToggle.closest("details");
    expect(provenanceDetails).not.toBeNull();
    expect(provenanceDetails).not.toHaveAttribute("open");
    fireEvent.click(provenanceToggle);
    expect(provenanceDetails).toHaveAttribute("open");
    expect(provenanceDetails).toHaveTextContent("원본 2026-10-24T01:02:02Z");
    expect(provenanceDetails).toHaveTextContent("수신 2026-10-24T01:02:03Z");

    fireEvent.click(screen.getByRole("button", { name: "3분" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "3분" })).toHaveAttribute("aria-pressed", "true");
  });

  it("adds a local horizontal drawing through the chart tool and makes it selectable and removable", async () => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(chart(apple, "drawing chart"))));
    render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true }));
    await screen.findByTestId("lightweight-chart");
    fireEvent.click(screen.getByText("작도 · 지표 템플릿"));
    fireEvent.click(screen.getByRole("button", { name: "수평" }));
    fireEvent.pointerDown(screen.getByLabelText("차트 작도 영역"), { clientX: 20, clientY: 40 });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "수평" })).toHaveLength(2));
    expect(localStorage.getItem("kiwoom-hts-chart-tools-v1")).toContain("horizontal");

    fireEvent.click(screen.getAllByRole("button", { name: "수평" }).at(-1)!);
    expect(screen.getByRole("button", { name: "삭제" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "수평" })).toHaveLength(1));
  });

  it("applies documented keys only while the focused plot uses Lightweight Charts public range APIs", async () => {
    const payload = chart(apple, "keyboard chart");
    payload.bars = Array.from({ length: 100 }, (_, index) => ({ t: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10).replaceAll("-", ""), o: 1, h: 3, l: 1, c: 2, v: 10 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload)));
    const bubbled = vi.fn();
    const onPreferencesChange = vi.fn();
    render(createElement("div", { onKeyDown: bubbled }, createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true, onPreferencesChange })));
    await screen.findByText(/keyboard chart/);
    const host = screen.getByTestId("lightweight-chart");
    const runtime = lightweightCharts.charts[0];
    expect(host).toHaveAttribute("tabindex", "0");

    runtime.timeScale.setVisibleLogicalRange.mockClear();

    fireEvent.keyDown(host, { key: "ArrowUp" });
    expect(runtime.timeScale.setVisibleLogicalRange).not.toHaveBeenCalled();
    bubbled.mockClear();

    fireEvent.pointerDown(host);
    expect(document.activeElement).toBe(host);
    const zoom = createEvent.keyDown(host, { key: "ArrowUp" });
    fireEvent(host, zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(runtime.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 1, to: 9 });

    fireEvent.keyDown(host, { key: "ArrowRight", ctrlKey: true });
    expect(runtime.timeScale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 1, to: 11 });
    expect(bubbled).toHaveBeenCalledTimes(1); // zoom bubbles; Ctrl+arrow is chart-local.

    const unsupported = createEvent.keyDown(host, { key: "1", ctrlKey: true });
    fireEvent(host, unsupported);
    expect(unsupported.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(2);

    const fitCallsBeforeShortcut = runtime.timeScale.fitContent.mock.calls.length;
    fireEvent.keyDown(host, { key: "*" });
    expect(runtime.timeScale.fitContent).toHaveBeenCalledTimes(fitCallsBeforeShortcut + 1);
    fireEvent.keyDown(host, { key: "!", code: "Digit1", shiftKey: true });
    await waitFor(() => expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ interval: "60" })));
  });

  it("does not fetch a hidden chart until activated, and ignores hidden identity changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(chart(apple, "activated")));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: false }));
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: false, refreshKey: 1 }));
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true, refreshKey: 1 }));
    await screen.findByText(/activated/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the same-feed viewport on explicit refresh", async () => {
    const payload = chart(apple, "refreshable");
    payload.bars = Array.from({ length: 200 }, (_, index) => ({ t: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10).replaceAll("-", ""), o: 1, h: 3, l: 1, c: 2, v: 10 }));
    const refreshed = { ...payload, bars: payload.bars.map((bar, index) => index === payload.bars.length - 1 ? { ...bar, c: 2.5 } : bar) };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(payload)).mockResolvedValueOnce(json(refreshed));
    vi.stubGlobal("fetch", fetchMock);
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const view = render(createElement(PriceChart, { instrument: apple, quote: null, onSelectPrice: vi.fn(), active: true }));
    await screen.findByText(/refreshable/);
    await waitFor(() => expect(lightweightCharts.createChart).toHaveBeenCalledTimes(1));
    const firstChart = lightweightCharts.charts[0]!;
    expect(setIntervalSpy.mock.calls.some(([, interval]) => interval === 30_000)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(firstChart.series[0].setData).toHaveBeenCalledTimes(2));
    expect(lightweightCharts.createChart).toHaveBeenCalledTimes(1);
    expect(firstChart.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 40, to: 203 });

    view.unmount();
    setIntervalSpy.mockRestore();
  });
});
