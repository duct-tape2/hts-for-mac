import type { Exchange, Instrument } from "./types";

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatUsd(value: number | null | undefined, digits = 2) {
  if (!isNumber(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatKrw(value: number | null | undefined) {
  if (!isNumber(value)) return "—";
  return `${new Intl.NumberFormat("ko-KR").format(Math.round(value))}원`;
}

export function formatPrice(value: number | null | undefined, currency: Instrument["currency"]) {
  return currency === "KRW" ? formatKrw(value) : formatUsd(value);
}

export function formatQty(value: number | null | undefined) {
  return isNumber(value) ? new Intl.NumberFormat("en-US").format(value) : "—";
}

export function formatSignedPrice(value: number | null | undefined, currency: Instrument["currency"]) {
  if (!isNumber(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatPrice(value, currency)}`;
}

export function formatVol(value: number | null | undefined) {
  if (!isNumber(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatQty(value);
}

export function formatNum(value: number | null | undefined, digits = 2) {
  if (!isNumber(value)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatPct(value: number | null | undefined) {
  if (!isNumber(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function changeClass(value: number | null | undefined) {
  if (!isNumber(value)) return "text-cream-500";
  if (value > 0) return "text-up";
  if (value < 0) return "text-down";
  return "text-cream-300";
}

export function exchangeLabel(code: Exchange) {
  return { KRX: "KRX", ND: "NASDAQ", NY: "NYSE", NA: "AMEX" }[code];
}

export function formatReceivedAt(value: string | null | undefined) {
  if (!value) return "수신 시각 미상";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "수신 시각 미상";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}
