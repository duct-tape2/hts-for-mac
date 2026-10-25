import type { Instrument, Quote } from "@/lib/types";

export const samsung: Instrument = {
  market: "KR",
  stkCd: "005930",
  stkNm: "삼성전자",
  stexTp: "KRX",
  listingVenue: "KOSPI",
  quoteVenue: "KRX",
  currency: "KRW",
  environment: "fixture",
};

export const apple: Instrument = {
  market: "US",
  stkCd: "AAPL",
  stkNm: "Apple Inc.",
  stexTp: "ND",
  listingVenue: "NASDAQ",
  quoteVenue: "ND",
  currency: "USD",
  environment: "fixture",
};

export function fixtureQuote(instrument: Instrument, overrides: Partial<Quote> = {}): Quote {
  return {
    ...instrument,
    last: instrument.market === "KR" ? 70000 : 210.5,
    open: instrument.market === "KR" ? 69500 : 209,
    high: instrument.market === "KR" ? 70500 : 212,
    low: instrument.market === "KR" ? 69000 : 208,
    prevClose: instrument.market === "KR" ? 69200 : 208,
    change: instrument.market === "KR" ? 800 : 2.5,
    changePct: 1.15,
    volume: 123456,
    bid: instrument.market === "KR" ? 69900 : 210.4,
    ask: instrument.market === "KR" ? 70000 : 210.6,
    bidQty: 10,
    askQty: 12,
    midPrice: instrument.market === "KR" ? 69950 : 210.5,
    asks: [{ price: instrument.market === "KR" ? 70000 : 210.6, qty: 12 }],
    bids: [{ price: instrument.market === "KR" ? 69900 : 210.4, qty: 10 }],
    source: "fixture",
    status: "snapshot",
    receivedAt: "2026-10-24T01:02:03Z",
    sourceTimestamp: "2026-10-24T01:02:02Z",
    note: "fixture sample",
    bookLive: false,
    ...overrides,
  };
}
