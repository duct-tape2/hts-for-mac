"""Verified saved-condition WebSocket contract, without transport ownership.

The stream worker owns connection/authentication and imports this module only
for strict condition packet construction and response normalization.  This
module never creates a client, reads credentials, or performs I/O.
"""
from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any


class ConditionSearchError(RuntimeError):
    """A safe, user-displayable saved-condition failure."""


class ConditionInputError(ConditionSearchError):
    """The caller supplied an unsupported saved-condition request."""


class ConditionProtocolError(ConditionSearchError):
    """A condition response did not match the verified SDK contract."""


_SEQ = re.compile(r"^[0-9]{1,20}$")
_LIVE_FIELDS = ("841", "9001", "843", "20", "907")
_RAW_FIELD_LIMIT = 64
_RAW_VALUE_LIMIT = 512

# Official installed SDK: ka10171/72/73/74 and usa20280/81/90/91.  ``GCNSRREQ``
# is used for the US normal response because the bundled response example uses
# it, despite one metadata label saying CNSRREQ.
_PROTOCOLS: dict[str, dict[str, Any]] = {
    "KR": {
        "list": {"apiId": "ka10171", "requestTrnm": "CNSRLST", "responseTrnm": "CNSRLST"},
        "result": {"apiId": "ka10172", "requestTrnm": "CNSRREQ", "responseTrnm": "CNSRREQ"},
        "live": {"apiId": "ka10173", "requestTrnm": "CNSRREQ", "responseTrnm": "CNSRREQ"},
        "unsubscribe": {"apiId": "ka10174", "requestTrnm": "CNSRCLR", "responseTrnm": "CNSRCLR"},
        "venue": {"KRX": "K"},
    },
    "US": {
        "list": {"apiId": "usa20280", "requestTrnm": "GCNSRLST", "responseTrnm": "GCNSRLST"},
        "result": {"apiId": "usa20281", "requestTrnm": "GCNSRREQ", "responseTrnm": "GCNSRREQ"},
        "live": {"apiId": "usa20290", "requestTrnm": "GCNSRREQ", "responseTrnm": "GCNSRREQ"},
        "unsubscribe": {"apiId": "usa20291", "requestTrnm": "GCNSRCLR", "responseTrnm": "GCNSRCLR"},
    },
}


@dataclass(frozen=True)
class ConditionCommandSpec:
    market: str
    operation: str
    api_id: str
    packet: dict[str, str]
    response_trnm: str
    seq: str | None
    realtime: bool


FEATURES: dict[str, dict[str, Any]] = {
    "saved-condition-list": {
        "featureId": "saved-condition-list",
        "provider": "kiwoom",
        "transport": "websocket-existing-market-stream",
        "readSemantics": "list server-saved conditions; authoring is not supported",
        "requestSchema": {"market": {"enum": ["KR", "US"]}},
        "responseSchema": {"conditions": "[{seq: numeric-string, name: string}]"},
        "capabilityState": "implemented",
    },
    "saved-condition-result": {
        "featureId": "saved-condition-result",
        "provider": "kiwoom",
        "transport": "websocket-existing-market-stream",
        "readSemantics": "one saved-condition result, bounded continuation",
        "requestSchema": {
            "market": {"enum": ["KR", "US"]},
            "seq": {"pattern": "^[0-9]{1,20}$"},
            "venue": {"KR": ["KRX"], "US": "not-supported"},
        },
        "responseSchema": {"rows": "[{item,name,exchange,fields}]", "complete": "boolean", "nextKey": "string|null"},
        "capabilityState": "implemented",
    },
    "saved-condition-live": {
        "featureId": "saved-condition-live",
        "provider": "kiwoom",
        "transport": "websocket-existing-market-stream",
        "readSemantics": "explicit activation only; never enabled by list/result reads",
        "requestSchema": {"market": {"enum": ["KR", "US"]}, "seq": {"pattern": "^[0-9]{1,20}$"}},
        "capabilityState": "implemented-explicit-only",
    },
}


def get_feature(feature_id: str) -> dict[str, Any] | None:
    """Return a copy of one public saved-condition capability declaration."""
    feature = FEATURES.get(str(feature_id or ""))
    return deepcopy(feature) if feature is not None else None


def normalize_market(market: str) -> str:
    value = str(market or "").strip().upper()
    if value not in _PROTOCOLS:
        raise ConditionInputError("condition market must be KR or US")
    return value


def normalize_seq(seq: str) -> str:
    value = str(seq or "").strip()
    if not _SEQ.fullmatch(value):
        raise ConditionInputError("condition seq must be a numeric saved-condition identifier")
    return value


def build_command(
    market: str,
    operation: str,
    *,
    seq: str | None = None,
    venue: str | None = None,
    cont_yn: str = "N",
    next_key: str = "",
) -> ConditionCommandSpec:
    selected = normalize_market(market)
    if operation not in {"list", "result", "live", "unsubscribe"}:
        raise ConditionInputError("unsupported condition operation")
    if operation == "list":
        if seq is not None or venue is not None:
            raise ConditionInputError("condition list does not accept seq or venue")
        metadata = _PROTOCOLS[selected][operation]
        return ConditionCommandSpec(selected, operation, metadata["apiId"], {"trnm": metadata["requestTrnm"]}, metadata["responseTrnm"], None, False)

    normalized_seq = normalize_seq(seq or "")
    metadata = _PROTOCOLS[selected][operation]
    packet: dict[str, str] = {"trnm": metadata["requestTrnm"], "seq": normalized_seq}
    if operation in {"result", "live"}:
        packet["search_type"] = "1" if operation == "live" else "0"
        if selected == "KR":
            selected_venue = str(venue or "KRX").strip().upper()
            venue_code = _PROTOCOLS[selected]["venue"].get(selected_venue)
            if venue_code is None:
                raise ConditionInputError("KR saved conditions support only the documented KRX venue")
            packet["stex_tp"] = venue_code
        elif venue is not None:
            raise ConditionInputError("US saved-condition requests do not expose a venue parameter")
        if operation == "result":
            if cont_yn not in {"N", "Y"}:
                raise ConditionInputError("condition continuation must be N or Y")
            packet["cont_yn"] = cont_yn
            packet["next_key"] = str(next_key or "") if cont_yn == "Y" else ""
    elif venue is not None:
        raise ConditionInputError("condition unsubscribe does not accept a venue")
    return ConditionCommandSpec(selected, operation, metadata["apiId"], packet, metadata["responseTrnm"], normalized_seq, operation == "live")


def _success(message: dict[str, Any]) -> None:
    if not isinstance(message, dict) or message.get("return_code") not in (None, 0, "0"):
        raise ConditionProtocolError("saved-condition request was rejected")


def _response_seq(message: dict[str, Any], expected: str) -> None:
    returned = message.get("seq")
    if returned is None or str(returned).strip() != expected:
        raise ConditionProtocolError("saved-condition response sequence did not match the request")


def parse_list_response(market: str, message: dict[str, Any]) -> dict[str, Any]:
    selected = normalize_market(market)
    _success(message)
    if str(message.get("trnm") or "") != _PROTOCOLS[selected]["list"]["responseTrnm"]:
        raise ConditionProtocolError("saved-condition list response type was unexpected")
    data = message.get("data", [])
    if not isinstance(data, list):
        raise ConditionProtocolError("saved-condition list was not a list")
    conditions = []
    for entry in data:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            conditions.append({"seq": normalize_seq(entry[0]), "name": str(entry[1] or "").strip()})
        elif isinstance(entry, dict):
            conditions.append({"seq": normalize_seq(entry.get("seq")), "name": str(entry.get("name") or "").strip()})
        else:
            raise ConditionProtocolError("saved-condition list contained an invalid item")
    return {"market": selected, "conditions": conditions, "complete": True}


def parse_result_page(market: str, spec: ConditionCommandSpec, message: dict[str, Any]) -> dict[str, Any]:
    selected = normalize_market(market)
    _success(message)
    if spec.market != selected or spec.operation not in {"result", "live"}:
        raise ConditionProtocolError("saved-condition response did not match an active request")
    if str(message.get("trnm") or "") != spec.response_trnm:
        raise ConditionProtocolError("saved-condition response type was unexpected")
    _response_seq(message, spec.seq or "")
    data = message.get("data", [])
    if not isinstance(data, list):
        raise ConditionProtocolError("saved-condition result was not a list")
    rows: list[dict[str, Any]] = []
    for raw in data:
        if not isinstance(raw, dict):
            raise ConditionProtocolError("saved-condition result contained an invalid row")
        # The provider's normal-result fields differ by saved condition and
        # market.  Keep unrecognised scalar values for the UI's safe text
        # table rather than pretending its fixed quote columns are complete.
        fields: dict[str, str] = {}
        for field, value in raw.items():
            if value in (None, "") or len(fields) >= _RAW_FIELD_LIMIT:
                continue
            key = str(field).strip()[:64]
            if key:
                fields[key] = str(value)[:_RAW_VALUE_LIMIT]
        rows.append({
            "item": fields.get("9001") or fields.get("jmcode"),
            "name": fields.get("302"),
            "exchange": fields.get("stex_tp") or fields.get("stexTp"),
            "fields": fields,
        })
    has_next = str(message.get("cont_yn") or "N").upper() == "Y"
    next_key = str(message.get("next_key") or "") if has_next else ""
    if has_next and not next_key:
        raise ConditionProtocolError("saved-condition continuation key was missing")
    return {"market": selected, "seq": spec.seq, "rows": rows, "hasNext": has_next, "nextKey": next_key}


def parse_unsubscribe_response(market: str, spec: ConditionCommandSpec, message: dict[str, Any]) -> dict[str, Any]:
    selected = normalize_market(market)
    _success(message)
    if spec.market != selected or spec.operation != "unsubscribe":
        raise ConditionProtocolError("saved-condition clear did not match an active request")
    if str(message.get("trnm") or "") != spec.response_trnm:
        raise ConditionProtocolError("saved-condition clear response type was unexpected")
    _response_seq(message, spec.seq or "")
    return {"market": selected, "seq": spec.seq, "unsubscribed": True}


def parse_live_membership_events(market: str, message: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse documented saved-condition REAL entries without inventing time."""
    selected = normalize_market(market)
    if not isinstance(message, dict) or str(message.get("trnm") or "") != "REAL":
        raise ConditionProtocolError("saved-condition live response type was unexpected")
    data = message.get("data")
    if not isinstance(data, list):
        raise ConditionProtocolError("saved-condition live response was not a list")
    events: list[dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict) or not isinstance(entry.get("values"), dict):
            raise ConditionProtocolError("saved-condition live response contained an invalid item")
        values = entry["values"]
        seq = normalize_seq(values.get("841"))
        item = str(entry.get("item") or values.get("9001") or "").strip() or None
        action = str(values.get("843") or "").strip().upper()
        if action not in {"I", "D"}:
            raise ConditionProtocolError("saved-condition live action was unsupported")
        fields = {field: str(values[field]) for field in _LIVE_FIELDS if values.get(field) not in (None, "")}
        events.append({
            "market": selected,
            "seq": seq,
            "item": item,
            "action": action,
            "eventType": str(entry.get("type") or ""),
            "name": str(entry.get("name") or "").strip() or None,
            "exchange": str(entry.get("stexTp") or entry.get("stex_tp") or "").strip().upper() or None,
            "fields": fields,
            "sourceTimestamp": None,
            "timeNote": "Raw provider time is retained in fields; timezone/date are not derived.",
        })
    return events


def combine_result_pages(spec: ConditionCommandSpec, pages: list[dict[str, Any]], *, complete: bool, note: str = "") -> dict[str, Any]:
    if not pages:
        raise ConditionProtocolError("saved-condition response contained no pages")
    final = pages[-1]
    return {
        "market": spec.market,
        "seq": spec.seq,
        "realtime": spec.realtime,
        "rows": [row for page in pages for row in page["rows"]],
        "pages": len(pages),
        "complete": bool(complete and not final["hasNext"]),
        "nextKey": final["nextKey"] if final["hasNext"] else None,
        "note": note,
    }


def fixture_list(market: str) -> dict[str, Any]:
    selected = normalize_market(market)
    return {"market": selected, "conditions": [{"seq": "0", "name": f"Fixture {selected} saved condition"}], "complete": True, "source": "fixture", "status": "fixture", "note": "Deterministic fixture saved-condition list; no broker request was made."}


def fixture_result(market: str, seq: str, *, realtime: bool) -> dict[str, Any]:
    selected, normalized_seq = normalize_market(market), normalize_seq(seq)
    row = {"item": "A005930", "name": "삼성전자", "exchange": None, "fields": {"9001": "A005930", "302": "삼성전자"}} if selected == "KR" else {"item": "NVDA", "name": "NVIDIA", "exchange": "ND", "fields": {"9001": "NVDA", "302": "NVIDIA", "stex_tp": "ND"}}
    return {"market": selected, "seq": normalized_seq, "realtime": False, "rows": [row], "pages": 1, "complete": True, "nextKey": None, "source": "fixture", "status": "fixture", "note": "Deterministic fixture saved-condition result; no broker request was made." + (" Realtime registration is unavailable in fixture mode." if realtime else "")}
