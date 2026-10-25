"""Local HTTP boundary for broker-saved condition reads and live membership.

The condition worker owns the one SDK WebSocket receiver.  These handlers only
validate local requests and offload its synchronous, bounded public methods so
an ASGI event loop is never blocked waiting for a broker reply.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app import condition_search, market_stream


_BODY_LIMIT = 512
_REGISTRATION_ID = re.compile(r"[0-9a-f]{32}")
AuthGuard = Callable[..., None]
_auth_guard: AuthGuard | None = None

router = APIRouter(prefix="/api/conditions", tags=["saved-conditions"])


def configure_auth_guard(guard: AuthGuard) -> None:
    """Root integration hook for main's local mutation capability guard."""
    global _auth_guard
    _auth_guard = guard


def _authorize(request: Request) -> None:
    if _auth_guard is None:
        raise HTTPException(503, "condition authorization is not configured")
    _auth_guard(request, mutation=True)


def _no_store(payload: dict[str, Any]) -> JSONResponse:
    return JSONResponse(payload, headers={"Cache-Control": "no-store", "Pragma": "no-cache", "Vary": "Origin"})


def _query_seq(request: Request) -> str:
    values = [value for key, value in request.query_params.multi_items() if key == "seq"]
    if len(values) != 1 or len(request.query_params) != 1:
        raise HTTPException(400, "invalid condition request")
    try:
        return condition_search.normalize_seq(values[0])
    except condition_search.ConditionInputError:
        raise HTTPException(400, "invalid condition request") from None


def _market(value: str) -> str:
    try:
        return condition_search.normalize_market(value)
    except condition_search.ConditionInputError:
        raise HTTPException(400, "invalid condition request") from None


async def _body_seq(request: Request) -> str:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _BODY_LIMIT:
            raise HTTPException(400, "invalid condition request")
        chunks.append(chunk)
    try:
        payload = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "invalid condition request") from exc
    if not isinstance(payload, dict) or set(payload) != {"seq"} or not isinstance(payload.get("seq"), str):
        raise HTTPException(400, "invalid condition request")
    try:
        return condition_search.normalize_seq(payload["seq"])
    except condition_search.ConditionInputError:
        raise HTTPException(400, "invalid condition request") from None


async def _body_unsubscribe(request: Request) -> tuple[str, str]:
    """Parse the exact ABA-safe unsubscribe capability body."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _BODY_LIMIT:
            raise HTTPException(400, "invalid condition request")
        chunks.append(chunk)
    try:
        payload = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "invalid condition request") from exc
    if (
        not isinstance(payload, dict)
        or set(payload) != {"seq", "registrationId"}
        or not isinstance(payload.get("seq"), str)
        or not isinstance(payload.get("registrationId"), str)
        or _REGISTRATION_ID.fullmatch(payload["registrationId"]) is None
    ):
        raise HTTPException(400, "invalid condition request")
    try:
        return condition_search.normalize_seq(payload["seq"]), payload["registrationId"]
    except condition_search.ConditionInputError:
        raise HTTPException(400, "invalid condition request") from None


async def _call(callback: Callable[..., dict[str, Any]], *args: Any, **kwargs: Any) -> JSONResponse:
    try:
        return _no_store(await asyncio.to_thread(callback, *args, **kwargs))
    except condition_search.ConditionInputError:
        raise HTTPException(400, "invalid condition request") from None
    except condition_search.ConditionSearchError:
        # Never return SDK packets, broker messages, or request correlation.
        raise HTTPException(503, "saved-condition request is unavailable") from None


@router.get("/{market}/list")
async def list_conditions(market: str, request: Request) -> JSONResponse:
    if request.query_params:
        raise HTTPException(400, "invalid condition request")
    return await _call(market_stream.condition_list, _market(market))


@router.get("/{market}/result")
async def result(market: str, request: Request) -> JSONResponse:
    return await _call(market_stream.condition_result, _market(market), _query_seq(request))


@router.get("/{market}/status")
async def status(market: str, request: Request) -> JSONResponse:
    return await _call(market_stream.condition_status, _market(market), _query_seq(request))


@router.post("/{market}/subscribe")
async def subscribe(market: str, request: Request) -> JSONResponse:
    _authorize(request)
    return await _call(market_stream.condition_result, _market(market), await _body_seq(request), realtime=True)


@router.post("/{market}/unsubscribe")
async def unsubscribe(market: str, request: Request) -> JSONResponse:
    _authorize(request)
    seq, registration_id = await _body_unsubscribe(request)
    return await _call(market_stream.condition_unsubscribe, _market(market), seq, registration_id=registration_id)
