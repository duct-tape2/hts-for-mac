import type { Environment, Instrument, Market, WatchlistItem } from "./types";

export function defaultInstrument(market: Market, environment: Environment): Instrument {
  if (market === "KR") {
    return {
      market: "KR",
      stkCd: "005930",
      stkNm: "삼성전자",
      stexTp: "KRX",
      listingVenue: "KOSPI",
      quoteVenue: "KRX",
      currency: "KRW",
      environment,
    };
  }
  return {
    market: "US",
    stkCd: "AAPL",
    stkNm: "Apple Inc.",
    stexTp: "ND",
    listingVenue: "NASDAQ",
    quoteVenue: "ND",
    currency: "USD",
    environment,
  };
}

export function matchingWatchlistInstrument(items: WatchlistItem[], market: Market, stkCd: string) {
  const normalized = market === "US" ? stkCd.trim().toUpperCase() : stkCd.trim();
  return items.find((item) => item.market === market && item.stkCd === normalized) ?? null;
}
