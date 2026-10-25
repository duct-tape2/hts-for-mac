import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestorCaptureView, MarketCaptureView, NewsCaptureView, SectorCaptureView } from "@/components/capture/CaptureViews";
import type { CapturePayload } from "@/lib/capture";

afterEach(cleanup);

function payload(overrides: Partial<CapturePayload> = {}): CapturePayload {
  return {
    screen: "0200", title: "시장종합", source: "fixture", status: "fixture", environment: "fixture", receivedAt: "2026-10-24T01:02:03Z", asOf: null, note: "", complete: true,
    columns: [{ key: "name", label: "지수명" }, { key: "index", label: "지수", numeric: true }],
    rows: [{ id: "KOSPI", name: "KOSPI", index: 2700 }], sections: [], bars: [], news: [],
    ...overrides,
  };
}

describe("capture specialized views", () => {
  it("keeps 0200 domestic root rows when external sections are also present", () => {
    const data = payload({ sections: [{ id: "global", title: "해외 지수", source: "external", status: "snapshot", asOf: null, note: "", columns: [{ key: "name", label: "지수" }], rows: [{ id: "spx", name: "S&P 500" }] }] });
    render(<MarketCaptureView payload={data} onPick={vi.fn()} />);
    expect(screen.getAllByText("KOSPI").length).toBeGreaterThan(0);
    expect(screen.getByText("S&P 500")).toBeInTheDocument();
  });

  it("keeps 0200 investor rows by investor and marks unprovided breadth and derivatives as unavailable", () => {
    const data = payload({
      rows: [{ id: "KOSPI", name: "KOSPI", index: 2700 }],
      sections: [{
        id: "investors", title: "투자자 매매동향", source: "official flow", status: "snapshot", asOf: "2026-10-24", note: "one base date only",
        columns: [{ key: "market", label: "시장" }, { key: "individual", label: "개인", numeric: true, unit: "KRW 100m" }, { key: "foreign", label: "외국인", numeric: true, unit: "KRW 100m" }, { key: "institutional", label: "기관계", numeric: true, unit: "KRW 100m" }],
        rows: [
          { id: "KOSPI:flow", market: "KOSPI", individual: 20, foreign: -10, institutional: 5 },
          { id: "KOSDAQ:flow", market: "KOSDAQ", individual: -2, foreign: 1, institutional: 1 },
        ],
      }],
    });
    render(<MarketCaptureView payload={data} onPick={vi.fn()} />);
    const investorTable = screen.getByRole("table", { name: "시장별 투자자 순매수" });
    expect(within(investorTable).getByRole("rowheader", { name: "개인" })).toBeInTheDocument();
    expect(within(investorTable).getByRole("columnheader", { name: "KOSPI" })).toBeInTheDocument();
    expect(screen.getByLabelText("시장 등락 종목수")).toHaveTextContent("미수신");
    expect(screen.getByText("현재 조회 데이터에 없음")).toBeInTheDocument();
    expect(screen.getByText(/출처: official flow · 수신/)).toBeInTheDocument();
  });

  it("colors breadth by its category rather than treating every count as an increase", () => {
    const data = payload({ rows: [{ id: "KOSPI", name: "KOSPI", index: 2700, rising: 3, falling: 2, flat: 1 }] });
    render(<MarketCaptureView payload={data} onPick={vi.fn()} />);
    const breadth = screen.getByLabelText("시장 등락 종목수");
    expect(within(breadth).getByText("상승 3")).toHaveClass("classic-up");
    expect(within(breadth).getByText("하락 2")).toHaveClass("classic-down");
    expect(within(breadth).getByText("보합 1")).not.toHaveClass("classic-up");
    expect(within(breadth).getByText("보합 1")).not.toHaveClass("classic-down");
  });

  it("uses the 0780 market-row and investor-column orientation with the cash-only limitation", () => {
    const data = payload({
      screen: "0780", title: "투자자별 매매동향",
      columns: [{ key: "market", label: "시장" }, { key: "individual", label: "개인", numeric: true, unit: "KRW 100m" }, { key: "foreign", label: "외국인", numeric: true, unit: "KRW 100m" }, { key: "institutional", label: "기관계", numeric: true, unit: "KRW 100m" }, { key: "securities", label: "금융투자", numeric: true, unit: "KRW 100m" }],
      rows: [
        { id: "KOSPI:flow", market: "KOSPI", individual: 20, foreign: -10, institutional: 5, securities: 2 },
        { id: "KOSDAQ:flow", market: "KOSDAQ", individual: -2, foreign: 1, institutional: 1, securities: 0 },
      ],
    });
    render(<InvestorCaptureView payload={data} />);
    const summaryTable = screen.getByRole("table", { name: "투자자별 시장 순매수" });
    expect(within(summaryTable).getByRole("rowheader", { name: "KOSPI" })).toBeInTheDocument();
    expect(within(summaryTable).getByRole("columnheader", { name: "개인" })).toBeInTheDocument();
    expect(within(summaryTable).getByText("+20")).toHaveClass("classic-up");
    expect(screen.getByText(/현물\(주식\) 시장의 기준일 순매수만 표시합니다/)).toBeInTheDocument();
    expect(screen.getByText(/세부 투자자 항목/).closest("details")).toHaveAttribute("open");
  });

  it("keeps domestic columns and merged global index, FX, and commodity quotes visible in 0200", () => {
    const quoteColumns = [
      { key: "name", label: "종목" }, { key: "last", label: "현재가", numeric: true, precision: 4 }, { key: "change", label: "등락", numeric: true, precision: 4 }, { key: "changePct", label: "등락률", numeric: true, unit: "%", precision: 2 }, { key: "currency", label: "통화" },
    ];
    const data = payload({
      columns: [{ key: "name", label: "지수명" }, { key: "index", label: "지수", numeric: true, unit: "index" }, { key: "change", label: "전일대비", numeric: true, unit: "index" }, { key: "changePct", label: "등락률", numeric: true, unit: "%" }, { key: "volume", label: "거래량", numeric: true, unit: "thousand shares" }, { key: "tradingValue", label: "거래대금", numeric: true, unit: "KRW millions" }],
      rows: [{ id: "KOSPI", name: "KOSPI", index: 5550.3, change: 16.53, changePct: 0.3, volume: 249517, tradingValue: 17374811 }],
      sections: [
        { id: "global-indices", title: "글로벌 주요 지수", source: "Yahoo", status: "delayed", asOf: "2026-10-24T00:00:00Z", note: "delayed", columns: quoteColumns, rows: [{ id: "spx", name: "S&P 500", last: 5762.5, change: -32, changePct: -0.42, currency: "USD" }] },
        { id: "global-fx", title: "환율", source: "Yahoo", status: "delayed", asOf: "2026-10-24T00:00:00Z", note: "delayed", columns: quoteColumns, rows: [{ id: "krw", name: "USD/KRW", last: 1388.25, change: 0.25, changePct: 0.02, currency: "KRW" }] },
        { id: "global-commodities", title: "원자재", source: "Yahoo", status: "delayed", asOf: "2026-10-24T00:00:00Z", note: "delayed", columns: quoteColumns, rows: [{ id: "wti", name: "WTI", last: 71.1234, change: 1.25, changePct: 1.79, currency: "USD" }] },
      ],
    });
    render(<MarketCaptureView payload={data} onPick={vi.fn()} />);
    const domestic = screen.getByRole("table", { name: "국내 지수" });
    expect(within(domestic).getByRole("columnheader", { name: "지수 (pt)" })).toBeInTheDocument();
    expect(within(domestic).getByRole("columnheader", { name: "전일대비 (pt)" })).toBeInTheDocument();
    expect(within(domestic).getByRole("columnheader", { name: "거래량 (천주)" })).toBeInTheDocument();
    expect(within(domestic).getByRole("columnheader", { name: "거래대금 (백만원)" })).toBeInTheDocument();
    const global = screen.getByRole("table", { name: "해외 지수 환율 상품" });
    expect(within(global).getByText("S&P 500")).toBeInTheDocument();
    expect(within(global).getByText("USD/KRW")).toBeInTheDocument();
    expect(within(global).getByText("WTI")).toBeInTheDocument();
    expect(within(global).getByText("1,388.2500")).toBeInTheDocument();
    expect(within(global).getByRole("columnheader", { name: "단위" })).toBeInTheDocument();
    expect(within(global).getByText("pt")).toBeInTheDocument();
    expect(within(global).getByText("KRW")).toBeInTheDocument();
    expect(screen.getAllByText(/출처: Yahoo · 기준: .*KST/)).toHaveLength(3);
  });

  it("defaults 0211 to its available daily data and exposes unavailable time data honestly", () => {
    const data = payload({
      screen: "0211", title: "업종시세", columns: [{ key: "index", label: "업종지수", numeric: true }, { key: "change", label: "전일대비", numeric: true }], rows: [{ id: "sector:001", sectorCode: "001", index: 2700, change: 10 }],
      sections: [{ id: "daily", title: "업종 일별", source: "fixture", status: "fixture", asOf: null, note: "", columns: [{ key: "date", label: "일자" }], rows: [{ id: "001:20261024", date: "20261024" }] }],
    });
    render(<SectorCaptureView payload={data} active onPick={vi.fn()} onSector={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "시간대별" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "일별" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("업종지수")).toBeInTheDocument();
  });

  it("formats valid 0211 times and exposes provider sentinels without inventing a clock value", () => {
    const data = payload({
      screen: "0211", title: "업종시세", columns: [{ key: "index", label: "업종지수", numeric: true }], rows: [{ id: "sector:001", sectorCode: "001", name: "종합(KOSPI)", index: 5550.3, change: 16.53, changePct: 0.3, open: 5403.17, high: 5550.3, low: 5305.98 }],
      sections: [{ id: "time", title: "시간대별", source: "fixture", status: "fixture", asOf: null, note: "", columns: [{ key: "time", label: "시간" }, { key: "index", label: "현재가", numeric: true }], rows: [
        { id: "valid", time: "153040", index: 5550.3 }, { id: "sentinel-a", time: "99:99:99", index: 5550.3 }, { id: "sentinel-b", time: "888888", index: 5550.3 },
      ] }],
    });
    render(<SectorCaptureView payload={data} active onPick={vi.fn()} onSector={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "001 · 종합(KOSPI)" })).toBeInTheDocument();
    expect(screen.getAllByText("5,550.30").length).toBeGreaterThan(0);
    expect(screen.getByText("▲ 16.53")).toHaveClass("classic-up");
    expect(screen.getByText("+0.30%")).toHaveClass("classic-up");
    expect(screen.getByText("5,403.17")).toBeInTheDocument();
    expect(screen.getByText("15:30:40")).toBeInTheDocument();
    expect(screen.getByText("미확인 (999999)")).toBeInTheDocument();
    expect(screen.getByText("미확인 (888888)")).toBeInTheDocument();
    expect(screen.queryByText("99:99:99")).not.toBeInTheDocument();
  });

  it("uses verified names for the primary 0211 sector codes instead of the generic provider name", () => {
    const view = render(<SectorCaptureView payload={payload({ screen: "0211", rows: [{ id: "sector:001", sectorCode: "001", name: "업종현재가" }] })} active onPick={vi.fn()} onSector={vi.fn()} />);
    for (const [code, name] of [["001", "종합(KOSPI)"], ["101", "종합(KOSDAQ)"], ["201", "KOSPI200"]]) {
      view.rerender(<SectorCaptureView payload={payload({ screen: "0211", rows: [{ id: `sector:${code}`, sectorCode: code, name: "업종현재가" }] })} active onPick={vi.fn()} onSector={vi.fn()} />);
      expect(screen.getByRole("heading", { name: `${code} · ${name}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "업종현재가" })).not.toBeInTheDocument();
  });

  it("retains a selected news item across a reception-time update when the item remains present", () => {
    const first = payload({ screen: "0700", title: "뉴스", news: [
      { id: "a", title: "첫 뉴스", provider: "source", publishedAt: "2026-10-24T01:00:00Z", url: "https://example.com/a", summary: "first" },
      { id: "b", title: "둘째 뉴스", provider: "source", publishedAt: "2026-10-24T02:00:00Z", url: "https://example.com/b", summary: "second" },
    ] });
    const view = render(<NewsCaptureView payload={first} provider="all" onProvider={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("listitem")[1]);
    expect(within(screen.getByRole("article")).getByText("second")).toBeInTheDocument();
    view.rerender(<NewsCaptureView payload={{ ...first, receivedAt: "2026-10-24T02:02:00Z" }} provider="all" onProvider={vi.fn()} />);
    expect(within(screen.getByRole("article")).getByText("second")).toBeInTheDocument();
  });

  it("moves news selection with arrow keys and resets it for provider or search changes", () => {
    const data = payload({ screen: "0700", title: "뉴스", news: [
      { id: "a", title: "첫 뉴스", provider: "source", publishedAt: "2026-10-24T01:00:00Z", url: "https://example.com/a", summary: "first" },
      { id: "b", title: "둘째 뉴스", provider: "source", publishedAt: "2026-10-24T02:00:00Z", url: "https://example.com/b", summary: "second" },
    ] });
    const view = render(<NewsCaptureView payload={data} provider="all" selectionScope="first" onProvider={vi.fn()} />);
    fireEvent.keyDown(screen.getAllByRole("listitem")[0], { key: "ArrowDown" });
    expect(within(screen.getByRole("article")).getByText("second")).toBeInTheDocument();
    view.rerender(<NewsCaptureView payload={data} provider="mk_stock" selectionScope="first" onProvider={vi.fn()} />);
    expect(within(screen.getByRole("article")).getByText("first")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("listitem")[1]);
    view.rerender(<NewsCaptureView payload={data} provider="mk_stock" selectionScope="second" onProvider={vi.fn()} />);
    expect(within(screen.getByRole("article")).getByText("first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "글자 크게" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps keyboard focus inside the originating news view and moves only one row", () => {
    const data = payload({ screen: "0700", title: "뉴스", news: [
      { id: "a", title: "첫 뉴스", provider: "source", publishedAt: "2026-10-24T01:00:00Z", url: "https://example.com/a", summary: "first" },
      { id: "b", title: "둘째 뉴스", provider: "source", publishedAt: "2026-10-24T02:00:00Z", url: "https://example.com/b", summary: "second" },
      { id: "c", title: "셋째 뉴스", provider: "source", publishedAt: "2026-10-24T03:00:00Z", url: "https://example.com/c", summary: "third" },
    ] });
    render(<><NewsCaptureView payload={data} provider="all" onProvider={vi.fn()} /><NewsCaptureView payload={data} provider="all" onProvider={vi.fn()} /></>);
    const lists = screen.getAllByRole("list", { name: "뉴스 목록" });
    const leftRows = within(lists[0]).getAllByRole("listitem");
    const rightRows = within(lists[1]).getAllByRole("listitem");
    fireEvent.keyDown(rightRows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rightRows[1]);
    expect(rightRows[1]).toHaveAttribute("aria-current", "true");
    expect(rightRows[2]).not.toHaveAttribute("aria-current", "true");
    expect(leftRows[0]).toHaveAttribute("aria-current", "true");
  });

  it("shows unknown article dates as 미상 and keeps long source notes collapsed", () => {
    const data = payload({ screen: "0700", title: "뉴스", note: "x".repeat(151), news: [
      { id: "unknown-date", title: "시각 미상 뉴스", provider: "source", publishedAt: "", url: "https://example.com/a", summary: "summary" },
    ] });
    render(<NewsCaptureView payload={data} provider="all" onProvider={vi.fn()} />);
    expect(screen.getAllByText("미상")).toHaveLength(2);
    expect(screen.getByRole("article")).toHaveTextContent("발행 시각 미상");
    expect(screen.getByText("범위·주의 보기")).toBeInTheDocument();
  });

  it("keeps the RSS source and limitation once when the provider already supplies the same limit", () => {
    const data = payload({ screen: "0700", title: "뉴스", source: "발행사 RSS", status: "snapshot", asOf: "2026-10-24T00:00:00Z", note: "발행사 RSS의 제목과 요약만 제공하며 기사 본문은 가져오지 않습니다.", news: [] });
    render(<NewsCaptureView payload={data} provider="all" onProvider={vi.fn()} />);
    expect(screen.getByText(/출처: 발행사 RSS · 수신 · 기준: .*KST/)).toBeInTheDocument();
    expect(screen.getAllByText(/발행사 RSS의 제목과 요약만 제공하며 기사 본문은 가져오지 않습니다/)).toHaveLength(1);
  });
});
