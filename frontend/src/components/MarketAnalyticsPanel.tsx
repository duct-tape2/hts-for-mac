"use client";

import { useEffect, useMemo, useState } from "react";
import {
  changeClass,
  formatNum,
  formatPct,
  formatPrice,
  formatReceivedAt,
  formatVol,
} from "@/lib/format";
import type { Environment, Instrument } from "@/lib/types";

type Props = {
  instrument: Instrument;
  onSelect?: (instrument: Instrument) => void;
  active?: boolean;
};

type RankingKind = "gainers" | "volume" | "value";
type RankingMarket = "all" | "KOSPI" | "KOSDAQ";
type Source = "kiwoom" | "fixture";

type RankingItem = {
  rank: number;
  instrument: Instrument;
  price: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  volumeUnit: "shares";
  tradingValue: number | null;
  tradingValueUnit: "KRW millions";
  metric: number | null;
  metricUnit: "percent" | "shares" | "KRW millions";
};

type RankingsPayload = {
  kind: RankingKind;
  market: RankingMarket;
  items: RankingItem[];
  source: Source;
  asOf: string | null;
  complete: boolean;
  incomplete: boolean;
  note: string;
};

type InvestorRow = {
  date: string;
  individual: number | null;
  foreign: number | null;
  institutional: number | null;
  financialInvestment: number | null;
  insurance: number | null;
  investmentTrust: number | null;
  otherFinancial: number | null;
  bank: number | null;
  pensionEtc: number | null;
  privateFund: number | null;
  nation: number | null;
  otherCorporation: number | null;
  domesticForeign: number | null;
};

type InvestorPayload = {
  instrument: Instrument;
  date: string;
  valueKind: "net_buy_quantity";
  unit: "shares";
  rows: InvestorRow[];
  source: Source;
  asOf: string | null;
  complete: boolean;
  incomplete: boolean;
  note: string;
};

type Result<T> = { key: string; data: T | null; error: string };

const INITIAL_RESULT = { key: "", data: null, error: "" };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : finite(value) ?? undefined;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseInstrument(value: unknown, environment: Environment): Instrument | null {
  const row = object(value);
  if (!row) return null;
  const code = text(row.stkCd)?.trim().toUpperCase();
  const name = text(row.stkNm)?.trim();
  if (
    row.market !== "KR" ||
    !code ||
    !/^[0-9A-Z]{6}$/.test(code) ||
    !name ||
    row.stexTp !== "KRX" ||
    row.quoteVenue !== "KRX" ||
    (row.listingVenue !== "KOSPI" && row.listingVenue !== "KOSDAQ") ||
    row.currency !== "KRW" ||
    (row.environment !== "fixture" && row.environment !== "demo" && row.environment !== "real") ||
    row.environment !== environment
  ) {
    return null;
  }
  return {
    market: "KR",
    stkCd: code,
    stkNm: name,
    stexTp: "KRX",
    listingVenue: row.listingVenue,
    quoteVenue: "KRX",
    currency: "KRW",
    // The owning desk environment remains authoritative for a selection.
    environment,
  };
}

function parseSource(value: unknown): Source | null {
  return value === "kiwoom" || value === "fixture" ? value : null;
}

function parseRankings(value: unknown, environment: Environment, expectedKind: RankingKind, expectedMarket: RankingMarket): RankingsPayload | null {
  const row = object(value);
  if (!row || !Array.isArray(row.items)) return null;
  const kind = row.kind;
  const market = row.market;
  const source = parseSource(row.source);
  const complete = boolean(row.complete);
  const incomplete = boolean(row.incomplete);
  const asOf = row.asOf === null ? null : text(row.asOf);
  const note = text(row.note);
  if (
    (kind !== "gainers" && kind !== "volume" && kind !== "value") ||
    (market !== "all" && market !== "KOSPI" && market !== "KOSDAQ") ||
    kind !== expectedKind || market !== expectedMarket ||
    !source ||
    (source === "fixture") !== (environment === "fixture") ||
    complete === null ||
    incomplete === null ||
    asOf === null && row.asOf !== null ||
    note === null
  ) {
    return null;
  }
  const items: RankingItem[] = [];
  for (const value of row.items) {
    const item = object(value);
    const instrument = item && parseInstrument(item.instrument, environment);
    const rank = item && finite(item.rank);
    const price = item && nullableNumber(item.price);
    const change = item && nullableNumber(item.change);
    const changePct = item && nullableNumber(item.changePct);
    const volume = item && nullableNumber(item.volume);
    const tradingValue = item && nullableNumber(item.tradingValue);
    const metric = item && nullableNumber(item.metric);
    if (
      !item ||
      !instrument ||
      rank === null ||
      price === undefined ||
      change === undefined ||
      changePct === undefined ||
      volume === undefined ||
      tradingValue === undefined ||
      metric === undefined ||
      item.volumeUnit !== "shares" ||
      item.tradingValueUnit !== "KRW millions" ||
      (item.metricUnit !== "percent" && item.metricUnit !== "shares" && item.metricUnit !== "KRW millions")
    ) {
      // A complete response cannot silently discard a malformed row: that
      // would falsely imply the provider's complete ranking was displayed.
      return null;
    }
    items.push({
      rank,
      instrument,
      price,
      change,
      changePct,
      volume,
      volumeUnit: "shares" as const,
      tradingValue,
      tradingValueUnit: "KRW millions" as const,
      metric,
      metricUnit: item.metricUnit as RankingItem["metricUnit"],
    });
  }
  return { kind, market, items, source, asOf, complete, incomplete, note };
}

function parseInvestorRows(value: unknown): InvestorRow[] | null {
  if (!Array.isArray(value)) return null;
  const fields = [
    "individual", "foreign", "institutional", "financialInvestment",
    "insurance", "investmentTrust", "otherFinancial", "bank", "pensionEtc",
    "privateFund", "nation", "otherCorporation", "domesticForeign",
  ] as const;
  const rows: InvestorRow[] = [];
  for (const entry of value) {
    const row = object(entry);
    const date = row && text(row.date);
    if (!row || !date || !/^\d{8}$/.test(date)) return null;
    const parsed = { date } as InvestorRow;
    for (const field of fields) {
      const number = nullableNumber(row[field]);
      if (number === undefined) return null;
      parsed[field] = number;
    }
    rows.push(parsed);
  }
  return rows;
}

function parseInvestor(value: unknown, environment: Environment): InvestorPayload | null {
  const row = object(value);
  if (!row) return null;
  const instrument = parseInstrument(row.instrument, environment);
  const date = text(row.date);
  const source = parseSource(row.source);
  const complete = boolean(row.complete);
  const incomplete = boolean(row.incomplete);
  const asOf = row.asOf === null ? null : text(row.asOf);
  const note = text(row.note);
  const rows = parseInvestorRows(row.rows);
  if (
    !instrument || !date || !/^\d{8}$/.test(date) ||
    row.valueKind !== "net_buy_quantity" || row.unit !== "shares" || !source ||
    (source === "fixture") !== (environment === "fixture") ||
    complete === null || incomplete === null ||
    (asOf === null && row.asOf !== null) || note === null || rows === null
  ) return null;
  return { instrument, date, valueKind: "net_buy_quantity", unit: "shares", rows, source, asOf, complete, incomplete, note };
}

class IndexLoadingError extends Error {}

async function localJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (response.status === 409) {
    try {
      const body = object(await response.json());
      if (body?.detail === "symbol index is loading") throw new IndexLoadingError();
    } catch (error) {
      if (error instanceof IndexLoadingError) throw error;
    }
  }
  if (!response.ok) throw new Error("market analytics request failed");
  return response.json();
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isIndexLoadingError(error: unknown) {
  return error instanceof IndexLoadingError;
}

function sourceLabel(source: Source | undefined) {
  return source === "fixture" ? "test data" : source === "kiwoom" ? "키움 REST 조회" : "수신 대기";
}

function indexIsLoading(data: RankingsPayload | null) {
  return Boolean(data?.incomplete && data.note.includes("symbol index is loading"));
}

function freshness(asOf: string | null | undefined) {
  return asOf ? `조회 ${formatReceivedAt(asOf)}` : "조회 시각 미상";
}

function completeness(data: { incomplete: boolean } | null) {
  if (!data) return "수신 대기";
  return data.incomplete ? "일부 결과" : "응답 범위 완료";
}

function PaginationControls({
  label,
  total,
  page,
  pageSize,
  onPage,
}: {
  label: string;
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const current = Math.min(page, lastPage);
  const first = total ? current * pageSize + 1 : 0;
  const last = Math.min(total, (current + 1) * pageSize);
  return (
    <div className="ml-auto flex items-center gap-1 text-[10px] text-cream-500" aria-label={`${label} 페이지`}>
      <span aria-live="polite">{first}–{last} / {total}개</span>
      <button className="hts-btn" type="button" aria-label={`${label} 이전 페이지`} disabled={current === 0} onClick={() => onPage(current - 1)}>이전</button>
      <button className="hts-btn" type="button" aria-label={`${label} 다음 페이지`} disabled={current >= lastPage || total === 0} onClick={() => onPage(current + 1)}>다음</button>
    </div>
  );
}

function unsupported() {
  return <p className="panel-empty" role="status">미국 순위·투자자 동향은 현재 이 조회 전용 연결에서 지원하지 않습니다.</p>;
}

function metric(value: number | null, unit: RankingItem["metricUnit"]) {
  if (unit === "percent") return formatPct(value);
  if (unit === "shares") return formatVol(value);
  return value === null ? "—" : `${formatNum(value, 0)}백만원`;
}

function signedQuantity(value: number | null) {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${formatVol(value)}`;
}

export function RankingsPanel({ instrument, onSelect, active = true }: Props) {
  const [kind, setKind] = useState<RankingKind>("gainers");
  const [market, setMarket] = useState<RankingMarket>("all");
  const [refresh, setRefresh] = useState(0);
  const key = `${instrument.environment}:${instrument.market}:${kind}:${market}:${refresh}`;
  const [result, setResult] = useState<Result<RankingsPayload>>(INITIAL_RESULT);
  const [page, setPage] = useState(0);

  useEffect(() => setPage(0), [instrument.listingVenue, instrument.stkCd]);

  useEffect(() => {
    if (!active || instrument.market !== "KR") {
      setResult(INITIAL_RESULT);
      return;
    }
    const controller = new AbortController();
    let current = true;
    let attempts = 0;
    let retryTimer: number | undefined;
    setPage(0);
    const load = () => void localJson(`/api/market/rankings?kind=${kind}&market=${market}`, controller.signal)
      .then((body) => {
        const data = parseRankings(body, instrument.environment, kind, market);
        if (current && !controller.signal.aborted) {
          setResult(data ? { key, data, error: "" } : { key, data: null, error: "시장 데이터 형식을 확인할 수 없습니다." });
          if (data && indexIsLoading(data) && attempts < 30) {
            attempts += 1;
            retryTimer = window.setTimeout(load, 1000);
          }
        }
      })
      .catch((error: unknown) => {
        if (current && !controller.signal.aborted && !isAbort(error)) {
          setResult({ key, data: null, error: "시장 순위를 불러오지 못했습니다. 잠시 후 다시 시도하세요." });
        }
      });
    setResult({ key, data: null, error: "" });
    load();
    return () => {
      current = false;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [active, instrument.environment, instrument.market, key, kind, market]);

  const data = result.key === key ? result.data : null;
  const error = result.key === key ? result.error : "";
  const title = { gainers: "상승률", volume: "거래량", value: "거래대금" }[kind];
  const loadingIdentity = indexIsLoading(data);
  const pageSize = 100;
  const total = data?.items.length ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const items = data?.items.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? [];
  useEffect(() => setPage((value) => Math.min(value, lastPage)), [lastPage]);
  return (
    <section className="panel flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#101925]" aria-label="국내 시장 순위">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-800 px-2 py-1">
        <h2 className="text-xs font-semibold text-cream-50">국내 시장 순위</h2>
        <label className="sr-only" htmlFor="ranking-kind">순위 기준</label>
        <select id="ranking-kind" className="field !w-[4.8rem] !py-0.5 text-[10px]" value={kind} onChange={(event) => setKind(event.target.value as RankingKind)} disabled={instrument.market !== "KR"}>
          <option value="gainers">상승률</option>
          <option value="volume">거래량</option>
          <option value="value">거래대금</option>
        </select>
        <label className="sr-only" htmlFor="ranking-market">시장 범위</label>
        <select id="ranking-market" className="field !w-[4.8rem] !py-0.5 text-[10px]" value={market} onChange={(event) => setMarket(event.target.value as RankingMarket)} disabled={instrument.market !== "KR"}>
          <option value="all">전체</option>
          <option value="KOSPI">KOSPI</option>
          <option value="KOSDAQ">KOSDAQ</option>
        </select>
        <button className="hts-btn" type="button" onClick={() => setRefresh((value) => value + 1)} disabled={!active || instrument.market !== "KR"}>새로고침</button>
        <PaginationControls label="순위" total={total} page={currentPage} pageSize={pageSize} onPage={setPage} />
      </div>
      {instrument.market !== "KR" ? unsupported() : !active ? <p className="panel-empty" role="status">패널이 비활성화되어 있습니다.</p> : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="hts-table" aria-label={`${title} 순위`}>
              <thead><tr><th>순위</th><th>종목</th><th>현재가</th><th>{title}</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.instrument.stkCd}-${item.instrument.listingVenue}`}>
                    <td>{item.rank}</td>
                    <td>
                      <button className="max-w-[8rem] truncate text-left text-cream-50 hover:text-[#e5ad39] disabled:text-cream-500" type="button" title={`${item.instrument.stkNm} · ${item.instrument.listingVenue}`} onClick={() => onSelect?.(item.instrument)} disabled={!onSelect}>
                        {item.instrument.stkNm}
                      </button>
                      <span className="ml-1 text-[10px] text-cream-500">{item.instrument.listingVenue}</span>
                    </td>
                    <td className={changeClass(item.change)}>{formatPrice(item.price, "KRW")}</td>
                    <td className={kind === "gainers" ? changeClass(item.metric) : "text-cream-300"}>{metric(item.metric, item.metricUnit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data?.items.length && <p className="panel-empty" role={error ? "alert" : "status"}>{error || (loadingIdentity ? "종목 상장시장을 확인 중입니다. 검증 후 순위를 불러옵니다." : data?.note || "시장 순위 불러오는 중…")}</p>}
          </div>
          <div className="shrink-0 border-t border-ink-800 px-2 py-1 text-[10px] text-cream-500">
            {sourceLabel(data?.source)} · {freshness(data?.asOf)} · {loadingIdentity ? "상장시장 검증 중" : completeness(data)}
          </div>
        </>
      )}
    </section>
  );
}

export function InvestorFlowPanel({ instrument, active = true }: Props) {
  const [refresh, setRefresh] = useState(0);
  const key = `${instrument.environment}:${instrument.market}:${instrument.stkCd}:${instrument.listingVenue}:${refresh}`;
  const [result, setResult] = useState<Result<InvestorPayload>>(INITIAL_RESULT);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!active || instrument.market !== "KR") {
      setResult(INITIAL_RESULT);
      setIdentityLoading(false);
      return;
    }
    const controller = new AbortController();
    let current = true;
    let attempts = 0;
    let retryTimer: number | undefined;
    setPage(0);
    const load = () => void localJson(`/api/market/investors?stk_cd=${encodeURIComponent(instrument.stkCd)}&listing_venue=${encodeURIComponent(instrument.listingVenue)}`, controller.signal)
      .then((body) => {
        const data = parseInvestor(body, instrument.environment);
        if (current && !controller.signal.aborted) {
          setIdentityLoading(false);
          if (!data) {
            setResult({ key, data: null, error: "투자자 동향 데이터 형식을 확인할 수 없습니다." });
          } else if (data.instrument.stkCd !== instrument.stkCd || data.instrument.listingVenue !== instrument.listingVenue) {
            setResult({ key, data: null, error: "종목 식별자가 일치하지 않습니다." });
          } else {
            setResult({ key, data, error: "" });
          }
        }
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted || isAbort(error)) return;
        if (isIndexLoadingError(error)) {
          setIdentityLoading(true);
          setResult({ key, data: null, error: "" });
          if (attempts < 30) {
            attempts += 1;
            retryTimer = window.setTimeout(load, 1000);
          }
        } else {
          setIdentityLoading(false);
          setResult({ key, data: null, error: "투자자 동향을 불러오지 못했습니다. 잠시 후 다시 시도하세요." });
        }
      });
    setResult({ key, data: null, error: "" });
    setIdentityLoading(false);
    load();
    return () => {
      current = false;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [active, instrument.environment, instrument.listingVenue, instrument.market, instrument.stkCd, key]);

  const data = result.key === key ? result.data : null;
  const error = result.key === key ? result.error : "";
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pageSize = 100;
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  useEffect(() => setPage((value) => Math.min(value, lastPage)), [lastPage]);
  return (
    <section className="panel flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#101925]" aria-label="국내 투자자 동향">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-800 px-2 py-1">
        <div><h2 className="text-xs font-semibold text-cream-50">투자자 동향</h2><p className="text-[10px] text-cream-500">일자별 순매수 수량 · 단위: 주</p></div>
        <button className="hts-btn" type="button" onClick={() => setRefresh((value) => value + 1)} disabled={!active || instrument.market !== "KR"}>새로고침</button>
        <PaginationControls label="투자자 동향" total={rows.length} page={currentPage} pageSize={pageSize} onPage={setPage} />
      </div>
      {instrument.market !== "KR" ? unsupported() : !active ? <p className="panel-empty" role="status">패널이 비활성화되어 있습니다.</p> : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="hts-table" aria-label="투자자 순매수 수량">
              <thead><tr><th>일자</th><th>개인</th><th>외국인</th><th>기관계</th><th>연기금등</th></tr></thead>
              <tbody>{visibleRows.map((row) => (
                <tr key={row.date}>
                  <td>{`${row.date.slice(0, 4)}.${row.date.slice(4, 6)}.${row.date.slice(6, 8)}`}</td>
                  <td className={changeClass(row.individual)}>{signedQuantity(row.individual)}</td>
                  <td className={changeClass(row.foreign)}>{signedQuantity(row.foreign)}</td>
                  <td className={changeClass(row.institutional)}>{signedQuantity(row.institutional)}</td>
                  <td className={changeClass(row.pensionEtc)}>{signedQuantity(row.pensionEtc)}</td>
                </tr>
              ))}</tbody>
            </table>
            {!rows.length && <p className="panel-empty" role={error ? "alert" : "status"}>{error || (identityLoading ? "종목 상장시장을 확인 중입니다. 검증 후 투자자 동향을 불러옵니다." : data?.note || "투자자 동향 불러오는 중…")}</p>}
          </div>
          <div className="shrink-0 border-t border-ink-800 px-2 py-1 text-[10px] text-cream-500">
            {sourceLabel(data?.source)} · {freshness(data?.asOf)} · {identityLoading ? "상장시장 검증 중" : completeness(data)} · 실시간 수급이 아닙니다
          </div>
        </>
      )}
    </section>
  );
}
