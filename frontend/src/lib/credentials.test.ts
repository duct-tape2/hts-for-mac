import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialApiError, getAuthStatus, parseAuthStatus, saveAuthCredentials } from "@/lib/credentials";

const status = {
  environment: "real",
  stored: true,
  storage: "keychain",
  status: "ready",
  registeredExpiresOn: "2028-01-02",
  remindOn: "2027-12-26",
  renewalDue: false,
  registrationExpired: false,
  tokenExpiresAt: "2026-10-24T02:03:04Z",
  lastRefreshAt: null,
  nextRetryAt: null,
  message: "키체인에 저장됨",
  setupToken: "setup-token",
} as const;

afterEach(() => vi.restoreAllMocks());

describe("credentials API boundary", () => {
  it("validates the documented status shape and rejects malformed dates", () => {
    expect(parseAuthStatus(status)).toMatchObject({ environment: "real", registeredExpiresOn: "2028-01-02" });
    expect(() => parseAuthStatus({ ...status, registeredExpiresOn: "23-10-2027" })).toThrow();
    expect(() => parseAuthStatus({ ...status, setupToken: "" })).toThrow();
  });

  it("accepts an unregistered status only with unknown dates and no renewal flags", () => {
    const fresh = { ...status, stored: false, storage: "none", status: "needs_credentials", registeredExpiresOn: null, remindOn: null, renewalDue: false, registrationExpired: false };
    expect(parseAuthStatus(fresh)).toMatchObject({ registeredExpiresOn: null, remindOn: null, renewalDue: false, registrationExpired: false });
    expect(() => parseAuthStatus({ ...fresh, renewalDue: true })).toThrow(CredentialApiError);
    expect(() => parseAuthStatus({ ...fresh, remindOn: "2027-12-26" })).toThrow(CredentialApiError);
  });

  it("uses same-origin no-store requests and never stores or echoes credential secrets", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await saveAuthCredentials("capability", { appKey: "app-key", appSecret: "app-secret", registeredExpiresOn: "2028-01-02" });
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/auth/credentials");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "omit" });
    expect(new Headers(init.headers).get("X-HTS-Setup")).toBe("capability");
    expect(JSON.parse(String(init.body))).toEqual({ appKey: "app-key", appSecret: "app-secret", registeredExpiresOn: "2028-01-02" });
    expect(localStorage.getItem("appSecret")).toBeNull();
  });

  it("reads status without a secret body and converts server failures to safe errors", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))
      .mockResolvedValueOnce(new Response("provider detail app-secret=do-not-echo", { status: 500 }))
      .mockResolvedValueOnce(new Response("provider detail app-secret=do-not-echo", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);

    await getAuthStatus();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store", credentials: "omit" });
    await expect(getAuthStatus()).rejects.toMatchObject({ message: "인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.", status: 500 });
    expect(fetcher.mock.calls[1][1]).not.toHaveProperty("body");
    await expect(saveAuthCredentials("capability", { appKey: "app-key", appSecret: "app-secret", registeredExpiresOn: "2028-01-02" })).rejects.toThrow("인증 정보를 저장하지 못했습니다");
  });
});
