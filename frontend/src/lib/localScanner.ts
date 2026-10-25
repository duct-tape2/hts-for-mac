import { feedKeyOf, sameFeed } from "./types";
import type { Environment, Instrument, Quote, WatchlistItem } from "./types";

export const LOCAL_SCANNER_CONCURRENCY = 2;

export type LocalScannerFilters = {
  minPrice: string;
  minChangePct: string;
  minVolume: string;
};

export type LocalScannerNumbers = {
  minPrice: number | null;
  minChangePct: number | null;
  minVolume: number | null;
};

export type LocalScannerRow = {
  instrument: Instrument;
  quote: Quote | null;
  error: string | null;
  availability: "ready" | "stale" | "unavailable";
};

export type LocalScannerSortKey = "name" | "last" | "changePct" | "volume";
export type LocalScannerSort = { key: LocalScannerSortKey; direction: "asc" | "desc" };

export function localScannerUniverse(items: WatchlistItem[], groupId: string, reference: Instrument, environment: Environment): Instrument[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    if (!item.enabled || item.watchlistId !== groupId || item.market !== reference.market || item.currency !== reference.currency) return [];
    const instrument: Instrument = {
      market: item.market, stkCd: item.stkCd, stkNm: item.stkNm, stexTp: item.stexTp,
      listingVenue: item.listingVenue, quoteVenue: item.quoteVenue, currency: item.currency, environment,
    };
    const identity = JSON.stringify(feedKeyOf(instrument));
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [instrument];
  });
}

export function parseLocalScannerFilters(filters: LocalScannerFilters): { values: LocalScannerNumbers; error: string | null } {
  const parse = (value: string, label: string): number | null | string => {
    if (!value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : `${label}에는 유한한 숫자를 입력하세요.`;
  };
  const price = parse(filters.minPrice, "최소 현재가");
  const changePct = parse(filters.minChangePct, "최소 등락률");
  const volume = parse(filters.minVolume, "최소 거래량");
  const error = [price, changePct, volume].find((value): value is string => typeof value === "string") ?? null;
  return {
    values: {
      minPrice: typeof price === "number" ? price : null,
      minChangePct: typeof changePct === "number" ? changePct : null,
      minVolume: typeof volume === "number" ? volume : null,
    },
    error,
  };
}

function known(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function localScannerRows(
  universe: Instrument[],
  responses: Array<{ instrument: Instrument; quote?: Quote; error?: string }>,
): LocalScannerRow[] {
  const received = new Map(responses.map((response) => [JSON.stringify(feedKeyOf(response.instrument)), response]));
  return universe.map((instrument) => {
    const response = received.get(JSON.stringify(feedKeyOf(instrument)));
    const quote = response?.quote && sameFeed(instrument, response.quote) ? response.quote : null;
    const availability = quote?.status === "stale" ? "stale" : quote && (quote.status === "live" || quote.status === "snapshot") ? "ready" : "unavailable";
    return { instrument, quote, error: response?.error ?? null, availability };
  });
}

export function filterLocalScannerRows(rows: LocalScannerRow[], filters: LocalScannerNumbers): LocalScannerRow[] {
  return rows.filter((row) => {
    if (row.availability !== "ready" || !row.quote) return false;
    const checks: Array<[number | null, number | null]> = [
      [row.quote.last, filters.minPrice],
      [row.quote.changePct, filters.minChangePct],
      [row.quote.volume, filters.minVolume],
    ];
    return checks.every(([value, minimum]) => minimum === null || (known(value) && value >= minimum));
  });
}

export function sortLocalScannerRows(rows: LocalScannerRow[], sort: LocalScannerSort): LocalScannerRow[] {
  const value = (row: LocalScannerRow): string | number | null => {
    if (sort.key === "name") return row.instrument.stkNm;
    return row.quote?.[sort.key] ?? null;
  };
  return [...rows].sort((left, right) => {
    const a = value(left), b = value(right);
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    const compared = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "ko");
    return sort.direction === "asc" ? compared : -compared;
  });
}

export function localScannerCounts(rows: LocalScannerRow[]) {
  return {
    ready: rows.filter((row) => row.availability === "ready").length,
    stale: rows.filter((row) => row.availability === "stale").length,
    unavailable: rows.filter((row) => row.availability === "unavailable").length,
  };
}

export async function collectLocalScannerQuotes(
  instruments: Instrument[],
  load: (instrument: Instrument, signal: AbortSignal) => Promise<Quote>,
  signal: AbortSignal,
): Promise<Array<{ instrument: Instrument; quote?: Quote; error?: string }>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const results: Array<{ instrument: Instrument; quote?: Quote; error?: string }> = new Array(instruments.length);
  let next = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const index = next++;
      if (index >= instruments.length) return;
      const instrument = instruments[index];
      try {
        const quote = await load(instrument, signal);
        if (signal.aborted) return;
        results[index] = { instrument, quote };
      } catch (error) {
        if (signal.aborted) return;
        results[index] = { instrument, error: error instanceof Error ? error.message : "시세를 받지 못했습니다." };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOCAL_SCANNER_CONCURRENCY, instruments.length) }, worker));
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return results;
}

export function localScannerCsv(rows: LocalScannerRow[]): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const header = ["종목", "코드", "시장", "통화", "현재가", "등락률", "거래량", "출처", "상태"];
  const body = rows.map((row) => [
    row.instrument.stkNm,
    row.instrument.stkCd,
    row.instrument.market,
    row.instrument.currency,
    row.quote?.last,
    row.quote?.changePct,
    row.quote?.volume,
    row.quote?.source,
    row.quote?.status ?? row.availability,
  ]);
  return [header, ...body].map((line) => line.map(cell).join(",")).join("\r\n");
}
