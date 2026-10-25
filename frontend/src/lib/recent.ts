import type { Instrument } from "./types";

export type RecentSymbol = Instrument;

const KEY = "kiwoom-readonly-recent-v1";
const LIMIT = 6;

export function readRecent(): RecentSymbol[] {
  try {
    const raw = localStorage.getItem(KEY);
    const rows = raw ? (JSON.parse(raw) as RecentSymbol[]) : [];
    return Array.isArray(rows) ? rows.filter(isRecentSymbol).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function pushRecent(hit: RecentSymbol) {
  const stkCd = hit.market === "US" ? hit.stkCd.trim().toUpperCase() : hit.stkCd.trim();
  if (!stkCd) return [];
  const next = [{ ...hit, stkCd }, ...readRecent().filter((row) => !(row.market === hit.market && row.stkCd === stkCd && row.listingVenue === hit.listingVenue && row.quoteVenue === hit.quoteVenue))].slice(0, LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Recent selections are a convenience only.
  }
  return next;
}

function isRecentSymbol(value: unknown): value is RecentSymbol {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RecentSymbol>;
  return (
    (row.market === "KR" || row.market === "US") &&
    typeof row.stkCd === "string" &&
    typeof row.stkNm === "string" &&
    (row.stexTp === "KRX" || row.stexTp === "ND" || row.stexTp === "NY" || row.stexTp === "NA") &&
    typeof row.listingVenue === "string" &&
    typeof row.quoteVenue === "string" &&
    (row.currency === "KRW" || row.currency === "USD") &&
    (row.environment === "fixture" || row.environment === "demo" || row.environment === "real")
  );
}
