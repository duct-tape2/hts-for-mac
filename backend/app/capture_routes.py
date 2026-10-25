"""HTTP route for normalized captured HTS payloads."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.capture_market import InputError, capture_screen

router = APIRouter(prefix="/api/hts", tags=["captured-hts"])

_QUERY_KEYS = frozenset({"market", "venue", "sort", "direction", "interval", "sector", "start", "end", "unit", "period", "query", "provider", "session", "stock", "credit", "volumeBand", "priceBand", "valueBand", "limitSort", "managed"})


@router.get("/screens/{code}")
def get_captured_screen(
    request: Request,
    code: str, market: str = "all", venue: str = "ALL", sort: str = "volume",
    direction: str = "up", interval: str = "D", sector: str = "001",
    start: str | None = None, end: str | None = None, unit: str = "amount",
    period: str = "1", query: str = "", provider: str = "all",
    session: str = "all", stock: str = "all", credit: str = "all",
    volumeBand: str = "all", priceBand: str = "all", valueBand: str = "all",
    limitSort: str = "changePct", managed: str = "exclude",
) -> dict:
    supplied = dict(request.query_params)
    if set(supplied) - _QUERY_KEYS:
        raise HTTPException(422, "조회 조건이 올바르지 않습니다.")
    try:
        return capture_screen(code, **supplied)
    except InputError as exc:
        detail = "지원하지 않는 캡처 화면입니다." if str(exc) == "unknown screen" else "조회 조건이 올바르지 않습니다."
        raise HTTPException(404 if str(exc) == "unknown screen" else 422, detail) from exc
