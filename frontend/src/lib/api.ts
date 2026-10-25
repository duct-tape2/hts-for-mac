import { sameFeed } from "./types";
import type { LocalWatchlistImport } from "./workspaceTransfer";
import type {
  ChartBar,
  ChartInterval,
  ChartPayload,
  Environment,
  Exchange,
  Health,
  Instrument,
  ListingVenue,
  Market,
  MarketSourceTime,
  ObservedMinute,
  Quote,
  QuoteStatus,
  ReadonlyState,
  SearchPayload,
  Watchlist,
  WatchlistItem,
} from "./types";

export class ApiShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiShapeError";
  }
}

type JsonObject = Record<string, unknown>;
type Parser<T> = (value: unknown) => T;

const markets = ["KR", "US"] as const;
const exchanges = ["KRX", "ND", "NY", "NA"] as const;
const venues = ["KOSPI", "KOSDAQ", "NASDAQ", "NYSE", "AMEX"] as const;
const environments = ["fixture", "demo", "real"] as const;
const quoteStatuses = ["snapshot", "live", "stale", "missing", "error"] as const;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiShapeError(`${label} 응답 형식이 올바르지 않습니다.`);
  return value as JsonObject;
}

function string(value: unknown, label: string) {
  if (typeof value !== "string") throw new ApiShapeError(`${label} 값이 없습니다.`);
  return value;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  return value;
}

function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  return value;
}

function nullableFinite(value: unknown, label: string) {
  return value === null ? null : finite(value, label);
}

function nullableString(value: unknown, label: string) {
  return value === null ? null : string(value, label);
}

function member<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  return value as T[number];
}

export function parseInstrument(value: unknown): Instrument {
  const row = object(value, "종목");
  const instrument = {
    market: member(row.market, markets, "market"),
    stkCd: string(row.stkCd, "stkCd"),
    stkNm: string(row.stkNm, "stkNm"),
    stexTp: member(row.stexTp, exchanges, "stexTp"),
    listingVenue: member(row.listingVenue, venues, "listingVenue"),
    quoteVenue: member(row.quoteVenue, exchanges, "quoteVenue"),
    currency: member(row.currency, ["KRW", "USD"] as const, "currency"),
    environment: member(row.environment, environments, "environment"),
  };
  if (!instrument.stkCd.trim()) throw new ApiShapeError("종목코드가 비어 있습니다.");
  const krListing = instrument.listingVenue === "KOSPI" || instrument.listingVenue === "KOSDAQ";
  const usListing = instrument.listingVenue === "NASDAQ" || instrument.listingVenue === "NYSE" || instrument.listingVenue === "AMEX";
  if (instrument.market === "KR") {
    if (!/^[0-9A-Z]{6}$/.test(instrument.stkCd) || !krListing || instrument.stexTp !== "KRX" || instrument.quoteVenue !== "KRX" || instrument.currency !== "KRW") {
      throw new ApiShapeError("국내 종목 식별자가 일관되지 않습니다.");
    }
  } else {
    const expectedQuoteVenue = instrument.listingVenue === "NASDAQ" ? "ND" : instrument.listingVenue === "NYSE" ? "NY" : "NA";
    if (!/^[A-Z][A-Z0-9.]{0,14}$/.test(instrument.stkCd) || !usListing || instrument.stexTp !== expectedQuoteVenue || instrument.quoteVenue !== expectedQuoteVenue || instrument.currency !== "USD") {
      throw new ApiShapeError("미국 종목 식별자가 일관되지 않습니다.");
    }
  }
  return instrument;
}

function parseWatchlist(value: unknown): Watchlist {
  const row = object(value, "관심종목 그룹");
  return {
    id: string(row.id, "watchlist.id"),
    name: string(row.name, "watchlist.name"),
    source: member(row.source, ["app", "kiwoom_import"] as const, "watchlist.source"),
    ...(typeof row.gcod === "string" ? { gcod: row.gcod } : {}),
  };
}

function displayNumber(row: JsonObject, key: string) {
  const value = row[key];
  return value === undefined ? null : nullableFinite(value, key);
}

function parseWatchlistItem(value: unknown): WatchlistItem {
  const row = object(value, "관심종목");
  return {
    ...parseInstrument(row),
    id: string(row.id, "item.id"),
    watchlistId: string(row.watchlistId, "item.watchlistId"),
    enabled: boolean(row.enabled, "item.enabled"),
    last: displayNumber(row, "last"),
    prevClose: displayNumber(row, "prevClose"),
    open: displayNumber(row, "open"),
    changePct: displayNumber(row, "changePct"),
  };
}

function parseLevels(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new ApiShapeError(`${label} 값이 올바르지 않습니다.`);
  return value.map((entry, index) => {
    const row = object(entry, `${label}[${index}]`);
    return { price: finite(row.price, `${label}.price`), qty: nullableFinite(row.qty, `${label}.qty`) };
  });
}

function parseSourceTime(value: unknown): MarketSourceTime | null {
  if (value === null) return null;
  const row = object(value, "시장 시각");
  if (row.timestamp !== null || row.timezone !== "unverified") throw new ApiShapeError("시장 시각 근거가 올바르지 않습니다.");
  return {
    rawTradeTime: nullableString(row.rawTradeTime, "rawTradeTime"),
    rawTradeDate: nullableString(row.rawTradeDate, "rawTradeDate"),
    rawLocalTradeTime: nullableString(row.rawLocalTradeTime, "rawLocalTradeTime"),
    precision: member(row.precision, ["second", "unknown"] as const, "precision"),
    datePrecision: member(row.datePrecision, ["day", "unavailable", "unknown"] as const, "datePrecision"),
    timezone: "unverified", timestamp: null, timestampStatus: string(row.timestampStatus, "timestampStatus"),
  };
}

function parseObservedMinute(value: unknown): ObservedMinute | null {
  if (value === null) return null;
  const row = object(value, "수신 관찰");
  const result: ObservedMinute = {
    basis: member(row.basis, ["receipt-time observations"] as const, "basis"),
    bucketStart: string(row.bucketStart, "bucketStart"),
    open: finite(row.open, "open"), high: finite(row.high, "high"),
    low: finite(row.low, "low"), close: finite(row.close, "close"),
    count: finite(row.count, "count"), firstSequence: finite(row.firstSequence, "firstSequence"),
    lastSequence: finite(row.lastSequence, "lastSequence"), complete: false,
  };
  if (row.complete !== false || !Number.isFinite(Date.parse(result.bucketStart)) ||
    result.low > Math.min(result.open,result.close) || result.high < Math.max(result.open,result.close) ||
    result.low <= 0 || !Number.isInteger(result.count) || result.count < 1 ||
    !Number.isInteger(result.firstSequence) || !Number.isInteger(result.lastSequence) ||
    result.firstSequence < 1 || result.lastSequence < result.firstSequence) throw new ApiShapeError("수신 관찰 범위가 올바르지 않습니다.");
  return result;
}

export function parseQuote(value: unknown): Quote {
  const row = object(value, "시세");
  const instrument = parseInstrument(row);
  const rawPrices = row.rawPrices;
  if (rawPrices !== undefined) {
    const raw = object(rawPrices, "rawPrices");
    for (const [key, price] of Object.entries(raw)) {
      if (price !== null && typeof price !== "string") throw new ApiShapeError(`rawPrices.${key} 값이 올바르지 않습니다.`);
    }
  }
  const quote = {
    ...instrument,
    last: nullableFinite(row.last, "last"),
    open: nullableFinite(row.open, "open"),
    high: nullableFinite(row.high, "high"),
    low: nullableFinite(row.low, "low"),
    prevClose: nullableFinite(row.prevClose, "prevClose"),
    change: nullableFinite(row.change, "change"),
    changePct: nullableFinite(row.changePct, "changePct"),
    volume: nullableFinite(row.volume, "volume"),
    bid: nullableFinite(row.bid, "bid"),
    ask: nullableFinite(row.ask, "ask"),
    bidQty: nullableFinite(row.bidQty, "bidQty"),
    askQty: nullableFinite(row.askQty, "askQty"),
    midPrice: nullableFinite(row.midPrice, "midPrice"),
    asks: parseLevels(row.asks, "asks"),
    bids: parseLevels(row.bids, "bids"),
    ...(rawPrices === undefined ? {} : { rawPrices: rawPrices as Record<string, string | null> }),
    source: member(row.source, ["kiwoom", "fixture"] as const, "source"),
    status: member(row.status, quoteStatuses, "status"),
    receivedAt: nullableString(row.receivedAt, "receivedAt"),
    ...(row.tradeReceivedAt === undefined ? {} : { tradeReceivedAt: nullableString(row.tradeReceivedAt, "tradeReceivedAt") }),
    ...(row.bookReceivedAt === undefined ? {} : { bookReceivedAt: nullableString(row.bookReceivedAt, "bookReceivedAt") }),
    ...(row.priceReceivedAt === undefined ? {} : { priceReceivedAt: nullableString(row.priceReceivedAt, "priceReceivedAt") }),
    ...(row.volumeReceivedAt === undefined ? {} : { volumeReceivedAt: nullableString(row.volumeReceivedAt, "volumeReceivedAt") }),
    ...(row.priceLive === undefined ? {} : { priceLive: boolean(row.priceLive, "priceLive") }),
    ...(row.volumeLive === undefined ? {} : { volumeLive: boolean(row.volumeLive, "volumeLive") }),
    ...(row.tradeSourceTime === undefined ? {} : { tradeSourceTime: parseSourceTime(row.tradeSourceTime) }),
    ...(row.bookSourceTime === undefined ? {} : { bookSourceTime: parseSourceTime(row.bookSourceTime) }),
    ...(row.observedMinute === undefined ? {} : { observedMinute: parseObservedMinute(row.observedMinute) }),
    sourceTimestamp: nullableString(row.sourceTimestamp, "sourceTimestamp"),
    note: string(row.note, "note"),
    bookLive: boolean(row.bookLive, "bookLive"),
    ...(row.bookNote === undefined ? {} : { bookNote: string(row.bookNote, "bookNote") }),
  };
  if ((quote.source === "fixture") !== (quote.environment === "fixture")) throw new ApiShapeError("시세 출처와 환경이 일관되지 않습니다.");
  return quote;
}

function parseBar(value: unknown, index: number): ChartBar {
  const row = object(value, `bars[${index}]`);
  return {
    t: string(row.t, `bars[${index}].t`),
    o: finite(row.o, `bars[${index}].o`),
    h: finite(row.h, `bars[${index}].h`),
    l: finite(row.l, `bars[${index}].l`),
    c: finite(row.c, `bars[${index}].c`),
    v: nullableFinite(row.v, `bars[${index}].v`),
  };
}

function parseChartRange(value: unknown) {
  if (value === undefined || value === null) return null;
  const row = object(value, "range");
  const range = {
    basis: string(row.basis, "range.basis"),
    start: string(row.start, "range.start"),
    end: string(row.end, "range.end"),
  };
  if (!range.basis || !range.start || !range.end) throw new ApiShapeError("range 값이 올바르지 않습니다.");
  return range;
}

export function parseChart(value: unknown): ChartPayload {
  const row = object(value, "차트");
  if (!Array.isArray(row.bars)) throw new ApiShapeError("bars 값이 올바르지 않습니다.");
  const instrument = parseInstrument(row);
  const chart = {
    ...instrument,
    interval: member(row.interval, ["1", "3", "5", "10", "15", "30", "45", "60", "D", "W", "M", "Y"] as const, "interval"),
    bars: row.bars.map(parseBar),
    source: member(row.source, ["kiwoom", "fixture"] as const, "source"),
    status: member(row.status, quoteStatuses, "status"),
    receivedAt: nullableString(row.receivedAt, "receivedAt"),
    sourceTimestamp: nullableString(row.sourceTimestamp, "sourceTimestamp"),
    range: parseChartRange(row.range),
    note: string(row.note, "note"),
    complete: boolean(row.complete, "complete"),
    adjusted: boolean(row.adjusted, "adjusted"),
  };
  if ((chart.source === "fixture") !== (chart.environment === "fixture")) throw new ApiShapeError("차트 출처와 환경이 일관되지 않습니다.");
  return chart;
}

function parseReadonlyState(value: unknown): ReadonlyState {
  const row = object(value, "상태");
  if (!Array.isArray(row.watchlists) || !Array.isArray(row.items)) throw new ApiShapeError("관심종목 상태 형식이 올바르지 않습니다.");
  return {
    mode: member(row.mode, environments, "mode"),
    kiwoom: member(row.kiwoom, ["connected", "disconnected"] as const, "kiwoom"),
    kiwoomError: string(row.kiwoomError, "kiwoomError"),
    watchlists: row.watchlists.map(parseWatchlist),
    items: row.items.map(parseWatchlistItem),
    ...(typeof row.watchlistNote === "string" ? { watchlistNote: row.watchlistNote } : {}),
  };
}

function parseSearch(value: unknown): SearchPayload {
  const row = object(value, "검색");
  if (!Array.isArray(row.results)) throw new ApiShapeError("검색 결과 형식이 올바르지 않습니다.");
  return { results: row.results.map(parseInstrument), complete: boolean(row.complete, "complete"), note: string(row.note, "note") };
}

function parseHealth(value: unknown): Health {
  const row = object(value, "상태");
  return {
    ok: boolean(row.ok, "ok"),
    version: string(row.version, "version"),
    mode: member(row.mode, environments, "mode"),
    kiwoom: member(row.kiwoom, ["connected", "disconnected"] as const, "kiwoom"),
    error: string(row.error, "error"),
    note: string(row.note, "note"),
  };
}

async function request<T>(path: string, parse: Parser<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const body = JSON.parse(text) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // Keep a non-JSON server error human-readable.
    }
    throw new Error(detail || `${init?.method ?? "GET"} ${path} ${res.status}`);
  }
  return parse(await res.json());
}

function queryFor(instrument: Instrument) {
  const params = new URLSearchParams({
    stk_cd: instrument.stkCd,
    stex_tp: instrument.stexTp,
    market: instrument.market,
    listing_venue: instrument.listingVenue,
  });
  return params.toString();
}

function assertFeed<T extends Instrument>(expected: Instrument, actual: T): T {
  if (!sameFeed(expected, actual)) throw new ApiShapeError("선택한 종목과 다른 데이터가 도착했습니다.");
  return actual;
}

type SharedChart = { promise: Promise<ChartPayload>; controller: AbortController; users: number; done: boolean };
const chartRequests = new Map<string, SharedChart>();

function sharedChart(instrument: Instrument, interval: ChartInterval, signal?: AbortSignal): Promise<ChartPayload> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const path = `/api/charts?${queryFor(instrument)}&interval=${interval}`;
  const key = `${instrument.environment}:${path}`;
  let entry = chartRequests.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 0, done: false, promise: request(path, parseChart, { signal: controller.signal }).then((chart) => assertFeed(instrument, chart)) };
    const own = entry;
    const finish = () => {
      own.done = true;
      if (chartRequests.get(key) === own) chartRequests.delete(key);
    };
    void entry.promise.then(finish, finish);
    chartRequests.set(key, entry);
  }
  const shared = entry;
  shared.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", abort);
      shared.users--;
      if (!shared.users && !shared.done) {
        shared.controller.abort();
        if (chartRequests.get(key) === shared) chartRequests.delete(key);
      }
      return true;
    };
    const abort = () => { if (release()) reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    shared.promise.then((chart) => { if (release()) resolve(chart); }, (error) => { if (release()) reject(error); });
  });
}

export const api = {
  health: (signal?: AbortSignal) => request("/api/health", parseHealth, { signal }),
  state: (signal?: AbortSignal) => request("/api/state", parseReadonlyState, { signal }),
  searchSymbols: (q: string, market: Market, signal?: AbortSignal) =>
    request(`/api/symbols/search?q=${encodeURIComponent(q)}&market=${market}`, parseSearch, { signal }),
  quote: async (instrument: Instrument, signal?: AbortSignal) =>
    assertFeed(instrument, await request(`/api/quotes?${queryFor(instrument)}`, parseQuote, { signal })),
  chart: sharedChart,
  streamUrl: (instrument: Instrument) => `/api/quotes/stream?${queryFor(instrument)}`,
  addWatchlist: (name: string) =>
    request("/api/watchlists", parseReadonlyState, { method: "POST", body: JSON.stringify({ name }) }),
  removeWatchlist: (id: string) => request(`/api/watchlists/${encodeURIComponent(id)}`, parseReadonlyState, { method: "DELETE" }),
  addItem: (watchlistId: string, instrument: Instrument) =>
    request(`/api/watchlists/${encodeURIComponent(watchlistId)}/items`, parseReadonlyState, {
      method: "POST",
      body: JSON.stringify(instrument),
    }),
  removeItem: (watchlistId: string, itemId: string) =>
    request(`/api/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(itemId)}`, parseReadonlyState, {
      method: "DELETE",
    }),
  saveWatchlist: (watchlistId: string) =>
    request(`/api/watchlists/${encodeURIComponent(watchlistId)}/save`, parseReadonlyState, { method: "POST" }),
  importKiwoom: (watchlistId: string, market: Market = "US") =>
    request(`/api/watchlists/${encodeURIComponent(watchlistId)}/import-kiwoom${market === "KR" ? "?market=KR" : ""}`, parseReadonlyState, { method: "POST" }),
  importLocalWatchlists: (payload: LocalWatchlistImport) =>
    request("/api/watchlists/import-local", parseReadonlyState, { method: "POST", body: JSON.stringify(payload) }),
};

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function environmentLabel(environment: Environment) {
  return environment === "fixture" ? "fixture" : environment === "demo" ? "demo" : "real";
}

export function exchangeFromVenue(market: Market, venue: ListingVenue): Exchange {
  if (market === "KR") return "KRX";
  return venue === "NASDAQ" ? "ND" : venue === "NYSE" ? "NY" : "NA";
}

export function isQuoteStatus(value: string): value is QuoteStatus {
  return quoteStatuses.includes(value as QuoteStatus);
}
