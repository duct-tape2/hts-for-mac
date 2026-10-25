"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CaptureChart } from "@/components/capture/CaptureChart";
import { CaptureGrid } from "@/components/capture/CaptureGrid";
import type { GridSort } from "@/components/capture/CaptureGrid";
import { InvestorCaptureView, MarketCaptureView, NewsCaptureView, SectorCaptureView } from "@/components/capture/CaptureViews";
import { CAPTURE_SCREEN_CODES, fetchCaptureScreen, isCaptureAbort } from "@/lib/capture";
import type { CaptureParams, CapturePayload, CaptureRow, CaptureScreenCode } from "@/lib/capture";
import { screenPresentation } from "@/lib/screenPresentation";
import type { Instrument } from "@/lib/types";
import "./capturePanel.css";

export type CapturePanelProps = {
  screen: string;
  instrument: Instrument;
  active: boolean;
  refreshKey: number;
  onPick: (instrument: Instrument) => void;
  sector?: string;
  onSector?: (code: string) => void;
  onPreferences?: (value: Record<string, unknown>) => void;
  preferences?: Record<string, unknown>;
};

type Filters = Required<Pick<CaptureParams, "market" | "venue" | "sort" | "direction" | "session" | "stock" | "credit" | "volumeBand" | "priceBand" | "valueBand" | "limitSort" | "managed" | "interval" | "sector" | "start" | "end" | "unit" | "period" | "query" | "provider">>;
type LocalFilters = { localNameOrCode: string; localMinPrice: string; localMinVolume: string; localMinMarketCap: string; localMinValue: string };
type Result = { key: string; identity: string; data: CapturePayload | null; error: string; loading: boolean; cachedAt: number | null };

const PAGE_SIZE = 50;
const RANKING_SCREENS = new Set<CaptureScreenCode>(["0198", "0187", "0186", "0184", "0162"]);
const INVESTOR_SCREENS = new Set<CaptureScreenCode>(["0780", "2797"]);
const SECTOR_SCREENS = new Set<CaptureScreenCode>(["0211", "0602"]);
/** Only labels confirmed by the existing 0211/0602 sector contract are named here. */
const KNOWN_SECTOR_CHARTS = [
  ["001", "종합(KOSPI)"],
  ["101", "종합(KOSDAQ)"],
  ["201", "KOSPI 200"],
] as const;
const LABELS: Record<CaptureScreenCode, string> = {
  "0198": "실시간 종목 순위", "0187": "시가총액상위", "0186": "거래대금순위", "0184": "당일거래상위", "0162": "상한가/하한가",
  "0211": "업종시세", "0602": "업종종합차트", "0780": "투자자별 매매동향", "2797": "업종별 투자자 기준일 순매수", "0200": "시장종합", "0700": "종합시황뉴스",
};

const RANK_0184_SESSION = [["all", "전체"], ["regular", "장중"], ["preMarket", "장전시간외"], ["afterMarket", "장후시간외"]] as const;
const RANK_0184_STOCK = [["all", "전체"], ["excludeManaged", "관리 제외"], ["excludePreferred", "우선주 제외"], ["excludeManagedPreferred", "관리·우선주 제외"], ["excludeEtf", "ETF 제외"], ["excludeEtfEtn", "ETF·ETN 제외"]] as const;
const RANK_0184_CREDIT = [["all", "전체"], ["creditAll", "신용 전체"], ["creditA", "신용 A"], ["creditB", "신용 B"], ["creditC", "신용 C"], ["creditD", "신용 D"], ["loan", "신용대주"]] as const;
const RANK_0184_VOLUME = [["all", "전체"], ["5k", "5천주 이상"], ["10k", "1만주 이상"], ["50k", "5만주 이상"], ["100k", "10만주 이상"], ["200k", "20만주 이상"], ["300k", "30만주 이상"], ["1m", "백만주 이상"]] as const;
const RANK_0184_PRICE = [["all", "전체"], ["under1k", "1천원 미만"], ["over1k", "1천원 이상"], ["1to2k", "1~2천원"], ["2to5k", "2~5천원"], ["over5k", "5천원 이상"], ["5to10k", "5천~1만원"], ["under10k", "1만원 미만"], ["over10k", "1만원 이상"], ["over50k", "5만원 이상"], ["over100k", "10만원 이상"]] as const;
const RANK_0184_VALUE = [["all", "전체"], ["10m", "1천만원 이상"], ["30m", "3천만원 이상"], ["50m", "5천만원 이상"], ["100m", "1억원 이상"], ["300m", "3억원 이상"], ["500m", "5억원 이상"], ["1b", "10억원 이상"], ["3b", "30억원 이상"], ["5b", "50억원 이상"], ["10b", "100억원 이상"], ["30b", "300억원 이상"], ["50b", "500억원 이상"]] as const;
const LIMIT_STOCK = RANK_0184_STOCK.slice(0, 4);
const LIMIT_CREDIT = [["all", "전체"], ["creditAll", "신용 전체"], ["creditA", "신용 A"], ["creditB", "신용 B"], ["creditC", "신용 C"], ["creditD", "신용 D"], ["creditE", "신용 E"]] as const;
const LIMIT_VOLUME = [["all", "전체"], ["10k", "1만주 이상"], ["50k", "5만주 이상"], ["100k", "10만주 이상"], ["150k", "15만주 이상"], ["200k", "20만주 이상"], ["300k", "30만주 이상"], ["500k", "50만주 이상"], ["1m", "백만주 이상"]] as const;
const LIMIT_PRICE = [["all", "전체"], ["under1k", "1천원 미만"], ["1to2k", "1~2천원"], ["2to3k", "2~3천원"], ["5to10k", "5천~1만원"], ["over10k", "1만원 이상"], ["over1k", "1천원 이상"]] as const;

function knownScreen(value: string): CaptureScreenCode | null {
  return (CAPTURE_SCREEN_CODES as readonly string[]).includes(value) ? value as CaptureScreenCode : null;
}

/** Do not infer a sector name for a provider code that this client does not know. */
export function sectorChartLabel(code: string) {
  return KNOWN_SECTOR_CHARTS.find(([knownCode]) => knownCode === code)?.[1] ?? `원본 코드 ${code}`;
}

function valid<T extends string>(value: unknown, values: readonly T[], fallback: T) {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : fallback;
}

function validCode(value: unknown, fallback: string) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(value) ? value : fallback;
}

function dateValue(value: unknown) {
  return typeof value === "string" && /^\d{8}$/.test(value) ? value : "";
}

function inputDate(value: string) {
  return value ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : "";
}

function normalizedDate(value: string) {
  const next = value.replaceAll("-", "");
  return /^\d{8}$/.test(next) ? next : "";
}

function localDecimal(value: unknown) {
  if (typeof value !== "string" || value.length > 24 || !/^\d+(?:\.\d+)?$/.test(value)) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? value : "";
}

function localFiltersFor(preferences: Record<string, unknown> | undefined): LocalFilters {
  const source = preferences ?? {};
  return {
    localNameOrCode: typeof source.localNameOrCode === "string" && source.localNameOrCode.length <= 100 && !/[\u0000-\u001F\u007F]/.test(source.localNameOrCode) ? source.localNameOrCode : "",
    localMinPrice: localDecimal(source.localMinPrice),
    localMinVolume: localDecimal(source.localMinVolume),
    localMinMarketCap: localDecimal(source.localMinMarketCap),
    localMinValue: localDecimal(source.localMinValue),
  };
}

function filtersFor(screen: CaptureScreenCode, preferences: Record<string, unknown> | undefined, sector: string | undefined): Filters {
  const source = preferences ?? {};
  const defaultVenue = screen === "0211" ? "KRX" : "ALL";
  return {
    market: valid(source.market, ["all", "KOSPI", "KOSDAQ"] as const, "all"),
    venue: valid(source.venue, ["KRX", "NXT", "ALL"] as const, defaultVenue),
    sort: valid(source.sort, ["volume", "turnover", "value"] as const, "volume"),
    direction: valid(source.direction, ["up", "down", "rise", "fall", "flat", "previousUpLimit", "previousDownLimit"] as const, "up"),
    session: valid(source.session, ["all", "regular", "preMarket", "afterMarket"] as const, "all"),
    stock: valid(source.stock, ["all", "excludeManaged", "excludePreferred", "excludeManagedPreferred", "excludeEtf", "excludeEtfEtn"] as const, "all"),
    credit: valid(source.credit, ["all", "creditAll", "creditA", "creditB", "creditC", "creditD", "creditE", "loan"] as const, "all"),
    volumeBand: valid(source.volumeBand, ["all", "5k", "10k", "50k", "100k", "150k", "200k", "300k", "500k", "1m"] as const, "all"),
    priceBand: valid(source.priceBand, ["all", "under1k", "over1k", "1to2k", "2to3k", "2to5k", "over5k", "5to10k", "under10k", "over10k", "over50k", "over100k"] as const, "all"),
    valueBand: valid(source.valueBand, ["all", "10m", "30m", "50m", "100m", "300m", "500m", "1b", "3b", "5b", "10b", "30b", "50b"] as const, "all"),
    limitSort: valid(source.limitSort, ["code", "streak", "changePct"] as const, "changePct"),
    managed: valid(source.managed, ["exclude", "include"] as const, "exclude"),
    interval: valid(source.interval, ["1", "3", "5", "10", "15", "30", "60", "D", "W", "M", "Y"] as const, "D"),
    sector: validCode(sector ?? source.sector, "001"),
    start: dateValue(source.start),
    end: dateValue(source.end) || (INVESTOR_SCREENS.has(screen) ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date()).replaceAll("-", "") : ""),
    unit: valid(source.unit, ["amount", "volume"] as const, "amount"),
    period: valid(source.period, ["1", "2", "3", "4", "5"] as const, "1"),
    query: typeof source.query === "string" ? source.query.slice(0, 100) : "",
    provider: typeof source.provider === "string" && source.provider.length <= 100 ? source.provider : "all",
  };
}

function sortFor(preferences: Record<string, unknown> | undefined): GridSort | undefined {
  const value = preferences?.tableSort;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sort = value as Record<string, unknown>;
  return typeof sort.key === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(sort.key) && (sort.direction === "asc" || sort.direction === "desc")
    ? { key: sort.key, direction: sort.direction }
    : undefined;
}

function columnWidthsFor(preferences: Record<string, unknown> | undefined) {
  const source = preferences?.tableColumnWidths;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof value !== "number" || !Number.isFinite(value)) continue;
    result[key] = Math.min(420, Math.max(56, Math.round(value)));
  }
  return result;
}

function requestParams(filters: Filters): CaptureParams {
  const { start, end, ...rest } = filters;
  return { ...rest, ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

function paramsForScreen(screen: CaptureScreenCode, filters: Filters): CaptureParams {
  const complete = requestParams(filters);
  switch (screen) {
    case "0198": return { period: complete.period };
    case "0187": return { market: complete.market, venue: complete.venue };
    case "0186": return { market: complete.market, venue: complete.venue, managed: complete.managed };
    case "0184": return { market: complete.market, venue: complete.venue, sort: complete.sort, session: complete.session, stock: complete.stock, credit: complete.credit, volumeBand: complete.volumeBand, priceBand: complete.priceBand, valueBand: complete.valueBand };
    case "0162": return { market: complete.market, venue: complete.venue, direction: complete.direction, limitSort: complete.limitSort, stock: complete.stock, credit: complete.credit, volumeBand: complete.volumeBand, priceBand: complete.priceBand };
    case "0211": return { venue: "KRX", sector: complete.sector, interval: complete.interval };
    case "0602": return { sector: complete.sector, interval: complete.interval };
    case "0780": return { market: complete.market, start: complete.start, end: complete.end, unit: complete.unit };
    case "2797": {
      const baseDate = complete.end || complete.start;
      return { market: complete.market, ...(baseDate ? { start: baseDate, end: baseDate } : {}), unit: complete.unit };
    }
    case "0700": return { query: complete.query, provider: complete.provider };
    case "0200": return {};
  }
}

function sameFilters(a: Filters, b: Filters) {
  return Object.keys(a).every((key) => a[key as keyof Filters] === b[key as keyof Filters]);
}

function sortRows(rows: CaptureRow[], sort: GridSort | undefined) {
  if (!sort) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left[sort.key] as string | number | null | undefined;
    const b = right[sort.key] as string | number | null | undefined;
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
    if (b === null || b === undefined) return -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
    return String(a).localeCompare(String(b), "ko") * direction;
  });
}

function localPreferenceFilters(filters: LocalFilters): LocalFilters {
  return {
    localNameOrCode: filters.localNameOrCode.length <= 100 && !/[\u0000-\u001F\u007F]/.test(filters.localNameOrCode) ? filters.localNameOrCode : "",
    localMinPrice: localDecimal(filters.localMinPrice),
    localMinVolume: localDecimal(filters.localMinVolume),
    localMinMarketCap: localDecimal(filters.localMinMarketCap),
    localMinValue: localDecimal(filters.localMinValue),
  };
}

function localNumber(value: string) {
  return value ? Number(value) : null;
}

function receivedRowFilters(rows: CaptureRow[], filters: LocalFilters) {
  const search = filters.localNameOrCode.trim().toLocaleLowerCase("ko");
  const minimums: Array<readonly [string, number | null]> = [
    ["price", localNumber(localDecimal(filters.localMinPrice))],
    ["volume", localNumber(localDecimal(filters.localMinVolume))],
    ["marketCap", localNumber(localDecimal(filters.localMinMarketCap))],
    ["tradingValue", localNumber(localDecimal(filters.localMinValue))],
  ];
  return rows.filter((row) => {
    if (search && ![row.name, row.code].some((value) => typeof value === "string" && value.toLocaleLowerCase("ko").includes(search))) return false;
    return minimums.every(([key, minimum]) => {
      if (minimum === null || !(key in row)) return true;
      const value = row[key];
      return typeof value === "number" && value >= minimum;
    });
  });
}

function sourceText(data: CapturePayload | null) {
  if (!data) return "수신 대기";
  const source = data.source === "fixture" ? "테스트 데이터 (fixture)" : data.source === "kiwoom" ? "키움 REST (kiwoom)" : data.source === "external" ? "외부 공개자료 (external)" : data.source;
  const status = data.status === "snapshot" ? "스냅샷" : data.status === "delayed" ? "지연" : data.status === "missing" ? "미수신" : data.status === "error" ? "오류" : "테스트";
  const formatTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : value;
  const received = data.receivedAt ? `수신 ${formatTime(data.receivedAt)} KST` : "수신 시각 미상";
  const asOf = data.asOf ? `제공 기준 ${formatTime(data.asOf)}` : "제공 기준시각 미상";
  return `${source} · 상태 ${status} · ${received} · ${asOf} · ${data.complete ? "전체" : "일부"}`;
}

function scopeText(data: CapturePayload) {
  const scope = data.scope;
  if (!scope) return data.note;
  const names: Record<string, string> = { market: "시장", venue: "거래소", sort: "정렬", direction: "등락", session: "세션", limitSort: "정렬", managed: "관리종목", interval: "주기", sector: "업종", start: "시작", end: "종료", unit: "기준", period: "조회구간", provider: "제공처", query: "검색", etf: "ETF 구분", tradingWeight: "거래비중", marketCapWeight: "시총비중", priceBand: "가격조건", volumeBand: "거래량조건", valueBand: "거래대금조건", credit: "신용조건", stock: "종목조건" };
  const values: Record<string, string> = { all: "전체", ALL: "통합", KOSPI: "코스피", KOSDAQ: "코스닥", amount: "금액", volume: "거래량", turnover: "회전율", value: "거래대금", regular: "장중", preMarket: "장전시간외", afterMarket: "장후시간외", exclude: "미포함", include: "포함", excludeManaged: "관리 제외", excludePreferred: "우선주 제외", excludeManagedPreferred: "관리·우선주 제외", excludeEtf: "ETF 제외", excludeEtfEtn: "ETF·ETN 제외", creditAll: "신용 전체", creditA: "신용 A", creditB: "신용 B", creditC: "신용 C", creditD: "신용 D", creditE: "신용 E", loan: "신용대주", code: "종목코드순", streak: "연속횟수순", changePct: "등락률순", previousUpLimit: "전일 상한", previousDownLimit: "전일 하한", up: "상한", rise: "상승", flat: "보합", fall: "하락", down: "하한" };
  const bands: Record<string, ReadonlyArray<readonly [string, string]>> = {
    volumeBand: [...RANK_0184_VOLUME, ...LIMIT_VOLUME],
    priceBand: [...RANK_0184_PRICE, ...LIMIT_PRICE],
    valueBand: RANK_0184_VALUE,
  };
  const applied = Object.entries(scope.appliedFilters).map(([key, value]) => `${names[key] ?? "조건"} ${bands[key]?.find(([id]) => id === value)?.[1] ?? values[value] ?? value}`).join(", ");
  const dates = scope.effectiveStart || scope.effectiveEnd ? `${scope.effectiveStart ?? "—"}~${scope.effectiveEnd ?? "—"}` : "";
  const unsupported = scope.unsupported.map((value) => names[value] ?? "지원하지 않는 조건");
  const limited = [scope.limitedReason, unsupported.length ? `미지원: ${unsupported.join(", ")}` : ""].filter(Boolean).join(" · ");
  return [applied, dates, `반환 ${scope.returnedRows}행`, limited, data.note].filter(Boolean).join(" · ");
}

function ToolbarRadios<T extends string>({ label, name, value, options, disabled, onChange }: {
  label: string;
  name: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  disabled: boolean;
  onChange: (next: T) => void;
}) {
  return <fieldset><legend>{label}</legend>{options.map(([next, text]) => <label className="capture-radio" key={next}>
    <input type="radio" name={name} value={next} checked={value === next} disabled={disabled} onChange={() => onChange(next)} />{text}
  </label>)}</fieldset>;
}

function ToolbarSelect<T extends string>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  disabled: boolean;
  onChange: (next: T) => void;
}) {
  return <label className="capture-select-label">{label}<select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>{options.map(([next, text]) => <option key={next} value={next}>{text}</option>)}</select></label>;
}

export function CapturePanel({ screen, instrument, active, refreshKey, onPick, sector, onSector, onPreferences, preferences }: CapturePanelProps) {
  const code = knownScreen(screen);
  const initial = filtersFor(code ?? "0198", preferences, sector);
  const [filters, setFilters] = useState<Filters>(initial);
  const filtersRef = useRef(filters);
  const [localFilters, setLocalFilters] = useState<LocalFilters>(() => localFiltersFor(preferences));
  const localFiltersRef = useRef(localFilters);
  const [queryDraft, setQueryDraft] = useState(initial.query);
  const [sectorDraft, setSectorDraft] = useState(initial.sector);
  const [page, setPage] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [gridSort, setGridSort] = useState<GridSort | undefined>(() => sortFor(preferences));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => columnWidthsFor(preferences));
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<Result>({ key: "", identity: "", data: null, error: "", loading: false, cachedAt: null });
  const [autoRefresh, setAutoRefresh] = useState(() => typeof preferences?.autoRefresh === "boolean" ? preferences.autoRefresh : code === "0198");
  const [newsInstrument, setNewsInstrument] = useState(() => preferences?.newsInstrument === true);
  const busyRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const identityRef = useRef("");
  const metadataRecoveryRef = useRef({ identity: "", attempts: 0 });

  useEffect(() => {
    if (!code) return;
    const next = filtersFor(code, preferences, sector);
    if (!sameFilters(filtersRef.current, next)) {
      filtersRef.current = next;
      setFilters(next);
      setQueryDraft(next.query);
      setSectorDraft(next.sector);
      setPage(0);
    }
    setGridSort(sortFor(preferences));
    setColumnWidths(columnWidthsFor(preferences));
    const nextLocalFilters = localFiltersFor(preferences);
    localFiltersRef.current = nextLocalFilters;
    setLocalFilters(nextLocalFilters);
    setAutoRefresh(typeof preferences?.autoRefresh === "boolean" ? preferences.autoRefresh : code === "0198");
    setNewsInstrument(preferences?.newsInstrument === true);
  }, [code, preferences, sector]);

  const persist = useCallback((next: Filters, sort = gridSort, widths = columnWidths) => {
    onPreferences?.({ ...next, ...localPreferenceFilters(localFiltersRef.current), ...(sort ? { tableSort: sort } : {}), ...(Object.keys(widths).length ? { tableColumnWidths: widths } : {}), autoRefresh, ...(code === "0700" ? { newsInstrument } : {}) });
  }, [autoRefresh, code, columnWidths, gridSort, newsInstrument, onPreferences]);
  const updateFilters = useCallback((change: Partial<Filters>) => {
    const next = { ...filtersRef.current, ...change };
    if (sameFilters(filtersRef.current, next)) return;
    filtersRef.current = next;
    setFilters(next);
    setPage(0);
    setSelectedId("");
    persist(next);
  }, [persist]);
  const updateSort = useCallback((next: GridSort) => {
    setGridSort(next);
    persist(filtersRef.current, next);
  }, [persist]);
  const updateColumnWidths = useCallback((next: Record<string, number>) => {
    setColumnWidths(next);
    persist(filtersRef.current, gridSort, next);
  }, [gridSort, persist]);
  const updateLocalFilters = useCallback((change: Partial<LocalFilters>) => {
    const next = { ...localFiltersRef.current, ...change };
    localFiltersRef.current = next;
    setLocalFilters(next);
    onPreferences?.({ ...filtersRef.current, ...localPreferenceFilters(next), ...(gridSort ? { tableSort: gridSort } : {}), ...(Object.keys(columnWidths).length ? { tableColumnWidths: columnWidths } : {}), autoRefresh, ...(code === "0700" ? { newsInstrument } : {}) });
  }, [autoRefresh, code, columnWidths, gridSort, newsInstrument, onPreferences]);
  useEffect(() => {
    if (code !== "0700" || !newsInstrument) return;
    const query = `${instrument.stkCd} ${instrument.stkNm}`.slice(0, 100);
    if (filtersRef.current.query !== query) {
      setQueryDraft(query);
      updateFilters({ query });
    }
  }, [code, instrument.stkCd, instrument.stkNm, newsInstrument, updateFilters]);

  const endpointParams = useMemo(() => code ? paramsForScreen(code, filters) : {}, [code, filters]);
  const identityKey = useMemo(() => code ? JSON.stringify({ code, environment: instrument.environment, endpointParams }) : "", [code, endpointParams, instrument.environment]);
  const requestKey = useMemo(() => JSON.stringify({ identityKey, refreshKey, refreshNonce }), [identityKey, refreshKey, refreshNonce]);
  useEffect(() => {
    if (!code || !active) {
      setResult({ key: requestKey, identity: identityKey, data: null, error: "", loading: false, cachedAt: null });
      busyRef.current = false;
      return;
    }
    const controller = new AbortController();
    const generation = ++requestGenerationRef.current;
    const changedIdentity = identityRef.current !== identityKey;
    identityRef.current = identityKey;
    busyRef.current = true;
    setResult((previous) => ({ key: requestKey, identity: identityKey, data: changedIdentity ? null : previous.data, error: "", loading: true, cachedAt: changedIdentity ? null : previous.cachedAt }));
    void fetchCaptureScreen(code, endpointParams, controller.signal, instrument.environment)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult((previous) => previous.key === requestKey ? { key: requestKey, identity: identityKey, data, error: "", loading: false, cachedAt: Date.now() } : previous);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isCaptureAbort(error)) return;
        setResult((previous) => previous.key === requestKey ? { key: requestKey, identity: identityKey, data: previous.data, error: error instanceof Error ? error.message : "캡처 화면을 불러오지 못했습니다.", loading: false, cachedAt: previous.cachedAt } : previous);
      })
      .finally(() => { if (requestGenerationRef.current === generation) busyRef.current = false; });
    return () => {
      controller.abort();
      if (requestGenerationRef.current === generation) busyRef.current = false;
    };
  // endpointParams is represented by identityKey/requestKey. Keeping the
  // effect keyed to those serialized values prevents quote-store renders or
  // regenerated parent callbacks from aborting a live request and restarting
  // its deadline.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, code, identityKey, requestKey]);

  const supportsAuto = code === "0198" || code === "0186";
  useEffect(() => {
    if (!active || !autoRefresh || !supportsAuto) return;
    const delays: Record<string, number> = { "1": 60_000, "2": 600_000, "3": 3_600_000, "4": 60_000, "5": 30_000 };
    const delay = code === "0198" ? delays[filters.period] : 30_000;
    let timer: number | undefined;
    const clear = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; };
    const schedule = () => {
      clear();
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        if (!busyRef.current && document.visibilityState !== "hidden") setRefreshNonce((value) => value + 1);
        schedule();
      }, delay);
    };
    const visibility = () => schedule();
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => { clear(); document.removeEventListener("visibilitychange", visibility); };
  }, [active, autoRefresh, code, filters.period, supportsAuto]);

  const data = result.identity === identityKey ? result.data : null;
  useEffect(() => {
    if (metadataRecoveryRef.current.identity !== identityKey) metadataRecoveryRef.current = { identity: identityKey, attempts: 0 };
    if (!active || !data?.selectionPending) {
      metadataRecoveryRef.current.attempts = 0;
      return;
    }
    let timer: number | undefined;
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (document.visibilityState === "hidden" || result.loading || metadataRecoveryRef.current.attempts >= 10) return;
      timer = window.setTimeout(() => {
        if (document.visibilityState === "hidden" || busyRef.current || metadataRecoveryRef.current.attempts >= 10) return;
        metadataRecoveryRef.current.attempts += 1;
        setRefreshNonce((value) => value + 1);
      }, 3000);
    };
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => { if (timer !== undefined) window.clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [active, data?.selectionPending, identityKey, result.loading]);
  useEffect(() => {
    if (code !== "0187" || !active || data?.status !== "delayed" || document.visibilityState === "hidden") return;
    const timer = window.setTimeout(() => { if (!busyRef.current) setRefreshNonce((value) => value + 1); }, 3000);
    return () => window.clearTimeout(timer);
  }, [active, code, data, requestKey]);
  const receivedRows = data?.rows ?? [];
  const receivedFiltered = useMemo(() => receivedRowFilters(receivedRows, localFilters), [localFilters, receivedRows]);
  const sorted = useMemo(() => sortRows(receivedFiltered, gridSort), [receivedFiltered, gridSort]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const rows = sorted.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const ranking = code ? RANKING_SCREENS.has(code) : false;
  const investor = code ? INVESTOR_SCREENS.has(code) : false;
  const singleBaseDate = investor;
  const sectorScreen = code ? SECTOR_SCREENS.has(code) : false;
  const showMarket = code !== "0198" && (ranking || investor);
  const showVenue = ranking && code !== "0198";
  const showSort = code === "0184";
  const showDirection = code === "0162";
  const showQuery = code === "0700";
  const showLocalFilters = ranking;
  const localFilterCapabilities = data ? new Set(data.columns.map((column) => column.key)) : new Set<string>();
  const autoRefreshLabel = code === "0198" ? ({ "1": "자동 1분", "2": "자동 10분", "3": "자동 1시간", "4": "자동 1분", "5": "자동 30초" }[filters.period]) : "자동 30초";

  const chooseSector = (next: string) => {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(next)) return;
    setSectorDraft(next);
    updateFilters({ sector: next });
    onSector?.(next);
  };
  const selectRow = (row: CaptureRow) => setSelectedId(row.id);
  const pickRow = (row: CaptureRow) => { setSelectedId(row.id); if (row.instrument) onPick(row.instrument); };
  const changeAutoRefresh = (next: boolean) => {
    setAutoRefresh(next);
    onPreferences?.({ ...filtersRef.current, ...localPreferenceFilters(localFiltersRef.current), ...(gridSort ? { tableSort: gridSort } : {}), ...(Object.keys(columnWidths).length ? { tableColumnWidths: columnWidths } : {}), autoRefresh: next, ...(code === "0700" ? { newsInstrument } : {}) });
  };
  const changeNewsInstrument = (next: boolean) => {
    setNewsInstrument(next);
    if (!next) {
      onPreferences?.({ ...filtersRef.current, ...localPreferenceFilters(localFiltersRef.current), ...(gridSort ? { tableSort: gridSort } : {}), ...(Object.keys(columnWidths).length ? { tableColumnWidths: columnWidths } : {}), autoRefresh, newsInstrument: false });
      return;
    }
    const query = `${instrument.stkCd} ${instrument.stkNm}`.slice(0, 100);
    setQueryDraft(query);
    const nextFilters = { ...filtersRef.current, query };
    filtersRef.current = nextFilters;
    setFilters(nextFilters);
    setPage(0);
    setSelectedId("");
    onPreferences?.({ ...nextFilters, ...localPreferenceFilters(localFiltersRef.current), ...(gridSort ? { tableSort: gridSort } : {}), ...(Object.keys(columnWidths).length ? { tableColumnWidths: columnWidths } : {}), autoRefresh, newsInstrument: true });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    updateFilters({ query: queryDraft.trim(), sector: sectorDraft.trim() });
    setRefreshNonce((value) => value + 1);
  };

  if (!code) return <section className="classic-window" aria-label="지원하지 않는 캡처 화면"><p className="classic-error" role="alert">지원하지 않는 캡처 화면입니다: {screen}</p></section>;
  return (
    <section className="classic-window" aria-label={`${code} ${LABELS[code]}`}>
      <header className="classic-titlebar"><span className="classic-window-number">1</span><strong>[{code}] {data?.title ?? LABELS[code]}</strong><span className="classic-readonly">조회전용</span></header>
      <form className="classic-toolbar capture-toolbar" onSubmit={submit}>
        {showMarket && <ToolbarRadios label="시장" name={`${code}-market`} value={filters.market} disabled={!active} onChange={(market) => updateFilters({ market })} options={[["all", "전체"], ["KOSPI", "코스피"], ["KOSDAQ", "코스닥"]] as const} />}
        {showVenue && <ToolbarRadios label="거래소" name={`${code}-venue`} value={filters.venue} disabled={!active} onChange={(venue) => updateFilters({ venue })} options={[["ALL", "통합"], ["KRX", "KRX"], ["NXT", "NXT"]] as const} />}
        {showSort && <ToolbarRadios label="정렬" name={`${code}-sort`} value={filters.sort} disabled={!active} onChange={(sort) => updateFilters({ sort })} options={[["volume", "거래량"], ["turnover", "회전"], ["value", "거래대금"]] as const} />}
        {code === "0184" && <><ToolbarSelect label="세션" value={filters.session} options={RANK_0184_SESSION} disabled={!active} onChange={(session) => updateFilters({ session })} /><ToolbarSelect label="종목" value={filters.stock} options={RANK_0184_STOCK} disabled={!active} onChange={(stock) => updateFilters({ stock })} /><ToolbarSelect label="신용" value={filters.credit} options={RANK_0184_CREDIT} disabled={!active} onChange={(credit) => updateFilters({ credit })} /><ToolbarSelect label="거래량" value={filters.volumeBand} options={RANK_0184_VOLUME} disabled={!active} onChange={(volumeBand) => updateFilters({ volumeBand })} /><ToolbarSelect label="가격" value={filters.priceBand} options={RANK_0184_PRICE} disabled={!active} onChange={(priceBand) => updateFilters({ priceBand })} /><ToolbarSelect label="거래대금" value={filters.valueBand} options={RANK_0184_VALUE} disabled={!active} onChange={(valueBand) => updateFilters({ valueBand })} /></>}
        {code === "0186" && <ToolbarSelect label="관리종목" value={filters.managed} options={[["exclude", "미포함"], ["include", "포함"]] as const} disabled={!active} onChange={(managed) => updateFilters({ managed })} />}
        {showDirection && <><ToolbarRadios label="등락" name={`${code}-direction`} value={filters.direction} disabled={!active} onChange={(direction) => updateFilters({ direction })} options={[["up", "상한"], ["rise", "상승"], ["flat", "보합"], ["fall", "하락"], ["down", "하한"], ["previousUpLimit", "전일 상한"], ["previousDownLimit", "전일 하한"]] as const} /><ToolbarSelect label="정렬" value={filters.limitSort} options={[["changePct", "등락률순"], ["code", "종목코드순"], ["streak", "연속횟수순"]] as const} disabled={!active} onChange={(limitSort) => updateFilters({ limitSort })} /><ToolbarSelect label="종목" value={filters.stock} options={LIMIT_STOCK} disabled={!active} onChange={(stock) => updateFilters({ stock })} /><ToolbarSelect label="신용" value={filters.credit} options={LIMIT_CREDIT} disabled={!active} onChange={(credit) => updateFilters({ credit })} /><ToolbarSelect label="거래량" value={filters.volumeBand} options={LIMIT_VOLUME} disabled={!active} onChange={(volumeBand) => updateFilters({ volumeBand })} /><ToolbarSelect label="가격" value={filters.priceBand} options={LIMIT_PRICE} disabled={!active} onChange={(priceBand) => updateFilters({ priceBand })} /></>}
        {code === "0198" && <><ToolbarRadios label="조회 구간" name={`${code}-period`} value={filters.period} disabled={!active} onChange={(period) => updateFilters({ period })} options={[["1", "1분"], ["2", "10분"], ["3", "1시간"], ["4", "당일 누적"], ["5", "30초"]] as const} /><span className="capture-unsupported" title="ka00198은 ETF 구분 조건을 제공하지 않습니다.">ETF 구분: API 미지원</span></>}
        {sectorScreen && <label>업종<input aria-label="업종 코드" value={sectorDraft} maxLength={32} pattern="[A-Za-z0-9_.-]+" disabled={!active} onChange={(event) => setSectorDraft(event.target.value)} /></label>}
        {investor && <><ToolbarRadios label="기준" name={`${code}-unit`} value={filters.unit} disabled={!active} onChange={(unit) => updateFilters({ unit })} options={[["amount", "금액"], ["volume", "수량"]] as const} />{singleBaseDate ? <label className="capture-date-label">기준일<input aria-label="기준일" type="date" value={inputDate(filters.end || filters.start)} disabled={!active} onChange={(event) => { const base = normalizedDate(event.target.value); updateFilters({ start: base, end: base }); }} /></label> : <><label className="capture-date-label">시작<input aria-label="시작일" type="date" value={inputDate(filters.start)} disabled={!active} onChange={(event) => updateFilters({ start: normalizedDate(event.target.value) })} /></label><label className="capture-date-label">종료<input aria-label="종료일" type="date" value={inputDate(filters.end)} disabled={!active} onChange={(event) => updateFilters({ end: normalizedDate(event.target.value) })} /></label></>}</>}
        {sectorScreen && <div className="classic-periods" aria-label="빠른 업종 선택">{KNOWN_SECTOR_CHARTS.map(([value, label]) => <button type="button" key={value} title={`${value} ${label}`} disabled={!active} aria-pressed={filters.sector === value} onClick={() => chooseSector(value)}>{value} {label}</button>)}</div>}
        {code === "0602" && <div className="classic-periods" aria-label="차트 주기">{[["1", "1분"], ["3", "3분"], ["5", "5분"], ["10", "10분"], ["15", "15분"], ["30", "30분"], ["60", "60분"], ["D", "일"], ["W", "주"], ["M", "월"], ["Y", "년"]].map(([value, label]) => <button type="button" key={value} disabled={!active} aria-pressed={filters.interval === value} onClick={() => updateFilters({ interval: value as Filters["interval"] })}>{label}</button>)}</div>}
        {showQuery && <label className="capture-query-label">검색<input aria-label="검색어" value={queryDraft} maxLength={100} disabled={!active} onChange={(event) => setQueryDraft(event.target.value)} /></label>}
        {code === "0700" && <label className="classic-auto"><input aria-label="선택 종목 뉴스" type="checkbox" checked={newsInstrument} disabled={!active} onChange={(event) => changeNewsInstrument(event.target.checked)} />선택 종목</label>}
        {supportsAuto && <label className="classic-auto"><input aria-label="자동조회" type="checkbox" checked={autoRefresh} disabled={!active} onChange={(event) => changeAutoRefresh(event.target.checked)} />{autoRefreshLabel}</label>}
        {(showQuery || sectorScreen) && <button type="submit" className="classic-button" disabled={!active}>{showQuery ? "검색" : "적용"}</button>}
        <button type="button" className="classic-button" disabled={!active || result.loading} onClick={() => setRefreshNonce((value) => value + 1)}>새로고침</button>
      </form>
      {showLocalFilters && <div className="capture-local-filters" role="group" aria-label="수신 자료 필터" onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}><strong>수신 자료 필터</strong><label>종목/코드<input aria-label="수신 자료 종목 또는 코드" value={localFilters.localNameOrCode} maxLength={100} disabled={!active} onChange={(event) => updateLocalFilters({ localNameOrCode: event.target.value })} /></label>{localFilterCapabilities.has("price") && <label>최소 현재가(원)<input aria-label="최소 현재가" inputMode="decimal" value={localFilters.localMinPrice} maxLength={24} disabled={!active} onChange={(event) => updateLocalFilters({ localMinPrice: event.target.value })} /></label>}{localFilterCapabilities.has("volume") && <label>최소 거래량(주)<input aria-label="최소 거래량" inputMode="decimal" value={localFilters.localMinVolume} maxLength={24} disabled={!active} onChange={(event) => updateLocalFilters({ localMinVolume: event.target.value })} /></label>}{localFilterCapabilities.has("marketCap") && <label>최소 시가총액(억원)<input aria-label="최소 시가총액" inputMode="decimal" value={localFilters.localMinMarketCap} maxLength={24} disabled={!active} onChange={(event) => updateLocalFilters({ localMinMarketCap: event.target.value })} /></label>}{localFilterCapabilities.has("tradingValue") && <label>최소 거래대금(백만원)<input aria-label="최소 거래대금" inputMode="decimal" value={localFilters.localMinValue} maxLength={24} disabled={!active} onChange={(event) => updateLocalFilters({ localMinValue: event.target.value })} /></label>}<span>수신 {receivedRows.length}행에서만 필터링</span></div>}
      {data && <div className="classic-statusline capture-statusline"><span className="capture-status-main">{sourceText(data)}</span>{result.loading && <span className="capture-status-refreshing">갱신 중{result.cachedAt ? " · 이전 결과 표시" : ""}</span>}<span className="capture-status-detail" title={scopeText(data)}>{scopeText(data)}</span></div>}
      {!active && <p className="classic-empty" role="status">비활성 패널입니다. 조회를 중지했습니다.</p>}
      {active && result.loading && <p className="classic-empty" role="status">조회 중…</p>}
      {active && result.error && <p className="classic-error" role="alert">{result.error}</p>}
      {active && data && (code === "0602" ? <CaptureChart bars={data.bars} active={active} interval={filters.interval} label={sectorChartLabel(filters.sector)} ariaLabel="업종종합차트" />
        : code === "0211" ? <SectorCaptureView payload={data} active={active} onPick={onPick} onSector={chooseSector} />
          : code === "0200" ? <MarketCaptureView payload={data} onPick={onPick} onSector={chooseSector} />
            : code === "0700" ? <NewsCaptureView payload={data} provider={filters.provider} selectionScope={filters.query} onProvider={(provider) => updateFilters({ provider })} />
              : code === "0780" ? <InvestorCaptureView payload={data} />
              : <><CaptureGrid label={data.title} columns={data.columns} rows={rows} selectedId={selectedId} sort={gridSort} onSort={updateSort} onSelectRow={selectRow} onPick={pickRow} onSector={chooseSector} presentation={screenPresentation(code)} columnWidths={columnWidths} onColumnWidthsChange={updateColumnWidths} /><footer className="classic-pager capture-pager"><span>{sorted.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, sorted.length)} / ${sorted.length}개` : "0개"}</span>{data.scope && <span className="capture-pager-detail">{data.scope.returnedRows}행 수신{data.scope.limitedReason ? ` · ${data.scope.limitedReason}` : ""}</span>}<button type="button" className="classic-button" aria-label="이전 페이지" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</button><button type="button" className="classic-button" aria-label="다음 페이지" disabled={currentPage + 1 >= totalPages} onClick={() => setPage(currentPage + 1)}>다음</button></footer></>) }
    </section>
  );
}
