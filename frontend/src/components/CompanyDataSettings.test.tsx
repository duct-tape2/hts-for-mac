import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyDataSettings, validateCompanyDartKey, validateCompanySecUserAgent } from "@/components/CompanyDataSettings";
import type { AuthStatus } from "@/lib/credentials";

const key = "a".repeat(40);
const auth: AuthStatus = {
  environment: "real", stored: false, storage: "none", status: "needs_credentials",
  registeredExpiresOn: null, remindOn: null, renewalDue: false, registrationExpired: false,
  tokenExpiresAt: null, lastRefreshAt: null, nextRetryAt: null, message: "", setupToken: "setup-token",
};
const emptyStatus = { environment: "real", secUserAgentConfigured: false, dartKeyConfigured: false, secSettingsStorage: "none", dartStorage: "none" };
const configuredStatus = { ...emptyStatus, secUserAgentConfigured: true, dartKeyConfigured: true, secSettingsStorage: "local", dartStorage: "keychain" };

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fetcher(initial = emptyStatus) {
  return vi.fn((path: string, init?: RequestInit) => {
    if (path === "/api/auth/status") return Promise.resolve(response(auth));
    if (path === "/api/company-credentials/status") return Promise.resolve(response(initial));
    if (path === "/api/company-credentials/dart-key/delete") return Promise.resolve(response(emptyStatus));
    if (path === "/api/company-credentials/dart-key") return Promise.resolve(response(configuredStatus));
    if (path === "/api/company-credentials/sec-user-agent") return Promise.resolve(response(configuredStatus));
    return Promise.resolve(response({ detail: "unexpected" }, 500));
  });
}

let dialogShim = false;

beforeEach(() => {
  const prototype = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
  if (!prototype.showModal) {
    Object.defineProperty(prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
    Object.defineProperty(prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
    dialogShim = true;
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  if (dialogShim) {
    delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).showModal;
    delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).close;
    dialogShim = false;
  }
});

describe("CompanyDataSettings", () => {
  it("validates a labeled SEC contact and exact DART key before any write", async () => {
    const request = fetcher();
    vi.stubGlobal("fetch", request);
    render(<CompanyDataSettings environment="real" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await userEvent.setup().click(screen.getByRole("button", { name: "회사·공시 설정" }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("SEC 연락처 User-Agent"), { target: { value: "contact@example.invalid" } });
    fireEvent.submit(screen.getByRole("button", { name: "SEC 연락처 저장" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("앱 이름과 실제 연락 이메일");
    expect(request.mock.calls.filter(([path, init]) => path !== "/api/auth/status" && path !== "/api/company-credentials/status" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
    expect(validateCompanySecUserAgent("Moa Desk support@example.invalid")).toBe(true);
    expect(validateCompanySecUserAgent("모아 데스크 support@example.invalid")).toBe(false);
    expect(validateCompanySecUserAgent("Moa\r\nDesk support@example.invalid")).toBe(false);
    expect(validateCompanyDartKey(key)).toBe(true);
    expect(validateCompanyDartKey("short")).toBe(false);
  });

  it("posts a DART key with the in-memory capability then clears it without browser storage", async () => {
    const request = fetcher();
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<CompanyDataSettings environment="real" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "회사·공시 설정" }));
    const input = screen.getByLabelText("OpenDART API 키");
    await user.type(input, key);
    await user.click(screen.getByRole("button", { name: "DART 키 저장" }));

    await waitFor(() => expect(input).toHaveValue(""));
    const write = request.mock.calls.find(([path, init]) => path === "/api/company-credentials/dart-key" && (init as RequestInit).method === "POST") as [string, RequestInit];
    expect(new Headers(write[1].headers).get("X-HTS-Setup")).toBe("setup-token");
    expect(JSON.parse(String(write[1].body))).toEqual({ dartApiKey: key });
    expect(localStorage.length).toBe(0);
    expect(screen.getByText("DART 키: 설정됨")).toBeInTheDocument();
  });

  it("uses a POST deletion request and leaves optional settings disabled in fixture mode", async () => {
    const request = fetcher(configuredStatus);
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<CompanyDataSettings environment="real" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "회사·공시 설정" }));
    await user.click(screen.getByRole("button", { name: "DART 키 삭제" }));
    await waitFor(() => expect(request.mock.calls.some(([path, init]) => path === "/api/company-credentials/dart-key/delete" && (init as RequestInit).method === "POST")).toBe(true));

    cleanup();
    const fixtureRequest = fetcher({ ...emptyStatus, environment: "fixture" });
    vi.stubGlobal("fetch", fixtureRequest);
    render(<CompanyDataSettings environment="fixture" />);
    await waitFor(() => expect(fixtureRequest).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "회사·공시 설정" }));
    expect(screen.getByRole("button", { name: "DART 키 저장" })).toBeDisabled();
    expect(screen.getByText("테스트 데이터 환경에서는 실제 SEC/DART 설정을 저장하지 않습니다.")).toBeInTheDocument();
  });
});
