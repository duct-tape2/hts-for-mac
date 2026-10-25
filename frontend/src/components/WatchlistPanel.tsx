"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { TickerSearch } from "@/components/TickerSearch";
import { changeClass, formatPct, formatPrice, formatQty, formatSignedPrice } from "@/lib/format";
import { useStore } from "@/lib/store";
import { defaultInstrument } from "@/lib/symbols";
import { quoteKey, useLiveQuotes } from "@/lib/useLiveQuote";
import { sameFeed } from "@/lib/types";
import type { Instrument, Market, Quote } from "@/lib/types";
import {
  DEFAULT_WATCHLIST_PREFERENCES,
  sanitizeWatchlistPreferences,
  WATCHLIST_COLUMNS,
  type WatchlistColumn,
  type WatchlistPreferences,
  type WatchlistSortDirection,
  type WatchlistSortKey,
} from "@/components/watchlistPreferences";
import "./captureTables.css";
import "./watchlistParity.css";

export type { WatchlistColumn, WatchlistPreferences, WatchlistSortDirection, WatchlistSortKey } from "@/components/watchlistPreferences";

type Props = {
  onSymbol: (instrument: Instrument) => void;
  selected: Instrument;
  preferences?: Partial<WatchlistPreferences>;
  onPreferencesChange?: (next: WatchlistPreferences) => void;
};

type SortKey = WatchlistSortKey;
type SortDirection = WatchlistSortDirection;

const QUOTES_PER_PAGE = 100;

export function WatchlistPanel({ onSymbol, selected, preferences, onPreferencesChange }: Props) {
  const { state, dispatch, isWatchlistPending } = useStore();
  const instanceId = useId().replace(/:/g, "");
  const groupSelectId = `watchlist-group-${instanceId}`;
  const groupManagementId = `watchlist-group-management-${instanceId}`;
  const newGroupId = `new-watchlist-${instanceId}`;
  const columnsDisclosureId = `watchlist-columns-${instanceId}`;
  const [newGroup, setNewGroup] = useState("");
  const [query, setQuery] = useState("");
  const [addMarket, setAddMarket] = useState<Market>(selected.market);
  const [groupManagementOpen, setGroupManagementOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [page, setPage] = useState(0);
  const [panelPreferences, setPanelPreferences] = useState<WatchlistPreferences>(() => {
    const initial = sanitizeWatchlistPreferences(preferences);
    return { ...initial, groupId: initial.groupId || state.selectedWatchlistId || state.watchlists[0]?.id || DEFAULT_WATCHLIST_PREFERENCES.groupId };
  });

  const externalPreferences = useMemo(() => (preferences ? sanitizeWatchlistPreferences(preferences) : null), [preferences]);

  const groupId = panelPreferences.groupId;
  const items = useMemo(() => state.items.filter((item) => item.watchlistId === groupId && item.enabled), [groupId, state.items]);
  const feedItems = useMemo(() => items.map((item) => (item.environment === state.mode ? item : { ...item, environment: state.mode })), [items, state.mode]);
  const pageCount = Math.max(1, Math.ceil(feedItems.length / QUOTES_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * QUOTES_PER_PAGE;
  const quoteItems = useMemo(() => feedItems.slice(pageStart, pageStart + QUOTES_PER_PAGE), [feedItems, pageStart]);
  const pageEnd = Math.min(pageStart + quoteItems.length, items.length);
  const { quotes, errors } = useLiveQuotes(quoteItems, refreshGeneration);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const createRequest = useRef<{ knownIds: Set<string>; name: string } | null>(null);

  useEffect(() => setAddMarket(selected.market), [selected.market]);
  useEffect(() => setPage(0), [groupId]);
  useEffect(() => setPage((previous) => Math.min(previous, pageCount - 1)), [pageCount]);

  const rows = useMemo(() => {
    const next = quoteItems.map((item, index) => ({ item, index, quote: quotes[quoteKey(item)] ?? null, quoteError: errors[quoteKey(item)] ?? "" }));
    return next.sort((left, right) => compareRows(left, right, panelPreferences.sortKey, panelPreferences.sortDirection));
  }, [errors, panelPreferences.sortDirection, panelPreferences.sortKey, quoteItems, quotes]);
  const rovingRowId = rows.find(({ item }) => sameFeed(item, selected))?.item.id ?? rows[0]?.item.id;

  useEffect(() => {
    setPanelPreferences((current) => {
      const validGroupIds = new Set(state.watchlists.map((group) => group.id));
      const preferredGroup = externalPreferences?.groupId;
      const nextGroupId = preferredGroup && validGroupIds.has(preferredGroup)
        ? preferredGroup
        : validGroupIds.has(current.groupId)
          ? current.groupId
          : validGroupIds.has(state.selectedWatchlistId)
            ? state.selectedWatchlistId
            : state.watchlists[0]?.id ?? "";
      const next = externalPreferences
        ? { ...current, ...externalPreferences, groupId: nextGroupId }
        : { ...current, groupId: nextGroupId };
      return preferencesEqual(current, next) ? current : next;
    });
  }, [externalPreferences, preferences, state.selectedWatchlistId, state.watchlists]);

  useEffect(() => {
    const request = createRequest.current;
    if (!request) return;
    const created = state.watchlists.find((group) => !request.knownIds.has(group.id) && group.name === request.name)
      ?? state.watchlists.find((group) => !request.knownIds.has(group.id));
    if (created) {
      createRequest.current = null;
      commitPreferences({ groupId: created.id });
    } else if (state.watchlistNote?.includes("서버 저장 실패")) {
      createRequest.current = null;
    }
  }, [state.watchlistNote, state.watchlists]);

  function commitPreferences(patch: Partial<WatchlistPreferences>) {
    const next = sanitizeWatchlistPreferences({ ...panelPreferences, ...patch });
    setPanelPreferences(next);
    onPreferencesChange?.(next);
  }

  function selectGroup(id: string) {
    if (state.watchlists.some((group) => group.id === id)) commitPreferences({ groupId: id });
  }

  function changeSort(nextKey: SortKey) {
    if (nextKey === panelPreferences.sortKey) {
      commitPreferences({ sortDirection: panelPreferences.sortDirection === "asc" ? "desc" : "asc" });
      return;
    }
    commitPreferences({ sortKey: nextKey, sortDirection: "asc" });
  }

  function toggleColumn(column: WatchlistColumn) {
    if (column === "name") return;
    const columns = panelPreferences.columns.includes(column)
      ? panelPreferences.columns.filter((value) => value !== column)
      : [...panelPreferences.columns, column];
    commitPreferences({ columns });
  }

  function moveColumn(column: WatchlistColumn, offset: -1 | 1) {
    const index = panelPreferences.columns.indexOf(column);
    const nextIndex = index + offset;
    if (index <= 0 || nextIndex <= 0 || nextIndex >= panelPreferences.columns.length) return;
    const columns = [...panelPreferences.columns];
    [columns[index], columns[nextIndex]] = [columns[nextIndex], columns[index]];
    commitPreferences({ columns });
  }

  function addInstrument(instrument: Instrument) {
    if (!groupId || isWatchlistPending) return;
    dispatch({ type: "addItem", watchlistId: groupId, instrument });
    setQuery("");
  }

  return (
    <section className="watchlist-panel panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#101925]" aria-label="관심종목">
      <div className="watchlist-classic-toolbar shrink-0 border-b border-ink-800">
        <div className="watchlist-toolbar flex items-center gap-1">
          <span className="mr-1 shrink-0 whitespace-nowrap text-xs font-semibold text-cream-50">관심종목</span>
          <label className="sr-only" htmlFor={groupSelectId}>
            관심종목 그룹
          </label>
          <select id={groupSelectId} className="field !w-auto min-w-0 max-w-[8.5rem] !py-0.5" value={groupId} onChange={(event) => selectGroup(event.target.value)} disabled={isWatchlistPending}>
            {state.watchlists.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost ml-auto !px-1.5 !py-0.5 text-[10px]"
            type="button"
            onClick={() => setRefreshGeneration((value) => value + 1)}
            disabled={isWatchlistPending || quoteItems.length === 0}
            aria-label="시세 새로고침"
            title="표시된 관심종목 시세를 한 번 다시 조회합니다. 실시간 수신은 공유 스트림에서 유지됩니다."
          >
            새로고침
          </button>
          <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" type="button" onClick={() => setGroupManagementOpen((open) => !open)} aria-expanded={groupManagementOpen} aria-controls={groupManagementId}>
            그룹
          </button>
          <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" type="button" aria-label="표시 항목" onClick={() => setColumnsOpen((open) => !open)} aria-expanded={columnsOpen} aria-controls={columnsDisclosureId}>
            필드·더보기
          </button>
        </div>
        <div className="watchlist-search-row mt-0.5">
          <nav className="watchlist-quick-groups" aria-label="관심그룹 바로가기">
            {state.watchlists.slice(0, 6).map((group, index) => (
              <button key={group.id} type="button" className="hts-btn" aria-pressed={group.id === groupId} title={group.name} aria-label={`${index + 1}번 그룹 ${group.name}`} onClick={() => selectGroup(group.id)} disabled={isWatchlistPending}>{index + 1}</button>
            ))}
          </nav>
          <div className="flex shrink-0 gap-0.5" aria-label="추가할 시장" title="관심종목에 추가할 종목의 검색 시장입니다. 기존 목록은 국내·미국을 함께 표시합니다.">
            {(["KR", "US"] as const).map((market) => (
              <button key={market} type="button" className={"px-1.5 py-0.5 text-[10px] " + (addMarket === market ? "bg-[#e5ad39] text-ink-950" : "bg-ink-800 text-cream-300")} onClick={() => setAddMarket(market)} aria-pressed={addMarket === market} disabled={isWatchlistPending}>
                {market === "KR" ? "국내" : "미국"}
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <TickerSearch market={addMarket} value={query} placeholder="종목 검색·추가" disabled={isWatchlistPending} onChange={setQuery} onPick={addInstrument} />
          </div>
          <span className="watchlist-status">{environmentLabel(state.mode)} · {state.kiwoom === "connected" ? "연결" : "미연결"}</span>
          <span className="watchlist-status">{items.length ? `시세 ${pageStart + 1}–${pageEnd}/${items.length} · 100종목/쪽` : "시세 0/0 · 100종목/쪽"}</span>
        </div>
      </div>

      {groupManagementOpen && (
        <div id={groupManagementId} className="shrink-0 border-b border-ink-800 bg-ink-950/60 px-2 py-1.5">
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!newGroup.trim()) return;
              createRequest.current = { knownIds: new Set(state.watchlists.map((group) => group.id)), name: newGroup.trim() };
              dispatch({ type: "addWatchlist", name: newGroup });
              setNewGroup("");
            }}
          >
            <label className="sr-only" htmlFor={newGroupId}>
              새 관심종목 그룹 이름
            </label>
            <input id={newGroupId} className="field min-w-0 flex-1 !py-0.5" value={newGroup} onChange={(event) => setNewGroup(event.target.value)} placeholder="새 그룹 이름" disabled={isWatchlistPending} />
            <button className="btn btn-ghost shrink-0 !px-1.5 !py-0.5 text-[10px]" type="submit" disabled={isWatchlistPending || !newGroup.trim()}>
              추가
            </button>
          </form>
          <div className="mt-1 flex flex-wrap gap-1">
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" type="button" onClick={() => dispatch({ type: "saveWatchlist", id: groupId })} disabled={!groupId || isWatchlistPending}>
              그룹 저장
            </button>
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" type="button" onClick={() => dispatch({ type: "importKiwoom", id: groupId, market: selected.market })} disabled={!groupId || isWatchlistPending} title="선택한 시장의 HTS 관심종목을 읽어 앱 로컬에 저장합니다.">
              {selected.market === "KR" ? "국내" : "미국"} HTS 가져오기
            </button>
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" type="button" onClick={() => dispatch({ type: "removeWatchlist", id: groupId })} disabled={isWatchlistPending || groupId === "wl_default" || state.watchlists.length < 2}>
              그룹 삭제
            </button>
          </div>
        </div>
      )}

      {columnsOpen && (
        <div id={columnsDisclosureId} className="shrink-0 border-b border-ink-800 bg-ink-950/60 px-2 py-1.5" role="region" aria-label="표시 항목 설정">
          <div className="flex items-center justify-between text-[10px] text-cream-500">
            <span>표시할 항목</span>
            <span>위·아래로 순서 변경</span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
            {WATCHLIST_COLUMNS.map((column) => {
              const visible = panelPreferences.columns.includes(column);
              return (
                <label key={column} className="flex min-w-0 items-center gap-1 text-[10px] text-cream-300">
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={column === "name"}
                    onChange={() => toggleColumn(column)}
                    aria-label={columnLabel(column)}
                  />
                  <span className="truncate">{columnLabel(column)}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-1 flex flex-wrap gap-1" aria-label="표시 항목 순서">
            {panelPreferences.columns.map((column, index) => (
              <span key={column} className="inline-flex items-center gap-0.5 border border-ink-700 px-1 py-0.5 text-[10px] text-cream-300">
                <span>{columnLabel(column)}</span>
                <button type="button" className="px-0.5 text-cream-500 hover:text-cream-50" onClick={() => moveColumn(column, -1)} disabled={index <= 1} aria-label={`${columnLabel(column)} 위로`}>
                  ↑
                </button>
                <button type="button" className="px-0.5 text-cream-500 hover:text-cream-50" onClick={() => moveColumn(column, 1)} disabled={index === 0 || index >= panelPreferences.columns.length - 1} aria-label={`${columnLabel(column)} 아래로`}>
                  ↓
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="watchlist-compact-notice">축약 보기 · 전체 열은 창 최대화</div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="hts-table watchlist-table watchlist-table--responsive w-full table-fixed border-collapse text-[11px]" style={{ minWidth: `${tableMinWidth(panelPreferences.columns)}px` }} aria-label="관심종목 시세 표">
          <colgroup>
            {panelPreferences.columns.map((column) => <col key={column} data-watchlist-column={column} style={{ width: `${columnWidth(column)}px` }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-ink-800 text-[10px] text-cream-500">
            <tr>
              {panelPreferences.columns.map((column) => (
                <SortHeader key={column} label={columnLabel(column)} column={column} current={panelPreferences.sortKey} direction={panelPreferences.sortDirection} onSort={changeSort} className={column === "name" || column === "code" || column === "venue" ? "text-left" : "text-right"} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, quote, quoteError }) => {
              const active = sameFeed(item, selected);
              return (
                <tr
                  key={item.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(item.id, node);
                    else rowRefs.current.delete(item.id);
                  }}
                  tabIndex={item.id === rovingRowId ? 0 : -1}
                  aria-selected={active}
                  className="watchlist-row cursor-pointer border-b border-ink-800 text-cream-100 outline-none hover:bg-ink-800 focus:bg-ink-800 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#e5ad39]"
                  onClick={(event) => {
                    if (event.target instanceof HTMLElement && event.target.closest("button,input,select,textarea,a")) return;
                    event.currentTarget.focus();
                    onSymbol(item);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      const currentIndex = rows.findIndex((row) => row.item.id === item.id);
                      const nextIndex = event.key === "ArrowUp" ? Math.max(0, currentIndex - 1) : Math.min(rows.length - 1, currentIndex + 1);
                      const nextRow = rows[nextIndex];
                      if (nextRow && nextRow.item.id !== item.id) {
                        rowRefs.current.get(nextRow.item.id)?.focus();
                        onSymbol(nextRow.item);
                      }
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSymbol(item);
                    }
                  }}
                >
                  {panelPreferences.columns.map((column) => {
                    const indicator = <span className={indicatorClass(quote, quoteError)} title={indicatorTitle(quote, quoteError)} aria-label={indicatorTitle(quote, quoteError)}>●</span>;
                    if (column === "name") {
                      return (
                        <td key={column} data-watchlist-column={column} className={"min-w-0 border-l-2 py-0.5 pl-1.5 pr-1 " + (active ? "border-[#e5ad39]" : "border-transparent")}>
                          <div className="flex min-w-0 items-center gap-1">
                            <span className="truncate font-medium">{item.stkNm}</span>
                            <span className="watchlist-name-indicator">{indicator}</span>
                            <button
                              type="button"
                              className="watchlist-remove ml-auto shrink-0 px-0.5 text-[11px] text-cream-500 hover:text-up"
                              onClick={(event) => {
                                event.stopPropagation();
                                dispatch({ type: "removeItem", id: item.id });
                              }}
                              aria-label={item.stkCd + " 관심종목에서 제거"}
                              disabled={isWatchlistPending}
                            >
                              ×
                            </button>
                          </div>
                        </td>
                      );
                    }
                    if (column === "code") {
                      return (
                        <td key={column} data-watchlist-column={column} className="min-w-0 px-1 py-0.5 font-mono">
                          <span className="inline-flex max-w-full items-center gap-1">
                            <span className="truncate">{item.stkCd}</span>
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={column} data-watchlist-column={column} className={"whitespace-nowrap px-1 py-0.5 font-mono " + (column === "venue" ? "text-left" : "text-right") + (column === "change" || column === "changePct" ? " " + changeClass(column === "change" ? quote?.change : quote?.changePct) : " text-cream-300")}>
                        {renderColumnValue(column, item, quote)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {rows.length === 0 && Array.from({ length: 18 }, (_, index) => (
              <tr className="watchlist-empty-row" key={`empty-${index}`} aria-hidden="true">
                {panelPreferences.columns.map((column) => <td key={column} />)}
              </tr>
            ))}
          </tbody>
        </table>

        {items.length > QUOTES_PER_PAGE && (
          <div className="sticky bottom-0 flex items-center justify-between border-t border-ink-800 bg-[#101925] px-2 py-1 text-[10px] text-cream-500">
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={currentPage === 0}>
              이전
            </button>
            <span>{currentPage + 1}/{pageCount}쪽 · 이 쪽 100종목만 수신</span>
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" type="button" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={currentPage >= pageCount - 1}>
              다음
            </button>
          </div>
        )}

        {items.length === 0 && (
          <div className="mx-2 my-5 border border-ink-700 bg-ink-950/60 p-3 text-center">
            <p className="text-xs text-cream-300">이 그룹은 비어 있습니다.</p>
            {state.mode === "fixture" ? (
              <>
                <p className="mt-1 text-[10px] text-cream-500">샘플 종목은 선택할 때만 이 그룹에 서버 저장을 요청합니다.</p>
                <div className="mt-2 flex justify-center gap-1">
                  {(["KR", "US"] as const).map((market) => {
                    const example = defaultInstrument(market, "fixture");
                    return (
                      <button key={market} type="button" className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" onClick={() => addInstrument(example)} disabled={isWatchlistPending}>
                        {example.stkNm} 추가
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="mt-1 text-[10px] text-cream-500">위 검색창에서 확인한 종목만 추가할 수 있습니다.</p>
            )}
          </div>
        )}
      </div>

      {state.watchlistNote && <p className="shrink-0 border-t border-ink-800 px-2 py-1 text-[10px] text-cream-500" role="status">{state.watchlistNote}</p>}
    </section>
  );
}

function SortHeader({
  label,
  column,
  current,
  direction,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  current: SortKey;
  direction: SortDirection;
  onSort: (column: SortKey) => void;
  className: string;
}) {
  const active = current === column;
  return (
    <th scope="col" data-watchlist-column={column} className={"h-6 px-1 " + className}>
      <button type="button" className="inline-flex max-w-full items-center gap-0.5 hover:text-cream-50" onClick={() => onSort(column)} aria-label={label + " 정렬"}>
        <span className="truncate">{label}</span>
        <span className={active ? "text-[#e5ad39]" : "text-cream-500"} aria-hidden="true">{active ? (direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function columnLabel(column: WatchlistColumn) {
  return {
    name: "종목명",
    code: "코드",
    last: "현재가",
    change: "등락",
    changePct: "등락률",
    volume: "거래량",
    open: "시가",
    high: "고가",
    low: "저가",
    prevClose: "전일종가",
    venue: "거래소",
  }[column];
}

function columnWidth(column: WatchlistColumn) {
  switch (column) {
    case "name":
      return 120;
    case "code":
      return 90;
    case "last":
    case "open":
    case "high":
    case "low":
    case "prevClose":
      return 100;
    case "change":
      return 100;
    case "changePct":
      return 80;
    case "volume":
      return 80;
    case "venue":
      return 85;
  }
}

function tableMinWidth(columns: WatchlistColumn[]) {
  return columns.reduce((total, column) => total + columnWidth(column), 0);
}

function renderColumnValue(column: WatchlistColumn, item: Instrument, quote: Quote | null) {
  switch (column) {
    case "last":
      return formatPrice(quote?.last ?? null, item.currency);
    case "change":
      return formatSignedPrice(quote?.change ?? null, item.currency);
    case "changePct":
      return formatPct(quote?.changePct ?? null);
    case "volume":
      return formatQty(quote?.volume ?? null);
    case "open":
      return formatPrice(quote?.open ?? null, item.currency);
    case "high":
      return formatPrice(quote?.high ?? null, item.currency);
    case "low":
      return formatPrice(quote?.low ?? null, item.currency);
    case "prevClose":
      return formatPrice(quote?.prevClose ?? null, item.currency);
    case "venue":
      return item.listingVenue;
    case "name":
    case "code":
      return "—";
  }
}

function preferencesEqual(left: WatchlistPreferences, right: WatchlistPreferences) {
  return left.groupId === right.groupId && left.sortKey === right.sortKey && left.sortDirection === right.sortDirection && left.columns.length === right.columns.length && left.columns.every((column, index) => column === right.columns[index]);
}

function compareRows(
  left: { item: Instrument; index: number; quote: Quote | null; quoteError: string },
  right: { item: Instrument; index: number; quote: Quote | null; quoteError: string },
  sortKey: SortKey,
  direction: SortDirection,
) {
  const leftValue = rowValue(left.item, left.quote, sortKey);
  const rightValue = rowValue(right.item, right.quote, sortKey);
  if (leftValue === null && rightValue === null) return left.index - right.index;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  const compared = typeof leftValue === "string" && typeof rightValue === "string" ? leftValue.localeCompare(rightValue, "ko") : Number(leftValue) - Number(rightValue);
  return direction === "asc" ? compared : -compared;
}

function rowValue(item: Instrument, quote: Quote | null, sortKey: SortKey) {
  switch (sortKey) {
    case "name":
      return item.stkNm;
    case "code":
      return item.stkCd;
    case "last":
      return quote?.last ?? null;
    case "change":
      return quote?.change ?? null;
    case "changePct":
      return quote?.changePct ?? null;
    case "volume":
      return quote?.volume ?? null;
    case "open":
      return quote?.open ?? null;
    case "high":
      return quote?.high ?? null;
    case "low":
      return quote?.low ?? null;
    case "prevClose":
      return quote?.prevClose ?? null;
    case "venue":
      return item.listingVenue;
  }
}

function indicatorClass(quote: Quote | null, error: string) {
  if (error || quote?.status === "error" || quote?.status === "missing" || quote?.status === "stale") return "text-[#e5ad39]";
  if (!quote) return "text-cream-500";
  return quote.status === "live" ? "text-up" : "text-down";
}

function indicatorTitle(quote: Quote | null, error: string) {
  if (error) return "출처: 미수신 · 상태: " + error;
  if (!quote) return "출처: 미수신 · 상태: 시세 수신 대기";
  return "출처: " + (quote.source === "kiwoom" ? "키움" : "샘플") + " · 환경: " + environmentLabel(quote.environment) + " · 상태: " + statusLabel(quote.status);
}

function environmentLabel(environment: Instrument["environment"]) {
  return { fixture: "샘플", demo: "데모", real: "실환경" }[environment];
}

function statusLabel(status: Quote["status"]) {
  return { snapshot: "스냅샷", live: "실시간", stale: "지연", missing: "미수신", error: "오류" }[status];
}
