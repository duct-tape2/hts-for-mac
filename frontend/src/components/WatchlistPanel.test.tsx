import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { api } from "@/lib/api";
import { StoreProvider, useStore } from "@/lib/store";
import { quoteKey, useLiveQuotes } from "@/lib/useLiveQuote";
import { apple, fixtureQuote, samsung } from "@/test/fixtures";
import type { ReadonlyState } from "@/lib/types";

vi.mock("@/lib/useLiveQuote", () => ({
  quoteKey: (instrument: { market: string; stkCd: string; listingVenue: string; quoteVenue: string; environment: string }) => [instrument.market, instrument.stkCd, instrument.listingVenue, instrument.quoteVenue, instrument.environment].join(":"),
  useLiveQuotes: vi.fn(),
}));

function stateWith(items: ReadonlyState["items"], watchlists: ReadonlyState["watchlists"] = [{ id: "wl_default", name: "내 관심종목", source: "app" }]): ReadonlyState {
  return {
    mode: "fixture",
    kiwoom: "disconnected",
    kiwoomError: "",
    watchlists,
    items,
  };
}

function GlobalSelectionHarness({ children }: { children: ReactNode }) {
  const { dispatch } = useStore();
  return createElement("div", null, createElement("button", { type: "button", onClick: () => dispatch({ type: "selectWatchlist", id: "wl-us" }) }, "전역 그룹 변경"), children);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WatchlistPanel quote display", () => {
  it("does not relabel a persisted price as live data when quote loading fails", async () => {
    const state = stateWith([{ ...samsung, id: "saved-item", watchlistId: "wl_default", enabled: true, last: 70000, prevClose: 69000, open: 69500, changePct: 1.45 }]);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: { [quoteKey(samsung)]: "시세 오류" } });

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, { selected: samsung, onSymbol: vi.fn() })));

    await waitFor(() => expect(screen.getByTitle("출처: 미수신 · 상태: 시세 오류")).toBeInTheDocument());
    expect(screen.queryByText("70,000원")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("sorts fetched quote values and lets a focused compact row select its instrument", async () => {
    const user = userEvent.setup();
    const onSymbol = vi.fn();
    const state = stateWith([
      { ...samsung, id: "samsung-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null },
      { ...apple, id: "apple-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null },
    ]);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockReturnValue({
      quotes: { [quoteKey(samsung)]: fixtureQuote(samsung), [quoteKey(apple)]: fixtureQuote(apple) },
      errors: {},
    });

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, { selected: samsung, onSymbol })));

    await waitFor(() => expect(screen.getByText("$210.50")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "현재가 정렬" }));

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Apple Inc.");
    rows[2].focus();
    await user.keyboard("{Enter}");
    expect(onSymbol).toHaveBeenCalledWith(expect.objectContaining(samsung));
  });

  it("only persists fixture quick-add examples after the user chooses one", async () => {
    const user = userEvent.setup();
    const initial = stateWith([]);
    const saved = stateWith([{ ...samsung, id: "server-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null }]);
    vi.spyOn(api, "state").mockResolvedValue(initial);
    const addItem = vi.spyOn(api, "addItem").mockResolvedValue(saved);
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: {} });

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, { selected: samsung, onSymbol: vi.fn() })));

    await waitFor(() => expect(screen.getByText("이 그룹은 비어 있습니다.")).toBeInTheDocument());
    expect(addItem).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "삼성전자 추가" }));
    await waitFor(() => expect(addItem).toHaveBeenCalledWith("wl_default", samsung));
  });

  it("keeps larger local groups and subscribes only to the visible 100-row shared-stream page", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 101 }, (_, index) => ({
      ...samsung,
      stkCd: String(100000 + index),
      stkNm: "테스트 종목 " + (index + 1),
      id: "item-" + index,
      watchlistId: "wl_default",
      enabled: true,
      last: null,
      prevClose: null,
      open: null,
      changePct: null,
    }));
    vi.spyOn(api, "state").mockResolvedValue(stateWith(items));
    const live = vi.mocked(useLiveQuotes);
    live.mockImplementation((instruments) => ({
      quotes: Object.fromEntries(instruments.map((instrument) => [quoteKey(instrument), fixtureQuote(instrument)])),
      errors: {},
    }));

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, { selected: samsung, onSymbol: vi.fn() })));

    await waitFor(() => expect(screen.getByText("시세 1–100/101 · 100종목/쪽")).toBeInTheDocument());
    await waitFor(() => expect(live.mock.calls.some(([instruments]) => instruments.length === 100)).toBe(true));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(screen.getByText("시세 101–101/101 · 100종목/쪽")).toBeInTheDocument());
    await waitFor(() => expect(live.mock.calls.some(([instruments]) => instruments.length === 1)).toBe(true));
    await user.click(screen.getByRole("button", { name: "시세 새로고침" }));
    await waitFor(() => expect(live.mock.calls.some(([, refreshKey]) => refreshKey === 1)).toBe(true));
  });

  it("hides and reorders fields through the persisted preference callback", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = vi.fn();
    const state = stateWith([{ ...samsung, id: "saved-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null }]);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: { [quoteKey(samsung)]: fixtureQuote(samsung) }, errors: {} });

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, {
      selected: samsung,
      onSymbol: vi.fn(),
      preferences: { columns: ["name", "last", "volume"] },
      onPreferencesChange,
    })));

    await waitFor(() => expect(screen.getByText("70,000원")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "표시 항목" }));
    await user.click(screen.getByRole("button", { name: "거래량 위로" }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ columns: ["name", "volume", "last"] }));
    await user.click(screen.getByLabelText("현재가"));
    expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ columns: ["name", "volume"] }));
    expect(screen.queryByRole("columnheader", { name: /현재가/ })).not.toBeInTheDocument();
  });

  it("keeps saved fields intact while exposing compact-priority hooks and full volume", async () => {
    const onPreferencesChange = vi.fn();
    const state = stateWith([{ ...samsung, id: "saved-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null }]);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockReturnValue({
      quotes: { [quoteKey(samsung)]: fixtureQuote(samsung, { volume: 16145972 }) },
      errors: {},
    });

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, {
      selected: samsung,
      onSymbol: vi.fn(),
      preferences: { columns: ["name", "code", "last", "change", "changePct", "volume"] },
      onPreferencesChange,
    })));

    await waitFor(() => expect(screen.getByText("16,145,972")).toBeInTheDocument());
    const table = screen.getByRole("table", { name: "관심종목 시세 표" });
    expect(table).toHaveClass("watchlist-table--responsive");
    expect(table.querySelectorAll('[data-watchlist-column="name"][scope="col"]').length).toBe(1);
    expect(table.querySelectorAll('[data-watchlist-column="last"][scope="col"]').length).toBe(1);
    expect(table.querySelectorAll('[data-watchlist-column="changePct"][scope="col"]').length).toBe(1);
    expect(table.querySelectorAll('[data-watchlist-column="volume"][scope="col"]').length).toBe(1);
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it("falls back from invalid saved settings and keeps two panels on independent groups", async () => {
    const user = userEvent.setup();
    const watchlists = [
      { id: "wl-kr", name: "국내", source: "app" as const },
      { id: "wl-us", name: "미국", source: "app" as const },
    ];
    const state = stateWith([
      { ...samsung, id: "kr-item", watchlistId: "wl-kr", enabled: true, last: null, prevClose: null, open: null, changePct: null },
      { ...apple, id: "us-item", watchlistId: "wl-us", enabled: true, last: null, prevClose: null, open: null, changePct: null },
    ], watchlists);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockImplementation((instruments) => ({
      quotes: Object.fromEntries(instruments.map((instrument) => [quoteKey(instrument), fixtureQuote(instrument)])),
      errors: {},
    }));

    render(createElement(StoreProvider, null, createElement(GlobalSelectionHarness, null,
      createElement(WatchlistPanel, { selected: samsung, onSymbol: vi.fn(), preferences: { groupId: "missing-group", columns: ["name", "name", "unknown"] as never, sortKey: "unknown" as never } }),
      createElement(WatchlistPanel, { selected: apple, onSymbol: vi.fn(), preferences: { groupId: "wl-us" } }),
    )));

    await waitFor(() => expect(screen.getAllByText("시세 1–1/1 · 100종목/쪽")).toHaveLength(2));
    const groups = screen.getAllByLabelText("관심종목 그룹") as HTMLSelectElement[];
    expect(groups.map((select) => select.value)).toEqual(["wl-kr", "wl-us"]);
    await user.click(screen.getByRole("button", { name: "전역 그룹 변경" }));
    expect(groups.map((select) => select.value)).toEqual(["wl-kr", "wl-us"]);
  });

  it("moves through the sorted visible rows with ArrowUp and ArrowDown", async () => {
    const user = userEvent.setup();
    const onSymbol = vi.fn();
    const state = stateWith([
      { ...samsung, id: "samsung-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null },
      { ...apple, id: "apple-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null },
    ]);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockReturnValue({
      quotes: { [quoteKey(samsung)]: fixtureQuote(samsung), [quoteKey(apple)]: fixtureQuote(apple) },
      errors: {},
    });

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, { selected: samsung, onSymbol })));
    await waitFor(() => expect(screen.getByText("$210.50")).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    rows[1].focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[2]);
    expect(onSymbol).toHaveBeenLastCalledWith(expect.objectContaining(apple));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows[1]);
    expect(onSymbol).toHaveBeenLastCalledWith(expect.objectContaining(samsung));
  });

  it("clamps arrow navigation at page boundaries and isolates duplicate panels", async () => {
    const user = userEvent.setup();
    const firstOnSymbol = vi.fn();
    const secondOnSymbol = vi.fn();
    const state = stateWith([
      { ...samsung, id: "samsung-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null },
      { ...apple, id: "apple-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null },
    ]);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockReturnValue({
      quotes: { [quoteKey(samsung)]: fixtureQuote(samsung), [quoteKey(apple)]: fixtureQuote(apple) },
      errors: {},
    });

    render(createElement(StoreProvider, null,
      createElement(WatchlistPanel, { selected: samsung, onSymbol: firstOnSymbol }),
      createElement(WatchlistPanel, { selected: apple, onSymbol: secondOnSymbol }),
    ));
    await waitFor(() => expect(screen.getAllByText("$210.50")).toHaveLength(2));

    const panels = screen.getAllByRole("region", { name: "관심종목" });
    const firstRows = within(panels[0]).getAllByRole("row");
    const secondRows = within(panels[1]).getAllByRole("row");
    firstRows[1].focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(firstRows[1]);
    expect(firstOnSymbol).not.toHaveBeenCalled();
    firstRows[2].focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(firstRows[2]);
    expect(firstOnSymbol).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(secondRows[1]);
    expect(secondOnSymbol).not.toHaveBeenCalled();
  });

  it("does not select a row when Enter or Space starts on its remove button", async () => {
    const onSymbol = vi.fn();
    const state = stateWith([{ ...samsung, id: "samsung-item", watchlistId: "wl_default", enabled: true, last: null, prevClose: null, open: null, changePct: null }]);
    vi.spyOn(api, "state").mockResolvedValue(state);
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: { [quoteKey(samsung)]: fixtureQuote(samsung) }, errors: {} });

    render(createElement(StoreProvider, null, createElement(WatchlistPanel, { selected: samsung, onSymbol })));
    await waitFor(() => expect(screen.getByText("70,000원")).toBeInTheDocument());
    const removeButton = screen.getByRole("button", { name: "005930 관심종목에서 제거" });
    fireEvent.keyDown(removeButton, { key: "Enter" });
    fireEvent.keyDown(removeButton, { key: " " });
    expect(onSymbol).not.toHaveBeenCalled();
  });

  it("follows a group created by this panel without moving a duplicate panel", async () => {
    const user = userEvent.setup();
    const watchlists = [
      { id: "wl_default", name: "내 관심종목", source: "app" as const },
      { id: "wl-other", name: "다른 그룹", source: "app" as const },
    ];
    const createdWatchlists = [...watchlists, { id: "wl-created", name: "새 그룹", source: "app" as const }];
    const state = stateWith([], watchlists);
    vi.spyOn(api, "state").mockResolvedValue(state);
    const addWatchlist = vi.spyOn(api, "addWatchlist").mockResolvedValue(stateWith([], createdWatchlists));
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: {} });

    render(createElement(StoreProvider, null,
      createElement(WatchlistPanel, { selected: samsung, onSymbol: vi.fn() }),
      createElement(WatchlistPanel, { selected: samsung, onSymbol: vi.fn(), preferences: { groupId: "wl-other" } }),
    ));
    await waitFor(() => expect(screen.getAllByLabelText("관심종목 그룹")).toHaveLength(2));

    const panels = screen.getAllByRole("region", { name: "관심종목" });
    await user.click(within(panels[0]).getByRole("button", { name: "그룹" }));
    await user.type(within(panels[0]).getByRole("textbox", { name: "새 관심종목 그룹 이름" }), "새 그룹");
    await user.click(within(panels[0]).getByRole("button", { name: "추가" }));
    await waitFor(() => expect(addWatchlist).toHaveBeenCalledWith("새 그룹"));
    await waitFor(() => {
      const groups = screen.getAllByLabelText("관심종목 그룹") as HTMLSelectElement[];
      expect(groups.map((group) => group.value)).toEqual(["wl-created", "wl-other"]);
    });
  });
});
