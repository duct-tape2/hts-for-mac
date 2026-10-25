"""Runtime configuration with a safe, explicit broker boundary."""
from __future__ import annotations

import os
from pathlib import Path


def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    return default if raw is None else raw.strip().lower() in {"1", "true", "yes", "on"}


KIWOOM_ENABLED = _flag("KIWOOM_ENABLED")
_configured_mode = (os.getenv("KIWOOM_MODE") or "real").strip().lower()
if _configured_mode not in {"real", "demo"}:
    if KIWOOM_ENABLED:
        raise RuntimeError("KIWOOM_MODE must be real or demo when KIWOOM_ENABLED=true")
    _configured_mode = "real"
KIWOOM_MODE = _configured_mode

# The legacy KIWOOM_ORDERS_ENABLED flag is deliberately not consumed.
ENVIRONMENT = KIWOOM_MODE if KIWOOM_ENABLED else "fixture"

# The existing data/watchlist.json is never read, changed, or removed.
DATA_DIR = Path(os.getenv("READONLY_DATA_DIR") or (Path(__file__).resolve().parents[2] / "data")).expanduser()
