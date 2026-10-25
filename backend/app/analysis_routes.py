"""Fixed, public-market analysis features; never a raw API proxy."""
from __future__ import annotations

import copy
import importlib
import time
from threading import Lock, BoundedSemaphore

from fastapi import APIRouter, HTTPException, Request
from app import kiwoom_gateway as gateway
from app.company_credentials import get_provider_credentials

router = APIRouter(prefix="/api/analysis", tags=["market-analysis"])
_PROVIDERS = ("app.analysis_kr", "app.analysis_kr_extra", "app.analysis_us", "app.company_data")
_IDENTITY_KEYS = frozenset({"stkCd", "stexTp", "listingVenue"})
_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = Lock()
_locks = tuple(Lock() for _ in range(64))
_capacity = BoundedSemaphore(4)


def _registry():
    result = {}
    for name in _PROVIDERS:
        module = importlib.import_module(name)
        for feature_id, metadata in module.FEATURES.items():
            if feature_id in result:
                raise RuntimeError("duplicate analysis feature")
            result[feature_id] = (module, metadata)
    return result


@router.get("/features")
def features():
    return {"features": [
        {"id": key, **{field: copy.deepcopy(meta[field]) for field in
          ("title", "market", "description", "parameters") if field in meta}}
        for key, (_, meta) in _registry().items()
    ]}


@router.get("/{feature_id}")
def query_feature(feature_id: str, request: Request):
    entry = _registry().get(feature_id)
    if entry is None:
        raise HTTPException(404, "지원하지 않는 분석 기능입니다.")
    module, metadata = entry
    supplied = dict(request.query_params)
    allowed = _IDENTITY_KEYS | {parameter["key"] for parameter in metadata.get("parameters", [])}
    if set(supplied) - allowed or len(request.query_params.multi_items()) != len(supplied):
        raise HTTPException(422, "지원하지 않는 조회 조건입니다.")
    limits = {p["key"]: min(2048, max(1, int(p.get("maxLength", 160)))) for p in metadata.get("parameters", [])}
    if any(len(value) > limits.get(key, 160) for key, value in supplied.items()):
        raise HTTPException(422, "조회 조건이 너무 깁니다.")
    instrument = None
    try:
        if supplied.get("stkCd"):
            instrument = gateway._identity(
                market=metadata["market"], stk_cd=supplied["stkCd"],
                stex_tp=supplied.get("stexTp"), listing_venue=supplied.get("listingVenue"),
            )
        params = {key: value for key, value in supplied.items() if key not in _IDENTITY_KEYS}
        cache_key = (gateway.ENVIRONMENT, feature_id, tuple(sorted(supplied.items())))
        lock = _locks[hash(cache_key) % len(_locks)]
        if not lock.acquire(timeout=15):
            raise HTTPException(503, "같은 조회를 처리 중입니다. 잠시 후 다시 조회하세요.")
        try:
            with _cache_lock:
                cached = _cache.get(cache_key)
                if cached and time.monotonic() - cached[0] < 15:
                    return copy.deepcopy(cached[1])
            if not _capacity.acquire(blocking=False):
                raise HTTPException(503, "분석 조회가 진행 중입니다. 잠시 후 다시 조회하세요.")
            try:
                if getattr(module, "__name__", "") == "app.company_data":
                    credentials = get_provider_credentials()
                    payload = module.get_feature(feature_id, params, instrument=instrument,
                        sec_user_agent=credentials.sec_user_agent, dart_api_key=credentials.dart_api_key)
                else:
                    payload = module.get_feature(feature_id, params, instrument=instrument)
            finally:
                _capacity.release()
            if getattr(module, "__name__", "") != "app.company_data" and payload.get("status") not in {"error", "setup-required"}:
                with _cache_lock:
                    if len(_cache) >= 128:
                        _cache.pop(min(_cache, key=lambda key: _cache[key][0]), None)
                    _cache[cache_key] = (time.monotonic(), copy.deepcopy(payload))
            return payload
        finally:
            lock.release()
    except HTTPException:
        raise
    except (ValueError, KeyError) as exc:
        raise HTTPException(422, "종목 또는 조회 조건을 확인하세요.") from exc
    except gateway.BrokerError as exc:
        raise HTTPException(502, "분석 자료를 받지 못했습니다. 연결 상태와 조회 조건을 확인하세요.") from exc
