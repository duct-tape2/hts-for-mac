import type { ScreenDefinition } from "@/lib/screenCatalog";

// Explicit supported adapter views; no invented official screen numbers.
export const ANALYSIS_SCREENS: readonly ScreenDefinition[] = [
  {
    "id": "analysis-kr_tape",
    "name": "체결정보",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_tape",
    "description": "종목별 체결 시세와 누적 거래 정보를 조회합니다."
  },
  {
    "id": "analysis-kr_brokers",
    "name": "주식 거래원",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_brokers",
    "description": "종목별 매도·매수 거래원 상위 정보를 조회합니다."
  },
  {
    "id": "analysis-kr_foreign_holding",
    "name": "외국인 종목별 동향",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_foreign_holding",
    "description": "외국인 보유·변동 시계열을 조회합니다."
  },
  {
    "id": "analysis-kr_credit_trend",
    "name": "신용매매동향",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_credit_trend",
    "description": "융자 또는 대주 신용 동향을 조회합니다."
  },
  {
    "id": "analysis-kr_short_sale",
    "name": "공매도추이",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_short_sale",
    "description": "선택 기간의 공매도 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_lending",
    "name": "대차거래추이",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_lending",
    "description": "시장 전체 대차거래 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_program_rank",
    "name": "프로그램 순매수 상위",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_rank",
    "description": "시장별 프로그램 순매수·순매도 상위를 조회합니다."
  },
  {
    "id": "analysis-kr_program_stock",
    "name": "종목별 프로그램 매매",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_stock",
    "description": "선택 시장의 종목별 프로그램 매매 현황을 조회합니다."
  },
  {
    "id": "analysis-kr_program_intraday",
    "name": "프로그램 매매 추이",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_intraday",
    "description": "선택 일자의 시간대별 프로그램 매매를 조회합니다."
  },
  {
    "id": "analysis-kr_program_arbitrage_balance",
    "name": "프로그램 차익잔고",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_arbitrage_balance",
    "description": "선택 일자의 프로그램 차익거래 잔고 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_program_stock_daily",
    "name": "종목 일별 프로그램 매매",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_stock_daily",
    "description": "종목별 일자 프로그램 매매 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_theme_groups",
    "name": "테마 그룹",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_theme_groups",
    "description": "테마별 수익률·등락률 그룹을 조회합니다."
  },
  {
    "id": "analysis-kr_theme_constituents",
    "name": "테마 구성종목",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_theme_constituents",
    "description": "테마 그룹의 구성종목을 조회합니다."
  },
  {
    "id": "analysis-kr_etf_returns",
    "name": "ETF 수익률",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_etf_returns",
    "description": "ETF 대상지수 기준의 수익률과 수급을 조회합니다."
  },
  {
    "id": "analysis-kr_etf_info",
    "name": "ETF 종목정보",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_etf_info",
    "description": "ETF 대상지수·원주가격·과세 정보를 조회합니다."
  },
  {
    "id": "analysis-kr_etf_all_quotes",
    "name": "ETF 전체시세",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_etf_all_quotes",
    "description": "선택된 과세·NAV·운용사 조건의 ETF 전체시세를 조회합니다."
  },
  {
    "id": "analysis-kr_etf_nav",
    "name": "ETF NAV",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_etf_nav",
    "description": "ETF NAV 및 추적오차·괴리율 정보를 조회합니다."
  },
  {
    "id": "analysis-kr_new_high_low",
    "name": "신고가·신저가",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_new_high_low",
    "description": "기간과 조건을 적용한 신고가·신저가 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_high_low_proximity",
    "name": "고저가 근접",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_high_low_proximity",
    "description": "선택한 고가 또는 저가에 근접한 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_price_surge",
    "name": "가격 급등락",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_price_surge",
    "description": "분전 또는 일전 기준 가격 급등·급락 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_orderbook_balance_rank",
    "name": "호가잔량 상위",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_orderbook_balance_rank",
    "description": "순매수·순매도 잔량 또는 비율 상위 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_volume_surge",
    "name": "거래량 급증",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_volume_surge",
    "description": "분 또는 전일 기준 거래량 급증·급감 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_volume_renewal",
    "name": "거래량 갱신",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_volume_renewal",
    "description": "선택 주기 거래량을 갱신한 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_valuation_extremes",
    "name": "고저 PER·PBR·ROE",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_valuation_extremes",
    "description": "저·고 PBR, PER 또는 ROE 조건의 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_credit_ratio_rank",
    "name": "신용비율 상위",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_credit_ratio_rank",
    "description": "신용비율 상위 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_foreign_period_rank",
    "name": "외국인 기간별 매매 상위",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_foreign_period_rank",
    "description": "외국인 기간별 순매수·순매도·순매매 상위를 조회합니다."
  },
  {
    "id": "analysis-kr_fundamentals",
    "name": "주식 기본정보",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_fundamentals",
    "description": "종목의 기초·밸류에이션 지표와 기준 시세를 조회합니다."
  },
  {
    "id": "analysis-kr_ohlcv_flow",
    "name": "주식 일주월 시세",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_ohlcv_flow",
    "description": "종목의 SDK 제공 일주월 시세·수급 시계열을 조회합니다."
  },
  {
    "id": "analysis-kr_daily_trade_sessions",
    "name": "일별 거래 상세",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_daily_trade_sessions",
    "description": "장전·장중·장후 거래량을 포함한 일별 거래 상세를 조회합니다."
  },
  {
    "id": "analysis-kr_daily_price",
    "name": "일별 주가",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_daily_price",
    "description": "기준일 이전의 일별 가격·투자자 지표를 조회합니다."
  },
  {
    "id": "analysis-kr_vi_events",
    "name": "VI 발동 종목",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_vi_events",
    "description": "조건에 맞는 변동성완화장치 발동 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_institution_daily_rank",
    "name": "일별 기관 매매 종목",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_institution_daily_rank",
    "description": "기간 기관 순매수·순매도 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_institution_stock_trend",
    "name": "종목별 기관 매매 추이",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_institution_stock_trend",
    "description": "종목별 기관·외인 매매 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_strength_intraday",
    "name": "시간별 체결강도",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_strength_intraday",
    "description": "종목의 시간별 체결강도 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_strength_daily",
    "name": "일별 체결강도",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_strength_daily",
    "description": "종목의 일별 체결강도 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_investor_daily_rank",
    "name": "투자자별 일별 매매 종목",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_investor_daily_rank",
    "description": "투자자와 기간 기준 매매 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_investor_stock_chart",
    "name": "종목별 투자자 차트",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_investor_stock_chart",
    "description": "종목별 투자자·기관 시계열을 조회합니다."
  },
  {
    "id": "analysis-kr_investor_stock_total",
    "name": "종목별 투자자 합계",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_investor_stock_total",
    "description": "기간 종목별 투자자·기관 합계를 조회합니다."
  },
  {
    "id": "analysis-kr_intraday_investor_rank",
    "name": "장중 투자자별 매매",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_intraday_investor_rank",
    "description": "장중 투자자별 순매수 종목을 조회합니다."
  },
  {
    "id": "analysis-kr_intraday_investor_chart",
    "name": "장중 투자자별 매매 차트",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_intraday_investor_chart",
    "description": "종목별 장중 투자자 시계열을 조회합니다."
  },
  {
    "id": "analysis-kr_after_close_investor",
    "name": "장마감후 투자자별 매매",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_after_close_investor",
    "description": "장마감 후 투자자별 종목 매매를 조회합니다."
  },
  {
    "id": "analysis-kr_program_accumulated",
    "name": "프로그램 매매 누적 추이",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_accumulated",
    "description": "종료일 기준 1년 범위의 프로그램 누적 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_program_stock_intraday",
    "name": "종목 시간별 프로그램 매매",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_stock_intraday",
    "description": "종목별 시간대 프로그램 매매 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_program_daily_trend",
    "name": "프로그램 매매 일자 추이",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_program_daily_trend",
    "description": "SDK가 명시한 시장·거래소 코드 기준 프로그램 일자 추이를 조회합니다."
  },
  {
    "id": "analysis-kr_minute_quote_raw",
    "name": "주식 시분 원문",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_minute_quote_raw",
    "description": "공급자 원문 시분 응답입니다. 단위와 기준시각을 해석하지 않습니다."
  },
  {
    "id": "analysis-kr_price_profile_raw",
    "name": "시세표성 정보 원문",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_price_profile_raw",
    "description": "공급자 원문 시세·10단계 호가 응답입니다. 단위와 기준시각을 해석하지 않습니다."
  },
  {
    "id": "analysis-kr_after_hours_book_raw",
    "name": "시간외 단일가 호가 원문",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_after_hours_book_raw",
    "description": "공급자 원문 시간외 단일가 호가 응답입니다. 단위와 기준시각을 해석하지 않습니다."
  },
  {
    "id": "analysis-kr_expected_execution_rank",
    "name": "예상체결 등락률 상위",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_expected_execution_rank",
    "description": "공급자가 반환한 예상체결가·예상체결량 순위입니다. 현재 체결/OHLC가 아닙니다."
  },
  {
    "id": "analysis-kr_orderbook_quantity_surge",
    "name": "호가잔량 급증",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_orderbook_quantity_surge",
    "description": "공급자가 계산한 매수 또는 매도 호가잔량 급증 순위입니다."
  },
  {
    "id": "analysis-kr_orderbook_ratio_surge",
    "name": "호가잔량 비율 급증",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_orderbook_ratio_surge",
    "description": "공급자가 계산한 매수/매도 또는 매도/매수 비율 급증 순위입니다."
  },
  {
    "id": "analysis-kr_price_concentration",
    "name": "매물대 집중",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_price_concentration",
    "description": "공급자의 지정 기간·비율 조건 매물대 집중 결과입니다. 실제 체결 분포를 자체 재구성하지 않습니다."
  },
  {
    "id": "analysis-kr_after_hours_single_price_rank",
    "name": "시간외 단일가 등락률 순위",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_after_hours_single_price_rank",
    "description": "공급자 시간외 단일가 순위와 총 호가잔량입니다. 요청 계약에는 거래소 파라미터가 없습니다."
  },
  {
    "id": "analysis-kr_today_previous_execution_volume",
    "name": "당일·전일 체결량",
    "market": "KR",
    "component": "analysis",
    "featureId": "kr_today_previous_execution_volume",
    "description": "종목별 당일 또는 전일 체결량 목록입니다. 대량체결 여부는 제공하지 않으며 체결시간에는 날짜를 합성하지 않습니다."
  },
  {
    "id": "analysis-usa20150",
    "name": "미국주식 상세 체결내역",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20150",
    "description": "선택한 미국 종목의 공개 시장 체결 목록입니다."
  },
  {
    "id": "analysis-usa20151",
    "name": "미국주식 일별 체결내역",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20151",
    "description": "선택한 미국 종목의 공개 일별 가격·거래량 목록입니다."
  },
  {
    "id": "analysis-usa01980",
    "name": "미국주식 실시간 종목 조회 순위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa01980",
    "description": "조회 서비스 구간별 공개 종목 조회 순위입니다."
  },
  {
    "id": "analysis-usa01990",
    "name": "미국주식 관심종목 등록 상위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa01990",
    "description": "일·주·월 단위의 공개 관심종목 등록 순위입니다."
  },
  {
    "id": "analysis-usa20510",
    "name": "미국주식 기간별 등락률 상위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20510",
    "description": "문서화된 조건으로 조회하는 미국 주식 기간별 등락률 순위입니다."
  },
  {
    "id": "analysis-usa20530",
    "name": "미국주식 당일 거래량 상위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20530",
    "description": "거래량·거래대금·회전율 중 문서화된 순위 기준을 선택할 수 있습니다."
  },
  {
    "id": "analysis-usa20540",
    "name": "미국주식 당일 거래대금 상위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20540",
    "description": "문서화된 조건으로 조회하는 미국 주식 당일 거래대금 순위입니다."
  },
  {
    "id": "analysis-usa20550",
    "name": "미국주식 시가총액 상위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20550",
    "description": "문서화된 조건으로 조회하는 미국 주식 시가총액 순위입니다."
  },
  {
    "id": "analysis-usa23000",
    "name": "미국주식 업종별 기간별 수익률",
    "market": "US",
    "component": "analysis",
    "featureId": "usa23000",
    "description": "미국 업종의 1일·5일·1개월·3개월·6개월·YTD·1년 수익률입니다."
  },
  {
    "id": "analysis-usa23100",
    "name": "미국주식 업종별 등락률 상위/하위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa23100",
    "description": "선택한 업종 안에서 문서화된 상승·하락 정렬을 조회합니다."
  },
  {
    "id": "analysis-usa20520",
    "name": "미국주식 거래량 급등락",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20520",
    "description": "문서화된 기간·가격·거래 조건으로 조회하는 미국 주식 거래량 급등락입니다."
  },
  {
    "id": "analysis-usa24100",
    "name": "미국주식 신고가/신저가",
    "market": "US",
    "component": "analysis",
    "featureId": "usa24100",
    "description": "고가 또는 종가 기준의 문서화된 기간 신고가·신저가 목록입니다."
  },
  {
    "id": "analysis-usa24140",
    "name": "미국주식 갭상승/갭하락",
    "market": "US",
    "component": "analysis",
    "featureId": "usa24140",
    "description": "문서화된 갭 방향·정렬·최소 갭비율로 조회하는 미국 주식 목록입니다."
  },
  {
    "id": "analysis-usa20930",
    "name": "미국주식 가격 급등락",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20930",
    "description": "분·일·지정 기간 기준의 문서화된 가격 급등·급락 목록입니다."
  },
  {
    "id": "analysis-usa24200",
    "name": "미국주식 호가잔량 상위",
    "market": "US",
    "component": "analysis",
    "featureId": "usa24200",
    "description": "순매수·순매도 잔량 또는 비율의 문서화된 순위입니다."
  },
  {
    "id": "analysis-usa24300",
    "name": "미국주식 리서치 목록",
    "market": "US",
    "component": "analysis",
    "featureId": "usa24300",
    "description": "공식 응답에 포함된 미국주식 또는 글로벌 ETF 종목·시세 목록입니다; 보고서 본문은 제공되지 않습니다."
  },
  {
    "id": "analysis-usa20880",
    "name": "키움 거래 상위 종목(미국주식)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20880",
    "description": "키움 고객 활동을 기준으로 한 미국주식 순위입니다. 전체 시장 순위가 아닙니다."
  },
  {
    "id": "analysis-usa20881",
    "name": "키움 거래 상위 종목(미국 ETF)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20881",
    "description": "키움 고객 활동을 기준으로 한 미국 ETF 순위입니다. 전체 시장 순위가 아닙니다."
  },
  {
    "id": "analysis-usa20910",
    "name": "미국주식 전일대비 등락률 상위(주식/업종)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20910",
    "description": "주식 또는 업종의 전일대비 등락률·등락폭·보합 순위입니다."
  },
  {
    "id": "analysis-usa20911",
    "name": "미국주식 전일대비 등락률 상위(ETF)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20911",
    "description": "ETF 카테고리의 전일대비 등락률·등락폭·보합 순위입니다."
  },
  {
    "id": "analysis-usa20920",
    "name": "미국주식 시가대비 등락률 상위(주식/업종)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20920",
    "description": "주식 또는 업종의 시가대비 상승·하락률 순위입니다."
  },
  {
    "id": "analysis-usa20921",
    "name": "미국주식 시가대비 등락률 상위(ETF)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20921",
    "description": "ETF 카테고리의 시가대비 상승·하락률 순위입니다."
  },
  {
    "id": "analysis-usa20922",
    "name": "미국주식 시가대비 등락률 상위(관심종목)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20922",
    "description": "명시한 공개 관심종목 목록 안에서만 조회하는 시가대비 등락률 순위입니다."
  },
  {
    "id": "analysis-usa20940",
    "name": "미국주식 누적 등락률 상위(주식/업종)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20940",
    "description": "기준일과 누적 등락률 범위를 적용한 주식·업종 순위입니다."
  },
  {
    "id": "analysis-usa20941",
    "name": "미국주식 누적 등락률 상위(ETF)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20941",
    "description": "기준일과 누적 등락률 범위를 적용한 ETF 카테고리 순위입니다."
  },
  {
    "id": "analysis-usa20960",
    "name": "미국주식 전일 거래 상위(주식/업종)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20960",
    "description": "전일 거래량 또는 거래대금 기준의 주식·업종 순위입니다."
  },
  {
    "id": "analysis-usa20961",
    "name": "미국주식 전일 거래 상위(ETF)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa20961",
    "description": "전일 거래량 또는 거래대금 기준의 ETF 카테고리 순위입니다."
  },
  {
    "id": "analysis-usa26410",
    "name": "미국주식 연도별 등락률(종목)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa26410",
    "description": "선택한 미국 종목의 연도별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다."
  },
  {
    "id": "analysis-usa26411",
    "name": "미국주식 연도별 업종별 종목등락률",
    "market": "US",
    "component": "analysis",
    "featureId": "usa26411",
    "description": "선택 연도·업종의 종목별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다."
  },
  {
    "id": "analysis-usa26412",
    "name": "미국주식 연도별 ETF 카테고리별 종목등락률",
    "market": "US",
    "component": "analysis",
    "featureId": "usa26412",
    "description": "선택 연도·ETF 카테고리의 종목별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다."
  },
  {
    "id": "analysis-usa26413",
    "name": "미국주식 연도별 등락률(업종)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa26413",
    "description": "선택 업종의 연도별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다."
  },
  {
    "id": "analysis-usa26414",
    "name": "미국주식 연도별 등락률(ETF)",
    "market": "US",
    "component": "analysis",
    "featureId": "usa26414",
    "description": "선택 ETF 카테고리의 연도별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다."
  },
  {
    "id": "analysis-sec_filings",
    "name": "SEC 최근 공시",
    "market": "US",
    "component": "analysis",
    "featureId": "sec_filings",
    "description": "SEC EDGAR의 최근 제출 공시입니다. 연락처 이메일을 포함한 정직한 User-Agent가 필요합니다."
  },
  {
    "id": "analysis-sec_financials",
    "name": "SEC 보고 재무 수치",
    "market": "US",
    "component": "analysis",
    "featureId": "sec_financials",
    "description": "SEC XBRL 회사 사실에서 보고된 연간·분기 수치만 표시합니다. 추정치나 컨센서스는 포함하지 않습니다."
  },
  {
    "id": "analysis-dart_disclosures",
    "name": "OpenDART 공시",
    "market": "KR",
    "component": "analysis",
    "featureId": "dart_disclosures",
    "description": "OpenDART 공식 법인 공시입니다. API 키는 URL이 아닌 별도 안전한 주입 경로에서만 전달합니다."
  },
  {
    "id": "analysis-dart_financials",
    "name": "OpenDART 전체 재무제표",
    "market": "KR",
    "component": "analysis",
    "featureId": "dart_financials",
    "description": "OpenDART XBRL 전체 재무제표의 보고 계정·통화·기간을 원문 값 그대로 표시합니다."
  }
];
