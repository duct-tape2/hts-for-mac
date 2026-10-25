export type Environment = "fixture" | "demo" | "real";
export type Market = "KR" | "US";
export type Exchange = "KRX" | "ND" | "NY" | "NA";
export type ListingVenue = "KOSPI" | "KOSDAQ" | "NASDAQ" | "NYSE" | "AMEX";
export type QuoteStatus = "snapshot" | "live" | "stale" | "missing" | "error";
export type DataSource = "kiwoom" | "fixture";

export type Instrument = {
  market: Market;
  stkCd: string;
  stkNm: string;
  /** Legacy routing alias. It is never sufficient as a cache identity. */
  stexTp: Exchange;
  listingVenue: ListingVenue;
  quoteVenue: Exchange;
  currency: "KRW" | "USD";
  environment: Environment;
};

export type FeedKey = Pick<Instrument, "market" | "stkCd" | "listingVenue" | "quoteVenue" | "environment">;

export type Watchlist = {
  id: string;
  name: string;
  source: "app" | "kiwoom_import";
  gcod?: string;
};

export type WatchlistItem = Instrument & {
  id: string;
  watchlistId: string;
  enabled: boolean;
  last: number | null;
  prevClose: number | null;
  open: number | null;
  changePct: number | null;
};

export type BookLevel = {
  price: number;
  qty: number | null;
};

export type MarketSourceTime = {
  rawTradeTime: string | null;
  rawTradeDate: string | null;
  rawLocalTradeTime: string | null;
  precision: "second" | "unknown";
  datePrecision: "day" | "unavailable" | "unknown";
  timezone: "unverified";
  timestamp: null;
  timestampStatus: string;
};

export type ObservedMinute = {
  basis: "receipt-time observations";
  bucketStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
  firstSequence: number;
  lastSequence: number;
  complete: false;
};

export type Quote = Instrument & {
  last: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  midPrice: number | null;
  asks: BookLevel[];
  bids: BookLevel[];
  rawPrices?: Record<string, string | null>;
  source: DataSource;
  status: QuoteStatus;
  receivedAt: string | null;
  tradeReceivedAt?: string | null;
  bookReceivedAt?: string | null;
  priceReceivedAt?: string | null;
  volumeReceivedAt?: string | null;
  priceLive?: boolean;
  volumeLive?: boolean;
  tradeSourceTime?: MarketSourceTime | null;
  bookSourceTime?: MarketSourceTime | null;
  observedMinute?: ObservedMinute | null;
  sourceTimestamp: string | null;
  note: string;
  bookLive: boolean;
  bookNote?: string;
};

export type ChartInterval = "1" | "3" | "5" | "10" | "15" | "30" | "45" | "60" | "D" | "W" | "M" | "Y";

export type ChartBar = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
};

export type ChartRange = {
  basis: string;
  start: string;
  end: string;
};

export type ChartPayload = Instrument & {
  interval: ChartInterval;
  bars: ChartBar[];
  source: DataSource;
  status: QuoteStatus;
  receivedAt: string | null;
  sourceTimestamp: string | null;
  range: ChartRange | null;
  note: string;
  complete: boolean;
  adjusted: boolean;
};

export type SearchPayload = {
  results: Instrument[];
  complete: boolean;
  note: string;
};

export type ReadonlyState = {
  mode: Environment;
  kiwoom: "connected" | "disconnected";
  kiwoomError: string;
  watchlists: Watchlist[];
  items: WatchlistItem[];
  watchlistNote?: string;
};

export type Health = {
  ok: boolean;
  version: string;
  mode: Environment;
  kiwoom: "connected" | "disconnected";
  error: string;
  note: string;
};

export function feedKeyOf(value: Instrument): FeedKey {
  return {
    market: value.market,
    stkCd: value.stkCd,
    listingVenue: value.listingVenue,
    quoteVenue: value.quoteVenue,
    environment: value.environment,
  };
}

export function sameFeed(a: FeedKey | Instrument | null | undefined, b: FeedKey | Instrument | null | undefined) {
  return Boolean(
    a &&
      b &&
      a.market === b.market &&
      a.stkCd === b.stkCd &&
      a.listingVenue === b.listingVenue &&
      a.quoteVenue === b.quoteVenue &&
      a.environment === b.environment,
  );
}
