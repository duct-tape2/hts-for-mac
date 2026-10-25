"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAuthStatus, isCredentialAbortError } from "@/lib/credentials";
import { api } from "@/lib/api";
import type { Exchange, Instrument } from "@/lib/types";
import "./conditionPanel.css";

export type ConditionPanelProps = { instrument: Instrument; active?: boolean; onPick?: (instrument: Instrument) => void };
type Condition = { seq: string; name: string };
type ResultRow = { item: string | null; name: string | null; exchange: string | null; fields: Record<string, string> };
type ConditionResult = { rows: ResultRow[]; complete: boolean; note: string; source?: string; status?: string; live?: { state?: string; registrationId?: string } };
type ConditionStatus = { active: boolean; state: string; note: string; reason?: string | null; registrationId: string | null; events: MembershipEvent[] };
type MembershipEvent = { sequence: number; action: string; item: string | null; name: string | null; receivedAt: string; timeNote?: string };
type OwnedSubscription = { market: Instrument["market"]; seq: string; registrationId: string; token: string };

const US_VENUES: Record<string, { exchange: Exchange; listingVenue: Instrument["listingVenue"] }> = {
  ND: { exchange: "ND", listingVenue: "NASDAQ" }, NY: { exchange: "NY", listingVenue: "NYSE" }, NA: { exchange: "NA", listingVenue: "AMEX" },
};
const REGISTRATION_ID = /^[0-9a-f]{32}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseConditions(value: unknown): Condition[] {
  if (!record(value) || !Array.isArray(value.conditions)) throw new Error("조건식 목록을 확인하지 못했습니다.");
  return value.conditions.flatMap((entry) => record(entry) && /^\d{1,20}$/.test(String(entry.seq)) && text(entry.name)
    ? [{ seq: String(entry.seq), name: String(entry.name).trim() }] : []);
}

function parseResult(value: unknown): ConditionResult {
  if (!record(value) || !Array.isArray(value.rows)) throw new Error("조건식 결과를 확인하지 못했습니다.");
  const live = record(value.live) ? {
    state: text(value.live.state) ?? undefined,
    registrationId: text(value.live.registrationId) ?? undefined,
  } : undefined;
  if (live?.state === "active" && (!live.registrationId || !REGISTRATION_ID.test(live.registrationId))) {
    throw new Error("조건식 실시간 등록 식별자를 확인하지 못했습니다.");
  }
  return {
    rows: value.rows.flatMap((entry) => {
      if (!record(entry) || !record(entry.fields)) return [];
      const fields: Record<string, string> = {};
      for (const [key, item] of Object.entries(entry.fields)) if (typeof item === "string") fields[key] = item;
      return [{ item: text(entry.item), name: text(entry.name), exchange: text(entry.exchange), fields }];
    }),
    complete: value.complete === true,
    note: text(value.note) ?? "",
    source: text(value.source) ?? undefined,
    status: text(value.status) ?? undefined,
    live,
  };
}

function parseStatus(value: unknown): ConditionStatus {
  if (
    !record(value)
    || typeof value.active !== "boolean"
    || !text(value.state)
    || !Array.isArray(value.events)
    || (value.registrationId !== null && (typeof value.registrationId !== "string" || !REGISTRATION_ID.test(value.registrationId)))
  ) throw new Error("조건식 실시간 상태를 확인하지 못했습니다.");
  return {
    active: value.active,
    state: String(value.state),
    note: text(value.note) ?? "",
    reason: text(value.reason),
    registrationId: value.registrationId,
    events: value.events.flatMap((entry) => record(entry) && Number.isInteger(entry.sequence) && text(entry.action) && text(entry.receivedAt)
      ? [{ sequence: Number(entry.sequence), action: String(entry.action), item: text(entry.item), name: text(entry.name), receivedAt: String(entry.receivedAt), timeNote: text(entry.timeNote) ?? undefined }] : []),
  };
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store", credentials: "omit", headers: { Accept: "application/json", ...(init.headers ?? {}) } });
  } catch (cause) {
    if (isCredentialAbortError(cause)) throw cause;
    throw new Error("조건식 요청을 완료하지 못했습니다.");
  }
  if (!response.ok) throw new Error(response.status === 403 ? "조건식 실행 권한을 새로 확인한 뒤 다시 시도하세요." : "조건식 요청을 완료하지 못했습니다.");
  try { return await response.json(); } catch { throw new Error("조건식 응답을 확인하지 못했습니다."); }
}

function pickableInstrument(row: ResultRow, current: Instrument): Instrument | null {
  const raw = (current.market === "KR" ? (row.item ?? "").replace(/^A(?=[0-9A-Z]{6}$)/i, "") : row.item ?? "").toUpperCase();
  if (current.market === "KR") {
    if (!/^[0-9A-Z]{6}$/.test(raw) || raw !== current.stkCd) return null;
    return { ...current, stkNm: row.name ?? current.stkNm };
  }
  const venue = row.exchange ? US_VENUES[row.exchange.toUpperCase()] : undefined;
  if (!venue || !/^[A-Z][A-Z0-9.]{0,14}$/.test(raw)) return null;
  return { market: "US", stkCd: raw, stkNm: row.name ?? raw, stexTp: venue.exchange, quoteVenue: venue.exchange, listingVenue: venue.listingVenue, currency: "USD", environment: current.environment };
}

function plainError(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function ConditionPanel({ instrument, active = true, onPick }: ConditionPanelProps) {
  const market = instrument.market;
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [selected, setSelected] = useState<Condition | null>(null);
  const [result, setResult] = useState<ConditionResult | null>(null);
  const [status, setStatus] = useState<ConditionStatus | null>(null);
  const [loading, setLoading] = useState<"list" | "result" | "live" | "stop" | null>(null);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const resultAbort = useRef<AbortController | null>(null);
  const owned = useRef<OwnedSubscription | null>(null);
  const [ownedSeq, setOwnedSeq] = useState<string | null>(null);
  const mounted = useRef(false);
  const lifecycleGeneration = useRef(0);
  const currentMarket = useRef(market);
  const currentActive = useRef(active);
  currentMarket.current = market;
  currentActive.current = active;

  const selectionGeneration = useRef(0);
  useEffect(() => { selectionGeneration.current += 1; return () => { selectionGeneration.current += 1; }; }, [market]);
  async function openResult(row: ResultRow) {
    const direct = pickableInstrument(row, instrument);
    if (direct) { onPick?.(direct); return; }
    const code = market === "KR" ? (row.item ?? "").replace(/^A(?=[0-9A-Z]{6}$)/i, "") : row.item ?? "";
    if (!code) return;
    const generation = ++selectionGeneration.current;
    try {
      const result = await api.searchSymbols(code, market);
      if (generation !== selectionGeneration.current) return;
      const matches = result.results.filter((item) => item.stkCd === code && item.market === market && item.environment === instrument.environment);
      if (matches.length !== 1) throw new Error("종목의 거래소를 확인하지 못했습니다. 종목 검색에서 선택하세요.");
      onPick?.(matches[0]);
    } catch { if (generation === selectionGeneration.current) setError("종목정보를 확인하지 못했습니다. 검색에서 종목을 선택하세요."); }
  }

  const columns = useMemo(() => [...new Set(result?.rows.flatMap((row) => Object.keys(row.fields)) ?? [])].sort(), [result]);

  const loadResult = useCallback(async (condition: Condition) => {
    resultAbort.current?.abort();
    const controller = new AbortController();
    resultAbort.current = controller;
    const sequence = ++requestId.current;
    setSelected(condition); setLoading("result"); setError(""); setResult(null); setStatus(null);
    try {
      const next = parseResult(await request(`/api/conditions/${market}/result?seq=${encodeURIComponent(condition.seq)}`, { signal: controller.signal }));
      if (mounted.current && sequence === requestId.current) setResult(next);
    } catch (cause) {
      if (!isCredentialAbortError(cause) && mounted.current && sequence === requestId.current) setError(plainError(cause, "조건식 결과를 확인하지 못했습니다."));
    } finally {
      if (mounted.current && sequence === requestId.current) setLoading(null);
    }
  }, [market]);

  const refreshList = useCallback(async () => {
    const sequence = ++requestId.current;
    setListLoaded(false); setLoading("list"); setError(""); setConditions([]); setSelected(null); setResult(null); setStatus(null);
    try {
      const next = parseConditions(await request(`/api/conditions/${market}/list`));
      if (mounted.current && sequence === requestId.current) { setConditions(next); setListLoaded(true); }
    } catch (cause) {
      if (mounted.current && sequence === requestId.current) setError(plainError(cause, "조건식 목록을 확인하지 못했습니다."));
    } finally {
      if (mounted.current && sequence === requestId.current) setLoading(null);
    }
  }, [market]);

  const stopOwned = useCallback(async (subscription: OwnedSubscription, keepalive = false) => {
    const response = await request(`/api/conditions/${subscription.market}/unsubscribe`, {
      method: "POST", keepalive, headers: { "Content-Type": "application/json", "X-HTS-Setup": subscription.token }, body: JSON.stringify({ seq: subscription.seq, registrationId: subscription.registrationId }),
    });
    return response;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifecycleGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    lifecycleGeneration.current += 1;
    if (!active) {
      // Hiding a tab keeps an already-active owned registration by design,
      // but makes any in-flight start stale before it can claim ownership.
      requestId.current += 1;
      resultAbort.current?.abort();
      setLoading(null);
    }
  }, [active]);

  useEffect(() => () => {
    resultAbort.current?.abort();
    const subscription = owned.current;
    if (subscription) void stopOwned(subscription, true).catch(() => undefined);
  }, [stopOwned]);

  useEffect(() => {
    lifecycleGeneration.current += 1;
    const previous = owned.current;
    if (previous && previous.market !== market) {
      owned.current = null;
      setOwnedSeq(null);
      void stopOwned(previous).catch(() => undefined);
    }
    resultAbort.current?.abort();
    requestId.current += 1;
    setListLoaded(false); setConditions([]); setSelected(null); setResult(null); setStatus(null); setError(""); setLoading(null);
  }, [market, stopOwned]);

  useEffect(() => {
    if (!active || !ownedSeq) return;
    const subscription = owned.current;
    if (!subscription || subscription.market !== market || subscription.seq !== ownedSeq) return;
    let canceled = false;
    const refresh = async () => {
      try {
        const next = parseStatus(await request(`/api/conditions/${market}/status?seq=${encodeURIComponent(ownedSeq)}`));
        if (canceled) return;
        if (next.active && next.registrationId !== subscription.registrationId) {
          if (owned.current?.registrationId === subscription.registrationId) {
            owned.current = null;
            setOwnedSeq(null);
            setStatus({
              ...next,
              active: false,
              state: "canceled",
              reason: "조건식 등록이 변경되었습니다. 이 패널에서 다시 등록하세요.",
              note: "다른 실시간 조건 등록을 채택하거나 해제하지 않았습니다.",
            });
          }
          return;
        }
        setStatus(next);
        if (!next.active) { owned.current = null; setOwnedSeq(null); }
      } catch (cause) {
        if (!canceled && !isCredentialAbortError(cause)) setError(plainError(cause, "조건식 실시간 상태를 확인하지 못했습니다."));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { canceled = true; window.clearInterval(timer); };
  }, [active, market, ownedSeq]);

  async function start() {
    if (!selected || loading) return;
    // Capture this before auth awaits: a market switch or unmount invalidates
    // the request even if the broker accepts its already-sent registration.
    const sequence = ++requestId.current;
    const generation = lifecycleGeneration.current;
    const requestedMarket = market;
    const requestedSeq = selected.seq;
    const isCurrentStart = () => mounted.current
      && lifecycleGeneration.current === generation
      && requestId.current === sequence
      && currentMarket.current === requestedMarket
      && currentActive.current;
    setLoading("live"); setError("");
    try {
      const auth = await getAuthStatus();
      if (!isCurrentStart()) return;
      const next = parseResult(await request(`/api/conditions/${requestedMarket}/subscribe`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-HTS-Setup": auth.setupToken }, body: JSON.stringify({ seq: requestedSeq }),
      }));
      if (next.live?.state !== "active") {
        if (!isCurrentStart()) return;
        setResult(next);
        throw new Error("현재 환경에서는 조건식 실시간 등록을 사용할 수 없습니다.");
      }
      const accepted: OwnedSubscription = { market: requestedMarket, seq: requestedSeq, registrationId: next.live.registrationId!, token: auth.setupToken };
      if (!isCurrentStart()) {
        // This panel never owned the late response, but the broker accepted
        // it. Clear precisely that registration without mutating current UI.
        void stopOwned(accepted, true).catch(() => undefined);
        return;
      }
      setResult(next);
      owned.current = accepted;
      setOwnedSeq(requestedSeq);
    } catch (cause) {
      if (isCurrentStart()) setError(plainError(cause, "조건식 실시간 등록을 완료하지 못했습니다."));
    } finally { if (isCurrentStart()) setLoading(null); }
  }

  async function stop() {
    const subscription = owned.current;
    if (!subscription || loading) return;
    setLoading("stop"); setError("");
    try {
      await stopOwned(subscription);
      owned.current = null; setOwnedSeq(null);
      setStatus((current) => current ? { ...current, active: false, state: "inactive", note: "실시간 조건 등록을 해제했습니다." } : current);
    } catch (cause) { setError(plainError(cause, "조건식 실시간 해제를 완료하지 못했습니다.")); }
    finally { setLoading(null); }
  }

  if (!active) return <div className="condition-panel condition-panel--inactive">비활성 패널입니다. 조건식 요청과 상태 확인을 멈췄습니다.</div>;
  return <section className="condition-panel" aria-label="저장 조건검색">
    <div className="condition-panel__toolbar"><strong>저장 조건검색</strong><span>{market} · 서버 저장 조건식</span><button className="condition-panel__button" type="button" onClick={() => void refreshList()} disabled={loading !== null || Boolean(ownedSeq)}>{loading === "list" ? "목록 조회 중…" : "조건식 목록 새로고침"}</button></div>
    <p className="condition-panel__hint">목록과 일반 결과는 읽기 전용입니다. 실시간은 선택한 조건식을 명시적으로 등록한 뒤, 편입·이탈 이벤트만 표시합니다.</p>
    {error && <p className="condition-panel__error" role="alert">{error}</p>}
    <div className="condition-panel__split">
      <div className="condition-panel__conditions" aria-label="저장 조건식 목록">
        {!conditions.length && <p className="condition-panel__empty">{listLoaded ? "키움에서 반환한 저장 조건식이 없습니다." : "목록 새로고침을 눌러 저장한 조건식을 확인하세요."}</p>}
        {conditions.map((condition) => <button key={condition.seq} type="button" className="condition-panel__condition" data-selected={selected?.seq === condition.seq || undefined} onClick={() => void loadResult(condition)} disabled={Boolean(ownedSeq) || loading === "result" || loading === "live" || loading === "stop"}><b>{condition.name}</b><small>#{condition.seq}</small></button>)}
      </div>
      <div className="condition-panel__result">
        <div className="condition-panel__actions"><span>{selected ? `${selected.name} #${selected.seq}` : "조건식을 선택하세요"}</span><button className="condition-panel__button" type="button" onClick={() => void start()} disabled={!selected || loading !== null || Boolean(ownedSeq)}>{loading === "live" ? "등록 중…" : "실시간 등록"}</button><button className="condition-panel__button" type="button" onClick={() => void stop()} disabled={!ownedSeq || loading !== null}>{loading === "stop" ? "해제 중…" : "실시간 해제"}</button></div>
        {loading === "result" && <p className="condition-panel__empty" role="status">일반 결과를 조회하는 중…</p>}
        {result && <><p className="condition-panel__summary">{result.rows.length}건 · {result.complete ? "수신 완료" : "일부 수신"}{result.note ? ` · ${result.note}` : ""}{result.source === "fixture" ? " · 테스트 자료" : ""}</p><div className="condition-panel__table-wrap"><table className="condition-panel__table"><thead><tr><th>종목</th>{columns.map((field) => <th key={field}>{field}</th>)}<th>연동</th></tr></thead><tbody>{result.rows.map((row, index) => { return <tr key={`${row.item ?? "row"}-${index}`}><td>{row.name ?? row.item ?? "—"}<small>{row.item ?? ""}</small></td>{columns.map((field) => <td key={field}>{row.fields[field] ?? "—"}</td>)}<td>{row.item && onPick ? <button className="condition-panel__pick" type="button" onClick={() => void openResult(row)}>종목 열기</button> : "종목정보 없음"}</td></tr>; })}</tbody></table></div></>}
        {status && <div className="condition-panel__status" role="status"><b>{status.active ? (status.events.length ? "실시간 이벤트 수신 중" : "실시간 등록 확인됨 · 이벤트 대기") : status.state === "canceled" ? "실시간 등록 취소됨" : "실시간 미등록"}</b><span>{status.reason ?? status.note}</span>{status.events.length > 0 && <ul>{status.events.slice(-5).reverse().map((event) => <li key={event.sequence}>#{event.sequence} · {event.action === "I" ? "편입" : "이탈"} · {event.name ?? event.item ?? "종목 미상"} · 수신 {event.receivedAt}</li>)}</ul>}</div>}
      </div>
    </div>
  </section>;
}
