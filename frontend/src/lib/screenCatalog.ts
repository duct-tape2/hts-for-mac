import { ANALYSIS_SCREENS } from "@/lib/analysisScreenCatalog";
import type { Market } from "@/lib/types";

export type ScreenDefinition = {
  id: string;
  code?: string;
  name: string;
  market?: Market;
  component:
    | "watch"
    | "book"
    | "chart"
    | "history"
    | "details"
    | "notes"
    | "alerts"
    | "rankings"
    | "investors"
    | "analysis"
    | "comparison"
    | "scanner"
    | "calculator"
    | "journal"
    | "conditions"
    | "capture";
  featureId?: string;
  description: string;
};

/**
 * Supported read-only views. Official numbers are shortcut references; each
 * numbered view is a partial, supported view rather than HTS feature parity.
 */
export const SCREEN_CATALOG: readonly ScreenDefinition[] = [
  ...ANALYSIS_SCREENS,
  { id: "app-conditions", name: "저장 조건검색", component: "conditions", description: "키움 저장 조건 목록·결과·실시간 편입과 이탈" },
  { id: "app-journal", name: "체결·호가 관찰 기록", component: "journal", description: "연결 후 수신 이벤트 256개 · 관찰 구간 재생" },
  { id: "app-calculator", name: "증권 계산기", component: "calculator", description: "사용자 입력 가격·수량·비용·환율 계산" },
  { id: "app-scanner", name: "관심종목 로컬 조건", component: "scanner", description: "저장한 관심그룹 내 가격·등락률·거래량 조건" },
  { id: "app-comparison", name: "수익률 비교 차트", component: "comparison", description: "최대 4종목의 공통 기준일 100 비교 · 환산 없음" },
  { id: "kr-analysis", name: "국내 종목·시장 분석", market: "KR", component: "analysis", description: "체결·거래원·수급·프로그램·ETF·테마·추가 순위" },
  { id: "us-analysis", name: "미국 종목·시장 분석", market: "US", component: "analysis", description: "미국 체결·거래량·거래대금·시가총액·업종 순위" },
  ...([
    ["0198", "실시간 종목 조회 순위"],
    ["0187", "시가총액상위"],
    ["0186", "거래대금상위"],
    ["0184", "당일거래상위"],
    ["0162", "상한가/하한가"],
    ["0602", "업종종합차트"],
    ["0211", "업종시세"],
    ["0780", "투자자별 매매동향"],
    ["2797", "업종별 투자자 기준일 순매수"],
    ["0200", "시장종합"],
    ["0700", "종합시황뉴스"],
  ] as const).map(([code, name]): ScreenDefinition => ({ id: `kr-${code}`, code, name, market: "KR", component: "capture", description: `${name} · 캡처 기준 조회 화면` })),
  { id: "kr-0601", code: "0601", name: "주식종합차트", market: "KR", component: "chart", description: "국내 주식 차트·이동평균·거래량" },
  {
    id: "kr-0101",
    code: "0101",
    name: "키움현재가",
    market: "KR",
    component: "book",
    description: "KRX 현재가·10단계 호가",
  },
  {
    id: "kr-0130",
    code: "0130",
    name: "관심종목",
    market: "KR",
    component: "watch",
    description: "로컬 관심그룹·표시 항목·종목 선택",
  },
  {
    id: "kr-0600",
    code: "0600",
    name: "키움종합차트",
    market: "KR",
    component: "chart",
    description: "국내 분·일·주·월봉과 보조지표",
  },
  {
    id: "kr-0180",
    code: "0180",
    name: "순위분석",
    market: "KR",
    component: "rankings",
    description: "국내 등락률·거래량·거래대금 순위",
  },
  {
    id: "kr-0796",
    code: "0796",
    name: "종목별투자자",
    market: "KR",
    component: "investors",
    description: "국내 종목별 일별 투자자 순매수 수량",
  },
  {
    id: "us-2010",
    code: "2010",
    name: "해외주식 현재가",
    market: "US",
    component: "book",
    description: "미국 현재가·10단계 호가",
  },
  {
    id: "us-2020",
    code: "2020",
    name: "해외주식 관심종목",
    market: "US",
    component: "watch",
    description: "로컬 관심그룹·미국 HTS 관심목록 가져오기",
  },
  {
    id: "us-0601",
    code: "0601",
    name: "해외주식 종합차트",
    market: "US",
    component: "chart",
    description: "미국 분·일·주·월봉과 보조지표",
  },
  {
    id: "app-history",
    name: "일별 시세 데이터",
    component: "history",
    description: "일별 시가·고가·저가·종가·거래량과 CSV 내보내기",
  },
  {
    id: "app-details",
    name: "종목정보",
    component: "details",
    description: "상장시장·시세 거래소·통화·수신 상태",
  },
  {
    id: "app-notes",
    name: "종목메모",
    component: "notes",
    description: "종목별 관찰 메모 저장",
  },
  {
    id: "app-alerts",
    name: "시세알림",
    component: "alerts",
    description: "가격·거래량 조건 알림",
  },
];

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("ko-KR").replace(/\s+/g, " ");
}

function compact(value: string) {
  return normalized(value).replace(/\s/g, "");
}

/**
 * Search supported screens in stable catalog order.
 *
 * A blank query shows the selected market's numbered views and all local app
 * views. An exact numbered shortcut is intentionally market-independent so a
 * user can type an official US/KR number directly from either market desk.
 */
export function searchScreens(query: string, market?: Market): ScreenDefinition[] {
  const text = normalized(query);
  if (!text) {
    return SCREEN_CATALOG.filter((screen) => !screen.market || !market || screen.market === market).slice();
  }

  const exactCodes = SCREEN_CATALOG.filter((screen) => screen.code && compact(screen.code) === compact(query));
  if (exactCodes.length) {
    const currentMarket = exactCodes.filter((screen) => screen.market === market);
    return currentMarket.length ? currentMarket : exactCodes;
  }

  const candidates = SCREEN_CATALOG.filter((screen) => !market || !screen.market || screen.market === market);
  return candidates.filter((screen) => {
    const name = normalized(screen.name);
    const description = normalized(screen.description);
    const code = screen.code ? compact(screen.code) : "";
    const needle = compact(query);
    return name.includes(text) || description.includes(text) || (code.length > 0 && code.includes(needle));
  });
}
