#!/usr/bin/env python3
"""Read-only runtime evidence. Never prints auth payloads or requests credentials."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


SCREENS = ("0198", "0187", "0186", "0184", "0162", "0602", "0211", "0780", "2797", "0200", "0700")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--screens", default=",".join(SCREENS))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("invalid local port")
    codes = args.screens.split(",")
    if any(code not in SCREENS for code in codes):
        parser.error("unknown captured screen")
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "checks": []}
    for code in codes:
        record = {"screen": code}
        try:
            with urlopen(f"http://127.0.0.1:{args.port}/api/hts/screens/{code}", timeout=45) as response:
                data = json.loads(response.read(4_000_000))
            assert data["screen"] == code
            assert isinstance(data["columns"], list) and isinstance(data["rows"], list)
            record.update({key: data.get(key) for key in ("status", "source", "environment", "asOf", "complete")})
            record.update(rows=len(data["rows"]), bars=len(data.get("bars", [])), news=len(data.get("news", [])), sections=[{"title": x.get("title"), "status": x.get("status"), "source": x.get("source"), "rows": len(x.get("rows", []))} for x in data.get("sections", [])], schema="PASS")
        except (HTTPError, URLError, AssertionError, KeyError, ValueError, TimeoutError) as exc:
            record.update(schema="FAIL", error=type(exc).__name__)
        report["checks"].append(record)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(any(item["schema"] != "PASS" for item in report["checks"]))


if __name__ == "__main__":
    raise SystemExit(main())
