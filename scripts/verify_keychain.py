#!/usr/bin/env python3
"""Exercise native Keychain replacement using an isolated synthetic item only.

Run from any directory with the project's backend Python. No network request,
real credential lookup, or application Keychain item is used.
"""
from __future__ import annotations

import secrets
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))


def main() -> int:
    if sys.platform != "darwin":
        print("NOT RUN: native Keychain requires macOS.")
        return 2
    from app.credentials import CredentialStoreUnavailable, KeychainCredentialStore, StoredCredential
    from keyring.backends.macOS import api

    service = "kiwoom-mac-hts-atomic-selftest-" + secrets.token_hex(8)

    class IsolatedStore(KeychainCredentialStore):
        @property
        def service_name(self) -> str:
            return service

    store = IsolatedStore("real")
    first = StoredCredential("synthetic-key-first", "synthetic-secret-first", date(2027, 10, 23))
    second = StoredCredential("synthetic-key-second", "synthetic-secret-second", date(2028, 10, 23))
    created = False
    try:
        store.create(first)
        created = True
        assert store.read() == first
        try:
            store.create(second)
        except CredentialStoreUnavailable:
            pass
        else:
            raise AssertionError("create-only save must not overwrite an existing item")
        assert store.read() == first
        print("PASS: create-only registration rejects a duplicate without overwrite")
        store.write(second)
        assert store.read() == second
        print("PASS: native first write and credential replacement")

        original_update, original_add = api._sec.SecItemUpdate, api.SecItemAdd

        def fail_update(*_args):
            return -50

        def forbidden_add(*_args):
            raise AssertionError("failed replacement must not add or delete")

        try:
            api._sec.SecItemUpdate, api.SecItemAdd = fail_update, forbidden_add
            try:
                store.write(first)
            except CredentialStoreUnavailable:
                pass
            else:
                raise AssertionError("replacement failure must be reported")
        finally:
            api._sec.SecItemUpdate, api.SecItemAdd = original_update, original_add
        assert store.read() == second
        print("PASS: failed replacement preserves the previous durable record")
        return 0
    except Exception as exc:
        print(f"FAIL: native Keychain verification ({type(exc).__name__}); no real credentials used.")
        return 1
    finally:
        if created:
            try:
                api.delete_generic_password(None, service, "credential-v1")
                print("PASS: isolated synthetic item removed")
            except Exception:
                print("FAIL: synthetic item cleanup requires checking the selftest Keychain service.")
                raise SystemExit(1) from None


if __name__ == "__main__":
    raise SystemExit(main())
