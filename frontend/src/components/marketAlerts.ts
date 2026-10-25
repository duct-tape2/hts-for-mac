import { feedKeyOf, sameFeed } from "@/lib/types";
import type { Instrument, Quote } from "@/lib/types";
import { withAlertStorageLock, type AlertLockManager } from "./alertOwnership";

export type AlertKind = "above" | "below" | "volume";

export type MarketAlertRule = {
  id: string;
  feedKey: string;
  instrument: Instrument;
  symbol: string;
  currency: Instrument["currency"];
  environment: Instrument["environment"];
  kind: AlertKind;
  threshold: number;
  armed: boolean;
  createdAt: string;
};

export type MarketAlertEvent = {
  id: string;
  ruleId: string;
  feedKey: string;
  symbol: string;
  currency: Instrument["currency"];
  environment: Instrument["environment"];
  kind: AlertKind;
  threshold: number;
  value: number;
  source: Quote["source"];
  fixture: boolean;
  firedAt: string;
};

export type AlertStorage = {
  rules: MarketAlertRule[];
  history: MarketAlertEvent[];
};

export const ALERT_STORAGE_KEY = "kiwoom-readonly-market-alerts-v1";
export const ALERT_HISTORY_LIMIT = 30;
export const ALERT_RULE_LIMIT = 100;

export function createAlertRule({
  feedKey,
  instrument,
  kind,
  threshold,
  now = new Date().toISOString(),
}: {
  feedKey: string;
  instrument: Instrument;
  kind: AlertKind;
  threshold: number;
  now?: string;
}): MarketAlertRule {
  if (!feedKey || !isAlertKind(kind) || !isPositiveFinite(threshold)) throw new Error("알림 기준값은 0보다 큰 유한한 숫자여야 합니다.");
  return {
    id: alertId(),
    feedKey,
    instrument: { ...instrument },
    symbol: instrument.stkCd,
    currency: instrument.currency,
    environment: instrument.environment,
    kind,
    threshold,
    armed: true,
    createdAt: now,
  };
}

export function rearmAlert(rules: MarketAlertRule[], id: string) {
  return rules.map((rule) => (rule.id === id ? { ...rule, armed: true } : rule));
}

export function removeAlert(rules: MarketAlertRule[], id: string) {
  return rules.filter((rule) => rule.id !== id);
}

export function quoteSignature(quote: Quote) {
  // Book-only receipt updates must not repeatedly trigger a price/volume rule.
  return [
    quote.priceReceivedAt ?? quote.tradeReceivedAt ?? quote.receivedAt,
    quote.volumeReceivedAt ?? quote.tradeReceivedAt ?? quote.receivedAt,
    quote.last, quote.volume, quote.status, quote.source,
  ].join("|");
}

export function evaluateAlertUpdate({
  rules,
  history,
  feedKey,
  instrument,
  quote,
  previousSignature,
  now = new Date().toISOString(),
}: {
  rules: MarketAlertRule[];
  history: MarketAlertEvent[];
  feedKey: string;
  instrument: Instrument;
  quote: Quote | null;
  previousSignature?: string;
  now?: string;
}) {
  if (!quote || !sameFeed(instrument, quote) || (!hasFreshAlertValue(instrument, quote, "above", Date.parse(now)) && !hasFreshAlertValue(instrument, quote, "volume", Date.parse(now)))) {
    return { rules, history, fired: [] as MarketAlertEvent[], signature: previousSignature };
  }

  const signature = quoteSignature(quote);
  if (signature === previousSignature) {
    return { rules, history, fired: [] as MarketAlertEvent[], signature };
  }

  const fired = rules
    .filter((rule) => rule.armed && rule.feedKey === feedKey && rule.currency === quote.currency && hasFreshAlertValue(instrument, quote, rule.kind, Date.parse(now)) && conditionMet(rule, quote))
    .map((rule): MarketAlertEvent => ({
      id: alertId(),
      ruleId: rule.id,
      feedKey,
      symbol: rule.symbol,
      currency: rule.currency,
      environment: rule.environment,
      kind: rule.kind,
      threshold: rule.threshold,
      // conditionMet above verifies that this quote field is finite and positive.
      value: valueFor(rule.kind, quote) as number,
      source: quote.source,
      fixture: quote.environment === "fixture" || quote.source === "fixture",
      firedAt: now,
    }));

  const firedIds = new Set(fired.map((event) => event.ruleId));
  return {
    rules: firedIds.size ? rules.map((rule) => (firedIds.has(rule.id) ? { ...rule, armed: false } : rule)) : rules,
    history: fired.length ? [...fired, ...history].slice(0, ALERT_HISTORY_LIMIT) : history,
    fired,
    signature,
  };
}

export function isFreshVerifiedQuote(instrument: Instrument, quote: Quote | null, now = Date.now()): quote is Quote {
  return Boolean(quote && (hasFreshAlertValue(instrument, quote, "above", now) || hasFreshAlertValue(instrument, quote, "volume", now)));
}

export function hasFreshAlertValue(instrument: Instrument, quote: Quote, kind: AlertKind, now = Date.now()) {
  if (!quote || !sameFeed(instrument, quote) || quote.status === "stale" || quote.status === "missing" || quote.status === "error") return false;
  if (quote.status !== "live" && quote.status !== "snapshot") return false;
  if (kind === "volume" ? quote.volumeLive === false : quote.priceLive === false) return false;
  const timestamp = kind === "volume"
    ? quote.volumeReceivedAt ?? quote.tradeReceivedAt ?? quote.receivedAt
    : quote.priceReceivedAt ?? quote.tradeReceivedAt ?? quote.receivedAt;
  if (!timestamp) return false;
  const receivedAt = Date.parse(timestamp);
  if (Number.isNaN(receivedAt)) return false;
  const age = now - receivedAt;
  return age >= -5_000 && age <= 60_000;
}

export function readAlertStorage(storage: Storage | null = browserStorage()): AlertStorage {
  if (!storage) return { rules: [], history: [] };
  try {
    const parsed = JSON.parse(storage.getItem(ALERT_STORAGE_KEY) || "{}") as Partial<AlertStorage>;
    return normalizeAlertStorage(parsed);
  } catch {
    return { rules: [], history: [] };
  }
}

export function writeAlertStorage(value: AlertStorage, storage: Storage | null = browserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(ALERT_STORAGE_KEY, JSON.stringify(normalizeAlertStorage(value)));
  } catch {
    // Alerts remain usable for this tab even when browser storage is unavailable.
  }
}

export type AlertStorageMutation<T> = { storage: AlertStorage; result: T };

export async function mutateAlertStorage<T>(
  mutate: (current: AlertStorage) => AlertStorageMutation<T>,
  options: { storage?: Storage | null; locks?: AlertLockManager | null; origin?: string; signal?: AbortSignal } = {},
) {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const locked = await withAlertStorageLock(() => {
    const current = readAlertStorage(storage);
    const update = mutate(current);
    const next = normalizeAlertStorage(update.storage);
    if (JSON.stringify(next) !== JSON.stringify(current)) writeAlertStorage(next, storage);
    return { storage: next, result: update.result };
  }, options);
  return { ...locked.value, atomic: locked.atomic };
}

function normalizeAlertStorage(value: Partial<AlertStorage>): AlertStorage {
  return {
    rules: Array.isArray(value.rules) ? value.rules.filter(isRule).slice(0, ALERT_RULE_LIMIT) : [],
    history: Array.isArray(value.history) ? value.history.filter(isEvent).slice(0, ALERT_HISTORY_LIMIT) : [],
  };
}

function conditionMet(rule: MarketAlertRule, quote: Quote) {
  const value = valueFor(rule.kind, quote);
  if (!isPositiveFinite(value)) return false;
  return rule.kind === "above" ? value >= rule.threshold : rule.kind === "below" ? value <= rule.threshold : value >= rule.threshold;
}

function valueFor(kind: AlertKind, quote: Quote) {
  return kind === "volume" ? quote.volume : quote.last;
}

function isRule(value: unknown): value is MarketAlertRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<MarketAlertRule>;
  return (
    typeof rule.id === "string" &&
    typeof rule.feedKey === "string" &&
    isInstrument(rule.instrument) &&
    rule.feedKey === JSON.stringify(feedKeyOf(rule.instrument)) &&
    rule.symbol === rule.instrument.stkCd &&
    rule.currency === rule.instrument.currency &&
    rule.environment === rule.instrument.environment &&
    typeof rule.symbol === "string" &&
    (rule.currency === "KRW" || rule.currency === "USD") &&
    (rule.environment === "fixture" || rule.environment === "demo" || rule.environment === "real") &&
    isAlertKind(rule.kind) &&
    isPositiveFinite(rule.threshold) &&
    typeof rule.armed === "boolean" &&
    typeof rule.createdAt === "string"
  );
}

function isInstrument(value: unknown): value is Instrument {
  if (!value || typeof value !== "object") return false;
  const instrument = value as Partial<Instrument>;
  const krListing = instrument.listingVenue === "KOSPI" || instrument.listingVenue === "KOSDAQ";
  const usListing = instrument.listingVenue === "NASDAQ" || instrument.listingVenue === "NYSE" || instrument.listingVenue === "AMEX";
  if (
    !(
      (instrument.market === "KR" || instrument.market === "US") &&
      typeof instrument.stkCd === "string" &&
      typeof instrument.stkNm === "string" &&
      (instrument.stexTp === "KRX" || instrument.stexTp === "ND" || instrument.stexTp === "NY" || instrument.stexTp === "NA") &&
      (instrument.listingVenue === "KOSPI" || instrument.listingVenue === "KOSDAQ" || instrument.listingVenue === "NASDAQ" || instrument.listingVenue === "NYSE" || instrument.listingVenue === "AMEX") &&
      (instrument.quoteVenue === "KRX" || instrument.quoteVenue === "ND" || instrument.quoteVenue === "NY" || instrument.quoteVenue === "NA") &&
      (instrument.currency === "KRW" || instrument.currency === "USD") &&
      (instrument.environment === "fixture" || instrument.environment === "demo" || instrument.environment === "real")
    )
  ) {
    return false;
  }
  if (instrument.market === "KR") {
    return /^\d{6}$/.test(instrument.stkCd) && krListing && instrument.stexTp === "KRX" && instrument.quoteVenue === "KRX" && instrument.currency === "KRW";
  }
  const expectedVenue = instrument.listingVenue === "NASDAQ" ? "ND" : instrument.listingVenue === "NYSE" ? "NY" : "NA";
  return /^[A-Z][A-Z0-9.]{0,9}$/.test(instrument.stkCd) && usListing && instrument.stexTp === expectedVenue && instrument.quoteVenue === expectedVenue && instrument.currency === "USD";
}

function isEvent(value: unknown): value is MarketAlertEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<MarketAlertEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.ruleId === "string" &&
    typeof event.feedKey === "string" &&
    typeof event.symbol === "string" &&
    (event.currency === "KRW" || event.currency === "USD") &&
    (event.environment === "fixture" || event.environment === "demo" || event.environment === "real") &&
    isAlertKind(event.kind) &&
    isPositiveFinite(event.threshold) &&
    isPositiveFinite(event.value) &&
    (event.source === "kiwoom" || event.source === "fixture") &&
    typeof event.fixture === "boolean" &&
    typeof event.firedAt === "string"
  );
}

function isAlertKind(value: unknown): value is AlertKind {
  return value === "above" || value === "below" || value === "volume";
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function alertId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : "alert-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function browserStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}
