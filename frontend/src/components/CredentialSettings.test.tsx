import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialSettings } from "@/components/CredentialSettings";
import type { AuthStatus } from "@/lib/credentials";

const baseStatus: AuthStatus = {
  environment: "real",
  stored: false,
  storage: "none",
  status: "needs_credentials",
  registeredExpiresOn: null,
  remindOn: null,
  renewalDue: false,
  registrationExpired: false,
  tokenExpiresAt: "2026-10-24T02:03:04Z",
  lastRefreshAt: null,
  nextRetryAt: null,
  message: "등록된 API 키가 없습니다.",
  setupToken: "setup-token",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function openSettings() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "API 연결 설정" });
  const alreadyOpen = screen.queryByRole("dialog");
  if (alreadyOpen) return { dialog: alreadyOpen, trigger, user };
  await user.click(trigger);
  const dialog = screen.getByRole("dialog");
  return { dialog, trigger, user };
}

let dialogShimInstalled = false;

beforeEach(() => {
  const prototype = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
  if (!prototype.showModal) {
    Object.defineProperty(prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
    Object.defineProperty(prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
    dialogShimInstalled = true;
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  if (dialogShimInstalled) {
    delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).showModal;
    delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).close;
    dialogShimInstalled = false;
  }
});

describe("CredentialSettings", () => {
  it("opens first-use setup once with a blank expiry and requires the user-entered date", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(baseStatus));
    vi.stubGlobal("fetch", fetcher);
    render(<CredentialSettings environment="real" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("키움 포털에 표시된 API 키 등록 만료일을 직접 입력하세요");
    expect(screen.getByLabelText("API 키 등록 만료일 (직접 등록)")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("AppKey"), { target: { value: "app-key" } });
    fireEvent.change(screen.getByLabelText("AppSecret"), { target: { value: "app-secret" } });
    fireEvent.submit(screen.getByRole("button", { name: "안전하게 저장" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("등록 만료일을 모두 입력하세요");
    expect(fetcher).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("saves an existing launcher pair without sending secret fields to the browser API", async () => {
    const available = {...baseStatus, canSaveLauncher: true};
    const saved = {...baseStatus, stored: true, storage: "keychain" as const, status: "ready" as const, registeredExpiresOn: "2028-01-02", remindOn: "2027-12-26", canSaveLauncher: false};
    const fetcher = vi.fn().mockResolvedValueOnce(response(available)).mockResolvedValueOnce(response(saved));
    vi.stubGlobal("fetch", fetcher);
    const connected = vi.fn();
    render(<CredentialSettings environment="real" onConnected={connected} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const {user} = await openSettings();
    fireEvent.change(screen.getByLabelText("API 키 등록 만료일 (직접 등록)"), { target: { value: "2028-01-02" } });
    await user.click(screen.getByRole("button", {name: "현재 연결 키를 키체인에 저장"}));
    await waitFor(() => expect(connected).toHaveBeenCalled());
    const [path, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/auth/credentials/from-launcher");
    expect(JSON.parse(String(init.body))).toEqual({registeredExpiresOn: "2028-01-02"});
    expect(new Headers(init.headers).get("X-HTS-Setup")).toBe("setup-token");
    expect(localStorage.length).toBe(0);
  });

  it("posts the pair with the in-memory setup capability and scrubs fields after success", async () => {
    const saved = { ...baseStatus, stored: true, storage: "keychain" as const, status: "ready" as const, registeredExpiresOn: "2028-01-02", remindOn: "2027-12-26", message: "키체인에 저장됨" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(baseStatus))
      .mockResolvedValueOnce(response(saved));
    vi.stubGlobal("fetch", fetcher);
    const onConnected = vi.fn();
    render(<CredentialSettings environment="real" onConnected={onConnected} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const { dialog, trigger, user } = await openSettings();
    const appKey = screen.getByLabelText("AppKey");
    const appSecret = screen.getByLabelText("AppSecret");
    fireEvent.change(appKey, { target: { value: "app-key" } });
    fireEvent.change(appSecret, { target: { value: "app-secret" } });
    fireEvent.change(screen.getByLabelText("API 키 등록 만료일 (직접 등록)"), { target: { value: "2028-01-02" } });
    await user.click(screen.getByRole("button", { name: "안전하게 저장" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(saved));
    const [path, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/auth/credentials");
    expect(new Headers(init.headers).get("X-HTS-Setup")).toBe("setup-token");
    expect(JSON.parse(String(init.body))).toEqual({ appKey: "app-key", appSecret: "app-secret", registeredExpiresOn: "2028-01-02" });
    expect(dialog).not.toHaveAttribute("open");
    expect(appKey).toHaveValue("");
    expect(appSecret).toHaveValue("");
    expect(trigger).toHaveFocus();
    expect(localStorage.length).toBe(0);
  });

  it("keeps the old dialog open with a safe error when save fails", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(baseStatus))
      .mockResolvedValueOnce(response({ detail: "provider app-secret=do-not-echo" }, 500));
    vi.stubGlobal("fetch", fetcher);
    render(<CredentialSettings environment="real" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const { dialog, user } = await openSettings();
    fireEvent.change(screen.getByLabelText("AppKey"), { target: { value: "app-key" } });
    fireEvent.change(screen.getByLabelText("AppSecret"), { target: { value: "app-secret" } });
    fireEvent.change(screen.getByLabelText("API 키 등록 만료일 (직접 등록)"), { target: { value: "2028-01-02" } });
    await user.click(screen.getByRole("button", { name: "안전하게 저장" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("인증 정보를 저장하지 못했습니다");
    expect(alert).not.toHaveTextContent("app-secret");
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByLabelText("AppSecret")).toHaveValue("app-secret");
  });

  it("refreshes an expired setup capability without replaying the secret body", async () => {
    const fresh = { ...baseStatus, setupToken: "fresh-setup-token" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(baseStatus))
      .mockResolvedValueOnce(response({ detail: "expired" }, 403))
      .mockResolvedValueOnce(response(fresh));
    vi.stubGlobal("fetch", fetcher);
    render(<CredentialSettings environment="real" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const { user } = await openSettings();
    fireEvent.change(screen.getByLabelText("AppKey"), { target: { value: "app-key" } });
    fireEvent.change(screen.getByLabelText("AppSecret"), { target: { value: "app-secret" } });
    fireEvent.change(screen.getByLabelText("API 키 등록 만료일 (직접 등록)"), { target: { value: "2028-01-02" } });
    await user.click(screen.getByRole("button", { name: "안전하게 저장" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("새 권한을 받았습니다"));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][0]).toBe("/api/auth/credentials");
    expect(fetcher.mock.calls[2][0]).toBe("/api/auth/status");
  });

  it("keeps registration expiry separate from the server token expiry and shows due reminders", async () => {
    const due = { ...baseStatus, registeredExpiresOn: "2028-01-02", renewalDue: true, remindOn: "2027-12-26" };
    const fetcher = vi.fn().mockResolvedValue(response(due));
    vi.stubGlobal("fetch", fetcher);
    render(<CredentialSettings environment="real" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("갱신 안내"));
    const { dialog } = await openSettings();
    expect(screen.getByLabelText("API 키 등록 만료일 (직접 등록)")).toHaveValue("2028-01-02");
    expect(dialog).toHaveTextContent("접속 토큰 만료");
    expect(dialog).toHaveTextContent("2026");
    expect(dialog).toHaveTextContent("2027-12-26");
  });

  it("does not overwrite an edited expiry date during status refresh and removes focus polling on unmount", async () => {
    const initial = { ...baseStatus, registeredExpiresOn: "2028-01-02", remindOn: "2027-12-26" };
    const refreshed = { ...initial, registeredExpiresOn: "2029-02-03", remindOn: "2029-01-27" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(initial))
      .mockResolvedValueOnce(response(refreshed));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<CredentialSettings environment="real" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await openSettings();
    const expiry = screen.getByLabelText("API 키 등록 만료일 (직접 등록)");
    fireEvent.change(expiry, { target: { value: "2030-03-04" } });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(expiry).toHaveValue("2030-03-04");

    view.unmount();
    fireEvent(window, new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the modal open and blocks close while a credential write is pending", async () => {
    let resolveSave!: (value: Response) => void;
    const savePending = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(baseStatus))
      .mockReturnValueOnce(savePending);
    vi.stubGlobal("fetch", fetcher);
    render(<CredentialSettings environment="real" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const { dialog } = await openSettings();
    fireEvent.change(screen.getByLabelText("AppKey"), { target: { value: "app-key" } });
    fireEvent.change(screen.getByLabelText("AppSecret"), { target: { value: "app-secret" } });
    fireEvent.change(screen.getByLabelText("API 키 등록 만료일 (직접 등록)"), { target: { value: "2028-01-02" } });
    fireEvent.submit(screen.getByRole("button", { name: "안전하게 저장" }).closest("form")!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "API 연결 설정 닫기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    resolveSave(response({ ...baseStatus, stored: true, storage: "keychain", status: "ready", registeredExpiresOn: "2028-01-02", remindOn: "2027-12-26" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });

  it("disables registration in fixture mode and does not make a broker write call", async () => {
    const fixtureStatus = { ...baseStatus, environment: "fixture" as const };
    const fetcher = vi.fn().mockResolvedValue(response(fixtureStatus));
    vi.stubGlobal("fetch", fetcher);
    render(<CredentialSettings environment="fixture" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await openSettings();
    expect(screen.getByText(/테스트 데이터 환경에서는 실제 브로커 호출/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "안전하게 저장" })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});


it("distinguishes a live temporary token from saved renewal credentials", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...baseStatus, status: "ready", stored: false })));
  render(<CredentialSettings environment="real" />);
  expect(await screen.findByLabelText("API 연결 상태: 임시 토큰 · 키 미저장")).toBeInTheDocument();
  expect(screen.queryByText("API · 연결 · 자동 갱신")).not.toBeInTheDocument();
});


it("does not label fixture mode as a live temporary token", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...baseStatus, environment: "fixture", status: "ready" })));
  render(<CredentialSettings environment="fixture" />);
  expect(screen.getByLabelText("API 연결 상태: 테스트 · API 미사용")).toBeInTheDocument();
});
it("shows an expired registration even while its current token is usable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...baseStatus, status: "ready", stored: true, storage: "keychain", registeredExpiresOn: "2028-01-02", remindOn: "2027-12-26", registrationExpired: true })));
  render(<CredentialSettings environment="real" />);
  expect(await screen.findByLabelText("API 연결 상태: 연결 · 등록 갱신 필요")).toBeInTheDocument();
});


it("keeps saved credentials for transient refresh failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({ ...baseStatus, status: "error", stored: true, storage: "keychain", registeredExpiresOn: "2028-01-02", remindOn: "2027-12-26", message: "다음 조회에서 자동 재시도합니다." })));
  render(<CredentialSettings environment="real" />);
  await openSettings();
  expect(await screen.findByText(/저장된 키로 자동 재시도/)).toBeInTheDocument();
  expect(screen.queryByText(/자동 갱신을 위해 키 확인 필요/)).not.toBeInTheDocument();
});
