"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatPrice, formatReceivedAt, formatVol } from "@/lib/format";
import type { Instrument } from "@/lib/types";
import "./marketJournal.css";

type Level = { price: number; qty: number | null };
export type MarketJournalEvent = {
  sequence: number;
  kind: "trade" | "book";
  eventType: string;
  receivedAt: string;
  sourceTime: { rawTradeDate: string | null; rawTradeTime: string | null; rawLocalTradeTime: string | null; timestampStatus: string | null } | null;
  connectionEpoch: number;
  last: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  asks: Level[];
  bids: Level[];
  gapBefore: string | null;
};
export type MarketJournal = {
  events: MarketJournalEvent[];
  oldestSequence: number | null;
  latestSequence: number;
  gap: boolean;
  truncated: boolean;
  transportGap: string | null;
  retention: number;
  sequenceSemantics: string;
};

type Props = { instrument: Instrument; active?: boolean; refreshKey?: number };
type ReplaySnapshot = { last: number | null; volume: number | null; asks: Level[]; bids: Level[]; sequence: number | null };
const MAX_EVENTS = 256;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
}

function levels(value: unknown): Level[] | null {
  if (!Array.isArray(value)) return null;
  const result: Level[] = [];
  for (const entry of value) {
    const row = object(entry);
    const price = row && finite(row.price);
    const qty = row && (row.qty === null ? null : finite(row.qty));
    if (!row || price === null || (row.qty !== null && qty === null)) return null;
    result.push({ price, qty });
  }
  return result;
}

function sourceTime(value: unknown): MarketJournalEvent["sourceTime"] | undefined {
  if (value === null || value === undefined) return null;
  const row = object(value);
  if (!row) return undefined;
  const rawTradeDate = nullableString(row.rawTradeDate);
  const rawTradeTime = nullableString(row.rawTradeTime);
  const rawLocalTradeTime = nullableString(row.rawLocalTradeTime);
  const timestampStatus = nullableString(row.timestampStatus);
  return rawTradeDate === undefined || rawTradeTime === undefined || rawLocalTradeTime === undefined || timestampStatus === undefined
    ? undefined
    : { rawTradeDate, rawTradeTime, rawLocalTradeTime, timestampStatus };
}

function event(value: unknown): MarketJournalEvent | null {
  const row = object(value);
  const sequence = row && finite(row.sequence);
  const kind = row?.kind === "trade" || row?.kind === "book" ? row.kind : null;
  const eventType = row && typeof row.eventType === "string" ? row.eventType : null;
  const receivedAt = row && typeof row.receivedAt === "string" && Number.isFinite(Date.parse(row.receivedAt)) ? row.receivedAt : null;
  const connectionEpoch = row && finite(row.connectionEpoch);
  const nextSourceTime = sourceTime(row?.sourceTime);
  const asks = levels(row?.asks ?? []);
  const bids = levels(row?.bids ?? []);
  const number = (key: string) => row?.[key] === null || row?.[key] === undefined ? null : finite(row?.[key]);
  const last = number("last"), change = number("change"), changePct = number("changePct"), volume = number("volume");
  if (!row || sequence === null || !Number.isInteger(sequence) || sequence < 1 || !kind || eventType === null || !receivedAt || connectionEpoch === null || !Number.isInteger(connectionEpoch) || connectionEpoch < 0 || nextSourceTime === undefined || !asks || !bids || last === null && row.last !== null && row.last !== undefined || change === null && row.change !== null && row.change !== undefined || changePct === null && row.changePct !== null && row.changePct !== undefined || volume === null && row.volume !== null && row.volume !== undefined) return null;
  const gap = row.gapBefore;
  return { sequence, kind, eventType, receivedAt, sourceTime: nextSourceTime, connectionEpoch, last, change, changePct, volume, asks, bids, gapBefore: gap && typeof gap === "object" ? "transport reconnect or failure" : null };
}

function sameIdentity(value: unknown, instrument: Instrument) {
  const row = object(value);
  return Boolean(row && row.market === instrument.market && row.stkCd === instrument.stkCd && row.stexTp === instrument.stexTp && row.listingVenue === instrument.listingVenue && row.quoteVenue === instrument.quoteVenue && (row.environment === undefined || row.environment === instrument.environment));
}

/** Strictly parses the bounded local arrival journal. It rejects another symbol's response. */
export function parseMarketJournal(value: unknown, instrument: Instrument): MarketJournal | null {
  const row = object(value);
  if (!row || !sameIdentity(row.identity, instrument) || !Array.isArray(row.events) || !Number.isInteger(row.latestSequence) || (row.oldestSequence !== null && !Number.isInteger(row.oldestSequence)) || typeof row.gap !== "boolean" || typeof row.truncated !== "boolean" || !Number.isInteger(row.retention) || typeof row.sequenceSemantics !== "string") return null;
  const events = row.events.map(event);
  if (events.some((item) => !item)) return null;
  const parsed = events as MarketJournalEvent[];
  if (parsed.some((item, index) => index > 0 && item.sequence <= parsed[index - 1].sequence)) return null;
  return {
    events: parsed,
    oldestSequence: row.oldestSequence as number | null,
    latestSequence: row.latestSequence as number,
    gap: row.gap,
    truncated: row.truncated,
    transportGap: row.transportGap && typeof row.transportGap === "object" ? "transport reconnect or failure" : null,
    retention: row.retention as number,
    sequenceSemantics: row.sequenceSemantics,
  };
}

/** Dedupe by local arrival sequence and retain the same bounded count as the backend tape. */
export function mergeMarketJournalEvents(current: readonly MarketJournalEvent[], incoming: readonly MarketJournalEvent[]) {
  const bySequence = new Map<number, MarketJournalEvent>();
  [...current, ...incoming].forEach((item) => bySequence.set(item.sequence, item));
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-MAX_EVENTS);
}

/** Replay is an observed local snapshot, never an inferred provider/exchange state. */
export function replayMarketJournal(events: readonly MarketJournalEvent[], throughIndex: number): ReplaySnapshot {
  const snapshot: ReplaySnapshot = { last: null, volume: null, asks: [], bids: [], sequence: null };
  for (const entry of events.slice(0, Math.max(0, throughIndex) + 1)) {
    if (entry.last !== null) snapshot.last = entry.last;
    if (entry.volume !== null) snapshot.volume = entry.volume;
    if (entry.asks.length) snapshot.asks = entry.asks;
    if (entry.bids.length) snapshot.bids = entry.bids;
    snapshot.sequence = entry.sequence;
  }
  return snapshot;
}

function identityKey(instrument: Instrument) {
  return [instrument.environment, instrument.market, instrument.stkCd, instrument.stexTp, instrument.listingVenue, instrument.quoteVenue].join("|");
}

function rawSourceTime(value: MarketJournalEvent["sourceTime"]) {
  if (!value) return "원본 시각 미수신";
  const parts = [value.rawTradeDate, value.rawTradeTime, value.rawLocalTradeTime].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : value.timestampStatus || "원본 시각 미수신";
}

function best(levels: Level[], side: "ask" | "bid") {
  const selected = levels.reduce<Level | null>((current, level) => {
    if (!current) return level;
    return side === "ask" ? level.price < current.price ? level : current : level.price > current.price ? level : current;
  }, null);
  return selected ? `${selected.price.toLocaleString()}${selected.qty === null ? "" : `/${selected.qty.toLocaleString()}`}` : "—";
}

export function marketJournalCsvCell(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function MarketJournal({ instrument, active = true, refreshKey = 0 }: Props) {
  const identity = identityKey(instrument);
  const [events, setEvents] = useState<MarketJournalEvent[]>([]);
  const [journal, setJournal] = useState<Omit<MarketJournal, "events"> | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const cursorRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const fetchingRef = useRef<number | null>(null);

  useEffect(() => {
    cursorRef.current = null;
    requestRef.current += 1;
    setEvents([]);
    setJournal(null);
    setError("");
    setReplayIndex(0);
  }, [identity, refreshKey]);

  useEffect(() => {
    if (!paused) setReplayIndex(Math.max(0, events.length - 1));
  }, [events.length, paused]);

  useEffect(() => {
    if (!active || paused) return;
    let closed = false;
    let controller: AbortController | null = null;
    const request = ++requestRef.current;
    const read = async () => {
      if (closed || fetchingRef.current === request || document.visibilityState === "hidden") return;
      fetchingRef.current = request;
      controller?.abort();
      controller = new AbortController();
      const params = new URLSearchParams({ market: instrument.market, stk_cd: instrument.stkCd, stex_tp: instrument.stexTp, listing_venue: instrument.listingVenue, limit: String(MAX_EVENTS) });
      if (cursorRef.current !== null) params.set("after_sequence", String(cursorRef.current));
      try {
        const response = await fetch(`/api/market/events?${params.toString()}`, { signal: controller.signal });
        const body: unknown = await response.json();
        if (!response.ok) {
          const detail = object(body)?.detail;
          throw new Error(typeof detail === "string" ? detail : "관찰 기록을 불러오지 못했습니다.");
        }
        const next = parseMarketJournal(body, instrument);
        if (!next) throw new Error("관찰 기록 응답 형식 또는 종목 식별자가 올바르지 않습니다.");
        if (closed || request !== requestRef.current) return;
        cursorRef.current = Math.max(cursorRef.current ?? 0, next.latestSequence);
        setEvents((current) => mergeMarketJournalEvents(current, next.events));
        setJournal({ oldestSequence: next.oldestSequence, latestSequence: next.latestSequence, gap: next.gap, truncated: next.truncated, transportGap: next.transportGap, retention: next.retention, sequenceSemantics: next.sequenceSemantics });
        setError("");
      } catch (reason) {
        if (!closed && request === requestRef.current && !(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "관찰 기록을 불러오지 못했습니다.");
      } finally {
        if (fetchingRef.current === request) fetchingRef.current = null;
      }
    };
    const onVisibility = () => { if (document.visibilityState !== "hidden") void read(); };
    void read();
    const timer = window.setInterval(() => void read(), 1_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { closed = true; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [active, identity, instrument.market, instrument.stkCd, instrument.stexTp, instrument.listingVenue, paused, refreshKey]);

  const replay = useMemo(() => replayMarketJournal(events, replayIndex), [events, replayIndex]);
  const hasGap = Boolean(journal?.gap || journal?.truncated || journal?.transportGap || events.some((entry) => entry.gapBefore));
  const exportCsv = useCallback(() => {
    if (!events.length || typeof URL.createObjectURL !== "function") return;
    const content = [
      ["sequence", "kind", "event_type", "received_at", "raw_trade_date", "raw_trade_time", "raw_local_trade_time", "last", "change", "change_pct", "volume", "best_ask", "best_bid"].map(marketJournalCsvCell).join(","),
      ...events.map((entry) => [entry.sequence, entry.kind, entry.eventType, entry.receivedAt, entry.sourceTime?.rawTradeDate, entry.sourceTime?.rawTradeTime, entry.sourceTime?.rawLocalTradeTime, entry.last, entry.change, entry.changePct, entry.volume, best(entry.asks, "ask"), best(entry.bids, "bid")].map(marketJournalCsvCell).join(",")),
    ].join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${instrument.market}-${instrument.stkCd}-received-events.csv`; anchor.click();
    URL.revokeObjectURL(url);
  }, [events, instrument.market, instrument.stkCd]);

  return <section className="market-journal" aria-label="수신 이벤트 기록">
    <header>
      <div><h2>수신 이벤트 기록</h2><span>{instrument.stkCd} · {instrument.stkNm} · 최대 {journal?.retention ?? MAX_EVENTS}건</span></div>
      <div className="market-journal-actions">
        <button type="button" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? "재개" : "일시정지"}</button>
        <button type="button" onClick={exportCsv} disabled={!events.length}>CSV</button>
      </div>
    </header>
    {hasGap && <p className="market-journal-gap" role="alert">기록 공백 또는 보존 한계 감지: 누락된 이벤트를 복원하거나 과거 시장 이력으로 해석하지 않습니다.</p>}
    <div className="market-journal-replay" aria-label="수신 이벤트 재생">
      <label>재생 위치 <input aria-label="수신 이벤트 재생 위치" type="range" min="0" max={Math.max(0, events.length - 1)} value={Math.min(replayIndex, Math.max(0, events.length - 1))} disabled={!events.length} onChange={(event) => { setPaused(true); setReplayIndex(Number(event.currentTarget.value)); }} /></label>
      <span>수신 순번 {replay.sequence ?? "—"} · 실제 수신 이벤트 스냅샷</span>
      <span>가격 {formatPrice(replay.last, instrument.currency)} · 거래량 {formatVol(replay.volume)} · 매도 {best(replay.asks, "ask")} · 매수 {best(replay.bids, "bid")}</span>
    </div>
    <div className="market-journal-table-wrap">
      <table>
        <thead><tr><th>수신순번</th><th>유형</th><th>앱 수신</th><th>원본 시각(원문)</th><th>현재가</th><th>대비</th><th>거래량</th><th>최우선 호가</th></tr></thead>
        <tbody>{events.map((entry, index) => <tr key={entry.sequence} aria-current={index === replayIndex}>
          <td>{entry.sequence}</td><td>{entry.kind === "trade" ? `체결 ${entry.eventType}` : `호가 ${entry.eventType}`}{entry.gapBefore ? " · 공백 후" : ""}</td>
          <td>{formatReceivedAt(entry.receivedAt)}</td><td title={entry.sourceTime?.timestampStatus ?? undefined}>{rawSourceTime(entry.sourceTime)}</td>
          <td>{formatPrice(entry.last, instrument.currency)}</td><td>{entry.change === null ? "—" : entry.change.toLocaleString()}</td><td>{formatVol(entry.volume)}</td><td>매도 {best(entry.asks, "ask")} / 매수 {best(entry.bids, "bid")}</td>
        </tr>)}
        {!events.length && <tr><td colSpan={8} className="market-journal-empty" role={error ? "alert" : "status"}>{error || (active ? "수신 이벤트 대기 중…" : "비활성 패널: 수신 기록 조회를 멈췄습니다.")}</td></tr>}
        </tbody>
      </table>
    </div>
    <footer>{journal?.sequenceSemantics || "local process arrival order; not provider or exchange order"} · 수신 시작 전 및 보존 범위 밖의 이력은 이 화면에 없습니다.</footer>
  </section>;
}
