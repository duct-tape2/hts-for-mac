"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, isAbortError } from "@/lib/api";
import { changeClass, formatPct, formatPrice, formatQty } from "@/lib/format";
import {
  collectLocalScannerQuotes,
  filterLocalScannerRows,
  localScannerCounts,
  localScannerCsv,
  localScannerRows,
  localScannerUniverse,
  parseLocalScannerFilters,
  sortLocalScannerRows,
  type LocalScannerFilters,
  type LocalScannerRow,
  type LocalScannerSort,
} from "@/lib/localScanner";
import { useStore } from "@/lib/store";
import type { Instrument } from "@/lib/types";
import "./localScanner.css";

export type LocalScannerProps = {
  instrument: Instrument;
  active?: boolean;
  onPick?: (instrument: Instrument) => void;
  refreshKey?: number;
};

type ScanState = { key: string; loading: boolean; rows: LocalScannerRow[]; error: string | null };
const emptyScan: ScanState = { key: "", loading: false, rows: [], error: null };
const initialFilters: LocalScannerFilters = { minPrice: "", minChangePct: "", minVolume: "" };

function requestKey(instrument: Instrument, groupId: string, universe: Instrument[], refreshKey: number, manualRefresh: number) {
  return [instrument.market, instrument.currency, instrument.environment, groupId, universe.map((item) => `${item.stkCd}:${item.listingVenue}:${item.quoteVenue}:${item.environment}`).join(","), refreshKey, manualRefresh].join("|");
}

export function LocalScanner({ instrument, active = true, onPick, refreshKey = 0 }: LocalScannerProps) {
  const { state } = useStore();
  const [groupId, setGroupId] = useState("");
  const [manualRefresh, setManualRefresh] = useState(0);
  const [filters, setFilters] = useState<LocalScannerFilters>(initialFilters);
  const [sort, setSort] = useState<LocalScannerSort>({ key: "name", direction: "asc" });
  const [scan, setScan] = useState<ScanState>(emptyScan);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    setGroupId((current) => state.watchlists.some((group) => group.id === current) ? current : state.selectedWatchlistId || state.watchlists[0]?.id || "");
  }, [state.selectedWatchlistId, state.watchlists]);

  const universe = useMemo(
    () => localScannerUniverse(state.items, groupId, instrument, state.mode),
    [groupId, instrument, state.items, state.mode],
  );
  const key = requestKey(instrument, groupId, universe, refreshKey, manualRefresh);

  useEffect(() => {
    if (!active || !groupId) return;
    const controller = new AbortController();
    const requestId = ++sequence.current;
    setScan({ key, loading: true, rows: [], error: null });
    void collectLocalScannerQuotes(universe, api.quote, controller.signal)
      .then((responses) => {
        if (requestId === sequence.current) setScan({ key, loading: false, rows: localScannerRows(universe, responses), error: null });
      })
      .catch((error: unknown) => {
        if (!isAbortError(error) && requestId === sequence.current) {
          setScan({ key, loading: false, rows: [], error: "관심종목 시세를 모두 받지 못했습니다." });
        }
      });
    return () => controller.abort();
  }, [active, groupId, key, universe]);

  const currentRows = scan.key === key ? scan.rows : [];
  const counts = useMemo(() => localScannerCounts(currentRows), [currentRows]);
  const parsedFilters = useMemo(() => parseLocalScannerFilters(filters), [filters]);
  const rows = useMemo(
    () => parsedFilters.error ? [] : sortLocalScannerRows(filterLocalScannerRows(currentRows, parsedFilters.values), sort),
    [currentRows, parsedFilters, sort],
  );

  useEffect(() => {
    if (!focusedId || !rows.some((row) => row.instrument.stkCd === focusedId)) setFocusedId(null);
  }, [focusedId, rows]);

  function toggleSort(next: LocalScannerSort["key"]) {
    setSort((current) => current.key === next ? { key: next, direction: current.direction === "asc" ? "desc" : "asc" } : { key: next, direction: "asc" });
  }

  function navigate(event: KeyboardEvent<HTMLTableElement>) {
    // A key from a sortable column button must not also select a result row.
    if (event.target !== event.currentTarget) return;
    if (!rows.length) return;
    const index = focusedId ? rows.findIndex((row) => row.instrument.stkCd === focusedId) : -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      setFocusedId(rows[next].instrument.stkCd);
    } else if (event.key === "Enter") {
      const row = rows.find((candidate) => candidate.instrument.stkCd === focusedId) ?? rows[0];
      event.preventDefault();
      onPick?.(row.instrument);
    }
  }

  async function copyCsv() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(localScannerCsv(rows));
      setCopyError(null);
    } catch {
      setCopyError("클립보드에 복사하지 못했습니다.");
    }
  }

  function downloadCsv() {
    const blob = new Blob([localScannerCsv(rows)], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "local-watchlist-scan.csv";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  if (!active) return <div className="local-scanner local-scanner-empty">비활성 패널입니다. 로컬 스캔을 중지했습니다.</div>;

  return (
    <section className="local-scanner" aria-label="로컬 관심종목 스캐너">
      <div className="local-scanner-toolbar">
        <strong>로컬 스캐너</strong>
        <label>관심그룹
          <select aria-label="관심그룹" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            {state.watchlists.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <span className="local-scanner-market">{instrument.market} · {instrument.currency}</span>
        <button className="local-scanner-button" type="button" onClick={() => setManualRefresh((current) => current + 1)} disabled={scan.loading || !universe.length}>로컬 시세 조회</button>
      </div>
      <p className="local-scanner-disclosure">선택 관심그룹의 현재 {instrument.market}/{instrument.currency} 종목 {universe.length}개만 조회합니다. 전체시장 조건 검색이 아닙니다.</p>

      <div className="local-scanner-filters">
        <label>최소 현재가 <input aria-label="최소 현재가" type="number" value={filters.minPrice} onChange={(event) => setFilters((current) => ({ ...current, minPrice: event.target.value }))} /></label>
        <label>최소 등락률(%) <input aria-label="최소 등락률" type="number" value={filters.minChangePct} onChange={(event) => setFilters((current) => ({ ...current, minChangePct: event.target.value }))} /></label>
        <label>최소 거래량 <input aria-label="최소 거래량" type="number" value={filters.minVolume} onChange={(event) => setFilters((current) => ({ ...current, minVolume: event.target.value }))} /></label>
        <button className="local-scanner-button" type="button" onClick={() => setFilters(initialFilters)}>조건 지우기</button>
      </div>
      {parsedFilters.error && <p className="local-scanner-error" role="alert">{parsedFilters.error}</p>}

      <div className="local-scanner-status">
        <span>수신 가능 {counts.ready}/{universe.length}</span>
        <span>오래된 시세 {counts.stale}</span>
        <span>미수신·오류 {counts.unavailable}</span>
        <span>조건 일치 {rows.length}</span>
        <button className="local-scanner-button" type="button" onClick={() => void copyCsv()} disabled={!rows.length}>CSV 복사</button>
        <button className="local-scanner-button" type="button" onClick={downloadCsv} disabled={!rows.length}>CSV 저장</button>
      </div>
      {copyError && <p className="local-scanner-error" role="alert">{copyError}</p>}
      {scan.loading && <p className="local-scanner-empty">관심종목 시세를 조회하는 중… (동시 최대 2건)</p>}
      {scan.error && <p className="local-scanner-error" role="alert">{scan.error}</p>}
      {!scan.loading && !scan.error && !universe.length && <p className="local-scanner-empty">이 관심그룹에 현재 시장·통화와 일치하는 저장 종목이 없습니다.</p>}
      {!scan.loading && !scan.error && universe.length > 0 && <div className="local-scanner-table-wrap">
        <table className="local-scanner-table" role="grid" aria-label="로컬 관심종목 스캔 결과" tabIndex={0} onKeyDown={navigate}>
          <thead><tr>
            <th><button type="button" onClick={() => toggleSort("name")}>종목명</button></th>
            <th><button type="button" onClick={() => toggleSort("last")}>현재가</button></th>
            <th><button type="button" onClick={() => toggleSort("changePct")}>등락률</button></th>
            <th><button type="button" onClick={() => toggleSort("volume")}>거래량</button></th>
            <th>출처</th>
          </tr></thead>
          <tbody>{rows.length ? rows.map((row) => <tr key={`${row.instrument.stkCd}:${row.instrument.listingVenue}`} className={focusedId === row.instrument.stkCd ? "selected" : ""} onClick={() => { setFocusedId(row.instrument.stkCd); onPick?.(row.instrument); }}>
            <td>{row.instrument.stkNm}<small>{row.instrument.stkCd}</small></td>
            <td>{formatPrice(row.quote?.last ?? null, row.instrument.currency)}</td>
            <td className={changeClass(row.quote?.changePct)}>{formatPct(row.quote?.changePct ?? null)}</td>
            <td>{formatQty(row.quote?.volume ?? null)}</td>
            <td>{row.quote?.source ?? "—"}</td>
          </tr>) : <tr><td className="local-scanner-empty-cell" colSpan={5}>수신된 로컬 시세 중 조건과 일치하는 종목이 없습니다.</td></tr>}</tbody>
        </table>
      </div>}
    </section>
  );
}
