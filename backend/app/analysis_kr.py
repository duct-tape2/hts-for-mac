"""Strict, read-only adapters for selected Korean market-analysis APIs.

This module deliberately does not change gateway policy.  ``ALLOWED_CALLS`` is
an integration proposal for the owner to review and merge into the gateway's
own allowlist.  Every live read still goes through its policy-enforcing
``_fetch_rows`` or ``_fetch_page`` helper.
"""
from __future__ import annotations

import copy
import json
import math
import re
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock
from typing import Any, Callable, TypedDict

from app import kiwoom_gateway as gateway


class FeatureMetadata(TypedDict):
    featureId: str
    title: str
    market: str
    description: str
    parameters: list[dict[str, Any]]
    apiId: str
    path: str


class Column(TypedDict, total=False):
    key: str
    label: str
    numeric: bool
    unit: str


class _Spec(TypedDict, total=False):
    apiId: str
    path: str
    listKey: str
    mode: str
    parameters: list[dict[str, Any]]
    columns: list[Column]
    fields: list[tuple[str, str, str, bool, str | None, str]]
    rawFields: list[tuple[str, str]]
    body: Callable[[dict[str, Any], str | None], dict[str, str]]
    required: tuple[str, ...]
    optionalList: bool


_KR_CODE = re.compile(r"^[0-9A-Z]{6}$")
_DATE = re.compile(r"^\d{8}$")
_THEME_CODE = re.compile(r"^[0-9]{1,20}$")
_ETF_INDEX = re.compile(r"^[A-Z0-9_]{1,32}$")
_SKIP_STOCK = re.compile(r"^[01]{9}$")
_CACHE_TTL = 15.0
_CACHE_LIMIT = 64
_CACHE_LOCK = Lock()
_CACHE: dict[tuple[str, str, str], tuple[float, dict[str, Any]]] = {}
_FIXTURE_RECEIVED_AT = "2026-10-24T00:00:00Z"
_PRICE_SOURCES = frozenset({
    "cur_prc", "close_pric", "pri_sel_bid_unit", "pri_buy_bid_unit", "sel_bid", "buy_bid",
    "high_pric", "low_pric", "tdy_high_pric", "tdy_low_pric", "base_pric", "shrts_avg_pric",
    "wonju_pric", "nav", "open_pric", "pred_close_pric", "upl_pric", "lst_pric", "repl_pric",
    "exp_cntr_pric", "exec_pric", "hgst_pric", "lwst_pric", "motn_pric", "dynm_stdpc", "static_stdpc",
    "prsm_avg_pric", "ovt_sigpric_cur_prc",
})


def _select(key: str, label: str, default: str, options: list[tuple[str, str]]) -> dict[str, Any]:
    return {"key": key, "label": label, "type": "select", "default": default,
            "options": [{"value": value, "label": option_label} for value, option_label in options]}


def _metadata_date_default() -> str:
    """Return a frontend-valid ISO calendar default, including fixture mode."""
    if not gateway.KIWOOM_ENABLED and str(gateway.ENVIRONMENT) == "fixture":
        return "2026-10-24"
    return (datetime.now(timezone.utc) + timedelta(hours=9)).strftime("%Y-%m-%d")


def _date(key: str, label: str, default: str | None = None) -> dict[str, Any]:
    # AnalysisExplorer validates type=date defaults as YYYY-MM-DD before a
    # query is made; protocol shorthand such as "today" is therefore not a
    # safe public metadata value.
    return {"key": key, "label": label, "type": "date", "default": default or _metadata_date_default()}


def _text(key: str, label: str, default: str = "") -> dict[str, Any]:
    return {"key": key, "label": label, "type": "text", "default": default}


def _number_parameter(key: str, label: str, default: int, minimum: int | None = None, maximum: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"key": key, "label": label, "type": "number", "default": default}
    if minimum is not None:
        result["minimum"] = minimum
    if maximum is not None:
        result["maximum"] = maximum
    return result


_MARKET = [("000", "전체"), ("001", "코스피"), ("101", "코스닥")]
_VENUE = [("1", "KRX"), ("2", "NXT"), ("3", "통합")]
_STOCK = [_text("stockCode", "종목코드")]
_MARKET_KOSPI_KOSDAQ = [("001", "코스피"), ("101", "코스닥")]
_MARKET_WITH_KOSPI200 = [*_MARKET, ("201", "코스피200")]
_STOCK_FILTER_CORE = [
    ("0", "전체조회"), ("1", "관리종목 제외"), ("3", "우선주 제외"), ("5", "증거금 100% 제외"),
    ("6", "증거금 100%만"), ("7", "증거금 40%만"), ("8", "증거금 30%만"),
]
_STOCK_FILTER_BOOK = [
    ("0", "전체조회"), ("1", "관리종목 제외"), ("5", "증거금 100% 제외"), ("6", "증거금 100%만"),
    ("7", "증거금 40%만"), ("8", "증거금 30%만"), ("9", "증거금 20%만"),
]
_STOCK_FILTER_VOLUME_SURGE = [
    ("0", "전체조회"), ("1", "관리종목 제외"), ("3", "우선주 제외"), ("11", "정리매매종목 제외"),
    ("4", "관리종목·우선주 제외"), ("5", "증거금 100% 제외"), ("6", "증거금 100%만"),
    ("13", "증거금 60%만"), ("12", "증거금 50%만"), ("7", "증거금 40%만"),
    ("8", "증거금 30%만"), ("9", "증거금 20%만"), ("17", "ETN 제외"), ("14", "ETF 제외"),
    ("18", "ETF·ETN 제외"), ("15", "스팩 제외"), ("20", "ETF·ETN·스팩 제외"),
]
_CREDIT_FILTER = [
    ("0", "전체조회"), ("1", "신용융자 A군"), ("2", "신용융자 B군"), ("3", "신용융자 C군"),
    ("4", "신용융자 D군"), ("7", "신용융자 E군"), ("9", "신용융자 전체"),
]
_VOLUME_THRESHOLD_FIVE_DIGIT = [
    ("00000", "전체조회"), ("00010", "1만주 이상"), ("00050", "5만주 이상"), ("00100", "10만주 이상"),
    ("00150", "15만주 이상"), ("00200", "20만주 이상"), ("00300", "30만주 이상"),
    ("00500", "50만주 이상"), ("01000", "100만주 이상"),
]
_VOLUME_THRESHOLD_BOOK = [("0000", "장 시작 전/0주 이상"), ("0010", "1만주 이상"), ("0050", "5만주 이상"), ("00100", "10만주 이상")]
_VOLUME_THRESHOLD = [
    ("5", "5천주 이상"), ("10", "1만주 이상"), ("50", "5만주 이상"), ("100", "10만주 이상"),
    ("200", "20만주 이상"), ("300", "30만주 이상"), ("500", "50만주 이상"), ("1000", "100만주 이상"),
]


def _columns(*items: tuple[str, str, bool, str | None]) -> list[Column]:
    return [{"key": key, "label": label, "numeric": numeric, **({"unit": unit} if unit else {})} for key, label, numeric, unit in items]


def _raw_columns(items: list[tuple[str, str]]) -> list[Column]:
    return [{"key": key, "label": f"{label} · 공급자 원문", "numeric": False} for key, label in items]


# tuple: output key, official source field, label, numeric, unit, conversion
_TAPE_FIELDS = [
    ("time", "tm", "시간", False, None, "text"), ("price", "cur_prc", "체결가", True, "KRW", "actualPrice"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "pre_rt", "대비율", True, "percent", "number"),
    ("ask", "pri_sel_bid_unit", "우선매도호가", True, "KRW", "number"), ("bid", "pri_buy_bid_unit", "우선매수호가", True, "KRW", "number"),
    ("tradeQuantity", "cntr_trde_qty", "체결거래량", True, "shares", "number"), ("accumulatedVolume", "acc_trde_qty", "누적거래량", True, "shares", "number"),
    ("accumulatedValue", "acc_trde_prica", "누적거래대금", True, "KRW", "number"), ("strength", "cntr_str", "체결강도", True, None, "number"),
    ("venue", "stex_tp", "거래소", False, None, "text"),
]
_FOREIGN_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("close", "close_pric", "종가", True, "KRW", "number"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("changeQuantity", "chg_qty", "변동수량", True, "shares", "number"), ("holdingQuantity", "poss_stkcnt", "보유주식수", True, "shares", "number"),
    ("weight", "wght", "비중", True, "percent", "number"), ("availableQuantity", "gain_pos_stkcnt", "취득가능주식수", True, "shares", "number"),
    ("limit", "frgnr_limit", "외국인한도", True, "shares", "number"), ("limitExhaustionRate", "limit_exh_rt", "한도소진률", True, "percent", "number"),
]
_CREDIT_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("new", "new", "신규", True, None, "number"), ("repayment", "rpya", "상환", True, None, "number"),
    ("balance", "remn", "잔고", True, None, "number"), ("amount", "amt", "금액", True, None, "number"),
    ("changeAmount", "pre", "대비", True, None, "number"), ("loanRate", "shr_rt", "공여율", True, "percent", "number"),
    ("balanceRate", "remn_rt", "잔고율", True, "percent", "number"),
]
_SHORT_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("close", "close_pric", "종가", True, "KRW", "number"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), ("shortQuantity", "shrts_qty", "공매도량", True, "shares", "number"),
    ("cumulativeShortQuantity", "ovr_shrts_qty", "누적공매도량", True, "shares", "number"), ("tradeWeight", "trde_wght", "매매비중", True, "percent", "number"),
    ("shortValue", "shrts_trde_prica", "공매도거래대금", True, "KRW thousands", "number"), ("shortAveragePrice", "shrts_avg_pric", "공매도평균가", True, "KRW", "number"),
]
_LENDING_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("contractQuantity", "dbrt_trde_cntrcnt", "대차체결주수", True, "shares", "number"),
    ("repaymentQuantity", "dbrt_trde_rpy", "대차상환주수", True, "shares", "number"), ("changeQuantity", "dbrt_trde_irds", "대차증감", True, "shares", "number"),
    ("balanceQuantity", "rmnd", "잔고주수", True, "shares", "number"), ("balanceAmount", "remn_amt", "잔고금액", True, "KRW millions", "number"),
]
_PROGRAM_RANK_FIELDS = [
    ("rank", "rank", "순위", True, None, "number"), ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "acc_trde_qty", "누적거래량", True, "shares", "number"),
    ("programSell", "prm_sell_amt", "프로그램매도", True, "KRW millions", "number"), ("programBuy", "prm_buy_amt", "프로그램매수", True, "KRW millions", "number"),
    ("programNetBuy", "prm_netprps_amt", "프로그램순매수", True, "KRW millions", "number"),
]
_PROGRAM_STOCK_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("buyQuantity", "buy_cntr_qty", "매수체결수량", True, "thousand shares", "number"),
    ("buyAmount", "buy_cntr_amt", "매수체결금액", True, "KRW millions", "number"), ("sellQuantity", "sel_cntr_qty", "매도체결수량", True, "thousand shares", "number"),
    ("sellAmount", "sel_cntr_amt", "매도체결금액", True, "KRW millions", "number"), ("netBuy", "netprps_prica", "순매수대금", True, "KRW millions", "number"),
    ("marketTradeRate", "all_trde_rt", "전체거래비율", True, "percent", "number"),
]
_PROGRAM_INTRADAY_FIELDS = [
    ("time", "cntr_tm", "체결시간", False, None, "text"), ("arbitrageSell", "dfrt_trde_sel", "차익매도", True, "KRW millions", "number"),
    ("arbitrageBuy", "dfrt_trde_buy", "차익매수", True, "KRW millions", "number"), ("arbitrageNet", "dfrt_trde_netprps", "차익순매수", True, "KRW millions", "number"),
    ("nonArbitrageSell", "ndiffpro_trde_sel", "비차익매도", True, "KRW millions", "number"), ("nonArbitrageBuy", "ndiffpro_trde_buy", "비차익매수", True, "KRW millions", "number"),
    ("nonArbitrageNet", "ndiffpro_trde_netprps", "비차익순매수", True, "KRW millions", "number"), ("totalSell", "all_sel", "전체매도", True, "KRW millions", "number"),
    ("totalBuy", "all_buy", "전체매수", True, "KRW millions", "number"), ("totalNet", "all_netprps", "전체순매수", True, "KRW millions", "number"),
    ("kospi200", "kospi200", "KOSPI200", True, None, "number"), ("basis", "basis", "BASIS", True, None, "number"),
]
_ARBITRAGE_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("buyQuantity", "buy_dfrt_trde_qty", "매수차익수량", True, "thousand shares", "number"),
    ("buyAmount", "buy_dfrt_trde_amt", "매수차익금액", True, "KRW millions", "number"), ("buyChangeAmount", "buy_dfrt_trde_irds_amt", "매수차익증감", True, "KRW millions", "number"),
    ("sellQuantity", "sel_dfrt_trde_qty", "매도차익수량", True, "thousand shares", "number"), ("sellAmount", "sel_dfrt_trde_amt", "매도차익금액", True, "KRW millions", "number"),
    ("sellChangeAmount", "sel_dfrt_trde_irds_amt", "매도차익증감", True, "KRW millions", "number"),
]
_PROGRAM_DAILY_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("programSellAmount", "prm_sell_amt", "프로그램매도", True, "KRW millions", "number"), ("programBuyAmount", "prm_buy_amt", "프로그램매수", True, "KRW millions", "number"),
    ("programNetAmount", "prm_netprps_amt", "프로그램순매수", True, "KRW millions", "number"), ("programNetAmountChange", "prm_netprps_amt_irds", "순매수증감", True, "KRW millions", "number"),
    ("programSellQuantity", "prm_sell_qty", "프로그램매도수량", True, "shares", "number"), ("programBuyQuantity", "prm_buy_qty", "프로그램매수수량", True, "shares", "number"),
    ("programNetQuantity", "prm_netprps_qty", "프로그램순매수수량", True, "shares", "number"), ("programNetQuantityChange", "prm_netprps_qty_irds", "순매수수량증감", True, "shares", "number"),
]
_THEME_FIELDS = [
    ("themeCode", "thema_grp_cd", "테마코드", False, None, "text"), ("theme", "thema_nm", "테마명", False, None, "text"), ("stockCount", "stk_num", "종목수", True, None, "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("risingCount", "rising_stk_num", "상승종목수", True, None, "number"),
    ("fallingCount", "fall_stk_num", "하락종목수", True, None, "number"), ("periodReturn", "dt_prft_rt", "기간수익률", True, "percent", "number"), ("mainStock", "main_stk", "주요종목", False, None, "text"),
]
_THEME_CONSTITUENT_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("volume", "acc_trde_qty", "누적거래량", True, "shares", "number"), ("ask", "sel_bid", "매도호가", True, "KRW", "number"),
    ("bid", "buy_bid", "매수호가", True, "KRW", "number"), ("periodReturn", "dt_prft_rt_n", "기간수익률", True, "percent", "number"),
]
_ETF_RETURN_FIELDS = [
    ("etfReturn", "etfprft_rt", "ETF수익률", True, "percent", "number"), ("tradeReturn", "cntr_prft_rt", "체결수익률", True, "percent", "number"),
    ("foreignNetBuyQuantity", "for_netprps_qty", "외인순매수수량", True, None, "number"), ("institutionalNetBuyQuantity", "orgn_netprps_qty", "기관순매수수량", True, None, "number"),
]
_ETF_ALL_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"), ("classification", "stk_cls", "종목분류", False, None, "text"),
    ("close", "close_pric", "종가", True, "KRW", "number"), ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "pre_rt", "대비율", True, "percent", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), ("nav", "nav", "NAV", True, None, "number"), ("trackingErrorRate", "trace_eor_rt", "추적오차율", True, "percent", "number"),
    ("trackingIndex", "trace_idex_nm", "추적지수", False, None, "text"), ("trackingChangePct", "trace_flu_rt", "추적등락률", True, "percent", "number"),
]
_ETF_NAV_FIELDS = [
    ("nav", "nav", "NAV", True, None, "number"), ("navChange", "navpred_pre", "NAV전일대비", True, None, "number"), ("navChangePct", "navflu_rt", "NAV등락률", True, "percent", "number"),
    ("trackingErrorRate", "trace_eor_rt", "추적오차율", True, "percent", "number"), ("disparityRate", "dispty_rt", "괴리율", True, "percent", "number"),
    ("stockCount", "stkcnt", "주식수", True, None, "number"), ("basePrice", "base_pric", "기준가", True, "KRW", "number"),
    ("foreignHoldingQuantity", "for_rmnd_qty", "외인보유수량", True, "shares", "number"),
]
_NEW_HIGH_LOW_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), ("previousVolumeChangePct", "pred_trde_qty_pre_rt", "전일거래량대비율", True, "percent", "number"),
    ("ask", "sel_bid", "매도호가", True, "KRW", "number"), ("bid", "buy_bid", "매수호가", True, "KRW", "number"),
    ("high", "high_pric", "고가", True, "KRW", "number"), ("low", "low_pric", "저가", True, "KRW", "number"),
]
_HIGH_LOW_PROXIMITY_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), ("ask", "sel_bid", "매도호가", True, "KRW", "number"),
    ("bid", "buy_bid", "매수호가", True, "KRW", "number"), ("dayHigh", "tdy_high_pric", "당일고가", True, "KRW", "number"),
    ("dayLow", "tdy_low_pric", "당일저가", True, "KRW", "number"),
]
_PRICE_SURGE_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("classification", "stk_cls", "종목분류", False, None, "text"),
    ("name", "stk_nm", "종목명", False, None, "text"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("basePrice", "base_pric", "기준가", True, "KRW", "number"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("baseChange", "base_pre", "기준대비", True, "KRW", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("surgePct", "jmp_rt", "급등률", True, "percent", "number"),
]
_ORDERBOOK_RANK_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("totalAskQuantity", "tot_sel_req", "총매도잔량", True, "shares", "number"), ("totalBidQuantity", "tot_buy_req", "총매수잔량", True, "shares", "number"),
    ("netBidQuantity", "netprps_req", "순매수잔량", True, "shares", "number"), ("bidRate", "buy_rt", "매수비율", True, "percent", "number"),
]
_VOLUME_SURGE_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("previousVolume", "prev_trde_qty", "이전거래량", True, "shares", "number"), ("currentVolume", "now_trde_qty", "현재거래량", True, "shares", "number"),
    ("surgeQuantity", "sdnin_qty", "급증량", True, "shares", "number"), ("surgePct", "sdnin_rt", "급증률", True, "percent", "number"),
]
_VOLUME_RENEWAL_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("previousVolume", "prev_trde_qty", "이전거래량", True, "shares", "number"), ("currentVolume", "now_trde_qty", "현재거래량", True, "shares", "number"),
    ("ask", "sel_bid", "매도호가", True, "KRW", "number"), ("bid", "buy_bid", "매수호가", True, "KRW", "number"),
]
_VALUATION_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("valuation", "per", "PER/PBR/ROE", True, None, "number"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("currentVolume", "now_trde_qty", "현재거래량", True, "shares", "number"),
    ("ask", "sel_bid", "매도호가", True, "KRW", "number"),
]
_CREDIT_RATIO_FIELDS = [
    ("stockInfo", "stk_infr", "종목정보", False, None, "text"), ("code", "stk_cd", "종목코드", False, None, "text"),
    ("name", "stk_nm", "종목명", False, None, "text"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("creditRatio", "crd_rt", "신용비율", True, "percent", "number"),
    ("askQuantity", "sel_req", "매도잔량", True, "shares", "number"), ("bidQuantity", "buy_req", "매수잔량", True, "shares", "number"),
    ("currentVolume", "now_trde_qty", "현재거래량", True, "shares", "number"),
]
_FOREIGN_PERIOD_FIELDS = [
    ("rank", "rank", "순위", True, None, "number"), ("code", "stk_cd", "종목코드", False, None, "text"),
    ("name", "stk_nm", "종목명", False, None, "text"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("ask", "sel_bid", "매도호가", True, "KRW", "number"), ("bid", "buy_bid", "매수호가", True, "KRW", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), ("netTradeQuantity", "netprps_qty", "순매매수량", True, "shares", "number"),
    ("availableQuantity", "gain_pos_stkcnt", "취득가능주식수", True, "shares", "number"),
]
_FUNDAMENTAL_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("settlementMonth", "setl_mm", "결산월", False, None, "text"), ("faceValue", "fav", "액면가", True, None, "number"),
    ("capital", "cap", "자본금", True, None, "number"), ("floatShares", "flo_stk", "유통주식", True, "shares", "number"),
    ("creditRatio", "crd_rt", "신용비율", True, "percent", "number"), ("yearHigh", "oyr_hgst", "연중최고", True, "KRW", "number"),
    ("yearLow", "oyr_lwst", "연중최저", True, "KRW", "number"), ("marketCap", "mac", "시가총액", True, None, "number"),
    ("marketCapWeight", "mac_wght", "시가총액비중", True, "percent", "number"), ("foreignExhaustionRate", "for_exh_rt", "외국인소진율", True, "percent", "number"),
    ("substitutePrice", "repl_pric", "대용가", True, "KRW", "number"), ("per", "per", "PER", True, None, "number"),
    ("eps", "eps", "EPS", True, None, "number"), ("roe", "roe", "ROE", True, "percent", "number"),
    ("pbr", "pbr", "PBR", True, None, "number"), ("ev", "ev", "EV", True, None, "number"), ("bps", "bps", "BPS", True, None, "number"),
    ("sales", "sale_amt", "매출액", True, None, "number"), ("businessProfit", "bus_pro", "영업이익", True, None, "number"),
    ("netIncome", "cup_nga", "당기순이익", True, None, "number"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("changeSign", "pre_sig", "대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
]
_OHLCV_FLOW_FIELDS = [
    ("date", "date", "날짜", False, None, "date"), ("open", "open_pric", "시가", True, "KRW", "number"),
    ("high", "high_pric", "고가", True, "KRW", "number"), ("low", "low_pric", "저가", True, "KRW", "number"),
    ("close", "close_pric", "종가", True, "KRW", "number"), ("change", "pre", "대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("tradingValue", "trde_prica", "거래대금", True, "KRW millions", "number"), ("foreignHolding", "for_poss", "외인보유", True, "percent", "number"),
    ("foreignWeight", "for_wght", "외인비중", True, "percent", "number"), ("foreignNetBuy", "for_netprps", "외인순매수", True, None, "number"),
    ("institutionalNetBuy", "orgn_netprps", "기관순매수", True, None, "number"), ("individualNetBuy", "ind_netprps", "개인순매수", True, None, "number"),
    ("foreignBroker", "frgn", "외국계", True, "shares", "number"), ("creditBalanceRate", "crd_remn_rt", "신용잔고율", True, "percent", "number"),
    ("program", "prm", "프로그램", True, "shares", "number"),
]
_DAILY_SESSION_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("close", "close_pric", "종가", True, "KRW", "number"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("tradingValue", "trde_prica", "거래대금", True, "KRW millions", "number"), ("preMarketVolume", "bf_mkrt_trde_qty", "장전거래량", True, "shares", "number"),
    ("regularVolume", "opmr_trde_qty", "장중거래량", True, "shares", "number"), ("afterMarketVolume", "af_mkrt_trde_qty", "장후거래량", True, "shares", "number"),
    ("periodVolume", "prid_trde_qty", "기간중거래량", True, "shares", "number"), ("strength", "cntr_str", "체결강도", True, "percent", "number"),
    ("foreignNetBuy", "for_netprps", "외인순매수", True, None, "number"), ("institutionalNetBuy", "orgn_netprps", "기관순매수", True, None, "number"),
    ("individualNetBuy", "ind_netprps", "개인순매수", True, None, "number"), ("program", "prm", "프로그램", True, None, "number"),
]
_DAILY_PRICE_FIELDS = [
    ("date", "date", "날짜", False, None, "date"), ("open", "open_pric", "시가", True, "KRW", "number"),
    ("high", "high_pric", "고가", True, "KRW", "number"), ("low", "low_pric", "저가", True, "KRW", "number"),
    ("close", "close_pric", "종가", True, "KRW", "number"), ("change", "pred_rt", "전일비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("tradingValue", "amt_mn", "금액", True, "KRW millions", "number"), ("creditRatio", "crd_rt", "신용비", True, "percent", "number"),
    ("individual", "ind", "개인", True, None, "number"), ("institutional", "orgn", "기관", True, None, "number"),
    ("foreign", "for_qty", "외인수량", True, None, "number"), ("program", "prm", "프로그램", True, None, "number"),
    ("foreignNetBuy", "for_netprps", "외인순매수", True, None, "number"), ("institutionalNetBuy", "orgn_netprps", "기관순매수", True, None, "number"),
    ("individualNetBuy", "ind_netprps", "개인순매수", True, None, "number"),
]
_VI_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("accumulatedVolume", "acc_trde_qty", "누적거래량", True, "shares", "number"), ("triggerPrice", "motn_pric", "발동가격", True, "KRW", "number"),
    ("dynamicDisparityRate", "dynm_dispty_rt", "동적괴리율", True, "percent", "number"), ("processingTime", "trde_cntr_proc_time", "매매체결처리시각", False, None, "text"),
    ("releaseTime", "virelis_time", "VI해제시각", False, None, "text"), ("applicationType", "viaplc_tp", "VI적용구분", False, None, "text"),
    ("dynamicBasePrice", "dynm_stdpc", "동적기준가격", True, "KRW", "number"), ("staticBasePrice", "static_stdpc", "정적기준가격", True, "KRW", "number"),
    ("staticDisparityRate", "static_dispty_rt", "정적괴리율", True, "percent", "number"), ("openChangePct", "open_pric_pre_flu_rt", "시가대비등락률", True, "percent", "number"),
    ("triggerCount", "vimotn_cnt", "VI발동횟수", True, None, "number"), ("venue", "stex_tp", "거래소", False, None, "text"),
]
_INSTITUTION_DAILY_RANK_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("netBuyQuantity", "netprps_qty", "순매수수량", True, "hundred shares", "number"), ("netBuyAmount", "netprps_amt", "순매수금액", True, "KRW millions", "number"),
]
_INSTITUTION_TREND_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("close", "close_pric", "종가", True, "KRW", "number"),
    ("changeSign", "pre_sig", "대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("institutionPeriodAccumulated", "orgn_dt_acc", "기관기간누적", True, None, "number"), ("institutionDailyNet", "orgn_daly_nettrde_qty", "기관일별순매매수량", True, "shares", "number"),
    ("foreignPeriodAccumulated", "for_dt_acc", "외인기간누적", True, None, "number"), ("foreignDailyNet", "for_daly_nettrde_qty", "외인일별순매매수량", True, "shares", "number"),
    ("foreignLimitExhaustionRate", "limit_exh_rt", "한도소진율", True, "percent", "number"),
]
_STRENGTH_INTRADAY_FIELDS = [
    ("time", "cntr_tm", "체결시간", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), ("accumulatedValue", "acc_trde_prica", "누적거래대금", True, "KRW millions", "number"),
    ("accumulatedVolume", "acc_trde_qty", "누적거래량", True, "shares", "number"), ("strength", "cntr_str", "체결강도", True, "percent", "number"),
    ("strength5", "cntr_str_5min", "체결강도5", True, "percent", "number"), ("strength20", "cntr_str_20min", "체결강도20", True, "percent", "number"),
    ("strength60", "cntr_str_60min", "체결강도60", True, "percent", "number"),
]
_STRENGTH_DAILY_FIELDS = [
    ("date", "dt", "일자", False, None, "date"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changeSign", "pred_pre_sig", "전일대비기호", False, None, "text"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), ("accumulatedValue", "acc_trde_prica", "누적거래대금", True, "KRW millions", "number"),
    ("accumulatedVolume", "acc_trde_qty", "누적거래량", True, "shares", "number"), ("strength", "cntr_str", "체결강도", True, "percent", "number"),
    ("strength5", "cntr_str_5min", "체결강도5일", True, "percent", "number"), ("strength20", "cntr_str_20min", "체결강도20일", True, "percent", "number"),
    ("strength60", "cntr_str_60min", "체결강도60일", True, "percent", "number"),
]
_INVESTOR_DAILY_RANK_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("netSettlementQuantity", "netslmt_qty", "순매도수량", True, "shares", "number"), ("netSettlementAmount", "netslmt_amt", "순매도금액", True, "KRW", "number"),
    ("estimatedAveragePrice", "prsm_avg_pric", "추정평균가", True, "KRW", "number"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("changeSign", "pre_sig", "대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("averagePriceChange", "avg_pric_pre", "평균가대비", True, "KRW", "number"), ("changePct", "pre_rt", "대비율", True, "percent", "number"),
    ("periodVolume", "dt_trde_qty", "기간거래량", True, "shares", "number"),
]
_INVESTOR_BREAKDOWN = [
    ("individual", "ind_invsr", "개인투자자"), ("foreign", "frgnr_invsr", "외국인투자자"), ("institutional", "orgn", "기관계"),
    ("financialInvestment", "fnnc_invt", "금융투자"), ("insurance", "insrnc", "보험"), ("investmentTrust", "invtrt", "투신"),
    ("otherFinancial", "etc_fnnc", "기타금융"), ("bank", "bank", "은행"), ("pensionEtc", "penfnd_etc", "연기금등"),
    ("privateFund", "samo_fund", "사모펀드"), ("nation", "natn", "국가"), ("otherCorporation", "etc_corp", "기타법인"), ("domesticForeign", "natfor", "내외국인"),
]
_INVESTOR_DATE_CHART_FIELDS = [("date", "dt", "일자", False, None, "date"), *[(key, source, label, True, None, "number") for key, source, label in _INVESTOR_BREAKDOWN]]
_INVESTOR_TIME_CHART_FIELDS = [
    ("time", "tm", "시간", False, None, "text"), ("foreign", "frgnr_invsr", "외국인투자자", True, None, "number"),
    ("institutional", "orgn", "기관계", True, None, "number"), ("investmentTrust", "invtrt", "투신", True, None, "number"),
    ("insurance", "insrnc", "보험", True, None, "number"), ("bank", "bank", "은행", True, None, "number"),
    ("pensionEtc", "penfnd_etc", "연기금등", True, None, "number"), ("otherCorporation", "etc_corp", "기타법인", True, None, "number"),
    ("nation", "natn", "국가", True, None, "number"),
]
_PROGRAM_STOCK_INTRADAY_FIELDS = [
    ("time", "tm", "시간", False, None, "text"), ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"),
    ("changeSign", "pre_sig", "대비기호", False, None, "text"), ("change", "pred_pre", "전일대비", True, "KRW", "number"),
    ("changePct", "flu_rt", "등락률", True, "percent", "number"), ("volume", "trde_qty", "거래량", True, "shares", "number"),
    ("programSellAmount", "prm_sell_amt", "프로그램매도금액", True, "KRW millions", "number"), ("programBuyAmount", "prm_buy_amt", "프로그램매수금액", True, "KRW millions", "number"),
    ("programNetAmount", "prm_netprps_amt", "프로그램순매수금액", True, "KRW millions", "number"), ("programNetAmountChange", "prm_netprps_amt_irds", "순매수금액증감", True, "KRW millions", "number"),
    ("programSellQuantity", "prm_sell_qty", "프로그램매도수량", True, "shares", "number"), ("programBuyQuantity", "prm_buy_qty", "프로그램매수수량", True, "shares", "number"),
    ("programNetQuantity", "prm_netprps_qty", "프로그램순매수수량", True, "shares", "number"), ("programNetQuantityChange", "prm_netprps_qty_irds", "순매수수량증감", True, "shares", "number"),
    ("basePriceTime", "base_pric_tm", "기준가시간", False, None, "text"), ("lendingRepaymentSum", "dbrt_trde_rpy_sum", "대차거래상환주수합", True, "shares", "number"),
    ("balanceOrderSum", "remn_rcvord_sum", "잔고수주합", True, "shares", "number"), ("venue", "stex_tp", "거래소", False, None, "text"),
]
_MINUTE_QUOTE_RAW_FIELDS = [
    ("date", "날짜"), ("open_pric", "시가"), ("high_pric", "고가"), ("low_pric", "저가"),
    ("close_pric", "종가"), ("pre", "대비"), ("flu_rt", "등락률"), ("trde_qty", "거래량"),
    ("trde_prica", "거래대금"), ("cntr_str", "체결강도"),
]
_PRICE_PROFILE_RAW_FIELDS = [
    ("stk_nm", "종목명"), ("stk_cd", "종목코드"), ("date", "날짜"), ("tm", "시간"), ("pred_close_pric", "전일종가"),
    ("pred_trde_qty", "전일거래량"), ("upl_pric", "상한가"), ("lst_pric", "하한가"), ("pred_trde_prica", "전일거래대금"),
    ("flo_stkcnt", "상장주식수"), ("cur_prc", "현재가"), ("smbol", "부호"), ("flu_rt", "등락률"), ("pred_rt", "전일비"),
    ("open_pric", "시가"), ("high_pric", "고가"), ("low_pric", "저가"), ("cntr_qty", "체결량"),
    ("trde_qty", "거래량"), ("trde_prica", "거래대금"), ("exp_cntr_pric", "예상체결가"), ("exp_cntr_qty", "예상체결량"),
    ("exp_sel_pri_bid", "예상매도우선호가"), ("exp_buy_pri_bid", "예상매수우선호가"), ("trde_strt_dt", "거래시작일"),
    ("exec_pric", "행사가격"), ("hgst_pric", "최고가"), ("lwst_pric", "최저가"), ("hgst_pric_dt", "최고가일"), ("lwst_pric_dt", "최저가일"),
    *[(f"sel_{level}bid", f"매도{level}호가") for level in range(1, 11)], *[(f"buy_{level}bid", f"매수{level}호가") for level in range(1, 11)],
    *[(f"sel_{level}bid_req", f"매도{level}호가잔량") for level in range(1, 11)], *[(f"buy_{level}bid_req", f"매수{level}호가잔량") for level in range(1, 11)],
    *[(f"sel_{level}bid_jub_pre", f"매도{level}호가직전대비") for level in range(1, 11)], *[(f"buy_{level}bid_jub_pre", f"매수{level}호가직전대비") for level in range(1, 11)],
    *[(f"sel_{level}bid_cnt", f"매도{level}호가건수") for level in range(1, 6)], *[(f"buy_{level}bid_cnt", f"매수{level}호가건수") for level in range(1, 6)],
    *[(f"lpsel_{level}bid_req", f"LP매도{level}호가잔량") for level in range(1, 11)], *[(f"lpbuy_{level}bid_req", f"LP매수{level}호가잔량") for level in range(1, 11)],
    ("tot_buy_req", "총매수잔량"), ("tot_sel_req", "총매도잔량"), ("tot_buy_cnt", "총매수건수"), ("tot_sel_cnt", "총매도건수"),
]
_AFTER_HOURS_BOOK_RAW_FIELDS = [
    ("bid_req_base_tm", "호가잔량기준시간"),
    *[(f"ovt_sigpric_sel_bid_jub_pre_{level}", f"시간외단일가 매도호가직전대비{level}") for level in range(5, 0, -1)],
    *[(f"ovt_sigpric_sel_bid_qty_{level}", f"시간외단일가 매도호가수량{level}") for level in range(5, 0, -1)],
    *[(f"ovt_sigpric_sel_bid_{level}", f"시간외단일가 매도호가{level}") for level in range(5, 0, -1)],
    *[(f"ovt_sigpric_buy_bid_{level}", f"시간외단일가 매수호가{level}") for level in range(1, 6)],
    *[(f"ovt_sigpric_buy_bid_qty_{level}", f"시간외단일가 매수호가수량{level}") for level in range(1, 6)],
    *[(f"ovt_sigpric_buy_bid_jub_pre_{level}", f"시간외단일가 매수호가직전대비{level}") for level in range(1, 6)],
    ("ovt_sigpric_sel_bid_tot_req", "시간외단일가 매도호가총잔량"), ("ovt_sigpric_buy_bid_tot_req", "시간외단일가 매수호가총잔량"),
    ("sel_bid_tot_req_jub_pre", "매도호가총잔량직전대비"), ("sel_bid_tot_req", "매도호가총잔량"), ("buy_bid_tot_req", "매수호가총잔량"), ("buy_bid_tot_req_jub_pre", "매수호가총잔량직전대비"),
    ("ovt_sel_bid_tot_req_jub_pre", "시간외매도호가총잔량직전대비"), ("ovt_sel_bid_tot_req", "시간외매도호가총잔량"), ("ovt_buy_bid_tot_req", "시간외매수호가총잔량"), ("ovt_buy_bid_tot_req_jub_pre", "시간외매수호가총잔량직전대비"),
    ("ovt_sigpric_cur_prc", "시간외단일가 현재가"), ("ovt_sigpric_pred_pre_sig", "시간외단일가 전일대비기호"), ("ovt_sigpric_pred_pre", "시간외단일가 전일대비"), ("ovt_sigpric_flu_rt", "시간외단일가 등락률"), ("ovt_sigpric_acc_trde_qty", "시간외단일가 누적거래량"),
]
_INTRADAY_INVESTOR_RANK_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("changeSign", "pre_sig", "대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("accumulatedVolume", "acc_trde_qty", "누적거래량", True, "shares", "number"), ("netBuyAmount", "netprps_amt", "순매수금액", True, "KRW millions", "number"),
    ("previousNetBuyAmount", "prev_netprps_amt", "이전순매수금액", True, "KRW millions", "number"), ("buyAmount", "buy_amt", "매수금액", True, "KRW millions", "number"),
    ("netBuyAmountChange", "netprps_amt_irds", "순매수금액증감", True, "KRW millions", "number"), ("sellAmount", "sell_amt", "매도금액", True, "KRW millions", "number"),
    ("netBuyQuantity", "netprps_qty", "순매수수량", True, "shares", "number"), ("previousNetBuyQuantity", "prev_pot_netprps_qty", "이전시점순매수수량", True, "shares", "number"),
    ("netBuyQuantityChange", "netprps_irds", "순매수증감", True, "shares", "number"), ("buyQuantity", "buy_qty", "매수수량", True, "shares", "number"),
    ("sellQuantity", "sell_qty", "매도수량", True, "shares", "number"),
]
_AFTER_CLOSE_INVESTOR_FIELDS = [
    ("code", "stk_cd", "종목코드", False, None, "text"), ("name", "stk_nm", "종목명", False, None, "text"),
    ("price", "cur_prc", "현재가", True, "KRW", "actualPrice"), ("changeSign", "pre_sig", "대비기호", False, None, "text"),
    ("change", "pred_pre", "전일대비", True, "KRW", "number"), ("changePct", "flu_rt", "등락률", True, "percent", "number"),
    ("volume", "trde_qty", "거래량", True, "shares", "number"), *[(key, source, label, True, None, "number") for key, source, label in _INVESTOR_BREAKDOWN[:-1]],
]
_PROGRAM_ACCUMULATED_FIELDS = [
    ("date", "dt", "일자", False, None, "date"), ("kospi200", "kospi200", "KOSPI200", True, None, "number"), ("basis", "basis", "BASIS", True, None, "number"),
    ("arbitrageToday", "dfrt_trde_tdy", "차익거래당일", True, None, "number"), ("arbitrageAccumulated", "dfrt_trde_acc", "차익거래누적", True, None, "number"),
    ("nonArbitrageToday", "ndiffpro_trde_tdy", "비차익거래당일", True, None, "number"), ("nonArbitrageAccumulated", "ndiffpro_trde_acc", "비차익거래누적", True, None, "number"),
    ("totalToday", "all_tdy", "전체당일", True, None, "number"), ("totalAccumulated", "all_acc", "전체누적", True, None, "number"),
]


def _body_stock(params: dict[str, Any], code: str | None) -> dict[str, str]:
    if not code:
        raise gateway.BrokerError("stockCode or instrument is required")
    return {"stk_cd": code}


def _body_credit(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {**_body_stock(params, code), "dt": params["date"], "qry_tp": params["queryType"]}


def _body_short(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {**_body_stock(params, code), "tm_tp": params["timeType"], "strt_dt": params["startDate"], "end_dt": params["endDate"]}


def _body_lending(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"strt_dt": params["startDate"], "end_dt": params["endDate"], "all_tp": "1"}


def _body_program_rank(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"trde_upper_tp": params["direction"], "amt_qty_tp": params["amountQuantity"], "mrkt_tp": params["market"], "stex_tp": params["venue"]}


def _body_program_stock(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"dt": params["date"], "mrkt_tp": params["market"], "stex_tp": params["venue"]}


def _body_program_intraday(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    market = params["market"]
    venue = params["venue"]
    market_body = {"P001": {"1": "P00101", "2": "P001_NX01", "3": "P001_AL01"}, "P101": {"1": "P10102", "2": "P101_NX02", "3": "P101_AL02"}}[market][venue]
    return {"date": params["date"], "amt_qty_tp": params["amountQuantity"], "mrkt_tp": market_body, "min_tic_tp": params["intervalType"], "stex_tp": venue}


def _body_program_balance(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"date": params["date"], "stex_tp": params["venue"]}


def _body_program_daily(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {"amt_qty_tp": params["amountQuantity"], **_body_stock(params, code), "date": params["date"]}


def _body_theme_groups(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    body = {"qry_tp": params["queryType"], "stk_cd": params["stockCode"], "date_tp": str(params["days"]), "thema_nm": params["themeName"], "flu_pl_amt_tp": params["sort"], "stex_tp": params["venue"]}
    return {key: value for key, value in body.items() if value != ""}


def _body_theme_constituents(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"date_tp": str(params["days"]), "thema_grp_cd": params["themeCode"], "stex_tp": params["venue"]}


def _body_etf_return(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {**_body_stock(params, code), "etfobjt_idex_cd": params["indexCode"], "dt": params["period"]}


def _body_etf_all(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"txon_type": params["taxType"], "navpre": params["navComparison"], "mngmcomp": params["manager"], "txon_yn": params["taxed"], "trace_idex": "0", "stex_tp": params["venue"]}


def _body_new_high_low(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "ntl_tp": params["direction"], "high_low_close_tp": params["reference"], "stk_cnd": params["stockFilter"], "trde_qty_tp": params["minimumVolume"], "crd_cnd": params["creditFilter"], "updown_incls": params["includeLimit"], "dt": params["period"], "stex_tp": params["venue"]}


def _body_high_low_proximity(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"high_low_tp": params["target"], "alacc_rt": params["proximity"], "mrkt_tp": params["market"], "trde_qty_tp": params["minimumVolume"], "stk_cnd": params["stockFilter"], "crd_cnd": params["creditFilter"], "stex_tp": params["venue"]}


def _body_price_surge(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "flu_tp": params["direction"], "tm_tp": params["timeType"], "tm": str(params["lookback"]), "trde_qty_tp": params["minimumVolume"], "stk_cnd": params["stockFilter"], "crd_cnd": params["creditFilter"], "pric_cnd": params["priceFilter"], "updown_incls": params["includeLimit"], "stex_tp": params["venue"]}


def _body_orderbook_rank(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "sort_tp": params["sort"], "trde_qty_tp": params["minimumVolume"], "stk_cnd": params["stockFilter"], "crd_cnd": params["creditFilter"], "stex_tp": params["venue"]}


def _body_volume_surge(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    body = {"mrkt_tp": params["market"], "sort_tp": params["sort"], "tm_tp": params["timeType"], "trde_qty_tp": params["minimumVolume"], "stk_cnd": params["stockFilter"], "pric_tp": params["priceFilter"], "stex_tp": params["venue"]}
    if params["timeType"] == "1":
        body["tm"] = str(params["lookback"])
    return body


def _body_volume_renewal(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "cycle_tp": params["cycle"], "trde_qty_tp": params["minimumVolume"], "stex_tp": params["venue"]}


def _body_valuation(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"pertp": params["metric"], "stex_tp": params["venue"]}


def _body_credit_ratio(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "trde_qty_tp": params["minimumVolume"], "stk_cnd": params["stockFilter"], "updown_incls": params["includeLimit"], "crd_cnd": params["creditFilter"], "stex_tp": params["venue"]}


def _body_foreign_period(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "trde_tp": params["tradeType"], "dt": params["period"], "stex_tp": params["venue"]}


def _body_stock_start(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {**_body_stock(params, code), "strt_dt": params["startDate"]}


def _body_daily_price(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {**_body_stock(params, code), "qry_dt": params["date"], "indc_tp": params["indicatorType"]}


def _body_vi(params: dict[str, Any], code: str | None) -> dict[str, str]:
    volume_bounds = (params["minimumVolume"], params["maximumVolume"]) if params["volumeFilter"] == "1" else ("", "")
    value_bounds = (params["minimumValue"], params["maximumValue"]) if params["valueFilter"] == "1" else ("", "")
    body = {"mrkt_tp": params["market"], "bf_mkrt_tp": params["session"], "stk_cd": code or "", "motn_tp": params["viType"], "skip_stk": params["skipStock"], "trde_qty_tp": params["volumeFilter"], "min_trde_qty": volume_bounds[0], "max_trde_qty": volume_bounds[1], "trde_prica_tp": params["valueFilter"], "min_trde_prica": value_bounds[0], "max_trde_prica": value_bounds[1], "motn_drc": params["direction"], "stex_tp": params["venue"]}
    return body


def _body_institution_daily(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"strt_dt": params["startDate"], "end_dt": params["endDate"], "trde_tp": params["tradeType"], "mrkt_tp": params["market"], "stex_tp": params["venue"]}


def _body_institution_trend(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {**_body_stock(params, code), "strt_dt": params["startDate"], "end_dt": params["endDate"], "orgn_prsm_unp_tp": params["institutionPriceType"], "for_prsm_unp_tp": params["foreignPriceType"]}


def _body_investor_daily_rank(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"strt_dt": params["startDate"], "end_dt": params["endDate"], "trde_tp": params["tradeType"], "mrkt_tp": params["market"], "invsr_tp": params["investor"], "stex_tp": params["venue"]}


def _body_stock_investor_chart(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {"dt": params["date"], **_body_stock(params, code), "amt_qty_tp": params["amountQuantity"], "trde_tp": params["tradeType"], "unit_tp": params["quantityUnit"]}


def _body_stock_investor_total(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {**_body_stock(params, code), "strt_dt": params["startDate"], "end_dt": params["endDate"], "amt_qty_tp": params["amountQuantity"], "trde_tp": "0", "unit_tp": params["quantityUnit"]}


def _body_intraday_investor_rank(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "amt_qty_tp": "1", "invsr": params["investor"], "frgn_all": params["includeAllForeign"], "smtm_netprps_tp": params["includeInterim"], "stex_tp": params["venue"]}


def _body_intraday_investor_chart(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "amt_qty_tp": params["amountQuantity"], "trde_tp": params["tradeType"], **_body_stock(params, code)}


def _body_after_close_investor(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"mrkt_tp": params["market"], "amt_qty_tp": params["amountQuantity"], "trde_tp": params["tradeType"], "stex_tp": params["venue"]}


def _body_program_accumulated(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"date": params["date"], "amt_qty_tp": params["amountQuantity"], "mrkt_tp": params["market"], "stex_tp": params["venue"]}


def _body_stock_program_intraday(params: dict[str, Any], code: str | None) -> dict[str, str]:
    return {"amt_qty_tp": params["amountQuantity"], **_body_stock(params, code), "date": params["date"]}


def _body_program_daily_trend(params: dict[str, Any], _code: str | None) -> dict[str, str]:
    return {"date": params["date"], "amt_qty_tp": params["amountQuantity"], "mrkt_tp": params["marketCode"], "min_tic_tp": params["intervalType"], "stex_tp": params["venue"]}


_SPECS: dict[str, _Spec] = {
    "kr_tape": {"apiId": "ka10003", "path": "/api/dostk/stkinfo", "listKey": "cntr_infr", "parameters": _STOCK, "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _TAPE_FIELDS]), "fields": _TAPE_FIELDS, "body": _body_stock},
    "kr_brokers": {"apiId": "ka10002", "path": "/api/dostk/stkinfo", "mode": "broker", "parameters": _STOCK, "columns": _columns(("side", "구분", False, None), ("rank", "순위", True, None), ("broker", "거래원", False, None), ("brokerCode", "거래원코드", False, None), ("quantity", "거래량", True, "shares")), "body": _body_stock},
    "kr_foreign_holding": {"apiId": "ka10008", "path": "/api/dostk/frgnistt", "listKey": "stk_frgnr", "parameters": _STOCK, "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _FOREIGN_FIELDS]), "fields": _FOREIGN_FIELDS, "body": _body_stock},
    "kr_credit_trend": {"apiId": "ka10013", "path": "/api/dostk/stkinfo", "listKey": "crd_trde_trend", "parameters": [*_STOCK, _date("date", "기준일"), _select("queryType", "조회구분", "1", [("1", "융자"), ("2", "대주")])], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _CREDIT_FIELDS]), "fields": _CREDIT_FIELDS, "body": _body_credit},
    "kr_short_sale": {"apiId": "ka10014", "path": "/api/dostk/shsa", "listKey": "shrts_trnsn", "parameters": [*_STOCK, _select("timeType", "기간구분", "1", [("0", "시작일"), ("1", "기간")]), _date("startDate", "시작일"), _date("endDate", "종료일")], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _SHORT_FIELDS]), "fields": _SHORT_FIELDS, "body": _body_short},
    "kr_lending": {"apiId": "ka10068", "path": "/api/dostk/slb", "listKey": "dbrt_trde_trnsn", "parameters": [_date("startDate", "시작일"), _date("endDate", "종료일")], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _LENDING_FIELDS]), "fields": _LENDING_FIELDS, "body": _body_lending},
    "kr_program_rank": {"apiId": "ka90003", "path": "/api/dostk/stkinfo", "listKey": "prm_netprps_upper_50", "parameters": [_select("direction", "순위", "2", [("1", "순매도"), ("2", "순매수")]), _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _select("market", "시장", "P00101", [("P00101", "코스피"), ("P10102", "코스닥")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PROGRAM_RANK_FIELDS]), "fields": _PROGRAM_RANK_FIELDS, "body": _body_program_rank},
    "kr_program_stock": {"apiId": "ka90004", "path": "/api/dostk/stkinfo", "listKey": "stk_prm_trde_prst", "parameters": [_date("date", "일자"), _select("market", "시장", "P00101", [("P00101", "코스피"), ("P10102", "코스닥")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PROGRAM_STOCK_FIELDS]), "fields": _PROGRAM_STOCK_FIELDS, "body": _body_program_stock},
    "kr_program_intraday": {"apiId": "ka90005", "path": "/api/dostk/mrkcond", "listKey": "prm_trde_trnsn", "parameters": [_date("date", "일자"), _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _select("market", "시장", "P001", [("P001", "코스피"), ("P101", "코스닥")]), _select("intervalType", "시간단위", "1", [("0", "틱"), ("1", "분")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PROGRAM_INTRADAY_FIELDS]), "fields": _PROGRAM_INTRADAY_FIELDS, "body": _body_program_intraday},
    "kr_program_arbitrage_balance": {"apiId": "ka90006", "path": "/api/dostk/mrkcond", "listKey": "prm_trde_dfrt_remn_trnsn", "parameters": [_date("date", "일자"), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _ARBITRAGE_FIELDS]), "fields": _ARBITRAGE_FIELDS, "body": _body_program_balance},
    "kr_program_stock_daily": {"apiId": "ka90013", "path": "/api/dostk/mrkcond", "listKey": "stk_daly_prm_trde_trnsn", "parameters": [*_STOCK, _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _date("date", "일자")], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PROGRAM_DAILY_FIELDS]), "fields": _PROGRAM_DAILY_FIELDS, "body": _body_program_daily},
    "kr_theme_groups": {"apiId": "ka90001", "path": "/api/dostk/thme", "listKey": "thema_grp", "parameters": [_select("queryType", "검색구분", "0", [("0", "전체"), ("1", "테마"), ("2", "종목")]), _text("stockCode", "종목코드"), _number_parameter("days", "기간(일)", 1, 1, 99), _text("themeName", "테마명"), _select("sort", "정렬", "1", [("1", "기간수익률 상위"), ("2", "기간수익률 하위"), ("3", "등락률 상위"), ("4", "등락률 하위")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _THEME_FIELDS]), "fields": _THEME_FIELDS, "body": _body_theme_groups},
    "kr_theme_constituents": {"apiId": "ka90002", "path": "/api/dostk/thme", "listKey": "thema_comp_stk", "parameters": [_text("themeCode", "테마코드"), _number_parameter("days", "기간(일)", 1, 1, 99), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _THEME_CONSTITUENT_FIELDS]), "fields": _THEME_CONSTITUENT_FIELDS, "body": _body_theme_constituents, "required": ("themeCode",)},
    "kr_etf_returns": {"apiId": "ka40001", "path": "/api/dostk/etf", "listKey": "etfprft_rt_lst", "parameters": [*_STOCK, _text("indexCode", "ETF대상지수코드"), _select("period", "기간", "0", [("0", "1주"), ("1", "1개월"), ("2", "6개월"), ("3", "1년")])], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _ETF_RETURN_FIELDS]), "fields": _ETF_RETURN_FIELDS, "body": _body_etf_return, "required": ("indexCode",)},
    "kr_etf_info": {"apiId": "ka40002", "path": "/api/dostk/etf", "mode": "etfInfo", "parameters": _STOCK, "columns": _columns(("name", "종목명", False, None), ("targetIndex", "ETF대상지수명", False, None), ("underlyingPrice", "원주가격", True, "KRW"), ("etfTaxType", "ETF과세유형", False, None), ("etnTaxType", "ETN과세유형", False, None)), "body": _body_stock},
    "kr_etf_all_quotes": {"apiId": "ka40004", "path": "/api/dostk/etf", "listKey": "etfall_mrpr", "parameters": [_select("taxType", "과세유형", "0", [("0", "전체"), ("1", "비과세"), ("2", "보유기간과세"), ("3", "회사형"), ("4", "외국"), ("5", "비과세해외")]), _select("navComparison", "NAV대비", "0", [("0", "전체"), ("1", "NAV 상회"), ("2", "NAV 하회")]), _select("manager", "운용사", "0000", [("0000", "전체"), ("3020", "KODEX"), ("3027", "KOSEF"), ("3191", "TIGER"), ("3228", "KINDEX"), ("3023", "KStar"), ("3022", "아리랑"), ("9999", "기타")]), _select("taxed", "과세여부", "0", [("0", "전체"), ("1", "과세"), ("2", "비과세")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _ETF_ALL_FIELDS]), "fields": _ETF_ALL_FIELDS, "body": _body_etf_all},
    "kr_etf_nav": {"apiId": "ka40009", "path": "/api/dostk/etf", "listKey": "etfnavarray", "parameters": _STOCK, "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _ETF_NAV_FIELDS]), "fields": _ETF_NAV_FIELDS, "body": _body_stock},
    "kr_new_high_low": {"apiId": "ka10016", "path": "/api/dostk/stkinfo", "listKey": "ntl_pric", "parameters": [_select("market", "시장", "000", _MARKET), _select("direction", "신고가/신저가", "1", [("1", "신고가"), ("2", "신저가")]), _select("reference", "기준", "1", [("1", "고저기준"), ("2", "종가기준")]), _select("stockFilter", "종목조건", "0", _STOCK_FILTER_CORE), _select("minimumVolume", "최소거래량", "00000", _VOLUME_THRESHOLD_FIVE_DIGIT), _select("creditFilter", "신용조건", "0", _CREDIT_FILTER), _select("includeLimit", "상하한 포함", "0", [("0", "미포함"), ("1", "포함")]), _select("period", "기간", "250", [("5", "5일"), ("10", "10일"), ("20", "20일"), ("60", "60일"), ("250", "250일")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _NEW_HIGH_LOW_FIELDS]), "fields": _NEW_HIGH_LOW_FIELDS, "body": _body_new_high_low},
    "kr_high_low_proximity": {"apiId": "ka10018", "path": "/api/dostk/stkinfo", "listKey": "high_low_pric_alacc", "parameters": [_select("target", "대상", "1", [("1", "고가"), ("2", "저가")]), _select("proximity", "근접률", "05", [("05", "0.5%"), ("10", "1.0%"), ("15", "1.5%"), ("20", "2.0%"), ("25", "2.5%"), ("30", "3.0%")]), _select("market", "시장", "000", _MARKET), _select("minimumVolume", "최소거래량", "00000", _VOLUME_THRESHOLD_FIVE_DIGIT), _select("stockFilter", "종목조건", "0", _STOCK_FILTER_CORE), _select("creditFilter", "신용조건", "0", _CREDIT_FILTER), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _HIGH_LOW_PROXIMITY_FIELDS]), "fields": _HIGH_LOW_PROXIMITY_FIELDS, "body": _body_high_low_proximity},
    "kr_price_surge": {"apiId": "ka10019", "path": "/api/dostk/stkinfo", "listKey": "pric_jmpflu", "parameters": [_select("market", "시장", "000", _MARKET_WITH_KOSPI200), _select("direction", "방향", "1", [("1", "급등"), ("2", "급락")]), _select("timeType", "비교단위", "1", [("1", "분전"), ("2", "일전")]), _number_parameter("lookback", "비교 시점", 5), _select("minimumVolume", "최소거래량", "00000", _VOLUME_THRESHOLD_FIVE_DIGIT), _select("stockFilter", "종목조건", "0", _STOCK_FILTER_CORE), _select("creditFilter", "신용조건", "0", _CREDIT_FILTER), _select("priceFilter", "가격조건", "0", [("0", "전체조회"), ("1", "1천원 미만"), ("2", "1천원~2천원"), ("3", "2천원~3천원"), ("4", "5천원~1만원"), ("5", "1만원 이상"), ("8", "1천원 이상")]), _select("includeLimit", "상하한 포함", "0", [("0", "미포함"), ("1", "포함")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PRICE_SURGE_FIELDS]), "fields": _PRICE_SURGE_FIELDS, "body": _body_price_surge},
    "kr_orderbook_balance_rank": {"apiId": "ka10020", "path": "/api/dostk/rkinfo", "listKey": "bid_req_upper", "parameters": [_select("market", "시장", "001", _MARKET_KOSPI_KOSDAQ), _select("sort", "정렬", "1", [("1", "순매수잔량순"), ("2", "순매도잔량순"), ("3", "매수비율순"), ("4", "매도비율순")]), _select("minimumVolume", "최소거래량", "0000", _VOLUME_THRESHOLD_BOOK), _select("stockFilter", "종목조건", "0", _STOCK_FILTER_BOOK), _select("creditFilter", "신용조건", "0", _CREDIT_FILTER), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _ORDERBOOK_RANK_FIELDS]), "fields": _ORDERBOOK_RANK_FIELDS, "body": _body_orderbook_rank},
    "kr_volume_surge": {"apiId": "ka10023", "path": "/api/dostk/rkinfo", "listKey": "trde_qty_sdnin", "parameters": [_select("market", "시장", "000", _MARKET), _select("sort", "정렬", "1", [("1", "급증량"), ("2", "급증률"), ("3", "급감량"), ("4", "급감률")]), _select("timeType", "비교단위", "1", [("1", "분"), ("2", "전일")]), _number_parameter("lookback", "비교 분", 5), _select("minimumVolume", "최소거래량", "5", _VOLUME_THRESHOLD), _select("stockFilter", "종목조건", "0", _STOCK_FILTER_VOLUME_SURGE), _select("priceFilter", "가격조건", "0", [("0", "전체조회"), ("2", "5만원 이상"), ("5", "1만원 이상"), ("6", "5천원 이상"), ("8", "1천원 이상"), ("9", "10만원 이상")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _VOLUME_SURGE_FIELDS]), "fields": _VOLUME_SURGE_FIELDS, "body": _body_volume_surge},
    "kr_volume_renewal": {"apiId": "ka10024", "path": "/api/dostk/stkinfo", "listKey": "trde_qty_updt", "parameters": [_select("market", "시장", "000", _MARKET), _select("cycle", "갱신주기", "5", [("5", "5일"), ("10", "10일"), ("20", "20일"), ("60", "60일"), ("250", "250일")]), _select("minimumVolume", "최소거래량", "5", _VOLUME_THRESHOLD), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _VOLUME_RENEWAL_FIELDS]), "fields": _VOLUME_RENEWAL_FIELDS, "body": _body_volume_renewal},
    "kr_valuation_extremes": {"apiId": "ka10026", "path": "/api/dostk/stkinfo", "listKey": "high_low_per", "parameters": [_select("metric", "지표", "3", [("1", "저PBR"), ("2", "고PBR"), ("3", "저PER"), ("4", "고PER"), ("5", "저ROE"), ("6", "고ROE")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _VALUATION_FIELDS]), "fields": _VALUATION_FIELDS, "body": _body_valuation},
    "kr_credit_ratio_rank": {"apiId": "ka10033", "path": "/api/dostk/rkinfo", "listKey": "crd_rt_upper", "parameters": [_select("market", "시장", "000", _MARKET), _select("minimumVolume", "최소거래량", "0", [("0", "전체조회"), *_VOLUME_THRESHOLD[1:]]), _select("stockFilter", "종목조건", "0", _STOCK_FILTER_BOOK), _select("includeLimit", "상하한 포함", "0", [("0", "미포함"), ("1", "포함")]), _select("creditFilter", "신용조건", "0", _CREDIT_FILTER), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _CREDIT_RATIO_FIELDS]), "fields": _CREDIT_RATIO_FIELDS, "body": _body_credit_ratio},
    "kr_foreign_period_rank": {"apiId": "ka10034", "path": "/api/dostk/rkinfo", "listKey": "for_dt_trde_upper", "parameters": [_select("market", "시장", "000", _MARKET), _select("tradeType", "거래구분", "2", [("1", "순매도"), ("2", "순매수"), ("3", "순매매")]), _select("period", "기간", "0", [("0", "당일"), ("1", "전일"), ("5", "5일"), ("10", "10일"), ("20", "20일"), ("60", "60일")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _FOREIGN_PERIOD_FIELDS]), "fields": _FOREIGN_PERIOD_FIELDS, "body": _body_foreign_period},
    "kr_fundamentals": {"apiId": "ka10001", "path": "/api/dostk/stkinfo", "mode": "scalar", "parameters": _STOCK, "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _FUNDAMENTAL_FIELDS]), "fields": _FUNDAMENTAL_FIELDS, "body": _body_stock},
    "kr_ohlcv_flow": {"apiId": "ka10005", "path": "/api/dostk/mrkcond", "listKey": "stk_ddwkmm", "parameters": _STOCK, "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _OHLCV_FLOW_FIELDS]), "fields": _OHLCV_FLOW_FIELDS, "body": _body_stock},
    "kr_daily_trade_sessions": {"apiId": "ka10015", "path": "/api/dostk/stkinfo", "listKey": "daly_trde_dtl", "parameters": [*_STOCK, _date("startDate", "시작일")], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _DAILY_SESSION_FIELDS]), "fields": _DAILY_SESSION_FIELDS, "body": _body_stock_start},
    "kr_daily_price": {"apiId": "ka10086", "path": "/api/dostk/mrkcond", "listKey": "daly_stkpc", "parameters": [*_STOCK, _date("date", "기준일"), _select("indicatorType", "투자자 단위", "0", [("0", "수량"), ("1", "금액(백만원)")])], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _DAILY_PRICE_FIELDS]), "fields": _DAILY_PRICE_FIELDS, "body": _body_daily_price},
    "kr_vi_events": {"apiId": "ka10054", "path": "/api/dostk/stkinfo", "listKey": "motn_stk", "optionalList": True, "parameters": [_text("stockCode", "종목코드"), _select("market", "시장", "000", _MARKET), _select("session", "시장구분", "0", [("0", "전체"), ("1", "정규시장"), ("2", "시간외단일가")]), _select("viType", "VI구분", "0", [("0", "전체"), ("1", "정적VI"), ("2", "동적VI"), ("3", "동적VI+정적VI")]), _text("skipStock", "제외종목", "000000000"), _select("volumeFilter", "거래량 필터", "1", [("0", "사용안함"), ("1", "사용")]), _text("minimumVolume", "최소거래량", "0"), _text("maximumVolume", "최대거래량", "100000000"), _select("valueFilter", "거래대금 필터", "1", [("0", "사용안함"), ("1", "사용")]), _text("minimumValue", "최소거래대금", "0"), _text("maximumValue", "최대거래대금", "100000000"), _select("direction", "발동방향", "0", [("0", "전체"), ("1", "상승"), ("2", "하락")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _VI_FIELDS]), "fields": _VI_FIELDS, "body": _body_vi},
    "kr_institution_daily_rank": {"apiId": "ka10044", "path": "/api/dostk/mrkcond", "listKey": "daly_orgn_trde_stk", "parameters": [_date("startDate", "시작일"), _date("endDate", "종료일"), _select("tradeType", "거래구분", "2", [("1", "순매도"), ("2", "순매수")]), _select("market", "시장", "001", _MARKET_KOSPI_KOSDAQ), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _INSTITUTION_DAILY_RANK_FIELDS]), "fields": _INSTITUTION_DAILY_RANK_FIELDS, "body": _body_institution_daily},
    "kr_institution_stock_trend": {"apiId": "ka10045", "path": "/api/dostk/mrkcond", "listKey": "stk_orgn_trde_trnsn", "parameters": [*_STOCK, _date("startDate", "시작일"), _date("endDate", "종료일"), _select("institutionPriceType", "기관추정단가", "1", [("1", "매수단가"), ("2", "매도단가")]), _select("foreignPriceType", "외인추정단가", "1", [("1", "매수단가"), ("2", "매도단가")])], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _INSTITUTION_TREND_FIELDS]), "fields": _INSTITUTION_TREND_FIELDS, "body": _body_institution_trend},
    "kr_strength_intraday": {"apiId": "ka10046", "path": "/api/dostk/mrkcond", "listKey": "cntr_str_tm", "parameters": _STOCK, "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _STRENGTH_INTRADAY_FIELDS]), "fields": _STRENGTH_INTRADAY_FIELDS, "body": _body_stock},
    "kr_strength_daily": {"apiId": "ka10047", "path": "/api/dostk/mrkcond", "listKey": "cntr_str_daly", "parameters": _STOCK, "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _STRENGTH_DAILY_FIELDS]), "fields": _STRENGTH_DAILY_FIELDS, "body": _body_stock},
    "kr_investor_daily_rank": {"apiId": "ka10058", "path": "/api/dostk/stkinfo", "listKey": "invsr_daly_trde_stk", "parameters": [_date("startDate", "시작일"), _date("endDate", "종료일"), _select("tradeType", "거래구분", "2", [("1", "순매도"), ("2", "순매수")]), _select("market", "시장", "001", _MARKET_KOSPI_KOSDAQ), _select("investor", "투자자", "9000", [("8000", "개인"), ("9000", "외국인"), ("1000", "금융투자"), ("3000", "투신"), ("3100", "사모펀드"), ("5000", "기타금융"), ("4000", "은행"), ("2000", "보험"), ("6000", "연기금"), ("7000", "국가"), ("7100", "기타법인"), ("9999", "기관계")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _INVESTOR_DAILY_RANK_FIELDS]), "fields": _INVESTOR_DAILY_RANK_FIELDS, "body": _body_investor_daily_rank},
    "kr_investor_stock_chart": {"apiId": "ka10060", "path": "/api/dostk/chart", "listKey": "stk_invsr_orgn_chart", "parameters": [*_STOCK, _date("date", "기준일"), _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _select("tradeType", "거래구분", "0", [("0", "순매수"), ("1", "매수"), ("2", "매도")]), _select("quantityUnit", "수량단위", "1", [("1000", "천주"), ("1", "단주")])], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _INVESTOR_DATE_CHART_FIELDS]), "fields": _INVESTOR_DATE_CHART_FIELDS, "body": _body_stock_investor_chart},
    "kr_investor_stock_total": {"apiId": "ka10061", "path": "/api/dostk/stkinfo", "mode": "scalar", "parameters": [*_STOCK, _date("startDate", "시작일"), _date("endDate", "종료일"), _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _select("quantityUnit", "수량단위", "1", [("1000", "천주"), ("1", "단주")])], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _INVESTOR_DATE_CHART_FIELDS[1:]]), "fields": _INVESTOR_DATE_CHART_FIELDS[1:], "body": _body_stock_investor_total},
    "kr_intraday_investor_rank": {"apiId": "ka10063", "path": "/api/dostk/mrkcond", "listKey": "opmr_invsr_trde", "parameters": [_select("market", "시장", "000", _MARKET), _select("investor", "투자자", "6", [("6", "외국인"), ("7", "기관계"), ("1", "투신"), ("0", "보험"), ("2", "은행"), ("3", "연기금"), ("4", "국가"), ("5", "기타법인")]), _select("includeAllForeign", "외국인전체", "0", [("0", "미체크"), ("1", "체크")]), _select("includeInterim", "잠정순매수", "0", [("0", "미체크"), ("1", "체크")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _INTRADAY_INVESTOR_RANK_FIELDS]), "fields": _INTRADAY_INVESTOR_RANK_FIELDS, "body": _body_intraday_investor_rank},
    "kr_intraday_investor_chart": {"apiId": "ka10064", "path": "/api/dostk/chart", "listKey": "opmr_invsr_trde_chart", "parameters": [*_STOCK, _select("market", "시장", "000", _MARKET), _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _select("tradeType", "거래구분", "0", [("0", "순매수"), ("1", "매수"), ("2", "매도")])], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _INVESTOR_TIME_CHART_FIELDS]), "fields": _INVESTOR_TIME_CHART_FIELDS, "body": _body_intraday_investor_chart},
    "kr_after_close_investor": {"apiId": "ka10066", "path": "/api/dostk/mrkcond", "listKey": "opaf_invsr_trde", "parameters": [_select("market", "시장", "000", _MARKET), _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _select("tradeType", "거래구분", "0", [("0", "순매수"), ("1", "매수"), ("2", "매도")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _AFTER_CLOSE_INVESTOR_FIELDS]), "fields": _AFTER_CLOSE_INVESTOR_FIELDS, "body": _body_after_close_investor},
    "kr_program_accumulated": {"apiId": "ka90007", "path": "/api/dostk/mrkcond", "listKey": "prm_trde_acc_trnsn", "parameters": [_date("date", "종료일"), _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _select("market", "시장", "0", [("0", "코스피"), ("1", "코스닥")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PROGRAM_ACCUMULATED_FIELDS]), "fields": _PROGRAM_ACCUMULATED_FIELDS, "body": _body_program_accumulated},
    "kr_program_stock_intraday": {"apiId": "ka90008", "path": "/api/dostk/mrkcond", "listKey": "stk_tm_prm_trde_trnsn", "parameters": [*_STOCK, _select("amountQuantity", "금액/수량", "1", [("1", "금액"), ("2", "수량")]), _date("date", "기준일")], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PROGRAM_STOCK_INTRADAY_FIELDS]), "fields": _PROGRAM_STOCK_INTRADAY_FIELDS, "body": _body_stock_program_intraday},
    "kr_program_daily_trend": {"apiId": "ka90010", "path": "/api/dostk/mrkcond", "listKey": "prm_trde_trnsn", "parameters": [_date("date", "기준일"), _select("amountQuantity", "금액/수량", "1", [("1", "금액(백만원)"), ("2", "수량(천주)")]), _select("marketCode", "시장·거래소 코드", "P00101", [("P00101", "코스피 KRX"), ("P001_NX01", "코스피 NXT"), ("P10102", "코스닥 KRX"), ("P101_NX02", "코스닥 NXT")]), _select("intervalType", "시간단위", "1", [("0", "틱"), ("1", "분")]), _select("venue", "거래소", "1", _VENUE)], "columns": _columns(*[(a, c, d, e) for a, _b, c, d, e, _f in _PROGRAM_INTRADAY_FIELDS]), "fields": _PROGRAM_INTRADAY_FIELDS, "body": _body_program_daily_trend},
    "kr_minute_quote_raw": {"apiId": "ka10006", "path": "/api/dostk/mrkcond", "mode": "providerRaw", "parameters": _STOCK, "columns": _raw_columns(_MINUTE_QUOTE_RAW_FIELDS), "rawFields": _MINUTE_QUOTE_RAW_FIELDS, "body": _body_stock},
    "kr_price_profile_raw": {"apiId": "ka10007", "path": "/api/dostk/mrkcond", "mode": "providerRaw", "parameters": _STOCK, "columns": _raw_columns(_PRICE_PROFILE_RAW_FIELDS), "rawFields": _PRICE_PROFILE_RAW_FIELDS, "body": _body_stock},
    "kr_after_hours_book_raw": {"apiId": "ka10087", "path": "/api/dostk/mrkcond", "mode": "providerRaw", "parameters": _STOCK, "columns": _raw_columns(_AFTER_HOURS_BOOK_RAW_FIELDS), "rawFields": _AFTER_HOURS_BOOK_RAW_FIELDS, "body": _body_stock},
}

# The analysis route always passes its currently selected instrument.  Only
# symbol-specific APIs may use that identity as a request fallback; rankers
# must instead attach each returned row from the shared symbol index.
_INSTRUMENT_FEATURES = frozenset({
    "kr_tape", "kr_brokers", "kr_foreign_holding", "kr_credit_trend", "kr_short_sale",
    "kr_program_stock_daily", "kr_etf_returns", "kr_etf_info", "kr_etf_nav",
    "kr_fundamentals", "kr_ohlcv_flow", "kr_daily_trade_sessions", "kr_daily_price", "kr_vi_events",
    "kr_institution_stock_trend", "kr_strength_intraday", "kr_strength_daily", "kr_investor_stock_chart",
    "kr_investor_stock_total", "kr_intraday_investor_chart", "kr_program_stock_intraday",
    "kr_minute_quote_raw", "kr_price_profile_raw", "kr_after_hours_book_raw",
})

FEATURES: dict[str, FeatureMetadata] = {
    feature_id: {"featureId": feature_id, "title": title, "market": "KR", "description": description,
                 "parameters": copy.deepcopy(spec["parameters"]), "apiId": spec["apiId"], "path": spec["path"]}
    for feature_id, title, description, spec in (
        ("kr_tape", "체결정보", "종목별 체결 시세와 누적 거래 정보를 조회합니다.", _SPECS["kr_tape"]),
        ("kr_brokers", "주식 거래원", "종목별 매도·매수 거래원 상위 정보를 조회합니다.", _SPECS["kr_brokers"]),
        ("kr_foreign_holding", "외국인 종목별 동향", "외국인 보유·변동 시계열을 조회합니다.", _SPECS["kr_foreign_holding"]),
        ("kr_credit_trend", "신용매매동향", "융자 또는 대주 신용 동향을 조회합니다.", _SPECS["kr_credit_trend"]),
        ("kr_short_sale", "공매도추이", "선택 기간의 공매도 추이를 조회합니다.", _SPECS["kr_short_sale"]),
        ("kr_lending", "대차거래추이", "시장 전체 대차거래 추이를 조회합니다.", _SPECS["kr_lending"]),
        ("kr_program_rank", "프로그램 순매수 상위", "시장별 프로그램 순매수·순매도 상위를 조회합니다.", _SPECS["kr_program_rank"]),
        ("kr_program_stock", "종목별 프로그램 매매", "선택 시장의 종목별 프로그램 매매 현황을 조회합니다.", _SPECS["kr_program_stock"]),
        ("kr_program_intraday", "프로그램 매매 추이", "선택 일자의 시간대별 프로그램 매매를 조회합니다.", _SPECS["kr_program_intraday"]),
        ("kr_program_arbitrage_balance", "프로그램 차익잔고", "선택 일자의 프로그램 차익거래 잔고 추이를 조회합니다.", _SPECS["kr_program_arbitrage_balance"]),
        ("kr_program_stock_daily", "종목 일별 프로그램 매매", "종목별 일자 프로그램 매매 추이를 조회합니다.", _SPECS["kr_program_stock_daily"]),
        ("kr_theme_groups", "테마 그룹", "테마별 수익률·등락률 그룹을 조회합니다.", _SPECS["kr_theme_groups"]),
        ("kr_theme_constituents", "테마 구성종목", "테마 그룹의 구성종목을 조회합니다.", _SPECS["kr_theme_constituents"]),
        ("kr_etf_returns", "ETF 수익률", "ETF 대상지수 기준의 수익률과 수급을 조회합니다.", _SPECS["kr_etf_returns"]),
        ("kr_etf_info", "ETF 종목정보", "ETF 대상지수·원주가격·과세 정보를 조회합니다.", _SPECS["kr_etf_info"]),
        ("kr_etf_all_quotes", "ETF 전체시세", "선택된 과세·NAV·운용사 조건의 ETF 전체시세를 조회합니다.", _SPECS["kr_etf_all_quotes"]),
        ("kr_etf_nav", "ETF NAV", "ETF NAV 및 추적오차·괴리율 정보를 조회합니다.", _SPECS["kr_etf_nav"]),
        ("kr_new_high_low", "신고가·신저가", "기간과 조건을 적용한 신고가·신저가 종목을 조회합니다.", _SPECS["kr_new_high_low"]),
        ("kr_high_low_proximity", "고저가 근접", "선택한 고가 또는 저가에 근접한 종목을 조회합니다.", _SPECS["kr_high_low_proximity"]),
        ("kr_price_surge", "가격 급등락", "분전 또는 일전 기준 가격 급등·급락 종목을 조회합니다.", _SPECS["kr_price_surge"]),
        ("kr_orderbook_balance_rank", "호가잔량 상위", "순매수·순매도 잔량 또는 비율 상위 종목을 조회합니다.", _SPECS["kr_orderbook_balance_rank"]),
        ("kr_volume_surge", "거래량 급증", "분 또는 전일 기준 거래량 급증·급감 종목을 조회합니다.", _SPECS["kr_volume_surge"]),
        ("kr_volume_renewal", "거래량 갱신", "선택 주기 거래량을 갱신한 종목을 조회합니다.", _SPECS["kr_volume_renewal"]),
        ("kr_valuation_extremes", "고저 PER·PBR·ROE", "저·고 PBR, PER 또는 ROE 조건의 종목을 조회합니다.", _SPECS["kr_valuation_extremes"]),
        ("kr_credit_ratio_rank", "신용비율 상위", "신용비율 상위 종목을 조회합니다.", _SPECS["kr_credit_ratio_rank"]),
        ("kr_foreign_period_rank", "외국인 기간별 매매 상위", "외국인 기간별 순매수·순매도·순매매 상위를 조회합니다.", _SPECS["kr_foreign_period_rank"]),
        ("kr_fundamentals", "주식 기본정보", "종목의 기초·밸류에이션 지표와 기준 시세를 조회합니다.", _SPECS["kr_fundamentals"]),
        ("kr_ohlcv_flow", "주식 일주월 시세", "종목의 SDK 제공 일주월 시세·수급 시계열을 조회합니다.", _SPECS["kr_ohlcv_flow"]),
        ("kr_daily_trade_sessions", "일별 거래 상세", "장전·장중·장후 거래량을 포함한 일별 거래 상세를 조회합니다.", _SPECS["kr_daily_trade_sessions"]),
        ("kr_daily_price", "일별 주가", "기준일 이전의 일별 가격·투자자 지표를 조회합니다.", _SPECS["kr_daily_price"]),
        ("kr_vi_events", "VI 발동 종목", "조건에 맞는 변동성완화장치 발동 종목을 조회합니다.", _SPECS["kr_vi_events"]),
        ("kr_institution_daily_rank", "일별 기관 매매 종목", "기간 기관 순매수·순매도 종목을 조회합니다.", _SPECS["kr_institution_daily_rank"]),
        ("kr_institution_stock_trend", "종목별 기관 매매 추이", "종목별 기관·외인 매매 추이를 조회합니다.", _SPECS["kr_institution_stock_trend"]),
        ("kr_strength_intraday", "시간별 체결강도", "종목의 시간별 체결강도 추이를 조회합니다.", _SPECS["kr_strength_intraday"]),
        ("kr_strength_daily", "일별 체결강도", "종목의 일별 체결강도 추이를 조회합니다.", _SPECS["kr_strength_daily"]),
        ("kr_investor_daily_rank", "투자자별 일별 매매 종목", "투자자와 기간 기준 매매 종목을 조회합니다.", _SPECS["kr_investor_daily_rank"]),
        ("kr_investor_stock_chart", "종목별 투자자 차트", "종목별 투자자·기관 시계열을 조회합니다.", _SPECS["kr_investor_stock_chart"]),
        ("kr_investor_stock_total", "종목별 투자자 합계", "기간 종목별 투자자·기관 합계를 조회합니다.", _SPECS["kr_investor_stock_total"]),
        ("kr_intraday_investor_rank", "장중 투자자별 매매", "장중 투자자별 순매수 종목을 조회합니다.", _SPECS["kr_intraday_investor_rank"]),
        ("kr_intraday_investor_chart", "장중 투자자별 매매 차트", "종목별 장중 투자자 시계열을 조회합니다.", _SPECS["kr_intraday_investor_chart"]),
        ("kr_after_close_investor", "장마감후 투자자별 매매", "장마감 후 투자자별 종목 매매를 조회합니다.", _SPECS["kr_after_close_investor"]),
        ("kr_program_accumulated", "프로그램 매매 누적 추이", "종료일 기준 1년 범위의 프로그램 누적 추이를 조회합니다.", _SPECS["kr_program_accumulated"]),
        ("kr_program_stock_intraday", "종목 시간별 프로그램 매매", "종목별 시간대 프로그램 매매 추이를 조회합니다.", _SPECS["kr_program_stock_intraday"]),
        ("kr_program_daily_trend", "프로그램 매매 일자 추이", "SDK가 명시한 시장·거래소 코드 기준 프로그램 일자 추이를 조회합니다.", _SPECS["kr_program_daily_trend"]),
        ("kr_minute_quote_raw", "주식 시분 원문", "공급자 원문 시분 응답입니다. 단위와 기준시각을 해석하지 않습니다.", _SPECS["kr_minute_quote_raw"]),
        ("kr_price_profile_raw", "시세표성 정보 원문", "공급자 원문 시세·10단계 호가 응답입니다. 단위와 기준시각을 해석하지 않습니다.", _SPECS["kr_price_profile_raw"]),
        ("kr_after_hours_book_raw", "시간외 단일가 호가 원문", "공급자 원문 시간외 단일가 호가 응답입니다. 단위와 기준시각을 해석하지 않습니다.", _SPECS["kr_after_hours_book_raw"]),
    )
}

ALLOWED_CALLS: set[tuple[str, str]] = {(spec["apiId"], spec["path"]) for spec in _SPECS.values()}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _today() -> str:
    # A fixture's omitted date must not make its advertised deterministic data
    # vary with the machine clock.
    if not gateway.KIWOOM_ENABLED and str(gateway.ENVIRONMENT) == "fixture":
        return "20261024"
    return (datetime.now(timezone.utc) + timedelta(hours=9)).strftime("%Y%m%d")


def _parse_date(value: object) -> str:
    candidate = _today() if value in {None, "", "today"} else str(value).strip().replace("-", "")
    if not _DATE.fullmatch(candidate):
        raise gateway.BrokerError("date must be YYYYMMDD")
    try:
        datetime.strptime(candidate, "%Y%m%d")
    except ValueError as exc:
        raise gateway.BrokerError("date must be a calendar date") from exc
    return candidate


def _validate_params(spec: _Spec, params: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(params, dict):
        raise gateway.BrokerError("params must be an object")
    definitions = {str(item["key"]): item for item in spec["parameters"]}
    unknown = set(params).difference(definitions)
    if unknown:
        raise gateway.BrokerError("unsupported feature parameter")
    result: dict[str, Any] = {}
    for key, definition in definitions.items():
        value = params.get(key, definition["default"])
        kind = definition["type"]
        if kind == "date" and key not in params and not gateway.KIWOOM_ENABLED and str(gateway.ENVIRONMENT) == "fixture":
            value = "2026-10-24"
        if kind == "select":
            value = str(value)
            if value not in {str(option["value"]) for option in definition["options"]}:
                raise gateway.BrokerError(f"invalid {key}")
        elif kind == "date":
            value = _parse_date(value)
        elif kind == "number":
            if isinstance(value, bool) or not str(value).strip().isdigit():
                raise gateway.BrokerError(f"invalid {key}")
            value = int(value)
            minimum = definition.get("minimum")
            maximum = definition.get("maximum")
            if (minimum is not None and value < int(minimum)) or (maximum is not None and value > int(maximum)):
                raise gateway.BrokerError(f"invalid {key}")
        else:
            value = str(value or "").strip().upper() if key in {"stockCode", "indexCode", "themeCode"} else str(value or "").strip()
        result[key] = value
    if "stockCode" in result and result["stockCode"] and not _KR_CODE.fullmatch(result["stockCode"]):
        raise gateway.BrokerError("stockCode must be a six-character KRX code")
    if "themeCode" in result and result["themeCode"] and not _THEME_CODE.fullmatch(result["themeCode"]):
        raise gateway.BrokerError("themeCode is invalid")
    if "indexCode" in result and result["indexCode"] and not _ETF_INDEX.fullmatch(result["indexCode"]):
        raise gateway.BrokerError("indexCode is invalid")
    if "skipStock" in result and not _SKIP_STOCK.fullmatch(result["skipStock"]):
        raise gateway.BrokerError("skipStock must be a nine-bit include/exclude mask")
    for key in spec.get("required", ()):
        if not result.get(key):
            raise gateway.BrokerError(f"{key} is required")
    if spec.get("body") is _body_theme_groups and result["queryType"] == "2" and not result["stockCode"]:
        raise gateway.BrokerError("stockCode is required for stock theme search")
    if result.get("startDate") and result.get("endDate") and result["startDate"] > result["endDate"]:
        raise gateway.BrokerError("startDate must not be after endDate")
    if spec.get("body") is _body_vi:
        for enabled_key, minimum_key, maximum_key in (("volumeFilter", "minimumVolume", "maximumVolume"), ("valueFilter", "minimumValue", "maximumValue")):
            if result[enabled_key] != "1":
                continue
            minimum_text, maximum_text = result[minimum_key], result[maximum_key]
            if not minimum_text.isdigit() or not maximum_text.isdigit():
                raise gateway.BrokerError(f"{minimum_key} and {maximum_key} are required when the filter is enabled")
            if int(minimum_text) > 100000000 or int(maximum_text) > 100000000 or int(minimum_text) > int(maximum_text):
                raise gateway.BrokerError(f"invalid {minimum_key} or {maximum_key}")
    return result


def _instrument_code(params: dict[str, Any], instrument: dict[str, Any] | None) -> tuple[str | None, dict[str, Any] | None]:
    requested = str(params.get("stockCode") or "").strip().upper()
    if instrument is None:
        if not requested:
            return None, None
        identity = gateway._identity(market="KR", stk_cd=requested, stex_tp="KRX", listing_venue="KOSPI")
        return identity["stkCd"], identity
    if not isinstance(instrument, dict) or str(instrument.get("market") or "").upper() != "KR":
        raise gateway.BrokerError("instrument must be a KR instrument")
    identity = gateway._identity(market="KR", stk_cd=str(instrument.get("stkCd") or ""), stex_tp=instrument.get("stexTp"), listing_venue=instrument.get("listingVenue"))
    if requested and requested != identity["stkCd"]:
        raise gateway.BrokerError("stockCode does not match instrument")
    return identity["stkCd"], identity


def _number(value: object, conversion: str, *, source: str = "") -> float | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    try:
        parsed = float(Decimal(str(value).strip().replace(",", "")))
    except (InvalidOperation, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    # Kiwoom direction-prefixes the documented quote/NAV fields.  Those are
    # display magnitudes; comparison, rate, net-flow and quantity fields keep
    # their provider sign rather than being silently abs().
    return abs(parsed) if conversion == "actualPrice" or source in _PRICE_SOURCES else parsed


def _value(raw: dict[str, Any], source: str, numeric: bool, conversion: str) -> str | float | None:
    value = raw.get(source)
    if numeric:
        return _number(value, conversion, source=source)
    if value is None or str(value).strip() == "":
        return None
    if conversion == "date":
        try:
            return datetime.strptime(str(value).strip(), "%Y%m%d").strftime("%Y%m%d")
        except ValueError:
            return None
    return str(value).strip()


def _unparsed_numeric_raw(value: object, conversion: str, source: str) -> str | None:
    """Keep malformed provider numerics visible without inventing a meaning."""
    if value is None:
        return None
    text = str(value).strip()
    if text in {"", "-"} or _number(value, conversion, source=source) is not None:
        return None
    return text


def _attachment_index() -> dict[str, dict[str, Any]]:
    if not gateway.KIWOOM_ENABLED:
        return {}
    rows, _complete, _note = gateway._indexed("KR")
    return {str(row.get("stkCd") or "").upper(): row for row in rows if isinstance(row, dict) and row.get("market") == "KR" and _KR_CODE.fullmatch(str(row.get("stkCd") or "").upper())}


def _map_rows(feature_id: str, raw_rows: list[dict[str, Any]], fields: list[tuple[str, str, str, bool, str | None, str]], index: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], list[Column]]:
    result: list[dict[str, Any]] = []
    raw_columns: dict[str, Column] = {}
    for position, raw in enumerate(raw_rows, start=1):
        if not isinstance(raw, dict):
            continue
        row: dict[str, Any] = {}
        for key, source, label, numeric, _unit, conversion in fields:
            parsed = _value(raw, source, numeric, conversion)
            row[key] = parsed
            raw_value = _unparsed_numeric_raw(raw.get(source), conversion, source) if numeric and parsed is None else None
            if raw_value is not None:
                raw_key = f"{key}Raw" if len(key) <= 61 else "rawUnknown"
                row[raw_key] = raw_value
                raw_columns.setdefault(raw_key, {"key": raw_key, "label": f"{label} 원본(해석 불가)", "numeric": False})
        code = str(raw.get("stk_cd") or "").strip().upper()
        row["id"] = f"{feature_id}:{code or raw.get('dt') or raw.get('tm') or position}:{position}"
        if code in index:
            row["instrument"] = copy.deepcopy(index[code])
        result.append(row)
    for row in result:
        for raw_key in raw_columns:
            row.setdefault(raw_key, None)
    return result, list(raw_columns.values())


def _provider_raw_rows(feature_id: str, raw: dict[str, Any], fields: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """Expose scalar quote/book responses without parsing their ambiguous units."""
    if not any(source in raw for source, _label in fields):
        raise gateway.BrokerError("Kiwoom response omitted its scalar result fields")
    row: dict[str, Any] = {"id": f"{feature_id}:provider"}
    for source, _label in fields:
        value = raw.get(source)
        row[source] = None if value is None else str(value)
    return [row]


def _fetch_optional_rows(spec: _Spec, body: dict[str, str]) -> tuple[list[dict[str, Any]], bool, str]:
    """Read a paginated list whose documented root may be omitted when empty."""
    list_key = spec["listKey"]
    rows: list[dict[str, Any]] = []
    cont_yn: str | None = None
    next_key: str | None = None
    seen: set[str] = set()
    for page_number in range(5):
        response = gateway._fetch_page(spec["apiId"], spec["path"], body, cont_yn=cont_yn, next_key=next_key)
        payload = getattr(response, "body", None)
        if not isinstance(payload, dict):
            raise gateway.BrokerError("Kiwoom response body is invalid")
        page = payload.get(list_key)
        has_next, cont_yn, next_key = gateway._continuation(response)
        if page is None:
            if page_number == 0 and not has_next:
                return [], True, ""
            raise gateway.BrokerError("Kiwoom response omitted its continuation result list")
        if not isinstance(page, list):
            raise gateway.BrokerError("Kiwoom response returned an invalid result list")
        rows.extend(row for row in page if isinstance(row, dict))
        if not has_next:
            return rows, True, ""
        if not next_key:
            return rows, False, "continuation key missing"
        if next_key in seen:
            return rows, False, "continuation key repeated"
        seen.add(next_key)
        if not page:
            return rows, False, "continuation page empty"
    return rows, False, "pagination capped at 5 pages"


def _broker_rows(raw: dict[str, Any], feature_id: str) -> list[dict[str, Any]]:
    rows = []
    for rank in range(1, 6):
        for side, name_key, code_key, quantity_key in (("sell", f"sel_trde_ori_nm_{rank}", f"sel_trde_ori_{rank}", f"sel_trde_qty_{rank}"), ("buy", f"buy_trde_ori_nm_{rank}", f"buy_trde_ori_{rank}", f"buy_trde_qty_{rank}")):
            if not any(value is not None and str(value).strip() != "" for value in (raw.get(name_key), raw.get(code_key), raw.get(quantity_key))):
                continue
            rows.append({"id": f"{feature_id}:{side}:{rank}", "side": "매도" if side == "sell" else "매수", "rank": rank,
                         "broker": _value(raw, name_key, False, "text"), "brokerCode": _value(raw, code_key, False, "text"),
                         "quantity": _value(raw, quantity_key, True, "number")})
    return rows


def _etf_info_row(raw: dict[str, Any], feature_id: str, code: str | None) -> list[dict[str, Any]]:
    fields = [("name", "stk_nm", False, "text"), ("targetIndex", "etfobjt_idex_nm", False, "text"), ("underlyingPrice", "wonju_pric", True, "number"), ("etfTaxType", "etftxon_type", False, "text"), ("etnTaxType", "etntxon_type", False, "text")]
    row = {key: _value(raw, source, numeric, conversion) for key, source, numeric, conversion in fields}
    if not any(value is not None for value in row.values()):
        return []
    row["id"] = f"{feature_id}:{code or 'item'}"
    return [row]


def _fixture_raw(spec: _Spec, params: dict[str, Any], code: str | None) -> list[dict[str, Any]] | dict[str, Any]:
    if spec.get("mode") == "broker":
        return {"stk_cd": code or "005930", "sel_trde_ori_nm_1": "가상매도", "sel_trde_ori_1": "001", "sel_trde_qty_1": "1200", "buy_trde_ori_nm_1": "가상매수", "buy_trde_ori_1": "002", "buy_trde_qty_1": "-900"}
    if spec.get("mode") == "etfInfo":
        return {"stk_nm": "가상 ETF", "etfobjt_idex_nm": "가상지수", "wonju_pric": "10000", "etftxon_type": "가상", "etntxon_type": ""}
    if spec.get("mode") == "providerRaw":
        return {source: "-1" for source, _label in spec["rawFields"]}
    raw: dict[str, Any] = {"stk_cd": code or "005930", "stk_nm": "가상 종목", "dt": params.get("date") or params.get("startDate") or "20261024", "tm": "090001", "cntr_tm": "090001", "thema_grp_cd": params.get("themeCode") or "100", "thema_nm": "가상 테마"}
    for _key, source, _label, numeric, _unit, conversion in spec.get("fields", []):
        if source in raw:
            continue
        raw[source] = "71500" if conversion == "actualPrice" else ("1.25" if numeric else "가상")
    return [raw]


def _cache_get(key: tuple[str, str, str]) -> dict[str, Any] | None:
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached and time.monotonic() - cached[0] < _CACHE_TTL:
            return copy.deepcopy(cached[1])
    return None


def _cache_put(key: tuple[str, str, str], value: dict[str, Any]) -> dict[str, Any]:
    with _CACHE_LOCK:
        if key not in _CACHE and len(_CACHE) >= _CACHE_LIMIT:
            _CACHE.pop(min(_CACHE, key=lambda item: _CACHE[item][0]), None)
        _CACHE[key] = (time.monotonic(), copy.deepcopy(value))
    return copy.deepcopy(value)


def _response(feature_id: str, spec: _Spec, params: dict[str, Any], *, source: str, status: str, complete: bool, note: str, rows: list[dict[str, Any]], requested_instrument: dict[str, Any] | None = None, resolved_stock_code: str | None = None, extra_columns: list[Column] | None = None, value_unit: str | None = None) -> dict[str, Any]:
    scope: dict[str, Any] = {"parameters": copy.deepcopy(params)}
    if resolved_stock_code:
        scope["resolvedStockCode"] = resolved_stock_code
    if requested_instrument:
        scope["requestedInstrument"] = copy.deepcopy(requested_instrument)
    if value_unit:
        scope["valueUnit"] = value_unit
    return {"featureId": feature_id, "title": FEATURES[feature_id]["title"], "market": "KR", "source": source, "status": status,
            "receivedAt": _FIXTURE_RECEIVED_AT if source == "fixture" else _now(), "asOf": None, "note": note, "complete": complete,
            "parameters": copy.deepcopy(params), "scope": scope, "columns": [*copy.deepcopy(spec["columns"]), *copy.deepcopy(extra_columns or [])], "rows": rows}


def _attach_requested_instrument(rows: list[dict[str, Any]], code: str | None, index: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach only an indexed/verified instrument, never caller-supplied data."""
    if not code or code not in index:
        return rows
    attachment = copy.deepcopy(index[code])
    for row in rows:
        row.setdefault("instrument", copy.deepcopy(attachment))
    return rows


def _value_unit(feature_id: str, params: dict[str, Any]) -> str | None:
    if feature_id in {"kr_investor_stock_chart", "kr_investor_stock_total"}:
        if params["amountQuantity"] == "1":
            return "KRW millions"
        return "thousand shares" if params["quantityUnit"] == "1000" else "shares"
    if feature_id in {"kr_intraday_investor_chart", "kr_after_close_investor"}:
        return "KRW millions" if params["amountQuantity"] == "1" else "shares"
    if feature_id == "kr_program_accumulated":
        return "KRW millions" if params["amountQuantity"] == "1" else "thousand shares"
    return None


def get_feature(feature_id: str, params: dict[str, Any], *, instrument: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a normalized, bounded read-only Korean analysis feature.

    Invalid feature IDs and parameters are rejected before gateway/index/transport
    access. Provider failures return an ``error`` payload rather than raw broker
    text. Only the fixture environment receives deterministic fixture rows.
    """
    if feature_id not in FEATURES:
        raise gateway.BrokerError("unsupported KR analysis feature")
    spec = _SPECS[feature_id]
    selected = _validate_params(spec, params)
    code, identity = _instrument_code(selected, instrument if feature_id in _INSTRUMENT_FEATURES else None)
    body = spec["body"](selected, code)
    value_unit = _value_unit(feature_id, selected)
    key = (str(gateway.ENVIRONMENT), feature_id, json.dumps({"params": selected, "code": code}, sort_keys=True, ensure_ascii=False))
    if cached := _cache_get(key):
        return cached
    if not gateway.KIWOOM_ENABLED:
        if str(gateway.ENVIRONMENT) != "fixture":
            return _response(feature_id, spec, selected, source="kiwoom", status="error", complete=False, note="Kiwoom read is disabled outside fixture mode.", rows=[], requested_instrument=identity, resolved_stock_code=code, value_unit=value_unit)
        raw = _fixture_raw(spec, selected, code)
        if spec.get("mode") == "broker":
            rows = _broker_rows(raw if isinstance(raw, dict) else {}, feature_id)
        elif spec.get("mode") == "etfInfo":
            rows = _etf_info_row(raw if isinstance(raw, dict) else {}, feature_id, code)
        elif spec.get("mode") == "providerRaw":
            rows = _provider_raw_rows(feature_id, raw if isinstance(raw, dict) else {}, spec["rawFields"])
        else:
            rows, fixture_extra_columns = _map_rows(feature_id, raw if isinstance(raw, list) else [], spec["fields"], {})
            return _cache_put(key, _response(feature_id, spec, selected, source="fixture", status="fixture", complete=True, note="Deterministic fixture/test data; no broker request was made.", rows=rows, requested_instrument=identity, resolved_stock_code=code, extra_columns=fixture_extra_columns, value_unit=value_unit))
        return _cache_put(key, _response(feature_id, spec, selected, source="fixture", status="fixture", complete=True, note="Deterministic fixture/test data; no broker request was made.", rows=rows, requested_instrument=identity, resolved_stock_code=code, value_unit=value_unit))
    try:
        index = _attachment_index()
        extra_columns: list[Column] = []
        if spec.get("mode") in {"broker", "etfInfo", "scalar", "providerRaw"}:
            response = gateway._fetch_page(spec["apiId"], spec["path"], body)
            raw_body = getattr(response, "body", None)
            if not isinstance(raw_body, dict):
                raise gateway.BrokerError("Kiwoom response body is invalid")
            if spec.get("mode") == "broker":
                rows = _broker_rows(raw_body, feature_id)
            elif spec.get("mode") == "etfInfo":
                rows = _etf_info_row(raw_body, feature_id, code)
            elif spec.get("mode") == "providerRaw":
                rows = _provider_raw_rows(feature_id, raw_body, spec["rawFields"])
            else:
                rows, extra_columns = _map_rows(feature_id, [raw_body], spec["fields"], index)
            complete, provider_note = True, ""
        else:
            if spec.get("optionalList"):
                raw_rows, complete, provider_note = _fetch_optional_rows(spec, body)
            else:
                raw_rows, complete, provider_note = gateway._fetch_rows(spec["apiId"], spec["path"], body, spec["listKey"], max_pages=5)
            rows, extra_columns = _map_rows(feature_id, raw_rows, spec["fields"], index)
    except gateway.BrokerError as exc:
        note = gateway.read_failure_note(exc)
        if feature_id == "kr_after_hours_book_raw" and str(exc) == "Kiwoom response omitted its scalar result fields":
            note = "Kiwoom did not return the documented after-hours book."
        return _response(feature_id, spec, selected, source="kiwoom", status="error", complete=False, note=note, rows=[], requested_instrument=identity, resolved_stock_code=code, value_unit=value_unit)
    rows = _attach_requested_instrument(rows, code, index)
    status = "snapshot" if rows else "missing"
    unparsed = [column["label"] for column in extra_columns]
    note = provider_note or ("" if complete else "Provider pagination is incomplete.")
    if unparsed:
        note = "; ".join(part for part in (note, f"Provider numeric values left unparsed: {', '.join(unparsed)}.") if part)
    return _cache_put(key, _response(feature_id, spec, selected, source="kiwoom", status=status, complete=bool(complete), note=note, rows=rows, requested_instrument=identity, resolved_stock_code=code, extra_columns=extra_columns, value_unit=value_unit))


def _clear_caches_for_tests() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()
