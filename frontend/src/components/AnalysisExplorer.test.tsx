import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisExplorer } from "@/components/AnalysisExplorer";
import { samsung } from "@/test/fixtures";

function featuresResponse() {
  return new Response(JSON.stringify({
    features: [
      { id: "income", title: "수익성", market: "KR", description: "수익성 지표", parameters: [{ key: "period", label: "기간", type: "select", default: "annual", options: [{ value: "annual", label: "연간" }] }] },
      { id: "balance", title: "안정성", market: "KR", description: "안정성 지표", parameters: [{ key: "period", label: "기간", type: "select", default: "annual", options: [{ value: "annual", label: "연간" }] }] },
      { id: "us-only", title: "미국 전용", market: "US", description: "미국 지표", parameters: [] },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function resultResponse(featureId = "income", name = "삼성전자", note = "fixture response", scope: Record<string, unknown> = { universe: "KOSPI" }) {
  return new Response(JSON.stringify({
    featureId,
    title: featureId === "income" ? "수익성" : "안정성",
    market: "KR",
    source: "fixture",
    status: "fixture",
    receivedAt: "2026-10-25T01:02:03Z",
    asOf: "2026-10-24T15:30:00Z",
    note,
    complete: false,
    columns: [{ key: "name", label: "종목", numeric: false }, { key: "changePct", label: "등락률", numeric: true, unit: "%" }],
    rows: [{ id: featureId, name, changePct: 0, instrument: samsung }],
    scope,
    parameters: { period: "annual" },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("AnalysisExplorer", () => {
  it("does not fetch its catalog or a result while hidden", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<AnalysisExplorer instrument={samsung} active={false} />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("비활성 패널입니다. 조회를 중지했습니다.")).toBeInTheDocument();
  });

  it("aborts a stale feature result, persists an explicit selection, and displays only the latest response", async () => {
    const first = deferred<Response>();
    let firstSignal: AbortSignal | undefined;
    const onFeatureChange = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(featuresResponse())
      .mockImplementationOnce((_url: string, init: RequestInit) => { firstSignal = init.signal as AbortSignal; return first.promise; })
      .mockResolvedValueOnce(resultResponse("balance", "새 분석"));
    vi.stubGlobal("fetch", fetch);
    render(<AnalysisExplorer instrument={samsung} active onFeatureChange={onFeatureChange} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("분석 기능"), { target: { value: "balance" } });
    expect(onFeatureChange).toHaveBeenCalledWith("balance");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(firstSignal?.aborted).toBe(true);
    expect(await screen.findByText("새 분석")).toBeInTheDocument();
    await act(async () => first.resolve(resultResponse("income", "이전 분석")));
    expect(screen.queryByText("이전 분석")).not.toBeInTheDocument();
  });

  it("uses validated row identities for keyboard selection", async () => {
    const onPick = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(featuresResponse()).mockResolvedValueOnce(resultResponse()));
    render(<AnalysisExplorer instrument={samsung} active onPick={onPick} />);
    const grid = await screen.findByRole("grid", { name: "수익성" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ stkCd: "005930", stkNm: "삼성전자" }));
    expect(screen.getByText(/일부 수신/)).toBeInTheDocument();
    expect(screen.getByText(/조회 조건: period=annual/)).toBeInTheDocument();
  });

  it("does not treat Enter on a column-sort button as a row selection", async () => {
    const onPick = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(featuresResponse()).mockResolvedValueOnce(resultResponse()));
    render(<AnalysisExplorer instrument={samsung} active onPick={onPick} />);
    await screen.findByRole("grid", { name: "수익성" });

    fireEvent.keyDown(screen.getByRole("button", { name: "종목" }), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps provenance visible while putting verbose request scope behind details", async () => {
    const scope = {
      requestedInstrument: {
        market: "KR",
        stkCd: "005930",
        stexTp: "KRX",
        listingVenue: "KOSPI",
        quoteVenue: "KRX",
        currency: "KRW",
        environment: "fixture",
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(featuresResponse()).mockResolvedValueOnce(resultResponse("income", "삼성전자", "pagination capped at 5 pages", scope)));
    render(<AnalysisExplorer instrument={samsung} active />);

    expect(await screen.findByTitle("최대 5페이지까지 조회한 일부 결과")).toHaveTextContent("최대 5페이지까지 조회한 일부 결과");
    expect(screen.getByText("출처: fixture")).toBeInTheDocument();
    expect(screen.getByText(/수신:/)).toBeInTheDocument();
    expect(screen.getByText(/상태: 고정 자료 · 일부 수신/)).toBeInTheDocument();
    expect(screen.getByText("단위: %")).toBeInTheDocument();

    const details = screen.getByText("조회 기준·상세").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("조회 기준·상세"));
    expect(details).toHaveAttribute("open");
    expect(details).toHaveTextContent("requestedInstrument={market:KR, stkCd:005930");
  });

  it("preserves an unrecognized provider note", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(featuresResponse()).mockResolvedValueOnce(resultResponse("income", "삼성전자", "Provider pagination incomplete: continuation key missing.")));
    render(<AnalysisExplorer instrument={samsung} active />);

    expect(await screen.findByTitle("Provider pagination incomplete: continuation key missing.")).toHaveTextContent("Provider pagination incomplete: continuation key missing.");
  });
});
