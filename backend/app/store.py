"""Versioned, local-only watchlist persistence for the read-only viewer."""
from __future__ import annotations

import json
import math
import os
import re
from copy import deepcopy
from pathlib import Path
from threading import Lock
from uuid import uuid4

from app.config import DATA_DIR, ENVIRONMENT


# Do not reuse or delete the pre-M0 file. It can contain a user's former
# broker-imported groups and is intentionally left untouched.
WATCHLIST_FILE = DATA_DIR / "watchlist-v2.json"
SCHEMA_VERSION = 2
_TRANSFER_INSTRUMENT_KEYS = {
    "market", "stkCd", "stkNm", "stexTp", "listingVenue", "quoteVenue", "currency",
}


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def _clean_number(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _instrument(payload: dict) -> dict:
    market = str(payload.get("market") or "US").upper()
    if market not in {"KR", "US"}:
        raise ValueError("market must be KR or US")
    code = str(payload.get("stkCd") or "").strip()
    if market == "KR":
        if not (re.fullmatch(r"[0-9A-Z]{6}", code)):
            raise ValueError("KR stkCd must be a six-character KRX code")
        stex, quote, currency = "KRX", "KRX", "KRW"
        listing = str(payload.get("listingVenue") or "KOSPI").upper()
        if listing not in {"KOSPI", "KOSDAQ"}:
            raise ValueError("KR listingVenue must be KOSPI or KOSDAQ")
    else:
        code = code.upper()
        if not re.fullmatch(r"[A-Z][A-Z0-9.]{0,14}", code):
            raise ValueError("US stkCd is invalid")
        stex = str(payload.get("stexTp") or payload.get("quoteVenue") or "ND").upper()
        if stex not in {"ND", "NY", "NA"}:
            raise ValueError("US stexTp must be ND, NY, or NA")
        quote, currency = stex, "USD"
        listing = str(payload.get("listingVenue") or {"ND": "NASDAQ", "NY": "NYSE", "NA": "AMEX"}[stex]).upper()
        if listing != {"ND": "NASDAQ", "NY": "NYSE", "NA": "AMEX"}[stex]:
            raise ValueError("US listingVenue does not match stexTp")
    return {
        "market": market,
        "stkCd": code,
        "stkNm": str(payload.get("stkNm") or code).strip() or code,
        "stexTp": stex,
        "listingVenue": listing,
        "quoteVenue": quote,
        "currency": currency,
        # The server's configured environment is authoritative. A browser may
        # echo stale item data, but it must not relabel a local selection or
        # create a second identity by forging fixture/real/demo here.
        "environment": ENVIRONMENT,
    }


def _transfer_instrument(payload: object) -> dict:
    """Accept only a portable identity; never a quote, token, or arbitrary field."""
    if not isinstance(payload, dict) or set(payload) != _TRANSFER_INSTRUMENT_KEYS:
        raise ValueError("invalid transferred instrument")
    if any(not isinstance(payload[key], str) or len(payload[key]) > 120 for key in _TRANSFER_INSTRUMENT_KEYS):
        raise ValueError("invalid transferred instrument")
    result = _instrument(payload)
    # Unlike normal item entry, transfer input is not allowed to rely on any
    # coercion or default venue/currency.  This makes the identity unambiguous.
    if any(payload[key] != result[key] for key in _TRANSFER_INSTRUMENT_KEYS):
        raise ValueError("inconsistent transferred instrument")
    return result


class AppStore:
    def __init__(self, path: Path = WATCHLIST_FILE) -> None:
        self._lock = Lock()
        self._path = path
        self._state = self._load()

    @staticmethod
    def _initial() -> dict:
        return {
            "mode": "fixture",
            "kiwoom": "disconnected",
            "kiwoomError": "",
            "watchlistNote": "",
            "watchlists": [{"id": "wl_default", "name": "관심종목", "source": "app"}],
            "items": [],
        }

    def _load(self) -> dict:
        state = self._initial()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
                return state
            groups, items = raw.get("watchlists"), raw.get("items")
            if not isinstance(groups, list) or not isinstance(items, list):
                return state
            clean_groups = [
                {"id": str(g["id"]), "name": str(g["name"]), "source": str(g.get("source") or "app"), **({"gcod": str(g["gcod"])} if g.get("gcod") else {})}
                for g in groups if isinstance(g, dict) and g.get("id") and g.get("name")
            ]
            known = {g["id"] for g in clean_groups}
            clean_items = []
            normalized_identities: set[tuple[str, ...]] = set()
            for row in items:
                if not isinstance(row, dict) or str(row.get("watchlistId") or "") not in known:
                    continue
                try:
                    # Capture persisted provenance before _instrument applies
                    # the current authoritative environment.
                    persisted_environment = str(row.get("environment") or "unknown")
                    item = {
                        "id": str(row.get("id") or _uid("item")), "watchlistId": str(row["watchlistId"]),
                        **_instrument(row), "enabled": bool(row.get("enabled", True)),
                        "last": _clean_number(row.get("last")), "prevClose": _clean_number(row.get("prevClose")),
                        "open": _clean_number(row.get("open")), "changePct": _clean_number(row.get("changePct")),
                    }
                    if persisted_environment != ENVIRONMENT:
                        item.update({"last": None, "prevClose": None, "open": None, "changePct": None})
                    identity = (item["watchlistId"], item["market"], item["stkCd"], item["listingVenue"], item["quoteVenue"], item["environment"])
                    if identity in normalized_identities:
                        continue
                    normalized_identities.add(identity)
                    clean_items.append(item)
                except ValueError:
                    continue
            if clean_groups:
                state["watchlists"], state["items"] = clean_groups, clean_items
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        return state

    def _persist_unlocked(self) -> None:
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload = {"schemaVersion": SCHEMA_VERSION, "watchlists": self._state["watchlists"], "items": self._state["items"]}
        tmp = self._path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            os.chmod(tmp, 0o600)
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self._path)

    def snapshot(self) -> dict:
        with self._lock:
            return deepcopy(self._state)

    def runtime_status(self, *, mode: str, connected: bool, error: str = "") -> dict:
        with self._lock:
            self._state["mode"] = mode
            self._state["kiwoom"] = "connected" if connected else "disconnected"
            self._state["kiwoomError"] = error
            return deepcopy(self._state)

    def add_watchlist(self, name: str) -> dict:
        name = name.strip()
        if not name:
            raise ValueError("name is required")
        with self._lock:
            self._state["watchlists"].append({"id": _uid("wl"), "name": name, "source": "app"})
            self._persist_unlocked()
            return deepcopy(self._state)

    def remove_watchlist(self, watchlist_id: str) -> dict:
        with self._lock:
            if watchlist_id == "wl_default":
                return deepcopy(self._state)
            self._state["watchlists"] = [g for g in self._state["watchlists"] if g["id"] != watchlist_id]
            self._state["items"] = [row for row in self._state["items"] if row["watchlistId"] != watchlist_id]
            self._persist_unlocked()
            return deepcopy(self._state)

    def add_item(self, watchlist_id: str, payload: dict) -> dict:
        instrument = _instrument(payload)
        with self._lock:
            if not any(group["id"] == watchlist_id for group in self._state["watchlists"]):
                raise ValueError("watchlist not found")
            identity = tuple(instrument[key] for key in ("market", "stkCd", "listingVenue", "quoteVenue", "environment"))
            exists = any(
                row["watchlistId"] == watchlist_id
                and tuple(row[key] for key in ("market", "stkCd", "listingVenue", "quoteVenue", "environment")) == identity
                for row in self._state["items"]
            )
            if not exists:
                self._state["items"].append({
                    "id": _uid("item"), "watchlistId": watchlist_id, **instrument,
                    "enabled": bool(payload.get("enabled", True)), "last": _clean_number(payload.get("last")),
                    "prevClose": _clean_number(payload.get("prevClose")), "open": _clean_number(payload.get("open")),
                    "changePct": _clean_number(payload.get("changePct")),
                })
                self._persist_unlocked()
            return deepcopy(self._state)

    def remove_item(self, watchlist_id: str, item_id: str) -> dict:
        with self._lock:
            self._state["items"] = [row for row in self._state["items"] if not (row["watchlistId"] == watchlist_id and row["id"] == item_id)]
            self._persist_unlocked()
            return deepcopy(self._state)

    def toggle_item(self, watchlist_id: str, item_id: str) -> dict:
        with self._lock:
            for row in self._state["items"]:
                if row["watchlistId"] == watchlist_id and row["id"] == item_id:
                    row["enabled"] = not row["enabled"]
                    break
            self._persist_unlocked()
            return deepcopy(self._state)

    def save(self) -> dict:
        with self._lock:
            self._persist_unlocked()
            return deepcopy(self._state)

    def import_kiwoom(self, _target_id: str, groups: list[dict]) -> dict:
        """Merge explicit read-only HTS groups without touching app groups."""
        with self._lock:
            added = 0
            for source_group in groups:
                gcod = str(source_group.get("gcod") or "").strip()
                if not gcod:
                    continue
                group_id = f"wl_hts_{gcod}"
                group = next((row for row in self._state["watchlists"] if row["id"] == group_id), None)
                if group is None:
                    self._state["watchlists"].append({"id": group_id, "name": str(source_group.get("name") or "HTS 관심종목"), "source": "kiwoom_import", "gcod": gcod})
                else:
                    group["name"] = str(source_group.get("name") or group["name"])
                # Only refresh this imported group's prior imported rows. App
                # groups (and every other imported group) remain intact.
                self._state["items"] = [row for row in self._state["items"] if row["watchlistId"] != group_id]
                for source_item in source_group.get("items") or []:
                    try:
                        instrument = _instrument(source_item)
                    except ValueError:
                        continue
                    self._state["items"].append({"id": _uid("item"), "watchlistId": group_id, **instrument, "enabled": True, "last": None, "prevClose": None, "open": None, "changePct": None})
                    added += 1
            self._state["watchlistNote"] = f"키움 관심그룹에서 {added}종목을 읽었습니다. 앱 로컬에만 저장됩니다."
            self._persist_unlocked()
            return deepcopy(self._state)

    def import_local_watchlists(self, groups: list[dict]) -> dict:
        """Non-destructively merge a secret-free portable watchlist document."""
        if not isinstance(groups, list) or len(groups) > 64:
            raise ValueError("invalid transferred watchlists")
        with self._lock:
            previous = self._state
            next_state = deepcopy(previous)
            total = added_groups = added_items = 0
            imported_names: set[str] = set()
            for group in groups:
                if not isinstance(group, dict) or set(group) != {"name", "instruments"}:
                    raise ValueError("invalid transferred watchlist")
                name, instruments = group["name"], group["instruments"]
                if not isinstance(name, str) or not (name := name.strip()) or len(name) > 80:
                    raise ValueError("invalid transferred watchlist name")
                normalized_name = name.casefold()
                if normalized_name in imported_names or not isinstance(instruments, list) or len(instruments) > 250:
                    raise ValueError("invalid transferred watchlist")
                imported_names.add(normalized_name)
                total += len(instruments)
                if total > 2_000:
                    raise ValueError("too many transferred instruments")
                # Existing groups retain their id, name, source, and members.
                target = next((item for item in next_state["watchlists"] if str(item["name"]).casefold() == normalized_name), None)
                if target is None:
                    target = {"id": _uid("wl"), "name": name, "source": "app"}
                    next_state["watchlists"].append(target)
                    added_groups += 1
                target_id = target["id"]
                existing = {
                    (item["market"], item["stkCd"], item["listingVenue"], item["quoteVenue"], item["environment"])
                    for item in next_state["items"] if item["watchlistId"] == target_id
                }
                incoming: set[tuple[str, ...]] = set()
                for raw in instruments:
                    instrument = _transfer_instrument(raw)
                    identity = tuple(instrument[key] for key in ("market", "stkCd", "listingVenue", "quoteVenue", "environment"))
                    if identity in incoming:
                        raise ValueError("duplicate transferred instrument")
                    incoming.add(identity)
                    if identity in existing:
                        continue
                    next_state["items"].append({
                        "id": _uid("item"), "watchlistId": target_id, **instrument, "enabled": True,
                        "last": None, "prevClose": None, "open": None, "changePct": None,
                    })
                    existing.add(identity)
                    added_items += 1
            next_state["watchlistNote"] = f"전송 파일에서 {added_groups}개 그룹과 {added_items}종목을 병합했습니다. 앱 로컬에만 저장됩니다."
            self._state = next_state
            try:
                self._persist_unlocked()
            except Exception:
                self._state = previous
                raise
            return deepcopy(next_state)


store = AppStore()
