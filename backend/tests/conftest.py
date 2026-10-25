"""Tests always start in fixture mode and never load a dotenv file."""
from __future__ import annotations

import os
import tempfile


os.environ["KIWOOM_ENABLED"] = "false"
os.environ.pop("KIWOOM_ORDERS_ENABLED", None)
os.environ.pop("PRD", None)
os.environ.pop("MOCK", None)
os.environ.pop("W_PRD", None)
os.environ.pop("W_MOCK", None)
os.environ["READONLY_DATA_DIR"] = tempfile.mkdtemp(prefix="kiwoom-readonly-tests-")
