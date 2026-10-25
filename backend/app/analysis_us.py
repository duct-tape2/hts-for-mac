"""Read-only adapters for documented Kiwoom US market-analysis endpoints.

This module intentionally has no HTTP client of its own.  Every live request
goes through ``kiwoom_gateway`` so allow-listing, credentials, pacing and
continuation handling remain in one place.  It exposes only public market
information; account, order and private-fill APIs are deliberately absent.
"""
from __future__ import annotations

import copy
import json
import math
import re
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock
from typing import Any

from app.config import ENVIRONMENT
from app import kiwoom_gateway as gateway


class InputError(ValueError):
    """A feature id or user-supplied parameter is outside this contract."""


class ProviderDataError(gateway.BrokerError):
    """A provider row contradicts the identity requested from a tape API."""


# Keep the public adapter's identity boundary byte-for-byte compatible with
# gateway._US_CODE: symbols start with a letter and are at most 15 characters.
_SYMBOL = re.compile(r"^[A-Z][A-Z0-9.]{0,14}$")
_INDUSTRY = re.compile(r"^[A-Z0-9_-]{0,20}$")
_DATE = re.compile(r"^\d{8}$")
_SIGNED_NUMBER = re.compile(r"^-?\d+(?:\.\d+)?$")
_MAX_PAGES = 5
_CACHE_TTL_SECONDS = 20
_CACHE_LIMIT = 128
_CACHE_LOCK = Lock()
_CACHE: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}

_VENUES = (
    {"value": "all", "label": "전체"},
    {"value": "nyse", "label": "NYSE"},
    {"value": "nasdaq", "label": "NASDAQ"},
    {"value": "amex", "label": "AMEX"},
)
_TAPE_VENUES = (
    {"value": "", "label": "종목 거래소 사용"},
    {"value": "NY", "label": "NYSE"},
    {"value": "ND", "label": "NASDAQ"},
    {"value": "NA", "label": "AMEX"},
)
_PRODUCTS = (
    {"value": "all", "label": "전체"},
    {"value": "stock", "label": "주식"},
)
_FILTERS = (
    {"value": "all", "label": "전체"},
    {"value": "gain100", "label": "100% 이상"},
    {"value": "gain50", "label": "50% 이상"},
)
_VOLUME_BANDS = tuple({"value": value, "label": label} for value, label in (
    ("0", "전체"), ("10", "10만주 이상"), ("15", "15만주 이상"),
    ("20", "20만주 이상"), ("30", "30만주 이상"), ("50", "50만주 이상"),
    ("100", "100만주 이상"), ("300", "300만주 이상"), ("500", "500만주 이상"),
))
_PRICE_BANDS = tuple({"value": value, "label": label} for value, label in (
    ("0", "전체"), ("1", "USD 5 미만"), ("2", "USD 10 미만"),
    ("3", "USD 10 이상"), ("4", "USD 10~20"), ("5", "USD 20~50"),
    ("6", "USD 50 이상"), ("7", "USD 50~100"), ("8", "USD 100 미만"),
    ("9", "USD 100 이상"), ("10", "USD 500 이상"),
))
_VALUE_BANDS = tuple({"value": value, "label": label} for value, label in (
    ("0", "전체"), ("1", "USD 1만 이상"), ("3", "USD 3만 이상"),
    ("5", "USD 5만 이상"), ("10", "USD 10만 이상"), ("30", "USD 30만 이상"),
    ("50", "USD 50만 이상"), ("100", "USD 100만 이상"), ("300", "USD 300만 이상"),
    ("500", "USD 500만 이상"), ("1000", "USD 1천만 이상"), ("3000", "USD 3천만 이상"),
    ("5000", "USD 5천만 이상"),
))


def _param(key: str, label: str, kind: str, default: str, options: tuple[dict[str, str], ...] | None = None, *, max_length: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"key": key, "label": label, "type": kind, "default": default}
    if options is not None:
        result["options"] = [dict(option) for option in options]
    if max_length is not None:
        result["maxLength"] = max_length
    return result


_TAPE_PARAMS = (
    _param("symbol", "종목코드", "text", ""),
    _param("exchange", "거래소", "select", "", _TAPE_VENUES),
)
_RANK_PARAMS = (
    _param("exchange", "거래소", "select", "all", _VENUES),
    _param("industry", "업종 코드", "text", ""),
    _param("product", "종목 구분", "select", "all", _PRODUCTS),
    _param("gainCondition", "상승 조건", "select", "all", _FILTERS),
    _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
    _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
    _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
)
_SURGE_PERIODS = (
    {"value": "5", "label": "5일"}, {"value": "10", "label": "10일"},
    {"value": "20", "label": "20일"}, {"value": "30", "label": "30일"},
)
_GAP_LEVELS = tuple({"value": value, "label": f"{value}% 이상"} for value in ("3", "5", "10", "50", "100", "150", "200"))
_CUSTOMER_RANK_TYPES = (
    {"value": "buy", "label": "매수 상위"}, {"value": "sell", "label": "매도 상위"},
    {"value": "netBuy", "label": "순매수 상위"}, {"value": "holding", "label": "보유잔고 상위"},
    {"value": "customers", "label": "보유고객 상위"}, {"value": "tradeRatio", "label": "거래비중 상위"},
    {"value": "tradeValue", "label": "거래대금 상위"},
)
_CUSTOMER_PERIODS = (
    {"value": "day", "label": "일"}, {"value": "week", "label": "주"},
    {"value": "month", "label": "월"}, {"value": "year", "label": "년"},
    {"value": "10m", "label": "10분"}, {"value": "30m", "label": "30분"},
    {"value": "60m", "label": "60분"}, {"value": "5m", "label": "5분"},
)
_DAILY_CHANGE_SORTS = (
    {"value": "riseRate", "label": "상승률"}, {"value": "riseAmount", "label": "상승폭"},
    {"value": "flat", "label": "보합"}, {"value": "fallRate", "label": "하락률"},
    {"value": "fallAmount", "label": "하락폭"},
)
_OPEN_SORTS = ({"value": "gainers", "label": "상승률"}, {"value": "losers", "label": "하락률"})
_CUMULATIVE_SORTS = (
    {"value": "riseRate", "label": "상승률"}, {"value": "riseAmount", "label": "상승폭"},
    {"value": "fallRate", "label": "하락률"}, {"value": "fallAmount", "label": "하락폭"},
)
_PREVIOUS_RANK_BY = ({"value": "volume", "label": "전일 거래량"}, {"value": "value", "label": "전일 거래대금"})
_INDEX_CLASSES = (
    {"value": "all", "label": "전체"}, {"value": "dow30", "label": "다우 30"},
    {"value": "nasdaq100", "label": "나스닥 100"}, {"value": "sp500", "label": "S&P 500"},
)
_WATCHLIST_PRODUCTS = (
    {"value": "all", "label": "전체"}, {"value": "stock", "label": "주식"}, {"value": "etf", "label": "ETF"},
)
_ETF_CATEGORY_PARAMS = (
    _param("etfCategory1", "ETF 대분류 코드", "text", ""),
    _param("etfCategory2", "ETF 중분류 코드", "text", ""),
)

# This is deliberately public metadata, rather than a proxy for arbitrary API
# ids or bodies.  API paths and fields were transcribed from the installed
# official SDK metadata on 2026-10-25; see ANALYSIS-US-CONTRACTS.md.
FEATURES: dict[str, dict[str, Any]] = {
    "usa20150": {
        "title": "미국주식 상세 체결내역", "market": "US",
        "description": "선택한 미국 종목의 공개 시장 체결 목록입니다.",
        "parameters": [dict(item) for item in _TAPE_PARAMS], "apiId": "usa20150", "path": "/api/us/mrkcond",
    },
    "usa20151": {
        "title": "미국주식 일별 체결내역", "market": "US",
        "description": "선택한 미국 종목의 공개 일별 가격·거래량 목록입니다.",
        "parameters": [*map(dict, _TAPE_PARAMS), _param("baseDate", "기준일 이전", "date", "")],
        "apiId": "usa20151", "path": "/api/us/mrkcond",
    },
    "usa01980": {
        "title": "미국주식 실시간 종목 조회 순위", "market": "US",
        "description": "조회 서비스 구간별 공개 종목 조회 순위입니다.",
        "parameters": [_param("interval", "집계 구간", "select", "1m", (
            {"value": "30s", "label": "30초"}, {"value": "1m", "label": "1분"},
            {"value": "10m", "label": "10분"}, {"value": "1h", "label": "1시간"},
            {"value": "day", "label": "당일"},
        ))], "apiId": "usa01980", "path": "/api/us/rkinfo",
    },
    "usa01990": {
        "title": "미국주식 관심종목 등록 상위", "market": "US",
        "description": "일·주·월 단위의 공개 관심종목 등록 순위입니다.",
        "parameters": [
            _param("period", "집계 단위", "select", "day", (
                {"value": "day", "label": "일"}, {"value": "week", "label": "주"}, {"value": "month", "label": "월"},
            )),
            _param("product", "종목 구분", "select", "all", (
                {"value": "all", "label": "전체"}, {"value": "stock", "label": "주식"}, {"value": "etf", "label": "ETF"},
            )),
        ], "apiId": "usa01990", "path": "/api/us/rkinfo",
    },
    "usa20510": {
        "title": "미국주식 기간별 등락률 상위", "market": "US",
        "description": "문서화된 조건으로 조회하는 미국 주식 기간별 등락률 순위입니다.",
        "parameters": [*map(dict, _RANK_PARAMS), _param("period", "기간", "select", "1", (
            {"value": "1", "label": "전일"}, {"value": "5", "label": "5일"},
            {"value": "10", "label": "10일"}, {"value": "30", "label": "30일"},
        ))], "apiId": "usa20510", "path": "/api/us/rkinfo",
    },
    "usa20530": {
        "title": "미국주식 당일 거래량 상위", "market": "US",
        "description": "거래량·거래대금·회전율 중 문서화된 순위 기준을 선택할 수 있습니다.",
        "parameters": [*map(dict, _RANK_PARAMS), _param("rankBy", "순위 기준", "select", "volume", (
            {"value": "volume", "label": "거래량"}, {"value": "value", "label": "거래대금"}, {"value": "turnover", "label": "거래회전율"},
        ))], "apiId": "usa20530", "path": "/api/us/rkinfo",
    },
    "usa20540": {
        "title": "미국주식 당일 거래대금 상위", "market": "US",
        "description": "문서화된 조건으로 조회하는 미국 주식 당일 거래대금 순위입니다.",
        "parameters": [*map(dict, _RANK_PARAMS)], "apiId": "usa20540", "path": "/api/us/rkinfo",
    },
    "usa20550": {
        "title": "미국주식 시가총액 상위", "market": "US",
        "description": "문서화된 조건으로 조회하는 미국 주식 시가총액 순위입니다.",
        "parameters": [*map(dict, _RANK_PARAMS)], "apiId": "usa20550", "path": "/api/us/rkinfo",
    },
    "usa23000": {
        "title": "미국주식 업종별 기간별 수익률", "market": "US",
        "description": "미국 업종의 1일·5일·1개월·3개월·6개월·YTD·1년 수익률입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES),
            _param("industry", "업종 코드", "text", "0"),
        ], "apiId": "usa23000", "path": "/api/us/sect",
    },
    "usa23100": {
        "title": "미국주식 업종별 등락률 상위/하위", "market": "US",
        "description": "선택한 업종 안에서 문서화된 상승·하락 정렬을 조회합니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES),
            _param("direction", "정렬", "select", "gainers", (
                {"value": "gainers", "label": "등락률 상위"}, {"value": "losers", "label": "등락률 하위"},
            )),
            _param("industry", "업종 코드", "text", "000"),
        ], "apiId": "usa23100", "path": "/api/us/sect",
    },
    "usa20520": {
        "title": "미국주식 거래량 급등락", "market": "US",
        "description": "문서화된 기간·가격·거래 조건으로 조회하는 미국 주식 거래량 급등락입니다.",
        "parameters": [*map(dict, _RANK_PARAMS), _param("period", "비교 기간", "select", "5", _SURGE_PERIODS)],
        "apiId": "usa20520", "path": "/api/us/stkinfo",
    },
    "usa24100": {
        "title": "미국주식 신고가/신저가", "market": "US",
        "description": "고가 또는 종가 기준의 문서화된 기간 신고가·신저가 목록입니다.",
        "parameters": [*map(dict, _RANK_PARAMS),
            _param("direction", "구분", "select", "newHigh", (
                {"value": "newHigh", "label": "신고가"}, {"value": "newLow", "label": "신저가"},
            )),
            _param("basis", "기준", "select", "highLow", (
                {"value": "highLow", "label": "고가/저가"}, {"value": "close", "label": "종가"},
            )),
            _param("periodDays", "기간(일)", "number", ""),
        ], "apiId": "usa24100", "path": "/api/us/stkinfo",
    },
    "usa24140": {
        "title": "미국주식 갭상승/갭하락", "market": "US",
        "description": "문서화된 갭 방향·정렬·최소 갭비율로 조회하는 미국 주식 목록입니다.",
        "parameters": [*map(dict, _RANK_PARAMS),
            _param("sort", "정렬 기준", "select", "gapRate", (
                {"value": "gapRate", "label": "갭비율"}, {"value": "change", "label": "전일대비"},
            )),
            _param("direction", "갭 방향", "select", "up", (
                {"value": "up", "label": "갭상승"}, {"value": "down", "label": "갭하락"},
            )),
            _param("minimumGap", "최소 갭비율", "select", "3", _GAP_LEVELS),
        ], "apiId": "usa24140", "path": "/api/us/stkinfo",
    },
    "usa20930": {
        "title": "미국주식 가격 급등락", "market": "US",
        "description": "분·일·지정 기간 기준의 문서화된 가격 급등·급락 목록입니다.",
        "parameters": [*map(dict, _RANK_PARAMS),
            _param("direction", "방향", "select", "surge", (
                {"value": "surge", "label": "급등"}, {"value": "drop", "label": "급락"},
            )),
            _param("comparisonType", "비교 기준", "select", "minutes", (
                {"value": "minutes", "label": "분 전"}, {"value": "days", "label": "일 전"}, {"value": "period", "label": "지정 기간"},
            )),
            _param("comparison", "비교 값", "number", "0"),
        ], "apiId": "usa20930", "path": "/api/us/stkinfo",
    },
    "usa24200": {
        "title": "미국주식 호가잔량 상위", "market": "US",
        "description": "순매수·순매도 잔량 또는 비율의 문서화된 순위입니다.",
        "parameters": [*map(dict, _RANK_PARAMS),
            _param("sort", "순위 기준", "select", "netBuyQuantity", (
                {"value": "netBuyQuantity", "label": "순매수잔량"}, {"value": "netSellQuantity", "label": "순매도잔량"},
                {"value": "netBuyRatio", "label": "순매수비율"}, {"value": "netSellRatio", "label": "순매도비율"},
            )),
        ], "apiId": "usa24200", "path": "/api/us/rkinfo",
    },
    "usa24300": {
        "title": "미국주식 리서치 목록", "market": "US",
        "description": "공식 응답에 포함된 미국주식 또는 글로벌 ETF 종목·시세 목록입니다; 보고서 본문은 제공되지 않습니다.",
        "parameters": [_param("product", "대상", "select", "stock", (
            {"value": "stock", "label": "미국주식"}, {"value": "globalEtf", "label": "글로벌 ETF"},
        ))], "apiId": "usa24300", "path": "/api/us/invtinfo",
    },
    "usa20880": {
        "title": "키움 거래 상위 종목(미국주식)", "market": "US",
        "description": "키움 고객 활동을 기준으로 한 미국주식 순위입니다. 전체 시장 순위가 아닙니다.",
        "parameters": [
            _param("rankType", "순위 구분", "select", "buy", _CUSTOMER_RANK_TYPES),
            _param("period", "집계 단위", "select", "day", _CUSTOMER_PERIODS),
        ], "apiId": "usa20880", "path": "/api/us/rkinfo",
    },
    "usa20881": {
        "title": "키움 거래 상위 종목(미국 ETF)", "market": "US",
        "description": "키움 고객 활동을 기준으로 한 미국 ETF 순위입니다. 전체 시장 순위가 아닙니다.",
        "parameters": [
            _param("rankType", "순위 구분", "select", "buy", _CUSTOMER_RANK_TYPES),
            _param("period", "집계 단위", "select", "day", _CUSTOMER_PERIODS),
        ], "apiId": "usa20881", "path": "/api/us/rkinfo",
    },
    "usa20910": {
        "title": "미국주식 전일대비 등락률 상위(주식/업종)", "market": "US",
        "description": "주식 또는 업종의 전일대비 등락률·등락폭·보합 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), _param("industry", "업종 코드", "text", ""),
            _param("indexClass", "대표지수 구분", "select", "all", _INDEX_CLASSES),
            _param("sort", "정렬", "select", "riseRate", _DAILY_CHANGE_SORTS),
            _param("product", "종목 구분", "select", "all", _PRODUCTS),
            _param("gainCondition", "상승 조건", "select", "all", _FILTERS),
            _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
            _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
            _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
        ], "apiId": "usa20910", "path": "/api/us/rkinfo",
    },
    "usa20911": {
        "title": "미국주식 전일대비 등락률 상위(ETF)", "market": "US",
        "description": "ETF 카테고리의 전일대비 등락률·등락폭·보합 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), *map(dict, _ETF_CATEGORY_PARAMS),
            _param("sort", "정렬", "select", "riseRate", _DAILY_CHANGE_SORTS),
            _param("gainCondition", "상승 조건", "select", "all", _FILTERS),
            _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
            _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
            _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
        ], "apiId": "usa20911", "path": "/api/us/rkinfo",
    },
    "usa20920": {
        "title": "미국주식 시가대비 등락률 상위(주식/업종)", "market": "US",
        "description": "주식 또는 업종의 시가대비 상승·하락률 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), _param("industry", "업종 코드", "text", ""),
            _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
            _param("product", "종목 구분", "select", "all", _PRODUCTS),
            _param("gainCondition", "상승 조건", "select", "all", _FILTERS),
            _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
            _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
            _param("sort", "정렬", "select", "gainers", _OPEN_SORTS),
        ], "apiId": "usa20920", "path": "/api/us/rkinfo",
    },
    "usa20921": {
        "title": "미국주식 시가대비 등락률 상위(ETF)", "market": "US",
        "description": "ETF 카테고리의 시가대비 상승·하락률 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), *map(dict, _ETF_CATEGORY_PARAMS),
            _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
            _param("gainCondition", "상승 조건", "select", "all", _FILTERS),
            _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
            _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
            _param("sort", "정렬", "select", "gainers", _OPEN_SORTS),
        ], "apiId": "usa20921", "path": "/api/us/rkinfo",
    },
    "usa20922": {
        "title": "미국주식 시가대비 등락률 상위(관심종목)", "market": "US",
        "description": "명시한 공개 관심종목 목록 안에서만 조회하는 시가대비 등락률 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES),
            _param("symbols", "관심 종목 (ND:AAPL, NY:IBM)", "text", "", max_length=2048),
            _param("sort", "정렬", "select", "gainers", _OPEN_SORTS),
            _param("product", "종목 구분", "select", "all", _WATCHLIST_PRODUCTS),
            _param("gainCondition", "상승 조건", "select", "all", _FILTERS),
            _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
            _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
            _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
        ], "apiId": "usa20922", "path": "/api/us/rkinfo",
    },
    "usa20940": {
        "title": "미국주식 누적 등락률 상위(주식/업종)", "market": "US",
        "description": "기준일과 누적 등락률 범위를 적용한 주식·업종 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), _param("industry", "업종 코드", "text", ""),
            _param("product", "종목 구분", "select", "all", _PRODUCTS),
            _param("sort", "정렬", "select", "riseRate", _CUMULATIVE_SORTS),
            _param("minimumCumulativePct", "최소 누적등락률", "text", "-100"),
            _param("maximumCumulativePct", "최대 누적등락률", "text", "100"),
            _param("baseDate", "기준일", "date", ""),
            _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
            _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
            _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
        ], "apiId": "usa20940", "path": "/api/us/rkinfo",
    },
    "usa20941": {
        "title": "미국주식 누적 등락률 상위(ETF)", "market": "US",
        "description": "기준일과 누적 등락률 범위를 적용한 ETF 카테고리 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), *map(dict, _ETF_CATEGORY_PARAMS),
            _param("sort", "정렬", "select", "riseRate", _CUMULATIVE_SORTS),
            _param("minimumCumulativePct", "최소 누적등락률", "text", "-100"),
            _param("maximumCumulativePct", "최대 누적등락률", "text", "100"),
            _param("baseDate", "기준일", "date", ""),
            _param("minVolume", "최소 거래량", "select", "0", _VOLUME_BANDS),
            _param("priceBand", "가격 조건", "select", "0", _PRICE_BANDS),
            _param("minTradingValue", "최소 거래대금", "select", "0", _VALUE_BANDS),
        ], "apiId": "usa20941", "path": "/api/us/rkinfo",
    },
    "usa20960": {
        "title": "미국주식 전일 거래 상위(주식/업종)", "market": "US",
        "description": "전일 거래량 또는 거래대금 기준의 주식·업종 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), _param("industry", "업종 코드", "text", ""),
            _param("product", "종목 구분", "select", "all", _PRODUCTS),
            _param("rankBy", "순위 기준", "select", "volume", _PREVIOUS_RANK_BY),
        ], "apiId": "usa20960", "path": "/api/us/rkinfo",
    },
    "usa20961": {
        "title": "미국주식 전일 거래 상위(ETF)", "market": "US",
        "description": "전일 거래량 또는 거래대금 기준의 ETF 카테고리 순위입니다.",
        "parameters": [
            _param("exchange", "거래소", "select", "all", _VENUES), *map(dict, _ETF_CATEGORY_PARAMS),
            _param("rankBy", "순위 기준", "select", "volume", _PREVIOUS_RANK_BY),
        ], "apiId": "usa20961", "path": "/api/us/rkinfo",
    },
    "usa26410": {
        "title": "미국주식 연도별 등락률(종목)", "market": "US",
        "description": "선택한 미국 종목의 연도별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다.",
        "parameters": [dict(item) for item in _TAPE_PARAMS], "apiId": "usa26410", "path": "/api/us/stkinfo",
    },
    "usa26411": {
        "title": "미국주식 연도별 업종별 종목등락률", "market": "US",
        "description": "선택 연도·업종의 종목별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다.",
        "parameters": [_param("industry", "업종 코드", "text", "000"), _param("searchYear", "조회 연도", "text", "2026")],
        "apiId": "usa26411", "path": "/api/us/stkinfo",
    },
    "usa26412": {
        "title": "미국주식 연도별 ETF 카테고리별 종목등락률", "market": "US",
        "description": "선택 연도·ETF 카테고리의 종목별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다.",
        "parameters": [*map(dict, _ETF_CATEGORY_PARAMS), _param("searchYear", "조회 연도", "text", "2026")],
        "apiId": "usa26412", "path": "/api/us/stkinfo",
    },
    "usa26413": {
        "title": "미국주식 연도별 등락률(업종)", "market": "US",
        "description": "선택 업종의 연도별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다.",
        "parameters": [_param("industry", "업종 코드", "text", "000")], "apiId": "usa26413", "path": "/api/us/stkinfo",
    },
    "usa26414": {
        "title": "미국주식 연도별 등락률(ETF)", "market": "US",
        "description": "선택 ETF 카테고리의 연도별 월 수익률 원값입니다. SDK가 월 수익률 단위를 명시하지 않았습니다.",
        "parameters": [*map(dict, _ETF_CATEGORY_PARAMS)], "apiId": "usa26414", "path": "/api/us/stkinfo",
    },
}

# Root merges this exact pair list into its transport policy.  The adapter
# itself cannot widen the gateway policy.
ALLOWED_CALLS = frozenset((feature["apiId"], feature["path"]) for feature in FEATURES.values())


_RANK_EXCHANGE = {"all": "0", "nyse": "1", "nasdaq": "2", "amex": "3"}
# Unlike the ranking endpoints above, the two sector endpoints assign 2=AMEX
# and 3=NASDAQ.  Provider row codes remain ND/NY/NA and are never sent back as
# numeric request values.
_SECTOR_EXCHANGE = {"all": "0", "nyse": "1", "amex": "2", "nasdaq": "3"}
_INTERVALS = {"30s": "B286", "1m": "B281", "10m": "B282", "1h": "B283", "day": "B284"}
_WATCH_PERIODS = {"day": "D", "week": "W", "month": "M"}
_WATCH_PRODUCTS = {"all": "A", "stock": "S", "etf": "E"}
_PRODUCT_CODES = {"all": "0", "stock": "1"}
_GAIN_CODES = {"all": "0", "gain100": "1", "gain50": "2"}
_RANK_BY = {"volume": "0", "value": "1", "turnover": "2"}
_US_LISTING = {"ND": "NASDAQ", "NY": "NYSE", "NA": "AMEX"}
_HIGH_LOW = {"newHigh": "1", "newLow": "2"}
_HIGH_LOW_BASIS = {"highLow": "1", "close": "2"}
_GAP_SORT = {"gapRate": "1", "change": "2"}
_GAP_DIRECTION = {"up": "1", "down": "2"}
_SURGE_DIRECTION = {"surge": "1", "drop": "2"}
_COMPARISON_TYPE = {"minutes": "1", "days": "2", "period": "3"}
_BOOK_SORT = {"netBuyQuantity": "1", "netSellQuantity": "2", "netBuyRatio": "3", "netSellRatio": "4"}
_RESEARCH_PRODUCT = {"stock": "0", "globalEtf": "1"}
_CUSTOMER_RANK_CODES = {"buy": "1", "sell": "2", "netBuy": "3", "holding": "4", "customers": "5", "tradeRatio": "6", "tradeValue": "7"}
_CUSTOMER_PERIOD_CODES = {"day": "1", "week": "2", "month": "3", "year": "4", "10m": "5", "30m": "6", "60m": "7", "5m": "8"}
_DAILY_CHANGE_SORT_CODES = {"riseRate": "1", "riseAmount": "2", "flat": "3", "fallRate": "4", "fallAmount": "5"}
_OPEN_SORT_CODES = {"gainers": "1", "losers": "2"}
_CUMULATIVE_SORT_CODES = {"riseRate": "0", "riseAmount": "1", "fallRate": "3", "fallAmount": "4"}
_INDEX_CLASS_CODES = {"all": "0", "dow30": "1", "nasdaq100": "2", "sp500": "3"}
_WATCHLIST_PRODUCT_CODES = {"all": "0", "stock": "1", "etf": "2"}
_PREVIOUS_RANK_CODES = {"volume": "0", "value": "1"}
_REQUEST_IDENTITY_FEATURES = frozenset({"usa20150", "usa20151", "usa26410"})
_CUSTOMER_SAMPLE_FEATURES = frozenset({"usa20880", "usa20881"})
_MONTH_RETURN_FEATURES = frozenset({"usa26410", "usa26411", "usa26412", "usa26413", "usa26414"})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _number(value: object, *, absolute: bool = False) -> float | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    try:
        number = float(Decimal(str(value).strip().replace(",", "")))
    except (InvalidOperation, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return abs(number) if absolute else number


def _signed(value: object, sign: object) -> float | None:
    number = _number(value)
    if number is None:
        return None
    marker = str(sign or "").strip()
    if marker == "+":
        return abs(number)
    if marker == "-":
        return -abs(number)
    if marker == "":
        return 0.0 if number == 0 else number
    return number


def _id(prefix: str, row: dict[str, Any], position: int) -> str:
    parts = (str(row.get(key) or "").strip() for key in ("rank", "stk_cd", "inds_cd", "dt", "cntr_tm"))
    meaningful = [part for part in parts if part]
    # Execution rows can legitimately share a provider time, so preserve the
    # bounded list position as the final discriminator rather than collapsing
    # rows in a keyed UI.
    return f"{prefix}:{':'.join(meaningful) if meaningful else 'row'}:{position}"


def _columns(*values: tuple[str, str, bool, str | None]) -> list[dict[str, Any]]:
    return [
        {"key": key, "label": label, "numeric": numeric, **({"unit": unit} if unit else {})}
        for key, label, numeric, unit in values
    ]


_STOCK_COLUMNS = _columns(
    ("rank", "순위", True, None), ("code", "종목코드", False, None), ("name", "종목명", False, None),
    ("exchange", "거래소", False, None), ("price", "현재가", True, "USD"),
    ("change", "전일대비", True, "USD"), ("changePct", "등락률", True, "%"),
)
_QUOTE_COLUMNS = _columns(
    ("code", "종목코드", False, None), ("name", "종목명", False, None),
    ("exchange", "거래소", False, None), ("price", "현재가", True, "USD"),
    ("change", "전일대비", True, "USD"), ("changePct", "등락률", True, "%"),
)
_TAPE_COLUMNS = _columns(
    ("time", "체결시각", False, None), ("price", "체결가", True, "USD"),
    ("change", "전일대비", True, "USD"), ("changePct", "등락률", True, "%"),
    ("quantity", "체결량", True, "shares"), ("changeSign", "전일대비 부호", False, None),
)
_DAILY_COLUMNS = _columns(
    ("date", "일자", False, None), ("price", "종가", True, "USD"), ("change", "전일대비", True, "USD"),
    ("changePct", "등락률", True, "%"), ("volume", "거래량", True, "shares"),
)
_MONTH_RETURN_COLUMNS = _columns(
    ("year", "연도", False, None), ("yearKind", "구분", False, None),
    ("janReturn", "1월 수익률", True, None), ("febReturn", "2월 수익률", True, None),
    ("marReturn", "3월 수익률", True, None), ("aprReturn", "4월 수익률", True, None),
    ("mayReturn", "5월 수익률", True, None), ("junReturn", "6월 수익률", True, None),
    ("julReturn", "7월 수익률", True, None), ("augReturn", "8월 수익률", True, None),
    ("sepReturn", "9월 수익률", True, None), ("octReturn", "10월 수익률", True, None),
    ("novReturn", "11월 수익률", True, None), ("decReturn", "12월 수익률", True, None),
)


def _feature_columns(feature_id: str) -> list[dict[str, Any]]:
    if feature_id in _CUSTOMER_SAMPLE_FEATURES:
        return _columns(
            ("rank", "키움 순위", True, None), ("rankMovementCode", "순위변화 상태", False, None),
            ("rankMovement", "순위변화폭", True, None), ("code", "종목코드", False, None),
            ("name", "종목명", False, None), ("exchange", "거래소", False, None),
            ("price", "현재가", True, "USD"), ("changePct", "등락률", True, "%"),
        )
    if feature_id == "usa20150":
        return copy.deepcopy(_TAPE_COLUMNS)
    if feature_id == "usa20151":
        return copy.deepcopy(_DAILY_COLUMNS)
    if feature_id == "usa01980":
        return _columns(
            ("rank", "순위", True, None), ("code", "종목코드", False, None), ("name", "종목명", False, None),
            ("exchange", "거래소", False, None), ("price", "현재가", True, "USD"),
            ("rankChange", "순위변화", True, None), ("referenceChangePct", "기준가대비 등락률", True, "%"),
            ("previousChangePct", "직전기준대비 등락률", True, "%"),
        )
    if feature_id == "usa01990":
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(("rankMovement", "순위변화", True, None), ("rankMovementCode", "순위변화 상태", False, None))
    if feature_id == "usa20510":
        return _columns(
            ("rank", "순위", True, None), ("code", "종목코드", False, None), ("name", "종목명", False, None),
            ("exchange", "거래소", False, None), ("startPrice", "시작 기준가", True, "USD"),
            ("endPrice", "종료 기준가", True, "USD"), ("change", "전일대비", True, "USD"),
            ("returnPct", "기간 등락률", True, "%"), ("startVolume", "시작 거래량", True, "shares"),
            ("endVolume", "종료 거래량", True, "shares"),
        )
    if feature_id == "usa20530":
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("volume", "거래량", True, "shares"), ("previousVolumePct", "전일 거래량 대비", True, "%"),
            ("tradingValue", "거래대금", True, "thousand USD"),
        )
    if feature_id == "usa20540":
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("volume", "거래량", True, "shares"), ("tradingValue", "거래대금", True, "thousand USD"),
        )
    if feature_id == "usa20550":
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("marketCap", "시가총액", True, "thousand USD"), ("marketCapWeight", "시가총액비", True, None),
            ("volume", "거래량", True, "shares"),
        )
    if feature_id == "usa23000":
        return _columns(
            ("industryCode", "업종코드", False, None), ("industry", "업종명", False, None),
            # The provider calls these returns but its SDK field descriptions
            # do not state a unit.  Do not silently assert a percentage unit.
            ("return1d", "1일 수익률", True, None), ("return5d", "5일 수익률", True, None),
            ("return1m", "1개월 수익률", True, None), ("return3m", "3개월 수익률", True, None),
            ("return6m", "6개월 수익률", True, None), ("returnYtd", "YTD 수익률", True, None),
            ("return1y", "1년 수익률", True, None),
        )
    if feature_id == "usa23100":
        return copy.deepcopy(_QUOTE_COLUMNS) + _columns(
            ("volume", "거래량", True, "shares"), ("ask", "매도호가", True, "USD"),
            ("bid", "매수호가", True, "USD"), ("open", "시가", True, "USD"),
            ("high", "고가", True, "USD"), ("low", "저가", True, "USD"), ("time", "시간", False, None),
        )
    if feature_id == "usa20520":
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("volume", "거래량", True, "shares"), ("volumeSurgePct", "거래량 급등락률", True, "%"),
            ("ask", "매도호가", True, "USD"), ("bid", "매수호가", True, "USD"),
        )
    if feature_id == "usa24100":
        return copy.deepcopy(_QUOTE_COLUMNS) + _columns(
            ("volume", "거래량", True, "shares"), ("previousVolumePct", "전일 거래량 대비", True, "%"),
            ("ask", "매도호가", True, "USD"), ("bid", "매수호가", True, "USD"),
            ("high", "고가", True, "USD"), ("low", "저가", True, "USD"),
        )
    if feature_id == "usa24140":
        return copy.deepcopy(_QUOTE_COLUMNS) + _columns(
            ("volume", "거래량", True, "shares"), ("open", "시가", True, "USD"),
            ("baseClose", "기준 종가", True, "USD"), ("gapPct", "갭비율", True, "%"),
        )
    if feature_id == "usa20930":
        return copy.deepcopy(_QUOTE_COLUMNS) + _columns(
            ("basePrice", "기준가", True, "USD"), ("baseDifference", "기준가 대비", True, "USD"),
            ("volume", "거래량", True, "shares"), ("volumeSurgeValue", "거래량 급등락 값", True, None),
        )
    if feature_id == "usa24200":
        return _columns(
            ("rank", "순위", True, None), ("code", "종목코드", False, None), ("name", "종목명", False, None),
            ("exchange", "거래소", False, None), ("price", "현재가", True, "USD"),
            ("change", "전일대비", True, "USD"), ("volume", "거래량", True, "shares"),
            ("totalAskQuantity", "총 매도잔량", True, "shares"), ("totalBidQuantity", "총 매수잔량", True, "shares"),
            ("netBuyQuantity", "순매수잔량", True, "shares"), ("netBuyRatio", "순매수비율", True, None),
            ("netSellQuantity", "순매도잔량", True, "shares"), ("netSellRatio", "순매도비율", True, None),
            ("time", "시간", False, None),
        )
    if feature_id == "usa24300":
        return copy.deepcopy(_QUOTE_COLUMNS) + _columns(("volume", "거래량", True, "shares"),)
    if feature_id in {"usa20910", "usa20911"}:
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("askQuantity", "매도잔량", True, "shares"), ("bidQuantity", "매수잔량", True, "shares"),
            ("tradeQuantity", "체결량", True, "shares"), ("providerCount", "제공 건수", True, None),
        )
    if feature_id in {"usa20920", "usa20921", "usa20922"}:
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("high", "고가", True, "USD"), ("low", "저가", True, "USD"),
            ("openChangePct", "시가대비 등락률", True, "%"), ("volume", "거래량", True, "shares"),
            ("time", "시간", False, None), ("open", "시가", True, "USD"),
        )
    if feature_id in {"usa20940", "usa20941"}:
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("volume", "거래량", True, "shares"), ("highestPrice", "기간 고가", True, "USD"),
            ("highestDate", "기간 고가일", False, None), ("lowestPrice", "기간 저가", True, "USD"),
            ("lowestDate", "기간 저가일", False, None), ("cumulativeChangePct", "누적 등락률", True, "%"),
            ("cumulativeChange", "누적 등락액", True, "USD"),
        )
    if feature_id in {"usa20960", "usa20961"}:
        return copy.deepcopy(_STOCK_COLUMNS) + _columns(
            ("previousTradeRate", "전일 거래비율", True, "%"), ("volume", "거래량", True, "shares"),
        )
    if feature_id == "usa26410":
        return copy.deepcopy(_MONTH_RETURN_COLUMNS)
    if feature_id in {"usa26411", "usa26412"}:
        return _columns(("code", "종목코드", False, None), ("name", "종목명", False, None), ("exchange", "거래소", False, None)) + [
            column for column in copy.deepcopy(_MONTH_RETURN_COLUMNS) if column["key"] not in {"year", "yearKind"}
        ]
    if feature_id in {"usa26413", "usa26414"}:
        return copy.deepcopy(_MONTH_RETURN_COLUMNS)
    return copy.deepcopy(_QUOTE_COLUMNS) + _columns(
        ("volume", "거래량", True, "shares"), ("ask", "매도호가", True, "USD"),
        ("bid", "매수호가", True, "USD"), ("open", "시가", True, "USD"),
        ("high", "고가", True, "USD"), ("low", "저가", True, "USD"), ("time", "시간", False, None),
    )


def _normalise_watchlist(value: str) -> str:
    """Canonicalise simple public watchlist input to the documented JSON body."""
    source = value.strip()
    if source.startswith("["):
        try:
            entries = json.loads(source)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise InputError("symbols JSON list is invalid") from exc
        if not isinstance(entries, list):
            raise InputError("symbols must be a list")
    else:
        parts = [part.strip() for part in source.split(",")]
        if not source or any(not part or part.count(":") != 1 for part in parts):
            raise InputError("symbols must use ND:AAPL, NY:IBM format")
        entries = []
        for part in parts:
            venue, code = (piece.strip() for piece in part.split(":"))
            entries.append({"stex_tp": venue, "stk_cd": code})
    if not 1 <= len(entries) <= 20:
        raise InputError("symbols must contain 1 to 20 entries")
    normalised: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"stex_tp", "stk_cd"}:
            raise InputError("symbols entries must contain only stex_tp and stk_cd")
        venue = str(entry["stex_tp"] or "").strip().upper()
        code = str(entry["stk_cd"] or "").strip().upper()
        if venue not in {"ND", "NY", "NA"} or not _SYMBOL.fullmatch(code):
            raise InputError("symbols contains an invalid US venue or symbol")
        if (venue, code) not in seen:
            normalised.append({"stex_tp": venue, "stk_cd": code})
            seen.add((venue, code))
    if not normalised:
        raise InputError("symbols must contain at least one unique entry")
    return json.dumps(normalised, separators=(",", ":"))


def _normalise(feature_id: str, params: dict[str, Any]) -> dict[str, str]:
    if not isinstance(params, dict):
        raise InputError("params must be an object")
    feature = FEATURES[feature_id]
    definitions = {item["key"]: item for item in feature["parameters"]}
    unknown = set(params).difference(definitions)
    if unknown:
        raise InputError("unsupported parameter")
    result: dict[str, str] = {}
    for key, definition in definitions.items():
        value = params.get(key, definition["default"])
        if value is None:
            value = definition["default"]
        text = str(value).strip()
        if definition["type"] == "select":
            allowed = {option["value"] for option in definition.get("options", [])}
            if text not in allowed:
                raise InputError(f"unsupported {key}")
        elif definition["type"] == "date":
            text = text.replace("-", "")
            if text and not _DATE.fullmatch(text):
                raise InputError(f"invalid {key}")
            if text:
                try:
                    datetime.strptime(text, "%Y%m%d")
                except ValueError as exc:
                    raise InputError(f"invalid {key}") from exc
        elif definition["type"] == "number":
            if text and not text.isdecimal():
                raise InputError(f"invalid {key}")
        elif key == "symbol":
            text = text.upper()
            if text and not _SYMBOL.fullmatch(text):
                raise InputError("invalid symbol")
        elif key in {"industry", "etfCategory1", "etfCategory2"} and not _INDUSTRY.fullmatch(text):
            raise InputError(f"invalid {key}")
        result[key] = text
    if feature_id == "usa24100" and result["periodDays"] and not 1 <= int(result["periodDays"]) <= 250:
        raise InputError("periodDays must be between 1 and 250")
    if feature_id == "usa20930":
        value = int(result["comparison"])
        if result["comparisonType"] in {"minutes", "days"} and not 0 <= value <= 30:
            raise InputError("comparison must be between 0 and 30")
        if result["comparisonType"] == "period" and not 1 <= value <= 9:
            raise InputError("comparison must be between 1 and 9 for period")
    if feature_id in {"usa20940", "usa20941"}:
        lower, upper = result["minimumCumulativePct"], result["maximumCumulativePct"]
        if not _SIGNED_NUMBER.fullmatch(lower) or not _SIGNED_NUMBER.fullmatch(upper):
            raise InputError("cumulative percentage bounds must be decimal numbers")
        if Decimal(lower) > Decimal(upper):
            raise InputError("minimumCumulativePct must not exceed maximumCumulativePct")
    if feature_id in {"usa26411", "usa26412"} and not re.fullmatch(r"\d{4}", result["searchYear"]):
        raise InputError("searchYear must be YYYY")
    if feature_id == "usa20922":
        result["symbols"] = _normalise_watchlist(result["symbols"])
    if feature_id in _CUSTOMER_SAMPLE_FEATURES and result["rankType"] in {"tradeRatio", "tradeValue"} and result["period"] not in {"10m", "30m", "60m", "5m"}:
        raise InputError("tradeRatio and tradeValue require a minute period")
    return result


def _instrument_identity(instrument: dict[str, Any] | None) -> tuple[str | None, str | None]:
    if instrument is None:
        return None, None
    if not isinstance(instrument, dict) or str(instrument.get("market") or "").upper() != "US":
        raise InputError("instrument must be a US instrument")
    code = str(instrument.get("stkCd") or "").strip().upper()
    venue = str(instrument.get("stexTp") or "").strip().upper()
    if not _SYMBOL.fullmatch(code) or venue not in {"ND", "NY", "NA"}:
        raise InputError("instrument lacks a verified US symbol and venue")
    return code, venue


def _tape_body(feature_id: str, normalized: dict[str, str], instrument: dict[str, Any] | None) -> dict[str, str]:
    instrument_code, instrument_venue = _instrument_identity(instrument)
    symbol = normalized["symbol"] or instrument_code
    venue = normalized["exchange"] or instrument_venue
    if not symbol or not venue:
        raise InputError("symbol and exchange are required for this feature")
    if instrument_code and symbol != instrument_code:
        raise InputError("symbol does not match verified instrument")
    if instrument_venue and normalized["exchange"] and venue != instrument_venue:
        raise InputError("exchange does not match verified instrument")
    body = {"stex_tp": venue, "stk_cd": symbol}
    if feature_id == "usa20151":
        body["base_dt"] = normalized["baseDate"]
    return body


def _rank_filters(normalized: dict[str, str]) -> dict[str, str]:
    return {
        "stex_tp": _RANK_EXCHANGE[normalized["exchange"]],
        "inds_cd": normalized["industry"],
        "stk_tp": _PRODUCT_CODES[normalized["product"]],
        "trde_qty_tp": normalized["minVolume"],
        "stk_cnd": _GAIN_CODES[normalized["gainCondition"]],
        "pric_cnd": normalized["priceBand"],
        "trde_prica_cnd": normalized["minTradingValue"],
    }


def _rank_body(feature_id: str, normalized: dict[str, str]) -> dict[str, str]:
    body = _rank_filters(normalized)
    if feature_id == "usa20510":
        body["tm"] = normalized["period"]
    elif feature_id == "usa20530":
        # Contract order matters to reviewers less than the actual numeric enum:
        # 0=volume, 1=value, 2=turnover.
        body = {
            "stex_tp": body["stex_tp"], "inds_cd": body["inds_cd"], "stk_tp": body["stk_tp"],
            "trde_qty_tp": body["trde_qty_tp"], "qry_tp": _RANK_BY[normalized["rankBy"]],
            "stk_cnd": body["stk_cnd"], "pric_cnd": body["pric_cnd"], "trde_prica_cnd": body["trde_prica_cnd"],
        }
    return body


def _daily_change_body(feature_id: str, normalized: dict[str, str]) -> dict[str, str]:
    if feature_id == "usa20910":
        return {
            "stex_tp": _RANK_EXCHANGE[normalized["exchange"]], "inds_cd": normalized["industry"],
            "inds_cls_tp": _INDEX_CLASS_CODES[normalized["indexClass"]],
            "sort_tp": _DAILY_CHANGE_SORT_CODES[normalized["sort"]], "stk_tp": _PRODUCT_CODES[normalized["product"]],
            "stk_cnd": _GAIN_CODES[normalized["gainCondition"]], "pric_cnd": normalized["priceBand"],
            "trde_prica_cnd": normalized["minTradingValue"], "trde_qty_tp": normalized["minVolume"],
        }
    return {
        "stex_tp": _RANK_EXCHANGE[normalized["exchange"]], "etf_cat1": normalized["etfCategory1"],
        "etf_cat2": normalized["etfCategory2"], "sort_tp": _DAILY_CHANGE_SORT_CODES[normalized["sort"]],
        "stk_cnd": _GAIN_CODES[normalized["gainCondition"]], "pric_cnd": normalized["priceBand"],
        "trde_prica_cnd": normalized["minTradingValue"], "trde_qty_tp": normalized["minVolume"],
    }


def _open_rank_body(feature_id: str, normalized: dict[str, str]) -> dict[str, str]:
    body = {"stex_tp": _RANK_EXCHANGE[normalized["exchange"]]}
    if feature_id == "usa20920":
        body.update({"inds_cd": normalized["industry"], "trde_qty_tp": normalized["minVolume"], "stk_tp": _PRODUCT_CODES[normalized["product"]]})
    elif feature_id == "usa20921":
        body.update({"etf_cat1": normalized["etfCategory1"], "etf_cat2": normalized["etfCategory2"], "trde_qty_tp": normalized["minVolume"]})
    else:
        body.update({"stk_cd": normalized["symbols"], "sort_tp": _OPEN_SORT_CODES[normalized["sort"]], "stk_tp": _WATCHLIST_PRODUCT_CODES[normalized["product"]]})
    if feature_id != "usa20922":
        body["stk_cnd"] = _GAIN_CODES[normalized["gainCondition"]]
        body["pric_cnd"] = normalized["priceBand"]
        body["trde_prica_cnd"] = normalized["minTradingValue"]
        body["sort_tp"] = _OPEN_SORT_CODES[normalized["sort"]]
        return body
    body.update({
        "stk_cnd": _GAIN_CODES[normalized["gainCondition"]], "pric_cnd": normalized["priceBand"],
        "trde_prica_cnd": normalized["minTradingValue"], "trde_qty_tp": normalized["minVolume"],
    })
    return body


def _cumulative_body(feature_id: str, normalized: dict[str, str]) -> dict[str, str]:
    body = {"stex_tp": _SECTOR_EXCHANGE[normalized["exchange"]]}
    if feature_id == "usa20940":
        body.update({"inds_cd": normalized["industry"], "stk_tp": _PRODUCT_CODES[normalized["product"]]})
    else:
        body.update({"etf_cat1": normalized["etfCategory1"], "etf_cat2": normalized["etfCategory2"]})
    body.update({
        "sort_tp": _CUMULATIVE_SORT_CODES[normalized["sort"]], "pric_cnd1": normalized["minimumCumulativePct"],
        "pric_cnd2": normalized["maximumCumulativePct"], "base_dt": normalized["baseDate"], "stk_cnd": "0",
        "trde_qty_tp": normalized["minVolume"], "pric_cnd": normalized["priceBand"],
        "trde_prica_cnd": normalized["minTradingValue"],
    })
    return body


def _previous_rank_body(feature_id: str, normalized: dict[str, str]) -> dict[str, str]:
    body = {"stex_tp": _SECTOR_EXCHANGE[normalized["exchange"]]}
    if feature_id == "usa20960":
        body.update({"inds_cd": normalized["industry"], "stk_tp": _PRODUCT_CODES[normalized["product"]]})
    else:
        body.update({"etf_cat1": normalized["etfCategory1"], "etf_cat2": normalized["etfCategory2"]})
    body["qry_tp"] = _PREVIOUS_RANK_CODES[normalized["rankBy"]]
    return body


def _body(feature_id: str, normalized: dict[str, str], instrument: dict[str, Any] | None) -> dict[str, str]:
    if feature_id in _REQUEST_IDENTITY_FEATURES:
        return _tape_body(feature_id, normalized, instrument)
    if feature_id == "usa01980":
        return {"svc_type": _INTERVALS[normalized["interval"]]}
    if feature_id == "usa01990":
        return {"dt_unit_tp": _WATCH_PERIODS[normalized["period"]], "stk_tp": _WATCH_PRODUCTS[normalized["product"]]}
    if feature_id in {"usa20510", "usa20530", "usa20540", "usa20550"}:
        return _rank_body(feature_id, normalized)
    if feature_id == "usa20520":
        filters = _rank_filters(normalized)
        return {
            "stex_tp": filters["stex_tp"], "inds_cd": filters["inds_cd"], "tm": normalized["period"],
            "stk_tp": filters["stk_tp"], "stk_cnd": filters["stk_cnd"], "pric_cnd": filters["pric_cnd"],
            "trde_prica_cnd": filters["trde_prica_cnd"], "trde_qty_tp": filters["trde_qty_tp"],
        }
    if feature_id == "usa24100":
        filters = _rank_filters(normalized)
        return {
            "stex_tp": filters["stex_tp"], "stk_tp": filters["stk_tp"], "inds_cd": filters["inds_cd"],
            "stk_cnd": filters["stk_cnd"], "ntl_tp": _HIGH_LOW[normalized["direction"]],
            "high_low_tp": _HIGH_LOW_BASIS[normalized["basis"]], "dt": normalized["periodDays"],
            "pric_cnd": filters["pric_cnd"], "trde_qty_tp": filters["trde_qty_tp"],
            "trde_prica_cnd": filters["trde_prica_cnd"],
        }
    if feature_id == "usa24140":
        filters = _rank_filters(normalized)
        return {
            "stex_tp": filters["stex_tp"], "inds_cd": filters["inds_cd"], "stk_tp": filters["stk_tp"],
            "sort_tp": _GAP_SORT[normalized["sort"]], "updown_tp": _GAP_DIRECTION[normalized["direction"]],
            "alacc_rt": normalized["minimumGap"], "stk_cnd": filters["stk_cnd"], "pric_cnd": filters["pric_cnd"],
            "trde_prica_cnd": filters["trde_prica_cnd"], "trde_qty_tp": filters["trde_qty_tp"],
        }
    if feature_id == "usa20930":
        filters = _rank_filters(normalized)
        return {
            "stex_tp": filters["stex_tp"], "stk_tp": filters["stk_tp"], "inds_cd": filters["inds_cd"],
            "stk_cnd": filters["stk_cnd"], "flu_tp": _SURGE_DIRECTION[normalized["direction"]],
            "tm_tp": _COMPARISON_TYPE[normalized["comparisonType"]], "tm": normalized["comparison"],
            "pric_cnd": filters["pric_cnd"], "trde_qty_tp": filters["trde_qty_tp"],
            "trde_prica_cnd": filters["trde_prica_cnd"],
        }
    if feature_id == "usa24200":
        filters = _rank_filters(normalized)
        return {
            "stex_tp": filters["stex_tp"], "inds_cd": filters["inds_cd"], "stk_tp": filters["stk_tp"],
            "sort_tp": _BOOK_SORT[normalized["sort"]], "stk_cnd": filters["stk_cnd"],
            "trde_qty_tp": filters["trde_qty_tp"], "pric_cnd": filters["pric_cnd"],
            "trde_prica_cnd": filters["trde_prica_cnd"],
        }
    if feature_id == "usa24300":
        return {"qry_tp": _RESEARCH_PRODUCT[normalized["product"]]}
    if feature_id in _CUSTOMER_SAMPLE_FEATURES:
        return {"qry_tp": _CUSTOMER_RANK_CODES[normalized["rankType"]], "dt_unit_tp": _CUSTOMER_PERIOD_CODES[normalized["period"]]}
    if feature_id in {"usa20910", "usa20911"}:
        return _daily_change_body(feature_id, normalized)
    if feature_id in {"usa20920", "usa20921", "usa20922"}:
        return _open_rank_body(feature_id, normalized)
    if feature_id in {"usa20940", "usa20941"}:
        return _cumulative_body(feature_id, normalized)
    if feature_id in {"usa20960", "usa20961"}:
        return _previous_rank_body(feature_id, normalized)
    if feature_id == "usa26411":
        return {"inds_cd": normalized["industry"], "srch_yr": normalized["searchYear"]}
    if feature_id == "usa26412":
        return {"etf_cat1": normalized["etfCategory1"], "etf_cat2": normalized["etfCategory2"], "srch_yr": normalized["searchYear"]}
    if feature_id == "usa26413":
        return {"inds_cd": normalized["industry"]}
    if feature_id == "usa26414":
        return {"etf_cat1": normalized["etfCategory1"], "etf_cat2": normalized["etfCategory2"]}
    if feature_id == "usa23000":
        return {"stex_tp": _SECTOR_EXCHANGE[normalized["exchange"]], "inds_cd": normalized["industry"]}
    return {
        "stex_tp": _SECTOR_EXCHANGE[normalized["exchange"]],
        "sort_tp": "1" if normalized["direction"] == "gainers" else "2",
        "inds_cd": normalized["industry"],
    }


def _quote_stock(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": _text(row.get("stk_cd")), "name": _text(row.get("stk_nm")),
        "exchange": _venue(row.get("stex_tp")), "price": _number(row.get("cur_prc") or row.get("curr_pric"), absolute=True),
        "change": _number(row.get("pred_pre")), "changePct": _number(row.get("flu_rt")),
    }


def _common_stock(row: dict[str, Any]) -> dict[str, Any]:
    return {"rank": _number(row.get("rank"), absolute=True), **_quote_stock(row)}


def _month_returns(row: dict[str, Any], *, include_year: bool) -> dict[str, Any]:
    values = {
        "janReturn": _number(row.get("m01_prft_rt")), "febReturn": _number(row.get("m02_prft_rt")),
        "marReturn": _number(row.get("m03_prft_rt")), "aprReturn": _number(row.get("m04_prft_rt")),
        "mayReturn": _number(row.get("m05_prft_rt")), "junReturn": _number(row.get("m06_prft_rt")),
        "julReturn": _number(row.get("m07_prft_rt")), "augReturn": _number(row.get("m08_prft_rt")),
        "sepReturn": _number(row.get("m09_prft_rt")), "octReturn": _number(row.get("m10_prft_rt")),
        "novReturn": _number(row.get("m11_prft_rt")), "decReturn": _number(row.get("m12_prft_rt")),
    }
    if include_year:
        year = _text(row.get("dt"))
        values = {"year": year, "yearKind": "average" if year == "0" else "year", **values}
    return values


def _hundredths(value: object) -> float | None:
    number = _number(value)
    return None if number is None else number / 100


def _text(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _venue(value: object) -> str | None:
    venue = str(value or "").strip().upper()
    return venue if venue in {"ND", "NY", "NA"} else None


def _provider_instrument(row: dict[str, Any]) -> dict[str, Any] | None:
    code = str(row.get("stk_cd") or "").strip().upper()
    venue = _venue(row.get("stex_tp"))
    if not _SYMBOL.fullmatch(code) or venue is None:
        return None
    name = _text(row.get("stk_nm")) or _text(row.get("stk_enm")) or code
    return {
        "market": "US", "stkCd": code, "stkNm": name, "stexTp": venue,
        "listingVenue": _US_LISTING[venue], "quoteVenue": venue,
        "currency": "USD", "environment": ENVIRONMENT,
    }


def _requested_tape_instrument(body: dict[str, str], instrument: dict[str, Any] | None) -> dict[str, Any]:
    """Build the UI identity from the validated request, never provider guesswork."""
    code, venue = body["stk_cd"], body["stex_tp"]
    name = _text(instrument.get("stkNm")) if isinstance(instrument, dict) else None
    return {
        "market": "US", "stkCd": code, "stkNm": name or code, "stexTp": venue,
        "listingVenue": _US_LISTING[venue], "quoteVenue": venue,
        "currency": "USD", "environment": ENVIRONMENT,
    }


def _verified_instrument(feature_id: str, row: dict[str, Any], requested_instrument: dict[str, Any] | None) -> dict[str, Any] | None:
    if feature_id not in _REQUEST_IDENTITY_FEATURES:
        # Ranking rows are independently selectable.  Do not gate a valid row
        # on whichever instrument happened to open the containing panel.
        return _provider_instrument(row)
    if requested_instrument is None:
        return None
    row_code = str(row.get("stk_cd") or "").strip().upper()
    raw_venue = str(row.get("stex_tp") or "").strip().upper()
    if row_code and row_code != requested_instrument["stkCd"]:
        raise ProviderDataError("provider response identity did not match symbol-specific query")
    if raw_venue and raw_venue != requested_instrument["stexTp"]:
        raise ProviderDataError("provider response identity did not match symbol-specific query")
    return dict(requested_instrument)


def _row(feature_id: str, raw: dict[str, Any], position: int, instrument: dict[str, Any] | None) -> dict[str, Any]:
    if feature_id == "usa20150":
        result = {
            "id": _id(feature_id, raw, position), "time": _text(raw.get("cntr_tm")),
            "price": _number(raw.get("cur_prc"), absolute=True), "change": _number(raw.get("pred_pre")),
            "changePct": _number(raw.get("flu_rt")), "quantity": _number(raw.get("trde_qty")),
            "changeSign": _text(raw.get("pred_pre_sig")),
        }
    elif feature_id == "usa20151":
        result = {
            "id": _id(feature_id, raw, position), "date": _text(raw.get("dt")),
            "price": _number(raw.get("cur_prc"), absolute=True), "change": _number(raw.get("pred_pre")),
            "changePct": _number(raw.get("flu_rt")), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
        }
    elif feature_id == "usa01980":
        result = {
            "id": _id(feature_id, raw, position), "rank": _number(raw.get("rank"), absolute=True),
            "code": _text(raw.get("stk_cd")), "name": _text(raw.get("stk_nm")), "exchange": _venue(raw.get("stex_tp")),
            "price": _number(raw.get("curr_pric"), absolute=True), "rankChange": _signed(raw.get("chg_val"), raw.get("sign")),
            "referenceChangePct": _signed(raw.get("diff_rate_for_gjga"), raw.get("sign_for_gjga")),
            "previousChangePct": _signed(raw.get("diff_rate_for_prev"), raw.get("sign_for_prev")),
        }
    elif feature_id == "usa01990":
        result = {
            "id": _id(feature_id, raw, position), **_common_stock(raw),
            "rankMovement": _number(raw.get("rank_flu")), "rankMovementCode": _text(raw.get("rank_flu_sig")),
        }
    elif feature_id == "usa20510":
        result = {
            "id": _id(feature_id, raw, position), "rank": _number(raw.get("rank"), absolute=True),
            "code": _text(raw.get("stk_cd")), "name": _text(raw.get("stk_nm")), "exchange": _venue(raw.get("stex_tp")),
            "startPrice": _number(raw.get("stdt_base_pric"), absolute=True), "endPrice": _number(raw.get("endt_base_pric"), absolute=True),
            "change": _number(raw.get("pred_pre")), "returnPct": _number(raw.get("flu_rt")),
            "startVolume": _number(raw.get("stdt_trde_qty"), absolute=True), "endVolume": _number(raw.get("endt_trde_qty"), absolute=True),
        }
    elif feature_id == "usa20530":
        result = {"id": _id(feature_id, raw, position), **_common_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True), "previousVolumePct": _number(raw.get("pred_rt")), "tradingValue": _number(raw.get("trde_prica"), absolute=True)}
    elif feature_id == "usa20540":
        result = {"id": _id(feature_id, raw, position), **_common_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True), "tradingValue": _number(raw.get("trde_prica"), absolute=True)}
    elif feature_id == "usa20550":
        result = {"id": _id(feature_id, raw, position), **_common_stock(raw), "marketCap": _number(raw.get("mac"), absolute=True), "marketCapWeight": _number(raw.get("mac_wght")), "volume": _number(raw.get("acc_trde_qty"), absolute=True)}
    elif feature_id == "usa23000":
        result = {
            "id": _id(feature_id, raw, position), "industryCode": _text(raw.get("inds_cd")), "industry": _text(raw.get("inds_nm")),
            "return1d": _number(raw.get("perf_1d")), "return5d": _number(raw.get("perf_5d")), "return1m": _number(raw.get("perf_1m")),
            "return3m": _number(raw.get("perf_3m")), "return6m": _number(raw.get("perf_6m")), "returnYtd": _number(raw.get("perf_ytd")), "return1y": _number(raw.get("perf_1y")),
        }
    elif feature_id == "usa23100":
        result = {
            "id": _id(feature_id, raw, position), **_quote_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
            "ask": _number(raw.get("sel_bid"), absolute=True), "bid": _number(raw.get("buy_bid"), absolute=True),
            "open": _number(raw.get("open_pric"), absolute=True), "high": _number(raw.get("high_pric"), absolute=True),
            "low": _number(raw.get("low_pric"), absolute=True), "time": _text(raw.get("cntr_tm")),
        }
    elif feature_id == "usa20520":
        result = {
            "id": _id(feature_id, raw, position), **_common_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
            "volumeSurgePct": _number(raw.get("sdnin_rt")), "ask": _number(raw.get("sel_bid"), absolute=True),
            "bid": _number(raw.get("buy_bid"), absolute=True),
        }
    elif feature_id == "usa24100":
        result = {
            "id": _id(feature_id, raw, position), **_quote_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
            "previousVolumePct": _number(raw.get("pre_trde_rt")), "ask": _number(raw.get("sel_bid"), absolute=True),
            "bid": _number(raw.get("buy_bid"), absolute=True), "high": _number(raw.get("high_pric"), absolute=True),
            "low": _number(raw.get("low_pric"), absolute=True),
        }
    elif feature_id == "usa24140":
        result = {
            "id": _id(feature_id, raw, position), **_quote_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
            "open": _number(raw.get("open_pric"), absolute=True), "baseClose": _number(raw.get("base_close_pric"), absolute=True),
            "gapPct": _number(raw.get("gap_rt")),
        }
    elif feature_id == "usa20930":
        result = {
            "id": _id(feature_id, raw, position), **_quote_stock(raw), "basePrice": _number(raw.get("base_pric"), absolute=True),
            "baseDifference": _number(raw.get("base_pre")), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
            "volumeSurgeValue": _number(raw.get("sdnin_rt")),
        }
    elif feature_id == "usa24200":
        result = {
            "id": _id(feature_id, raw, position), "rank": _number(raw.get("rank"), absolute=True), **_quote_stock(raw),
            "volume": _number(raw.get("acc_trde_qty"), absolute=True), "totalAskQuantity": _number(raw.get("tot_sel_req"), absolute=True),
            "totalBidQuantity": _number(raw.get("tot_buy_req"), absolute=True), "netBuyQuantity": _number(raw.get("buy_req")),
            "netBuyRatio": _hundredths(raw.get("buy_rt")), "netSellQuantity": _number(raw.get("sel_req")),
            "netSellRatio": _hundredths(raw.get("sel_rt")), "time": _text(raw.get("cntr_tm")),
        }
    elif feature_id in _CUSTOMER_SAMPLE_FEATURES:
        result = {
            "id": _id(feature_id, raw, position), "rank": _number(raw.get("kw_high_rank"), absolute=True),
            "rankMovementCode": _text(raw.get("kw_high_rank_sig")), "rankMovement": _number(raw.get("kw_high_rank_hl")),
            "code": _text(raw.get("stk_cd")), "name": _text(raw.get("stk_nm")), "exchange": _venue(raw.get("stex_tp")),
            "price": _number(raw.get("cur_prc"), absolute=True), "changePct": _number(raw.get("flu_rt")),
        }
    elif feature_id in {"usa20910", "usa20911"}:
        result = {
            "id": _id(feature_id, raw, position), **_common_stock(raw),
            "askQuantity": _number(raw.get("sel_req")), "bidQuantity": _number(raw.get("buy_req")),
            "tradeQuantity": _number(raw.get("trde_qty")), "providerCount": _number(raw.get("cnt"), absolute=True),
        }
    elif feature_id in {"usa20920", "usa20921", "usa20922"}:
        result = {
            "id": _id(feature_id, raw, position), **_common_stock(raw), "high": _number(raw.get("high_pric"), absolute=True),
            "low": _number(raw.get("low_pric"), absolute=True), "openChangePct": _number(raw.get("open_pric_pre")),
            "volume": _number(raw.get("acc_trde_qty"), absolute=True), "time": _text(raw.get("cntr_tm")),
            "open": _number(raw.get("open_pric"), absolute=True),
        }
    elif feature_id in {"usa20940", "usa20941"}:
        result = {
            "id": _id(feature_id, raw, position), **_common_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
            "highestPrice": _number(raw.get("hgst_pric"), absolute=True), "highestDate": _text(raw.get("stk_high_dt")),
            "lowestPrice": _number(raw.get("lwst_pric"), absolute=True), "lowestDate": _text(raw.get("stk_low_dt")),
            "cumulativeChangePct": _number(raw.get("acc_flu_rt")), "cumulativeChange": _number(raw.get("acc_flu_amt")),
        }
    elif feature_id in {"usa20960", "usa20961"}:
        result = {
            "id": _id(feature_id, raw, position), **_common_stock(raw),
            "previousTradeRate": _number(raw.get("pred_rt")), "volume": _number(raw.get("acc_trde_qty"), absolute=True),
        }
    elif feature_id in _MONTH_RETURN_FEATURES:
        if feature_id in {"usa26411", "usa26412"}:
            result = {"id": _id(feature_id, raw, position), "code": _text(raw.get("stk_cd")), "name": _text(raw.get("stk_nm")), "exchange": _venue(raw.get("stex_tp")), **_month_returns(raw, include_year=False)}
        else:
            result = {"id": _id(feature_id, raw, position), **_month_returns(raw, include_year=True)}
    else:  # usa24300: the documented response has only list/quote fields.
        result = {"id": _id(feature_id, raw, position), **_quote_stock(raw), "volume": _number(raw.get("acc_trde_qty"), absolute=True)}
    attached = _verified_instrument(feature_id, raw, instrument)
    if attached is not None:
        result["instrument"] = attached
    return result


_FIXTURE_ROWS: dict[str, list[dict[str, str]]] = {
    "usa20150": [{"cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "trde_qty": "+20", "cntr_tm": "093015", "pred_pre_sig": "2"}],
    "usa20151": [{"dt": "20261024", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "acc_trde_qty": "123456"}],
    "usa01980": [{"rank": "1", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "stex_tp": "ND", "curr_pric": "187.2500", "sign": "+", "chg_val": "2", "sign_for_gjga": "+", "diff_rate_for_gjga": "0.59", "sign_for_prev": "-", "diff_rate_for_prev": "0.12"}],
    "usa01990": [{"rank": "1", "rank_flu_sig": "N", "rank_flu": "", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59"}],
    "usa20510": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "stdt_base_pric": "+180.0000", "endt_base_pric": "+187.2500", "pred_pre": "+7.2500", "flu_rt": "+4.03", "stdt_trde_qty": "100", "endt_trde_qty": "123456"}],
    "usa20530": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "acc_trde_qty": "123456", "pred_rt": "+2.2", "trde_prica": "23000"}],
    "usa20540": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "acc_trde_qty": "123456", "trde_prica": "23000"}],
    "usa20550": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "mac": "4000000000", "mac_wght": "5.2", "acc_trde_qty": "123456"}],
    "usa23000": [{"inds_cd": "10", "inds_nm": "Fixture Energy", "perf_1d": "-1.11", "perf_5d": "1.72", "perf_1m": "", "perf_3m": "2.50", "perf_6m": "3.25", "perf_ytd": "4.50", "perf_1y": "5.75"}],
    "usa23100": [{"stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "acc_trde_qty": "123456", "sel_bid": "+187.2600", "buy_bid": "+187.2400", "open_pric": "+186.0000", "high_pric": "+188.0000", "low_pric": "+185.0000", "cntr_tm": "09:30"}],
    "usa20520": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "acc_trde_qty": "123456", "sdnin_rt": "+88.2", "sel_bid": "+187.2600", "buy_bid": "+187.2400"}],
    "usa24100": [{"stex_tp": "NA", "stk_cd": "ARKG", "stk_nm": "Fixture ARKG", "cur_prc": "+38.0600", "pred_pre": "+2.0500", "flu_rt": "+5.69", "acc_trde_qty": "32040", "pre_trde_rt": "-99.33", "sel_bid": "+38.0600", "buy_bid": "+38.0400", "high_pric": "38.0600", "low_pric": "24.6000"}],
    "usa24140": [{"stex_tp": "ND", "stk_cd": "NUWE", "stk_nm": "Fixture NUWE", "cur_prc": "-0.0874", "pred_pre": "-0.0406", "flu_rt": "-31.72", "acc_trde_qty": "1644553", "open_pric": "-0.0898", "base_close_pric": "0.1280", "gap_rt": "-27.99"}],
    "usa20930": [{"stex_tp": "NA", "stk_cd": "AAAU", "stk_nm": "Fixture AAAU", "cur_prc": "-39.5900", "pred_pre": "-0.9400", "flu_rt": "-2.32", "base_pric": "39.5900", "base_pre": "0.0000", "acc_trde_qty": "3485", "sdnin_rt": "0.00"}],
    "usa24200": [{"rank": "1", "stex_tp": "NY", "stk_cd": "PRA", "stk_nm": "Fixture PRA", "cur_prc": "+24.9900", "pred_pre": "+0.3400", "acc_trde_qty": "11475", "tot_sel_req": "7300", "tot_buy_req": "901416", "buy_req": "894116", "buy_rt": "2658", "sel_req": "-894116", "sel_rt": "81", "cntr_tm": "08:02"}],
    "usa24300": [{"stex_tp": "ND", "stk_cd": "AEP", "stk_nm": "Fixture AEP", "cur_prc": "-128.2700", "pred_pre": "-1.4800", "flu_rt": "-1.14", "acc_trde_qty": "6105001"}],
    "usa20880": [{"stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "kw_high_rank": "1", "kw_high_rank_sig": "0", "kw_high_rank_hl": "", "cur_prc": "+187.2500", "flu_rt": "+0.59"}],
    "usa20881": [{"stex_tp": "NY", "stk_cd": "SPY", "stk_nm": "Fixture SPY ETF", "kw_high_rank": "2", "kw_high_rank_sig": "1", "kw_high_rank_hl": "3", "cur_prc": "+600.1200", "flu_rt": "+0.25"}],
    "usa20910": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "sel_req": "50", "buy_req": "-30", "trde_qty": "+20", "cnt": "4"}],
    "usa20911": [{"rank": "1", "stex_tp": "NY", "stk_cd": "SPY", "stk_nm": "Fixture SPY ETF", "cur_prc": "+600.1200", "pred_pre": "+1.2000", "flu_rt": "+0.20", "sel_req": "70", "buy_req": "30", "trde_qty": "+40", "cnt": "2"}],
    "usa20920": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "high_pric": "+188.0000", "low_pric": "+185.0000", "open_pric_pre": "+0.40", "acc_trde_qty": "123456", "cntr_tm": "09:30", "open_pric": "+186.5000"}],
    "usa20921": [{"rank": "1", "stex_tp": "NY", "stk_cd": "SPY", "stk_nm": "Fixture SPY ETF", "cur_prc": "+600.1200", "pred_pre": "+1.2000", "flu_rt": "+0.20", "high_pric": "+601.0000", "low_pric": "+598.0000", "open_pric_pre": "+0.10", "acc_trde_qty": "234567", "cntr_tm": "09:30", "open_pric": "+599.5000"}],
    "usa20922": [{"rank": "1", "stex_tp": "ND", "stk_cd": "AAPL", "stk_nm": "Fixture Apple", "cur_prc": "+220.1200", "pred_pre": "+0.50", "flu_rt": "+0.23", "high_pric": "+221.0000", "low_pric": "+219.0000", "open_pric_pre": "+0.11", "acc_trde_qty": "345678", "cntr_tm": "09:30", "open_pric": "+219.8800"}],
    "usa20940": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "flu_rt": "+0.59", "acc_trde_qty": "123456", "hgst_pric": "200.0000", "stk_high_dt": "20261020", "lwst_pric": "150.0000", "stk_low_dt": "20260115", "acc_flu_rt": "+24.83", "acc_flu_amt": "+37.2500"}],
    "usa20941": [{"rank": "1", "stex_tp": "NY", "stk_cd": "SPY", "stk_nm": "Fixture SPY ETF", "cur_prc": "+600.1200", "pred_pre": "+1.2000", "flu_rt": "+0.20", "acc_trde_qty": "234567", "hgst_pric": "620.0000", "stk_high_dt": "20261020", "lwst_pric": "500.0000", "stk_low_dt": "20260115", "acc_flu_rt": "+20.02", "acc_flu_amt": "+100.1200"}],
    "usa20960": [{"rank": "1", "stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "cur_prc": "+187.2500", "pred_pre": "+1.1000", "pred_rt": "+2.20", "acc_trde_qty": "123456"}],
    "usa20961": [{"rank": "1", "stex_tp": "NY", "stk_cd": "SPY", "stk_nm": "Fixture SPY ETF", "cur_prc": "+600.1200", "pred_pre": "+1.2000", "pred_rt": "+0.20", "acc_trde_qty": "234567"}],
    "usa26410": [{"dt": "2025", "m01_prft_rt": "+1.1", "m02_prft_rt": "-2.2", "m03_prft_rt": "", "m04_prft_rt": "+4.4", "m05_prft_rt": "+5.5", "m06_prft_rt": "+6.6", "m07_prft_rt": "+7.7", "m08_prft_rt": "+8.8", "m09_prft_rt": "+9.9", "m10_prft_rt": "+10.1", "m11_prft_rt": "+11.1", "m12_prft_rt": "+12.1"}],
    "usa26411": [{"stex_tp": "ND", "stk_cd": "NVDA", "stk_nm": "Fixture NVIDIA", "m01_prft_rt": "+1.1", "m02_prft_rt": "-2.2", "m03_prft_rt": "", "m04_prft_rt": "+4.4", "m05_prft_rt": "+5.5", "m06_prft_rt": "+6.6", "m07_prft_rt": "+7.7", "m08_prft_rt": "+8.8", "m09_prft_rt": "+9.9", "m10_prft_rt": "+10.1", "m11_prft_rt": "+11.1", "m12_prft_rt": "+12.1"}],
    "usa26412": [{"stex_tp": "NY", "stk_cd": "SPY", "stk_nm": "Fixture SPY ETF", "m01_prft_rt": "+1.1", "m02_prft_rt": "-2.2", "m03_prft_rt": "", "m04_prft_rt": "+4.4", "m05_prft_rt": "+5.5", "m06_prft_rt": "+6.6", "m07_prft_rt": "+7.7", "m08_prft_rt": "+8.8", "m09_prft_rt": "+9.9", "m10_prft_rt": "+10.1", "m11_prft_rt": "+11.1", "m12_prft_rt": "+12.1"}],
    "usa26413": [{"dt": "0", "m01_prft_rt": "+1.1", "m02_prft_rt": "-2.2", "m03_prft_rt": "", "m04_prft_rt": "+4.4", "m05_prft_rt": "+5.5", "m06_prft_rt": "+6.6", "m07_prft_rt": "+7.7", "m08_prft_rt": "+8.8", "m09_prft_rt": "+9.9", "m10_prft_rt": "+10.1", "m11_prft_rt": "+11.1", "m12_prft_rt": "+12.1"}],
    "usa26414": [{"dt": "2025", "m01_prft_rt": "+1.1", "m02_prft_rt": "-2.2", "m03_prft_rt": "", "m04_prft_rt": "+4.4", "m05_prft_rt": "+5.5", "m06_prft_rt": "+6.6", "m07_prft_rt": "+7.7", "m08_prft_rt": "+8.8", "m09_prft_rt": "+9.9", "m10_prft_rt": "+10.1", "m11_prft_rt": "+11.1", "m12_prft_rt": "+12.1"}],
}


def _cache_key(feature_id: str, normalized: dict[str, str], instrument: dict[str, Any] | None) -> tuple[Any, ...]:
    code, venue = _instrument_identity(instrument)
    return (ENVIRONMENT, feature_id, tuple(sorted(normalized.items())), code, venue, bool(gateway.KIWOOM_ENABLED))


def _cache_get(key: tuple[Any, ...]) -> dict[str, Any] | None:
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is None or time.monotonic() - cached[0] >= _CACHE_TTL_SECONDS:
            return None
        return copy.deepcopy(cached[1])


def _cache_put(key: tuple[Any, ...], result: dict[str, Any]) -> dict[str, Any]:
    with _CACHE_LOCK:
        if key not in _CACHE and len(_CACHE) >= _CACHE_LIMIT:
            _CACHE.pop(min(_CACHE, key=lambda entry: _CACHE[entry][0]), None)
        _CACHE[key] = (time.monotonic(), copy.deepcopy(result))
    return copy.deepcopy(result)


def _payload(feature_id: str, *, normalized: dict[str, str], body: dict[str, str], source: str, status: str, rows: list[dict[str, Any]], complete: bool, note: str, instrument: dict[str, Any] | None) -> dict[str, Any]:
    scope: dict[str, Any] = {
        "apiId": FEATURES[feature_id]["apiId"], "path": FEATURES[feature_id]["path"],
        "returnedRows": len(rows), "maxPages": _MAX_PAGES,
    }
    if "stex_tp" in body:
        scope["requestExchange"] = body["stex_tp"]
    if "exchange" in normalized:
        scope["marketScope"] = {"exchange": normalized["exchange"], "providerRequestExchange": body.get("stex_tp")}
    if feature_id in _CUSTOMER_SAMPLE_FEATURES:
        scope["population"] = "Kiwoom customer activity sample; not a whole-market ranking."
        scope["periodScope"] = {"aggregation": normalized["period"]}
    elif feature_id in {"usa20910", "usa20911", "usa20920", "usa20921", "usa20922", "usa20940", "usa20941", "usa20960", "usa20961"}:
        scope["population"] = "Public market ranking universe for the selected filters; not a Kiwoom-customer activity sample."
    if feature_id in {"usa20940", "usa20941"}:
        scope["periodScope"] = {"baseDate": normalized["baseDate"], "minimumCumulativePct": normalized["minimumCumulativePct"], "maximumCumulativePct": normalized["maximumCumulativePct"]}
    if feature_id in {"usa26411", "usa26412"}:
        scope["periodScope"] = {"searchYear": normalized["searchYear"]}
    if instrument is not None:
        code, venue = _instrument_identity(instrument)
        scope["requestedInstrument"] = {"stkCd": code, "stexTp": venue}
    return {
        "featureId": feature_id, "title": FEATURES[feature_id]["title"], "market": "US", "source": source,
        "status": status, "receivedAt": _utc_now(), "asOf": None, "note": note, "complete": complete,
        "columns": _feature_columns(feature_id), "rows": rows, "scope": scope, "parameters": dict(normalized),
    }


def _clear_caches_for_tests() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def get_feature(feature_id: str, params: dict[str, Any], *, instrument: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return one documented US public-market feature.

    Unknown features/parameters fail before broker I/O.  In fixture mode a
    deterministic, visibly labelled fixture is returned.  A live broker error
    is returned as ``status='error'`` and never falls back to those fixtures.
    """
    if feature_id not in FEATURES:
        raise InputError("unsupported US analysis feature")
    normalized = _normalise(feature_id, params)
    body = _body(feature_id, normalized, instrument)
    row_instrument = _requested_tape_instrument(body, instrument) if feature_id in _REQUEST_IDENTITY_FEATURES else instrument
    key = _cache_key(feature_id, normalized, instrument)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    if not gateway.KIWOOM_ENABLED:
        if ENVIRONMENT != "fixture":
            return _payload(
                feature_id, normalized=normalized, body=body, source="kiwoom", status="error", rows=[], complete=False,
                note="Kiwoom read is disabled outside fixture mode.", instrument=row_instrument,
            )
        rows = [_row(feature_id, raw, index, row_instrument) for index, raw in enumerate(_FIXTURE_ROWS[feature_id], start=1)]
        result = _payload(
            feature_id, normalized=normalized, body=body, source="fixture", status="fixture", rows=rows,
            complete=True, note="Deterministic fixture/test data; no Kiwoom request was made.", instrument=row_instrument,
        )
        return _cache_put(key, result)

    try:
        raw_rows, complete, continuation_note = gateway._fetch_rows(
            FEATURES[feature_id]["apiId"], FEATURES[feature_id]["path"], body, "result_list", max_pages=_MAX_PAGES,
        )
    except gateway.BrokerError as exc:
        return _payload(
            feature_id, normalized=normalized, body=body, source="kiwoom", status="error", rows=[], complete=False,
            note=gateway.read_failure_note(exc), instrument=row_instrument,
        )

    try:
        rows = [_row(feature_id, raw, index, row_instrument) for index, raw in enumerate(raw_rows, start=1)]
    except ProviderDataError:
        return _payload(
            feature_id, normalized=normalized, body=body, source="kiwoom", status="error", rows=[], complete=False,
            note="Provider response identity did not match the symbol-specific query.", instrument=row_instrument,
        )
    note = ""
    if not complete:
        note = f"Provider pagination incomplete: {continuation_note or 'continuation unavailable'}."
    result = _payload(
        feature_id, normalized=normalized, body=body, source="kiwoom", status="snapshot" if rows else "missing",
        rows=rows, complete=bool(complete), note=note, instrument=row_instrument,
    )
    return _cache_put(key, result)
