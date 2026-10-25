import { beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_HISTORY_LIMIT,
  createAlertRule,
  evaluateAlertUpdate,
  isFreshVerifiedQuote,
  mutateAlertStorage,
  quoteSignature,
  readAlertStorage,
  rearmAlert,
  writeAlertStorage,
} from "@/components/marketAlerts";
import type { AlertLockManager } from "@/components/alertOwnership";
import { fixtureQuote, samsung } from "@/test/fixtures";

const feedKey = JSON.stringify({
  market: samsung.market,
  stkCd: samsung.stkCd,
  listingVenue: samsung.listingVenue,
  quoteVenue: samsung.quoteVenue,
  environment: samsung.environment,
});

beforeEach(() => localStorage.clear());

class SerialLocks implements AlertLockManager {
  private tail = Promise.resolve();

  request<T>(_name: string, _options: { mode: "exclusive"; signal?: AbortSignal }, callback: (lock: unknown) => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(() => callback({})).finally(() => release?.());
  }
}

describe("market alerts", () => {
  it("fires an armed matching rule once per fresh verified same-feed update, then can re-arm", () => {
    const rule = createAlertRule({ feedKey, instrument: samsung, kind: "above", threshold: 70000, now: "2026-10-24T01:00:00Z" });
    const quote = fixtureQuote(samsung, { last: 70000, receivedAt: "2026-10-24T01:00:01Z" });

    const first = evaluateAlertUpdate({ rules: [rule], history: [], feedKey, instrument: samsung, quote, now: "2026-10-24T01:00:02Z" });
    expect(first.fired).toHaveLength(1);
    expect(first.rules[0].armed).toBe(false);

    const duplicate = evaluateAlertUpdate({ rules: first.rules, history: first.history, feedKey, instrument: samsung, quote, previousSignature: first.signature, now: "2026-10-24T01:00:02Z" });
    expect(duplicate.fired).toHaveLength(0);

    const rearmed = rearmAlert(first.rules, rule.id);
    const fresh = fixtureQuote(samsung, { last: 70100, receivedAt: "2026-10-24T01:00:03Z" });
    const second = evaluateAlertUpdate({ rules: rearmed, history: first.history, feedKey, instrument: samsung, quote: fresh, previousSignature: first.signature, now: "2026-10-24T01:00:04Z" });
    expect(second.fired).toHaveLength(1);
    expect(second.history).toHaveLength(2);
  });

  it("does not fire from stale, missing, or another feed even when the numerical threshold matches", () => {
    const rule = createAlertRule({ feedKey, instrument: samsung, kind: "below", threshold: 80000 });
    const stale = fixtureQuote(samsung, { last: 70000, status: "stale", receivedAt: "2026-10-24T01:00:01Z" });
    expect(evaluateAlertUpdate({ rules: [rule], history: [], feedKey, instrument: samsung, quote: stale, now: "2026-10-24T01:00:02Z" }).fired).toHaveLength(0);

    const other = fixtureQuote({ ...samsung, stkCd: "000660", stkNm: "다른 종목" }, { last: 70000, receivedAt: "2026-10-24T01:00:02Z" });
    expect(evaluateAlertUpdate({ rules: [rule], history: [], feedKey, instrument: samsung, quote: other, now: "2026-10-24T01:00:03Z" }).fired).toHaveLength(0);

    const missing = fixtureQuote(samsung, { last: null, receivedAt: "2026-10-24T01:00:03Z" });
    expect(evaluateAlertUpdate({ rules: [rule], history: [], feedKey, instrument: samsung, quote: missing, now: "2026-10-24T01:00:04Z" }).fired).toHaveLength(0);
  });

  it("keeps feed-local currency and fixture provenance in bounded browser storage", () => {
    const rule = createAlertRule({ feedKey, instrument: samsung, kind: "volume", threshold: 1000 });
    const quote = fixtureQuote(samsung, { volume: 1500, receivedAt: "2026-10-24T01:00:01Z" });
    const result = evaluateAlertUpdate({ rules: [rule], history: [], feedKey, instrument: samsung, quote, now: "2026-10-24T01:00:02Z" });
    expect(result.fired[0]).toMatchObject({ currency: "KRW", fixture: true, source: "fixture", value: 1500 });

    const repeatedHistory = Array.from({ length: ALERT_HISTORY_LIMIT + 4 }, () => result.fired[0]);
    const repeatedRules = Array.from({ length: 104 }, () => result.rules[0]);
    writeAlertStorage({ rules: repeatedRules, history: repeatedHistory });
    const stored = readAlertStorage();
    expect(stored.rules[0].currency).toBe("KRW");
    expect(stored.history).toHaveLength(ALERT_HISTORY_LIMIT);
    expect(stored.rules).toHaveLength(100);
  });

  it("rejects zero, negative, and non-finite thresholds", () => {
    expect(() => createAlertRule({ feedKey, instrument: samsung, kind: "above", threshold: 0 })).toThrow();
    expect(() => createAlertRule({ feedKey, instrument: samsung, kind: "above", threshold: -1 })).toThrow();
    expect(() => createAlertRule({ feedKey, instrument: samsung, kind: "above", threshold: Number.NaN })).toThrow();
  });

  it("requires a recent trade receipt and does not use fresh book time to retrigger an old trade", () => {
    const oldTrade = fixtureQuote(samsung, {
      last: 70000,
      receivedAt: "2026-10-24T01:00:00Z",
      tradeReceivedAt: "2026-10-24T01:00:00Z",
      bookReceivedAt: "2026-10-24T01:00:55Z",
    });
    const newerBookOnly = { ...oldTrade, bookReceivedAt: "2026-10-24T01:01:00Z" };
    const now = Date.parse("2026-10-24T01:01:05Z");

    expect(isFreshVerifiedQuote(samsung, oldTrade, now)).toBe(false);
    expect(quoteSignature(newerBookOnly)).toBe(quoteSignature(oldTrade));
    expect(isFreshVerifiedQuote(samsung, fixtureQuote(samsung, { receivedAt: "2026-10-24T01:01:12Z" }), now)).toBe(false);
  });

  it("evaluates price and cumulative-volume freshness independently", () => {
    const price = createAlertRule({ feedKey, instrument: samsung, kind: "above", threshold: 70000 });
    const volume = createAlertRule({ feedKey, instrument: samsung, kind: "volume", threshold: 1000 });
    const quote = fixtureQuote(samsung, {
      last: 70000, volume: 1500, priceReceivedAt: "2026-10-24T01:00:00Z", volumeReceivedAt: "2026-10-24T01:01:05Z",
      priceLive: false, volumeLive: true,
    });
    const result = evaluateAlertUpdate({ rules: [price, volume], history: [], feedKey, instrument: samsung, quote, now: "2026-10-24T01:01:10Z" });

    expect(result.fired.map((event) => event.kind)).toEqual(["volume"]);
    expect(result.rules.find((rule) => rule.id === price.id)?.armed).toBe(true);
    expect(result.rules.find((rule) => rule.id === volume.id)?.armed).toBe(false);
  });

  it("merges concurrent shared mutations under the separate storage lock", async () => {
    const locks = new SerialLocks();
    const first = createAlertRule({ feedKey, instrument: samsung, kind: "above", threshold: 70000 });
    const second = createAlertRule({ feedKey, instrument: samsung, kind: "volume", threshold: 1000 });
    await Promise.all([
      mutateAlertStorage((current) => ({ storage: { rules: [...current.rules, first], history: current.history }, result: first.id }), { storage: localStorage, locks, origin: "https://localhost:3010" }),
      mutateAlertStorage((current) => ({ storage: { rules: [...current.rules, second], history: current.history }, result: second.id }), { storage: localStorage, locks, origin: "https://localhost:3010" }),
    ]);

    expect(readAlertStorage(localStorage).rules.map((rule) => rule.id).sort()).toEqual([first.id, second.id].sort());
  });
});
