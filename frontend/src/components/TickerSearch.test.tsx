import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TickerSearch } from "@/components/TickerSearch";
import { api } from "@/lib/api";
import { samsung } from "@/test/fixtures";
import { pushRecent } from "@/lib/recent";

function SearchHarness({ onPick }: { onPick: (code: string) => void }) {
  const [value, setValue] = useState("삼");
  return <TickerSearch market="KR" value={value} onChange={setValue} onPick={(hit) => onPick(hit.stkCd)} />;
}

function ToolbarHarness({ onPick }: { onPick?: (code: string) => void }) {
  const [value, setValue] = useState("005930");
  const [selectedValue, setSelectedValue] = useState("005930");
  return (
    <TickerSearch
      market="KR"
      value={value}
      selectedValue={selectedValue}
      showRecent
      onChange={setValue}
      onPick={(hit) => {
        setValue(hit.stkCd);
        setSelectedValue(hit.stkCd);
        onPick?.(hit.stkCd);
      }}
    />
  );
}

function MutableToolbarHarness({ market, selectedValue }: { market: "KR" | "US"; selectedValue: string }) {
  const [value, setValue] = useState(selectedValue);
  useEffect(() => setValue(selectedValue), [selectedValue]);
  return <TickerSearch market={market} value={value} selectedValue={selectedValue} showRecent onChange={setValue} onPick={vi.fn()} />;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TickerSearch", () => {
  it("does not search a programmatic toolbar selection and shows market recents on focus", () => {
    const search = vi.spyOn(api, "searchSymbols");
    pushRecent(samsung);
    render(<ToolbarHarness />);
    const input = screen.getByRole("searchbox");

    fireEvent.focus(input);
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText("최근 선택")).toBeInTheDocument();
    expect(screen.getByRole("option")).toHaveTextContent("삼성전자");
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", 6);

    fireEvent.click(screen.getByRole("option"));
    fireEvent.focus(input);
    expect(search).not.toHaveBeenCalled();
  });

  it("starts a debounced search only after toolbar input is edited", async () => {
    vi.useFakeTimers();
    const search = vi.spyOn(api, "searchSymbols").mockResolvedValue({ results: [samsung], complete: true, note: "" });
    render(<ToolbarHarness />);
    const input = screen.getByRole("searchbox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "삼" } });
    expect(search).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(180));
    expect(search).toHaveBeenCalledWith("삼", "KR", expect.any(AbortSignal));
  });

  it("ignores stale results when the toolbar market changes", async () => {
    vi.useFakeTimers();
    let resolveSearch!: (value: { results: typeof samsung[]; complete: boolean; note: string }) => void;
    const pending = new Promise<{ results: typeof samsung[]; complete: boolean; note: string }>((resolve) => {
      resolveSearch = resolve;
    });
    const search = vi.spyOn(api, "searchSymbols").mockReturnValue(pending);
    const view = render(<MutableToolbarHarness market="KR" selectedValue="005930" />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "삼" } });
    await act(() => vi.advanceTimersByTimeAsync(180));
    expect(search).toHaveBeenCalledWith("삼", "KR", expect.any(AbortSignal));

    view.rerender(<MutableToolbarHarness market="US" selectedValue="AAPL" />);
    await act(async () => {
      resolveSearch({ results: [samsung], complete: true, note: "" });
      await pending;
    });
    fireEvent.focus(screen.getByRole("searchbox"));
    expect(screen.queryByText("삼성전자")).not.toBeInTheDocument();
  });

  it("shows completed background results without asking the user to retype", async () => {
    vi.useFakeTimers();
    const search = vi.spyOn(api, "searchSymbols")
      .mockResolvedValueOnce({ results: [], complete: false, note: "KR symbol index is loading in the background" })
      .mockResolvedValue({ results: [samsung], complete: false, note: "omitted 2 unsupported KR symbols" });
    render(<SearchHarness onPick={vi.fn()} />);
    fireEvent.focus(screen.getByRole("searchbox"));
    await act(() => vi.advanceTimersByTimeAsync(180));
    expect(screen.getByText(/종목 목록을 받는 중/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("option")).toHaveTextContent("삼성전자");
    expect(screen.getByText("현재 지원 범위의 종목만 표시합니다.")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("cancels the former query's background retry when the query changes", async () => {
    vi.useFakeTimers();
    const search = vi.spyOn(api, "searchSymbols").mockImplementation(async (q) => q === "삼"
      ? { results: [], complete: false, note: "KR symbol index is loading in the background" }
      : { results: [{ ...samsung, stkCd: "000660", stkNm: "SK하이닉스" }], complete: true, note: "" });
    render(<SearchHarness onPick={vi.fn()} />);
    fireEvent.focus(screen.getByRole("searchbox"));
    await act(() => vi.advanceTimersByTimeAsync(180));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "000660" } });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole("option")).toHaveTextContent("SK하이닉스");
    expect(search.mock.calls.map(([q]) => q)).toEqual(["삼", "000660"]);
  });
  it("shows Korean market and venue detail, then picks the keyboard-highlighted result", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const second = { ...samsung, stkCd: "000660", stkNm: "SK하이닉스" };
    vi.spyOn(api, "searchSymbols").mockResolvedValue({ results: [samsung, second], complete: true, note: "" });

    render(<SearchHarness onPick={onPick} />);
    await user.click(screen.getByRole("searchbox", { name: "국내 종목 검색" }));

    expect((await screen.findAllByText("국내 · KOSPI/KRX · 샘플")).length).toBe(2);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("000660");
  });
});
