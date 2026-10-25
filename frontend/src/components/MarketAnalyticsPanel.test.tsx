import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestorFlowPanel, RankingsPanel } from "@/components/MarketAnalyticsPanel";
import { apple, samsung } from "@/test/fixtures";

const ecopro = {
  ...samsung,
  stkCd: "247540",
  stkNm: "에코프로비엠",
  listingVenue: "KOSDAQ" as const,
};

function response(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response);
}

function rankingPayload() {
  return {
    kind: "volume",
    market: "all",
    items: [{
      rank: 1,
      instrument: ecopro,
      price: 128000,
      change: -1000,
      changePct: -0.78,
      volume: 410000,
      volumeUnit: "shares",
      tradingValue: 52480,
      tradingValueUnit: "KRW millions",
      metric: 410000,
      metricUnit: "shares",
    }],
    source: "fixture",
    asOf: "2026-10-24T00:00:00Z",
    complete: true,
    incomplete: false,
    note: "Deterministic fixture/test data; not broker ranking data.",
  };
}

function investorPayload(instrument = samsung, date = "20261024") {
  return {
    instrument,
    date,
    valueKind: "net_buy_quantity",
    unit: "shares",
    rows: [{
      date,
      individual: -1200,
      foreign: 700,
      institutional: 500,
      financialInvestment: 210,
      insurance: null,
      investmentTrust: null,
      otherFinancial: null,
      bank: null,
      pensionEtc: 90,
      privateFund: null,
      nation: null,
      otherCorporation: null,
      domesticForeign: null,
    }],
    source: "fixture",
    asOf: "2026-10-24T00:00:00Z",
    complete: true,
    incomplete: false,
    note: "Date-based net-buy quantity; not real-time investor flow.",
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MarketAnalyticsPanel", () => {
  it("maps normalized ranking fields, explicit units, and selects the full validated instrument", async () => {
    const fetch = vi.fn().mockImplementation(() => response(rankingPayload()));
    const onSelect = vi.fn();
    vi.stubGlobal("fetch", fetch);

    render(<RankingsPanel instrument={samsung} onSelect={onSelect} />);
    fireEvent.change(screen.getByLabelText("순위 기준"), { target: { value: "volume" } });

    expect(await screen.findByRole("button", { name: "에코프로비엠" })).toBeInTheDocument();
    expect(screen.getByText("410.0K")).toBeInTheDocument();
    expect(screen.getByText(/test data/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "에코프로비엠" }));
    expect(onSelect).toHaveBeenCalledWith(ecopro);
    expect(fetch).toHaveBeenLastCalledWith("/api/market/rankings?kind=volume&market=all", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("aborts and isolates a former investor request when the selected identity changes", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const fetch = vi.fn()
      .mockImplementationOnce((_path: string, init: RequestInit) => {
        firstSignal = init.signal as AbortSignal;
        return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      })
      .mockImplementationOnce(() => response(investorPayload(ecopro, "20261025")));
    vi.stubGlobal("fetch", fetch);

    const view = render(<InvestorFlowPanel instrument={samsung} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<InvestorFlowPanel instrument={ecopro} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);

    expect(await screen.findByText("2026.10.25")).toBeInTheDocument();
    await act(async () => resolveFirst?.({ ok: true, json: async () => investorPayload(samsung, "20261024") } as Response));
    expect(screen.queryByText("2026.10.24")).not.toBeInTheDocument();
    expect(fetch.mock.calls[1][0]).toContain("stk_cd=247540");
    expect(fetch.mock.calls[1][0]).toContain("listing_venue=KOSDAQ");
  });

  it("does not request a dummy US analytics panel", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    render(<RankingsPanel instrument={apple} />);

    expect(screen.getByText("미국 순위·투자자 동향은 현재 이 조회 전용 연결에서 지원하지 않습니다.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed ranking row instead of presenting a falsely complete subset", async () => {
    const malformed = rankingPayload();
    malformed.items.push({ ...malformed.items[0], rank: Number.NaN });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => response(malformed)));

    render(<RankingsPanel instrument={samsung} />);
    fireEvent.change(screen.getByLabelText("순위 기준"), { target: { value: "volume" } });

    expect(await screen.findByText("시장 데이터 형식을 확인할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "에코프로비엠" })).not.toBeInTheDocument();
  });

  it("rejects fixture data when the source cannot belong to the selected environment", async () => {
    const mismatched = investorPayload();
    mismatched.source = "kiwoom";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => response(mismatched)));

    render(<InvestorFlowPanel instrument={samsung} />);

    expect(await screen.findByText("투자자 동향 데이터 형식을 확인할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("2026.10.24")).not.toBeInTheDocument();
  });

  it("applies the same source/environment rule to rankings", async () => {
    const mismatched = rankingPayload();
    mismatched.kind = "gainers";
    mismatched.source = "kiwoom";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => response(mismatched)));

    render(<RankingsPanel instrument={samsung} />);

    expect(await screen.findByText("시장 데이터 형식을 확인할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "에코프로비엠" })).not.toBeInTheDocument();
  });

  it("retries only the known identity-loading conflict before showing investor rows", async () => {
    vi.useFakeTimers();
    const loading = { ok: false, status: 409, json: async () => ({ detail: "symbol index is loading" }) } as Response;
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(loading))
      .mockImplementationOnce(() => response(investorPayload()));
    vi.stubGlobal("fetch", fetch);

    render(<InvestorFlowPanel instrument={samsung} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("종목 상장시장을 확인 중입니다. 검증 후 투자자 동향을 불러옵니다.")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(screen.getByText("2026.10.24")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds 205 retained ranking rows to 100 per local page without another request", async () => {
    const payload = rankingPayload();
    payload.items = Array.from({ length: 205 }, (_, index) => ({
      ...payload.items[0],
      rank: index + 1,
      instrument: { ...ecopro, stkCd: String(100000 + index), stkNm: `순위 ${index + 1}` },
    }));
    const fetch = vi.fn().mockImplementation(() => response(payload));
    vi.stubGlobal("fetch", fetch);

    const view = render(<RankingsPanel instrument={samsung} />);
    fireEvent.change(screen.getByLabelText("순위 기준"), { target: { value: "volume" } });

    expect(await screen.findByRole("button", { name: "순위 1" })).toBeInTheDocument();
    expect(screen.getByText("1–100 / 205개")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(101);
    const requestCount = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "순위 다음 페이지" }));
    expect(screen.getByText("101–200 / 205개")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "순위 101" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(101);
    expect(fetch).toHaveBeenCalledTimes(requestCount);
    view.rerender(<RankingsPanel instrument={ecopro} />);
    expect(screen.getByText("1–100 / 205개")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(requestCount);
  });

  it("bounds 205 retained investor rows to 100 per local page without another request", async () => {
    const payload = investorPayload();
    payload.rows = Array.from({ length: 205 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10).replaceAll("-", "");
      return { ...payload.rows[0], date, individual: index + 1 };
    });
    const fetch = vi.fn().mockImplementation(() => response(payload));
    vi.stubGlobal("fetch", fetch);

    render(<InvestorFlowPanel instrument={samsung} />);

    expect(await screen.findByText("1–100 / 205개")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(101);
    const requestCount = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "투자자 동향 다음 페이지" }));
    expect(screen.getByText("101–200 / 205개")).toBeInTheDocument();
    expect(screen.getByText("+101")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(101);
    expect(fetch).toHaveBeenCalledTimes(requestCount);
  });
});
