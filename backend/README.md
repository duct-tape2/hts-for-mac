# Backend — read-only KR/US market viewer

This FastAPI service supplies the local read-only workstation. It supports
KR/US search, quotes, 10-level books, minute/day/week/month charts, shared
KR 0B/0D and US FE/FT subscriptions, and KR rankings/investor flow. It has no order,
account, position, trade-history, funds-transfer, or generic
broker-proxy routes.

The default is deterministic fixture data. Fixture responses say
`environment: "fixture"` and are never substituted after a real/demo broker
failure.

## Install and verify

```bash
cd backend
uv sync --locked --extra test
.venv/bin/pytest
```

Run the safe local fixture server:

```bash
cd backend
KIWOOM_ENABLED=false .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8010
```

The supported local endpoints are documented by the running service at
`http://127.0.0.1:8010/docs`. Bind the server to loopback only.

## Broker configuration

Run `python3 scripts/run_local.py --environment real` from the repository root, then use the app's `API 연결 설정` dialog. New credentials are validated through the official SDK before replacing an app-owned macOS Keychain record. The process-wide manager supplies SDK HTTP/WebSocket authentication, renews before the actual server expiry, and retains subscriptions through reauthentication. Use `demo` for mock credentials.

The registered key expiry is user-provided metadata (unset until explicitly entered during setup); it is separate from the server access token's expiry. The renewal reminder starts seven KST calendar days earlier. Auth responses contain status and a local setup capability, never the key pair or broker token. Browser writes require a trusted local origin, Fetch Metadata and `X-HTS-Setup`; responses use `Cache-Control: no-store`.

The compatibility option `--prompt-credentials` still passes credentials only to backend memory. It does not implicitly persist them. A valid legacy SDK token may be read into memory without modifying its file; new app-managed durable credentials/tokens belong in Keychain. Existing environment credentials are lower precedence than the pair explicitly saved in the app.

The backend never loads `.env`. The launcher selects these runtime settings to enable **read-only** Kiwoom requests:

```bash
KIWOOM_ENABLED=true
KIWOOM_MODE=real  # or demo
```

The bundled official SDK reads these credential variable names when it needs a
token:

| Mode | Credentials |
| --- | --- |
| `real` | `APP_KEY`, `APP_SECRET` |
| `demo` | `APP_KEY_MOCK`, `APP_SECRET_MOCK` |

Do not put credential values in logs, test fixtures, or source control. A
read-only application policy cannot reduce permissions embedded in a broker
credential; use credentials only after the fixture checks pass.

`KIWOOM_MODE` must be `real` or `demo` whenever `KIWOOM_ENABLED=true`.
Legacy `KIWOOM_ORDERS_ENABLED` is ignored. The SDK endpoint override variables
(`PRD`, `MOCK`, `W_PRD`, `W_MOCK`) are not a supported configuration surface:
the adapter rejects any host other than Kiwoom's exact official real/demo host
before client authentication or network I/O, and its transport disables
redirect following.

The market-stream registry refcounts full instrument identities and uses one
SDK client per official KR/US socket path. Each window multiplexes its feeds
over one POST SSE connection. A book frame cannot fabricate a last trade.
REST and websocket trade/book receipt times are tracked separately. Live
broker-session acceptance and actual intraday market-frame delivery are
different checks; see the latest validation report.

Chart caches are bounded by both entry count and 150,000 total bars. Initial
history reads cap at 32 pages; refresh reads cap at two newest pages. Earlier
session history is retained, so historical corporate-action revisions require
a fresh session/full history load. Snapshot failure never produces fixture data.

## Local watchlists

All watchlist changes are local-only and require a localhost Host/Origin.
They are atomically written as schema-v2 JSON to:

```text
${READONLY_DATA_DIR:-<repo>/data}/watchlist-v2.json
```

Set `READONLY_DATA_DIR` for browser smoke runs or tests. The pre-M0
`data/watchlist.json` file is not read, modified, or deleted. The explicit
`POST /api/watchlists/{id}/import-kiwoom` operation reads US HTS groups only;
it never runs at startup and never writes upstream.
