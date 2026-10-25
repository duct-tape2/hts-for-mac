import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureGrid } from "@/components/capture/CaptureGrid";
import type { CaptureRow } from "@/lib/capture";
import { screenPresentation } from "@/lib/screenPresentation";
import { samsung } from "@/test/fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const columns = [
  { key: "name", label: "종목명" },
  { key: "price", label: "현재가", unit: "KRW", numeric: true },
  { key: "volume", label: "거래량", unit: "shares", numeric: true },
];

describe("CaptureGrid", () => {
  it("uses distinct ARIA row ids for independent grids and supports keyboard sector activation", () => {
    const onPick = vi.fn();
    const onSector = vi.fn();
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    render(<>
      <CaptureGrid label="종목 그리드" columns={columns} rows={[{ id: "shared", name: "삼성전자", price: 70000, volume: 2, instrument: samsung }]} onPick={onPick} />
      <CaptureGrid label="업종 그리드" columns={columns} rows={[{ id: "shared", name: "반도체", price: 10, volume: 1, sectorCode: "001" }]} onSector={onSector} />
    </>);

    const [stockGrid, sectorGrid] = screen.getAllByRole("grid");
    fireEvent.keyDown(stockGrid, { key: "ArrowDown" });
    fireEvent.keyDown(sectorGrid, { key: "ArrowDown" });
    const stockRowId = stockGrid.getAttribute("aria-activedescendant");
    const sectorRowId = sectorGrid.getAttribute("aria-activedescendant");
    expect(stockRowId).toBeTruthy();
    expect(sectorRowId).toBeTruthy();
    expect(stockRowId).not.toBe(sectorRowId);
    expect(document.getElementById(stockRowId!)).toBeTruthy();
    expect(document.getElementById(sectorRowId!)).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(stockGrid, { key: "Enter" });
    fireEvent.keyDown(sectorGrid, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ instrument: expect.objectContaining({ stkCd: "005930" }) }));
    expect(onSector).toHaveBeenCalledWith("001");
  });

  it("returns name activation to the grid for row navigation without letting header controls navigate rows", () => {
    const onPick = vi.fn();
    render(<CaptureGrid label="키보드 종목" columns={columns} rows={[
      { id: "sk", name: "SK하이닉스", price: 100, volume: 1, instrument: samsung },
      { id: "samsung", name: "삼성전자", price: 200, volume: 2, instrument: samsung },
    ]} onPick={onPick} />);

    const grid = screen.getByRole("grid", { name: "키보드 종목" });
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid).toHaveAttribute("aria-activedescendant", within(grid).getByText("SK하이닉스").closest("tr")!.id);

    fireEvent.click(within(grid).getByRole("button", { name: "SK하이닉스" }));
    const skRow = within(grid).getByText("SK하이닉스").closest("tr")!;
    expect(grid).toHaveFocus();
    expect(skRow).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    const samsungRow = within(grid).getByText("삼성전자").closest("tr")!;
    expect(grid).toHaveAttribute("aria-activedescendant", samsungRow.id);
    expect(samsungRow).toHaveAttribute("aria-selected", "true");
    expect(skRow).not.toHaveAttribute("aria-selected");

    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ id: "samsung" }));

    const priceHeader = within(grid).getByRole("button", { name: "현재가 (원)" });
    priceHeader.focus();
    fireEvent.keyDown(priceHeader, { key: "ArrowUp" });
    expect(priceHeader).toHaveFocus();
    expect(grid).toHaveAttribute("aria-activedescendant", samsungRow.id);
  });

  it("locally and stably sorts when no parent sort callback is supplied", () => {
    render(<CaptureGrid label="정렬 그리드" columns={columns} rows={[
      { id: "beta", name: "Beta", price: 10, volume: 1 },
      { id: "alpha", name: "Alpha", price: 20, volume: 1 },
      { id: "gamma", name: "Gamma", price: 20, volume: 1 },
    ]} />);
    const grid = screen.getByRole("grid", { name: "정렬 그리드" });
    const priceHeader = within(grid).getByRole("button", { name: "현재가 (원)" });
    expect(within(grid).getByRole("button", { name: "거래량 (주)" })).toBeInTheDocument();

    fireEvent.click(priceHeader);
    expect(within(grid).getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual(["Alpha201", "Gamma201", "Beta101"]);
    expect(priceHeader.closest("th")).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(priceHeader);
    expect(within(grid).getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual(["Beta101", "Alpha201", "Gamma201"]);
    expect(priceHeader.closest("th")).toHaveAttribute("aria-sort", "ascending");
  });

  it("uses the documented ka00198 rank-change signs without guessing unknown values", () => {
    render(<CaptureGrid label="순위 변동" columns={[{ key: "name", label: "종목명" }, { key: "rankChange", label: "순위등락", numeric: true }]} rows={[
      { id: "up", name: "상승", rankChange: 3, rankChangeSign: "+" },
      { id: "flat", name: "변동없음", rankChange: 0, rankChangeSign: "N" },
      { id: "unknown", name: "미확인", rankChange: 1, rankChangeSign: "?" },
    ]} />);
    const grid = screen.getByRole("grid", { name: "순위 변동" });
    expect(within(grid).getByText("↑ 3")).toBeInTheDocument();
    expect(within(grid).getByText("—")).toBeInTheDocument();
    expect(within(grid).getByText("1 (?)")).toBeInTheDocument();
  });

  it("uses validated provider precision for global FX and other quote cells", () => {
    render(<>
      <CaptureGrid label="환율" columns={[
        { key: "name", label: "종목" }, { key: "last", label: "현재가", numeric: true, precision: 4 }, { key: "change", label: "등락", numeric: true, precision: 4 }, { key: "changePct", label: "등락률", unit: "%", numeric: true, precision: 2 },
      ]} rows={[{ id: "eurusd", name: "EUR/USD", last: 1.1204, change: 0.0002, changePct: 0.125 }]} />
      <CaptureGrid label="글로벌 지수" columns={[
        { key: "name", label: "종목" }, { key: "last", label: "현재가", numeric: true, precision: 2 }, { key: "change", label: "등락", numeric: true, precision: 2 },
      ]} rows={[{ id: "spx", name: "S&P 500", last: 5000.5, change: -10.25 }]} />
    </>);
    const fx = screen.getByRole("grid", { name: "환율" });
    expect(within(fx).getByText("1.1204")).toBeInTheDocument();
    expect(within(fx).getByText("▲ 0.0002")).toBeInTheDocument();
    expect(within(fx).getByText("0.13%")).toBeInTheDocument();
    const indices = screen.getByRole("grid", { name: "글로벌 지수" });
    expect(within(indices).getByText("5,000.50")).toBeInTheDocument();
    expect(within(indices).getByText("▼ 10.25")).toBeInTheDocument();
  });

  it("keeps ratio, strength, missing-price, and reference-time semantics explicit", () => {
    render(<>
      <CaptureGrid label="당일거래" presentation={screenPresentation("0184")} columns={[
        { key: "turnoverRate", label: "회전율", unit: "%", numeric: true }, { key: "previousChangePct", label: "전일비", unit: "%", numeric: true }, { key: "sellPrice", label: "매도", unit: "KRW", numeric: true },
      ]} rows={[{ id: "daily", turnoverRate: 0.46, previousChangePct: -32.4, sellPrice: null, change: 100 }]} />
      <CaptureGrid label="시가총액" presentation={screenPresentation("0187")} columns={[{ key: "tradingStrength", label: "체결강도", numeric: true }, { key: "marketCap", label: "시가총액", unit: "KRW 100m", numeric: true }]} rows={[{ id: "cap", tradingStrength: 75.07, marketCap: 123456 }]} />
      <CaptureGrid label="조회순위" presentation={screenPresentation("0198")} columns={[
        { key: "price", label: "현재가", unit: "KRW", numeric: true }, { key: "changePct", label: "등락률", unit: "%", numeric: true }, { key: "asOf", label: "기준시각" },
      ]} rows={[{ id: "rank", price: 70000, changePct: 1.25, asOf: "20261025 121900" }]} />
    </>);

    const daily = screen.getByRole("grid", { name: "당일거래" });
    expect(within(daily).getByText("0.46%").closest("td")).not.toHaveClass("classic-up");
    expect(within(daily).getByText("-32.40%").closest("td")).not.toHaveClass("classic-down");
    expect(within(daily).getByText("—").closest("td")).not.toHaveClass("classic-up");

    const capitalization = screen.getByRole("grid", { name: "시가총액" });
    const strength = within(capitalization).getByText("75.07").closest("td");
    expect(strength).toHaveClass("classic-down");
    expect(within(capitalization).queryByText("75.07%")).not.toBeInTheDocument();
    expect(within(capitalization).getByRole("button", { name: "시가총액(억원)" })).toBeInTheDocument();

    const ranking = screen.getByRole("grid", { name: "조회순위" });
    expect(within(ranking).getByRole("button", { name: "기준시점 주가 (원)" })).toBeInTheDocument();
    expect(within(ranking).getByRole("button", { name: "기준 대비 등락률 (%)" })).toBeInTheDocument();
    expect(within(ranking).getByText("2026-10-25 12:19:00")).toBeInTheDocument();
  });

  it("puts every 2797 investor flow before hidden market-price detail columns", () => {
    const investorColumns = [
      ["individual", "개인", 1], ["foreign", "외국인", -2], ["institutional", "기관계", 0], ["securities", "금융투자", -4], ["insurance", "보험", 5], ["investmentTrust", "투신", -6], ["bank", "은행", 7], ["pension", "종금", -8], ["fund", "연기금", 9], ["privateFund", "사모펀드", -10], ["national", "국가", 11], ["nativeTrmtForeign", "내국인대우 외국인", -12], ["otherCorporation", "기타법인", 13],
    ] as const;
    const row: CaptureRow = { id: "sector", market: "KOSPI", sector: "반도체", price: 1000, change: 10, changePct: 1 };
    for (const [key, _label, value] of investorColumns) row[key] = value;
    render(<CaptureGrid label="업종수급" presentation={screenPresentation("2797")} columns={[
      { key: "market", label: "시장" }, { key: "sector", label: "업종" }, { key: "price", label: "현재가", numeric: true }, { key: "change", label: "전일대비", numeric: true }, { key: "changePct", label: "등락률", numeric: true },
      ...investorColumns.map(([key, label]) => ({ key, label, numeric: true })),
    ]} rows={[row]} />);

    const grid = screen.getByRole("grid", { name: "업종수급" });
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "업종", "개인", "외국인", "기관계", "금융투자", "보험", "투신", "은행", "종금", "연기금", "사모", "국가", "내국인대우", "기타법인",
    ]);
    expect(within(grid).queryByRole("button", { name: "시장" })).not.toBeInTheDocument();
    for (const [key, _label, value] of investorColumns) {
      const text = value > 0 ? `+${value}` : value < 0 ? `${value}` : "0";
      const cell = within(grid).getByText(text).closest("td");
      if (value === 0) expect(cell).not.toHaveClass("classic-up", "classic-down");
      else expect(cell).toHaveClass(value > 0 ? "classic-up" : "classic-down");
      expect(within(cell!).getByText(text)).toHaveAttribute("title", text);
      expect(key).toBeTruthy();
    }
  });
});
