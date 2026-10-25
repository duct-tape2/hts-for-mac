import { parseInstrument } from "@/lib/api";
import type { Environment, Instrument } from "@/lib/types";

export const CAPTURE_SCREEN_CODES = ["0198", "0187", "0186", "0184", "0162", "0211", "0602", "0780", "2797", "0200", "0700"] as const;
export type CaptureScreenCode = (typeof CAPTURE_SCREEN_CODES)[number];

export type CaptureColumn = { key: string; label: string; unit?: string; numeric?: boolean; precision?: number };
export type CaptureRow = {
  id: string;
  instrument?: Instrument;
  sectorCode?: string;
  [key: string]: string | number | null | Instrument | undefined;
};
export type CaptureSection = {
  id: string;
  title: string;
  columns: CaptureColumn[];
  rows: CaptureRow[];
  source: string;
  status: CaptureStatus;
  asOf: string | null;
  note: string;
};
export type CaptureScope = {
  appliedFilters: Record<string, string>;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  returnedRows: number;
  limitedReason: string | null;
  unsupported: string[];
};
export type CaptureBar = { t: string; o: number; h: number; l: number; c: number; v: number | null };
export type CaptureNews = { id: string; title: string; provider: string; publishedAt: string; url: string; summary: string; symbol?: string };
export type CaptureStatus = "snapshot" | "delayed" | "missing" | "error" | "fixture";
export type CapturePayload = {
  screen: CaptureScreenCode;
  title: string;
  source: string;
  status: CaptureStatus;
  environment: Environment;
  receivedAt: string | null;
  asOf: string | null;
  note: string;
  complete: boolean;
  columns: CaptureColumn[];
  rows: CaptureRow[];
  sections: CaptureSection[];
  bars: CaptureBar[];
  news: CaptureNews[];
  scope?: CaptureScope;
  selectionPending?: boolean;
};

export type CaptureParams = {
  market?: "all" | "KOSPI" | "KOSDAQ";
  venue?: "KRX" | "NXT" | "ALL";
  sort?: "volume" | "turnover" | "value";
  direction?: "up" | "down" | "rise" | "fall" | "flat" | "previousUpLimit" | "previousDownLimit";
  session?: "all" | "regular" | "preMarket" | "afterMarket";
  stock?: "all" | "excludeManaged" | "excludePreferred" | "excludeManagedPreferred" | "excludeEtf" | "excludeEtfEtn";
  credit?: "all" | "creditAll" | "creditA" | "creditB" | "creditC" | "creditD" | "creditE" | "loan";
  volumeBand?: "all" | "5k" | "10k" | "50k" | "100k" | "150k" | "200k" | "300k" | "500k" | "1m";
  priceBand?: "all" | "under1k" | "over1k" | "1to2k" | "2to3k" | "2to5k" | "over5k" | "5to10k" | "under10k" | "over10k" | "over50k" | "over100k";
  valueBand?: "all" | "10m" | "30m" | "50m" | "100m" | "300m" | "500m" | "1b" | "3b" | "5b" | "10b" | "30b" | "50b";
  limitSort?: "code" | "streak" | "changePct";
  managed?: "exclude" | "include";
  interval?: "1" | "3" | "5" | "10" | "15" | "30" | "60" | "D" | "W" | "M" | "Y";
  sector?: string;
  start?: string;
  end?: string;
  unit?: "amount" | "volume";
  period?: "1" | "2" | "3" | "4" | "5";
  query?: string;
  provider?: string;
};

export class CaptureShapeError extends Error {
  constructor(message = "캡처 화면 데이터 형식을 확인할 수 없습니다.") {
    super(message);
    this.name = "CaptureShapeError";
  }
}

const STATUSES = ["snapshot", "delayed", "missing", "error", "fixture"] as const;
const ENVIRONMENTS = ["fixture", "demo", "real"] as const;
const columnKey = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const code = /^[A-Za-z0-9_.-]{1,32}$/;
const compactText = /^[^\u0000-\u001F]{1,100}$/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CaptureShapeError();
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new CaptureShapeError();
  return value;
}

function noteText(value: unknown): string {
  if (typeof value !== "string") throw new CaptureShapeError();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001F]/.test(value)) throw new CaptureShapeError();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : requiredText(value);
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CaptureShapeError();
  return value;
}

function nullableFinite(value: unknown): number | null {
  return value === null ? null : finite(value);
}

function status(value: unknown): CaptureStatus {
  if (typeof value !== "string" || !STATUSES.includes(value as CaptureStatus)) throw new CaptureShapeError();
  return value as CaptureStatus;
}

function environment(value: unknown): Environment {
  if (typeof value !== "string" || !ENVIRONMENTS.includes(value as Environment)) throw new CaptureShapeError();
  return value as Environment;
}

function receivedAt(value: unknown): string | null {
  const result = nullableText(value);
  if (result !== null && Number.isNaN(Date.parse(result))) throw new CaptureShapeError();
  return result;
}

/** Converts supported capture timestamps to UTC milliseconds without browser-specific parsing. */
export function captureTimestamp(value: string): number | null {
  const compact = value.replace(/[ T:.-]/g, "");
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(compact);
  if (match && (compact.length === 8 || compact.length === 14)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] ?? 0);
    const minute = Number(match[5] ?? 0);
    const second = Number(match[6] ?? 0);
    const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
      ? timestamp
      : null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function columns(value: unknown): CaptureColumn[] {
  if (!Array.isArray(value)) throw new CaptureShapeError();
  const seen = new Set<string>();
  return value.map((entry) => {
    const next = record(entry);
    const key = requiredText(next.key);
    const label = requiredText(next.label);
    if (!columnKey.test(key) || seen.has(key)) throw new CaptureShapeError();
    seen.add(key);
    if (next.unit !== undefined && typeof next.unit !== "string") throw new CaptureShapeError();
    if (next.numeric !== undefined && typeof next.numeric !== "boolean") throw new CaptureShapeError();
    const precision = next.precision;
    if (precision !== undefined && (typeof precision !== "number" || !Number.isInteger(precision) || precision < 0 || precision > 8)) throw new CaptureShapeError();
    return {
      key,
      label,
      ...(next.unit === undefined ? {} : { unit: next.unit }),
      ...(next.numeric === undefined ? {} : { numeric: next.numeric }),
      ...(precision === undefined ? {} : { precision }),
    };
  });
}

function rows(value: unknown, visibleColumns: CaptureColumn[], expectedEnvironment: Environment): CaptureRow[] {
  if (!Array.isArray(value)) throw new CaptureShapeError();
  const keys = new Set(visibleColumns.map((column) => column.key));
  const identities = new Set<string>();
  return value.map((entry) => {
    const raw = record(entry);
    for (const [key, metadata] of Object.entries(raw)) {
      if (key === "id" || key === "instrument" || key === "sectorCode" || keys.has(key)) continue;
      // Providers sometimes retain non-displayed scalar fields (for example
      // currency or a sign marker). They are deliberately not rendered.
      if (metadata !== null && typeof metadata !== "string" && (typeof metadata !== "number" || !Number.isFinite(metadata))) throw new CaptureShapeError();
    }
    const id = identifier(raw.id);
    if (identities.has(id)) throw new CaptureShapeError();
    identities.add(id);
    const next: CaptureRow = { id };
    for (const column of visibleColumns) {
      if (!(column.key in raw)) throw new CaptureShapeError();
      const cell = raw[column.key];
      if (cell !== null && typeof cell !== "string" && (typeof cell !== "number" || !Number.isFinite(cell))) throw new CaptureShapeError();
      next[column.key] = cell as string | number | null;
    }
    // Keep documented provider metadata (notably rankChangeSign) available to
    // the presenter. It must remain scalar so untrusted nested objects cannot
    // quietly cross the transport boundary.
    for (const [key, metadata] of Object.entries(raw)) {
      if (key === "id" || key === "instrument" || key === "sectorCode" || keys.has(key)) continue;
      next[key] = metadata as string | number | null;
    }
    if (raw.instrument !== undefined) {
      let instrument: Instrument;
      try {
        instrument = parseInstrument(raw.instrument);
      } catch {
        throw new CaptureShapeError();
      }
      if (instrument.environment !== expectedEnvironment) throw new CaptureShapeError();
      next.instrument = instrument;
    }
    if (raw.sectorCode !== undefined) {
      const sectorCode = requiredText(raw.sectorCode);
      if (!code.test(sectorCode)) throw new CaptureShapeError();
      next.sectorCode = sectorCode;
    }
    return next;
  });
}

function scope(value: unknown): CaptureScope | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  const expected = ["appliedFilters", "effectiveStart", "effectiveEnd", "returnedRows", "limitedReason", "unsupported"];
  if (Object.keys(raw).length !== expected.length || expected.some((key) => !(key in raw))) throw new CaptureShapeError();
  const filters = record(raw.appliedFilters);
  const appliedFilters: Record<string, string> = {};
  for (const [key, filter] of Object.entries(filters)) {
    if (!columnKey.test(key) || typeof filter !== "string" || !compactText.test(filter)) throw new CaptureShapeError();
    appliedFilters[key] = filter;
  }
  const returnedRows = finite(raw.returnedRows);
  if (!Number.isInteger(returnedRows) || returnedRows < 0) throw new CaptureShapeError();
  if (!Array.isArray(raw.unsupported) || raw.unsupported.some((entry) => typeof entry !== "string" || !compactText.test(entry))) throw new CaptureShapeError();
  return {
    appliedFilters,
    effectiveStart: raw.effectiveStart === null ? null : requiredText(raw.effectiveStart),
    effectiveEnd: raw.effectiveEnd === null ? null : requiredText(raw.effectiveEnd),
    returnedRows,
    limitedReason: raw.limitedReason === null ? null : requiredText(raw.limitedReason),
    unsupported: [...raw.unsupported],
  };
}

function sections(value: unknown, expectedEnvironment: Environment): CaptureSection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CaptureShapeError();
  const seen = new Set<string>();
  return value.map((entry) => {
    const raw = record(entry);
    const id = identifier(raw.id);
    if (seen.has(id)) throw new CaptureShapeError();
    seen.add(id);
    const sectionColumns = columns(raw.columns);
    return {
      id,
      title: requiredText(raw.title),
      columns: sectionColumns,
      rows: rows(raw.rows, sectionColumns, expectedEnvironment),
      source: requiredText(raw.source),
      status: status(raw.status),
      asOf: nullableText(raw.asOf),
      note: noteText(raw.note),
    };
  });
}

function bars(value: unknown): CaptureBar[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CaptureShapeError();
  return value.map((entry) => {
    const raw = record(entry);
    const t = requiredText(raw.t);
    if (captureTimestamp(t) === null) throw new CaptureShapeError();
    const o = finite(raw.o);
    const h = finite(raw.h);
    const l = finite(raw.l);
    const c = finite(raw.c);
    const v = nullableFinite(raw.v);
    if (h < Math.max(o, c) || l > Math.min(o, c) || l > h || (v !== null && v < 0)) throw new CaptureShapeError();
    return { t, o, h, l, c, v };
  });
}

function safeUrl(value: unknown): string {
  const url = requiredText(value);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new CaptureShapeError();
  } catch {
    throw new CaptureShapeError();
  }
  return url;
}

function news(value: unknown): CaptureNews[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CaptureShapeError();
  const seen = new Set<string>();
  return value.map((entry) => {
    const raw = record(entry);
    const id = identifier(raw.id);
    if (seen.has(id)) throw new CaptureShapeError();
    seen.add(id);
    // RSS feeds legitimately omit a parseable publication date. Preserve an
    // empty value as "unknown" so that one undated article cannot discard the
    // complete response; non-empty malformed values remain a schema error.
    if (typeof raw.publishedAt !== "string") throw new CaptureShapeError();
    const publishedAt = raw.publishedAt;
    if (publishedAt && Number.isNaN(Date.parse(publishedAt))) throw new CaptureShapeError();
    if (raw.symbol !== undefined && typeof raw.symbol !== "string") throw new CaptureShapeError();
    return {
      id,
      title: requiredText(raw.title),
      provider: requiredText(raw.provider),
      publishedAt,
      url: safeUrl(raw.url),
      summary: typeof raw.summary === "string" ? raw.summary : (() => { throw new CaptureShapeError(); })(),
      ...(raw.symbol === undefined ? {} : { symbol: raw.symbol }),
    };
  });
}

export function parseCapturePayload(value: unknown, expectedScreen: CaptureScreenCode, expectedEnvironment?: Environment): CapturePayload {
  const raw = record(value);
  if (raw.screen !== expectedScreen) throw new CaptureShapeError();
  const payloadEnvironment = environment(raw.environment);
  if (expectedEnvironment !== undefined && payloadEnvironment !== expectedEnvironment) throw new CaptureShapeError("선택한 환경과 다른 캡처 데이터가 도착했습니다.");
  const source = requiredText(raw.source);
  // A fixture response must say so, and a non-fixture response cannot be
  // rendered as a fixture. This prevents provenance from being silently lost.
  if ((source === "fixture") !== (payloadEnvironment === "fixture")) throw new CaptureShapeError();
  const responseColumns = columns(raw.columns);
  const parsedRows = rows(raw.rows, responseColumns, payloadEnvironment);
  const parsedScope = scope(raw.scope);
  if (raw.selectionPending !== undefined && raw.selectionPending !== true) throw new CaptureShapeError();
  return {
    screen: expectedScreen,
    title: requiredText(raw.title),
    source,
    status: status(raw.status),
    environment: payloadEnvironment,
    receivedAt: receivedAt(raw.receivedAt),
    asOf: nullableText(raw.asOf),
    note: noteText(raw.note),
    complete: raw.complete === true || raw.complete === false ? raw.complete : (() => { throw new CaptureShapeError(); })(),
    columns: responseColumns,
    rows: parsedRows,
    sections: sections(raw.sections, payloadEnvironment),
    bars: bars(raw.bars),
    news: news(raw.news),
    ...(parsedScope === undefined ? {} : { scope: parsedScope }),
    ...(raw.selectionPending === true ? { selectionPending: true } : {}),
  };
}

function isCaptureScreen(value: string): value is CaptureScreenCode {
  return (CAPTURE_SCREEN_CODES as readonly string[]).includes(value);
}

function date(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{8}$/.test(value)) throw new CaptureShapeError("조회 조건이 올바르지 않습니다.");
  return value;
}

function parameter(name: keyof CaptureParams, value: string | undefined, values?: readonly string[]) {
  if (value === undefined) return undefined;
  if (values && !values.includes(value)) throw new CaptureShapeError("조회 조건이 올바르지 않습니다.");
  if (!values && (!compactText.test(value) || value.length > 100)) throw new CaptureShapeError("조회 조건이 올바르지 않습니다.");
  return [name, value] as const;
}

export function captureQuery(params: CaptureParams = {}) {
  const values: Array<readonly [string, string]> = [];
  const append = (item: readonly [string, string] | undefined) => { if (item) values.push(item); };
  append(parameter("market", params.market, ["all", "KOSPI", "KOSDAQ"]));
  append(parameter("venue", params.venue, ["KRX", "NXT", "ALL"]));
  append(parameter("sort", params.sort, ["volume", "turnover", "value"]));
  append(parameter("direction", params.direction, ["up", "down", "rise", "fall", "flat", "previousUpLimit", "previousDownLimit"]));
  append(parameter("session", params.session, ["all", "regular", "preMarket", "afterMarket"]));
  append(parameter("stock", params.stock, ["all", "excludeManaged", "excludePreferred", "excludeManagedPreferred", "excludeEtf", "excludeEtfEtn"]));
  append(parameter("credit", params.credit, ["all", "creditAll", "creditA", "creditB", "creditC", "creditD", "creditE", "loan"]));
  append(parameter("volumeBand", params.volumeBand, ["all", "5k", "10k", "50k", "100k", "150k", "200k", "300k", "500k", "1m"]));
  append(parameter("priceBand", params.priceBand, ["all", "under1k", "over1k", "1to2k", "2to3k", "2to5k", "over5k", "5to10k", "under10k", "over10k", "over50k", "over100k"]));
  append(parameter("valueBand", params.valueBand, ["all", "10m", "30m", "50m", "100m", "300m", "500m", "1b", "3b", "5b", "10b", "30b", "50b"]));
  append(parameter("limitSort", params.limitSort, ["code", "streak", "changePct"]));
  append(parameter("managed", params.managed, ["exclude", "include"]));
  append(parameter("interval", params.interval, ["1", "3", "5", "10", "15", "30", "60", "D", "W", "M", "Y"]));
  if (params.sector !== undefined && !code.test(params.sector)) throw new CaptureShapeError("조회 조건이 올바르지 않습니다.");
  append(params.sector === undefined ? undefined : ["sector", params.sector]);
  append(date(params.start) === undefined ? undefined : ["start", params.start as string]);
  append(date(params.end) === undefined ? undefined : ["end", params.end as string]);
  append(parameter("unit", params.unit, ["amount", "volume"]));
  append(parameter("period", params.period, ["1", "2", "3", "4", "5"]));
  if (params.query !== undefined && params.query.length > 100) throw new CaptureShapeError("조회 조건이 올바르지 않습니다.");
  if (params.query?.trim()) values.push(["query", params.query.trim()]);
  append(parameter("provider", params.provider));
  return new URLSearchParams(values as [string, string][]).toString();
}

export class CaptureTimeoutError extends Error {
  constructor(message = "캡처 화면 조회 시간이 초과되었습니다.") {
    super(message);
    this.name = "CaptureTimeoutError";
  }
}

export async function fetchCaptureScreen(screen: CaptureScreenCode, params: CaptureParams, signal?: AbortSignal, expectedEnvironment?: Environment): Promise<CapturePayload> {
  if (!isCaptureScreen(screen)) throw new CaptureShapeError("지원하지 않는 캡처 화면입니다.");
  const query = captureQuery(params);
  const timeoutMs = screen === "0700" ? 12_000 : 20_000;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response: Response;
  try {
    response = await fetch(`/api/hts/screens/${screen}${query ? `?${query}` : ""}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (timedOut) throw new CaptureTimeoutError(screen === "0700" ? "뉴스 조회가 12초 안에 끝나지 않았습니다." : "캡처 화면 조회 시간이 초과되었습니다.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    let message = "캡처 화면을 불러오지 못했습니다.";
    try {
      const body = record(await response.json());
      if (typeof body.detail === "string" && body.detail) message = body.detail;
    } catch {
      // A server error without JSON remains intentionally generic.
    }
    throw new Error(message);
  }
  return parseCapturePayload(await response.json(), screen, expectedEnvironment);
}

export function isCaptureAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
