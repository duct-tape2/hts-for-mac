export type ScreenLinkKind = "instrument" | "sector" | "market" | "none";

export type CaptureValueFormat = "text" | "integer" | "price" | "usd" | "percent" | "ratio" | "strength" | "change" | "netFlow" | "rankChange" | "datetime";

export type ColumnPresentation = {
  label?: string;
  width: number;
  format?: CaptureValueFormat;
  precision?: number;
  pinned?: boolean;
  visible?: boolean;
  order?: number;
};

export type ScreenPresentation = {
  title: string;
  defaultMinWidth: number;
  defaultMinHeight: number;
  linkKind: ScreenLinkKind;
  columns: Record<string, ColumnPresentation>;
};

const stockColumns: Record<string, ColumnPresentation> = {
  rank: { label: "순위", width: 58, format: "integer", pinned: true },
  previousRank: { label: "전순위", width: 66, format: "integer" },
  name: { label: "종목명", width: 150, format: "text", pinned: true },
  code: { label: "코드", width: 78, format: "text" },
  price: { label: "현재가", width: 96, format: "price" },
  change: { label: "대비", width: 92, format: "change" },
  changePct: { label: "등락률", width: 76, format: "percent", precision: 2 },
  volume: { label: "거래량", width: 108, format: "integer" },
  previousVolume: { label: "전일거래량", width: 108, format: "integer" },
  tradingValue: { label: "거래대금", width: 108, format: "integer" },
  sellPrice: { label: "매도호가", width: 90, format: "price" },
  buyPrice: { label: "매수호가", width: 90, format: "price" },
  sellQuantity: { label: "매도잔량", width: 96, format: "integer" },
  buyQuantity: { label: "매수잔량", width: 96, format: "integer" },
};

const presentations: Record<string, ScreenPresentation> = {
  "0198": {
    title: "실시간 종목 조회 순위", defaultMinWidth: 1050, defaultMinHeight: 440, linkKind: "instrument",
    columns: { ...stockColumns, price: { label: "기준시점 주가", width: 108, format: "price" }, changePct: { label: "기준 대비 등락률", width: 90, format: "percent", precision: 2 }, rankChange: { label: "순위변동", width: 82, format: "rankChange" }, previousChangePct: { label: "직전 기준 대비율", width: 94, format: "percent", precision: 2 }, asOf: { label: "기준시각", width: 142, format: "datetime" } },
  },
  "0187": {
    title: "시가총액상위", defaultMinWidth: 1050, defaultMinHeight: 440, linkKind: "instrument",
    columns: { ...stockColumns, tradingWeight: { label: "거래비중", width: 82, format: "ratio", precision: 2 }, marketCap: { label: "시가총액(억원)", width: 116, format: "integer" }, marketCapWeight: { label: "시총비중", width: 82, format: "ratio", precision: 2 }, tradingStrength: { label: "체결강도", width: 82, format: "strength", precision: 2 } },
  },
  "0186": { title: "거래대금상위", defaultMinWidth: 990, defaultMinHeight: 440, linkKind: "instrument", columns: { ...stockColumns, rank: { label: "순위", width: 52, format: "integer", pinned: true }, previousRank: { label: "전순위", width: 60, format: "integer" }, name: { label: "종목명", width: 140, format: "text", pinned: true }, price: { label: "현재가", width: 90, format: "price" }, change: { label: "대비", width: 88, format: "change" }, changePct: { label: "등락률", width: 72, format: "percent", precision: 2 }, sellPrice: { label: "매도호가", width: 84, format: "price" }, buyPrice: { label: "매수호가", width: 84, format: "price" }, volume: { label: "거래량", width: 106, format: "integer" }, previousVolume: { label: "전일거래량", width: 106, format: "integer" }, tradingValue: { label: "거래대금", width: 106, format: "integer" } } },
  "0184": { title: "당일거래상위", defaultMinWidth: 1050, defaultMinHeight: 440, linkKind: "instrument", columns: { ...stockColumns, previousChangePct: { label: "전일비", width: 76, format: "ratio", precision: 2 }, turnoverRate: { label: "회전율", width: 76, format: "ratio", precision: 2 } } },
  "0162": { title: "상한가/하한가", defaultMinWidth: 1050, defaultMinHeight: 440, linkKind: "instrument", columns: { ...stockColumns, count: { label: "횟수", width: 64, format: "integer" } } },
  "0130": { title: "관심종목", defaultMinWidth: 420, defaultMinHeight: 420, linkKind: "instrument", columns: stockColumns },
  "0211": { title: "업종시세", defaultMinWidth: 840, defaultMinHeight: 440, linkKind: "sector", columns: { name: { label: "업종명", width: 160, pinned: true }, index: { label: "지수", width: 96, format: "price" }, change: { label: "대비", width: 90, format: "change" }, changePct: { label: "등락률", width: 76, format: "percent", precision: 2 }, volume: { label: "거래량", width: 108, format: "integer" }, tradingValue: { label: "거래대금", width: 108, format: "integer" } } },
  "0601": { title: "종합차트", defaultMinWidth: 760, defaultMinHeight: 480, linkKind: "instrument", columns: {} },
  "0602": { title: "업종종합차트", defaultMinWidth: 760, defaultMinHeight: 480, linkKind: "sector", columns: {} },
  "0780": { title: "투자자별 매매동향", defaultMinWidth: 1000, defaultMinHeight: 480, linkKind: "market", columns: {} },
  "2797": { title: "업종별 투자자 기준일 순매수", defaultMinWidth: 1065, defaultMinHeight: 480, linkKind: "sector", columns: {
    sector: { label: "업종", width: 120, format: "text", pinned: true, order: 1 },
    individual: { label: "개인", width: 75, format: "netFlow", order: 2 }, foreign: { label: "외국인", width: 75, format: "netFlow", order: 3 }, institutional: { label: "기관계", width: 75, format: "netFlow", order: 4 },
    securities: { label: "금융투자", width: 72, format: "netFlow", order: 5 }, insurance: { label: "보험", width: 72, format: "netFlow", order: 6 }, investmentTrust: { label: "투신", width: 72, format: "netFlow", order: 7 }, bank: { label: "은행", width: 72, format: "netFlow", order: 8 }, pension: { label: "종금", width: 72, format: "netFlow", order: 9 }, fund: { label: "연기금", width: 72, format: "netFlow", order: 10 }, privateFund: { label: "사모", width: 72, format: "netFlow", order: 11 }, national: { label: "국가", width: 72, format: "netFlow", order: 12 }, nativeTrmtForeign: { label: "내국인대우", width: 72, format: "netFlow", order: 13 }, otherCorporation: { label: "기타법인", width: 72, format: "netFlow", order: 14 },
    market: { width: 70, visible: false }, price: { width: 90, format: "price", visible: false }, change: { width: 82, format: "change", visible: false }, changePct: { width: 72, format: "percent", precision: 2, visible: false },
  } },
  "0200": { title: "시장종합", defaultMinWidth: 1180, defaultMinHeight: 560, linkKind: "market", columns: {} },
  "0700": { title: "종합시황뉴스", defaultMinWidth: 1000, defaultMinHeight: 520, linkKind: "none", columns: {} },
};

const fallback: ScreenPresentation = { title: "조회 화면", defaultMinWidth: 760, defaultMinHeight: 440, linkKind: "none", columns: {} };

export function screenPresentation(code: string): ScreenPresentation {
  return presentations[code] ?? fallback;
}
