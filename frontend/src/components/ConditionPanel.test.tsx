import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConditionPanel } from "@/components/ConditionPanel";
import { api } from "@/lib/api";
import { apple, samsung } from "@/test/fixtures";

const auth = {
  environment: "fixture", stored: false, storage: "none", status: "needs_credentials",
  registeredExpiresOn: null, remindOn: null, renewalDue: false, registrationExpired: false,
  tokenExpiresAt: null, lastRefreshAt: null, nextRetryAt: null, message: "", setupToken: "setup-token",
};
const REGISTRATION_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const REGISTRATION_B = "b1b2c3d4e5f60718293a4b5c6d7e8f90";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function fetcher(statusPayload: unknown = { active: true, state: "active", registrationId: REGISTRATION_A, note: "문서화된 편입·이탈 이벤트를 기다리는 중입니다.", events: [] }) {
  return vi.fn((path: string, init?: RequestInit) => {
    if (path === "/api/auth/status") return Promise.resolve(response(auth));
    if (path === "/api/conditions/KR/list") return Promise.resolve(response({ market: "KR", conditions: [{ seq: "4", name: "대형주 조건" }] }));
    if (path === "/api/conditions/KR/result?seq=4") return Promise.resolve(response({ market: "KR", seq: "4", complete: true, note: "", rows: [{ item: "A005930", name: "삼성전자", fields: { "9001": "A005930", "302": "삼성전자", unexpected: "보존됨" } }] }));
    if (path === "/api/conditions/KR/subscribe") return Promise.resolve(response({ market: "KR", seq: "4", complete: true, note: "", live: { state: "active", registrationId: REGISTRATION_A }, rows: [{ item: "A005930", name: "삼성전자", fields: { "9001": "A005930" } }] }));
    if (path === "/api/conditions/KR/status?seq=4") return Promise.resolve(response(statusPayload));
    if (path === "/api/conditions/KR/unsubscribe") return Promise.resolve(response({ market: "KR", seq: "4", unsubscribed: true }));
    return Promise.resolve(response({ detail: "unexpected" }, 500));
  });
}

async function loadAndSelect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "조건식 목록 새로고침" }));
  await user.click(await screen.findByRole("button", { name: /대형주 조건/ }));
  await screen.findByText("보존됨");
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ConditionPanel", () => {
  it("distinguishes a successfully empty saved-condition list from an unread list", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response({market:"KR", conditions:[]}))));
    const user = userEvent.setup();
    render(<ConditionPanel instrument={samsung} />);
    await user.click(screen.getByRole("button", {name:"조건식 목록 새로고침"}));
    expect(await screen.findByText("키움에서 반환한 저장 조건식이 없습니다.")).toBeInTheDocument();
  });

  it("only reads a normal result after explicit list refresh and preserves unknown raw fields safely", async () => {
    const request = fetcher();
    const onPick = vi.fn();
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ConditionPanel instrument={samsung} onPick={onPick} />);
    expect(request).not.toHaveBeenCalled();

    await loadAndSelect(user);
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/conditions/KR/list", "/api/conditions/KR/result?seq=4"]);
    expect(screen.getByText("unexpected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "종목 열기" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ market: "KR", stkCd: "005930", listingVenue: "KOSPI" }));
  });

  it("starts only from the explicit control with the in-memory capability and exposes actual membership status", async () => {
    const request = fetcher({ active: true, state: "active", registrationId: REGISTRATION_A, note: "문서화된 편입·이탈 이벤트를 수신 중입니다.", events: [{ sequence: 1, action: "I", item: "005930", name: "삼성전자", receivedAt: "2026-10-25T01:02:03Z" }] });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/subscribe")).toBe(false);

    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    await screen.findByText("실시간 이벤트 수신 중");
    expect(screen.getByRole("button", {name:"조건식 목록 새로고침"})).toBeDisabled();
    const subscription = request.mock.calls.find(([path]) => path === "/api/conditions/KR/subscribe") as [string, RequestInit];
    expect(new Headers(subscription[1].headers).get("X-HTS-Setup")).toBe("setup-token");
    expect(JSON.parse(String(subscription[1].body))).toEqual({ seq: "4" });
    expect(screen.getByText(/편입.*삼성전자/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "실시간 해제" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/unsubscribe")).toBe(true));
    const unsubscription = request.mock.calls.find(([path]) => path === "/api/conditions/KR/unsubscribe") as [string, RequestInit];
    expect(JSON.parse(String(unsubscription[1].body))).toEqual({ seq: "4", registrationId: REGISTRATION_A });
  });

  it("shows reconnect cancellation instead of presenting a registration acknowledgement as live", async () => {
    const request = fetcher({ active: false, state: "canceled", registrationId: null, reason: "realtime reconnect", note: "다시 등록하세요.", events: [] });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    expect(await screen.findByText("실시간 등록 취소됨")).toBeInTheDocument();
    expect(screen.getByText("realtime reconnect")).toBeInTheDocument();
  });

  it("requires a valid registration ID in an active subscribe acknowledgement", async () => {
    const request = fetcher();
    request.mockImplementation((path: string) => path === "/api/conditions/KR/subscribe"
      ? Promise.resolve(response({ market: "KR", seq: "4", complete: true, note: "", live: { state: "active" }, rows: [] }))
      : fetcher()(path));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));

    expect(await screen.findByText("조건식 실시간 등록 식별자를 확인하지 못했습니다.")).toBeInTheDocument();
    expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/status?seq=4")).toBe(false);
  });

  it("does not adopt or clear a different registration returned by status", async () => {
    const request = fetcher({ active: true, state: "active", registrationId: REGISTRATION_B, note: "다른 등록", events: [] });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));

    expect(await screen.findByText("실시간 등록 취소됨")).toBeInTheDocument();
    expect(screen.getByText("조건식 등록이 변경되었습니다. 이 패널에서 다시 등록하세요.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실시간 해제" })).toBeDisabled();
    expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/unsubscribe")).toBe(false);
  });

  it("best-effort clears only a subscription this panel created on unmount and makes no calls while hidden", async () => {
    const hidden = fetcher();
    vi.stubGlobal("fetch", hidden);
    const view = render(<ConditionPanel instrument={samsung} active={false} />);
    expect(hidden).not.toHaveBeenCalled();
    view.unmount();

    const request = fetcher();
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const mounted = render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    await screen.findByText("실시간 등록 확인됨 · 이벤트 대기");
    mounted.unmount();
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "/api/conditions/KR/unsubscribe")).toHaveLength(1));
  });

  it("does not subscribe after a market switch invalidates a start still awaiting auth", async () => {
    const authGate = deferred<Response>();
    const request = fetcher();
    request.mockImplementation((path: string) => path === "/api/auth/status" ? authGate.promise : fetcher()(path));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const view = render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/api/auth/status")).toBe(true));

    view.rerender(<ConditionPanel instrument={apple} />);
    authGate.resolve(response(auth));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/subscribe")).toBe(false);
    expect(screen.getByText("US · 서버 저장 조건식")).toBeInTheDocument();
  });

  it("invalidates a start awaiting auth across an active true-to-false-to-true tab transition", async () => {
    const authGate = deferred<Response>();
    const request = fetcher();
    request.mockImplementation((path: string) => path === "/api/auth/status" ? authGate.promise : fetcher()(path));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const view = render(<ConditionPanel instrument={samsung} active />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/api/auth/status")).toBe(true));

    view.rerender(<ConditionPanel instrument={samsung} active={false} />);
    view.rerender(<ConditionPanel instrument={samsung} active />);
    authGate.resolve(response(auth));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/subscribe")).toBe(false);
    expect(screen.getByRole("button", { name: "조건식 목록 새로고침" })).not.toBeDisabled();
  });

  it("clears a late accepted subscription from its captured market after switching markets", async () => {
    const subscribeGate = deferred<Response>();
    const request = fetcher();
    request.mockImplementation((path: string) => path === "/api/conditions/KR/subscribe"
      ? subscribeGate.promise
      : fetcher()(path));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const view = render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/subscribe")).toBe(true));

    view.rerender(<ConditionPanel instrument={apple} />);
    subscribeGate.resolve(response({ market: "KR", seq: "4", complete: true, note: "", live: { state: "active", registrationId: REGISTRATION_A }, rows: [{ item: "A005930", name: "삼성전자", fields: { "9001": "A005930" } }] }));

    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "/api/conditions/KR/unsubscribe")).toHaveLength(1));
    const lateUnsubscription = request.mock.calls.find(([path]) => path === "/api/conditions/KR/unsubscribe") as [string, RequestInit];
    expect(JSON.parse(String(lateUnsubscription[1].body))).toEqual({ seq: "4", registrationId: REGISTRATION_A });
    expect(request.mock.calls.some(([path]) => path === "/api/conditions/US/status?seq=4")).toBe(false);
    expect(screen.getByText("US · 서버 저장 조건식")).toBeInTheDocument();
    expect(screen.queryByText("삼성전자")).not.toBeInTheDocument();
  });

  it("clears a late accepted subscription after unmount without retaining ownership", async () => {
    const subscribeGate = deferred<Response>();
    const request = fetcher();
    request.mockImplementation((path: string) => path === "/api/conditions/KR/subscribe"
      ? subscribeGate.promise
      : fetcher()(path));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const view = render(<ConditionPanel instrument={samsung} />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/subscribe")).toBe(true));

    view.unmount();
    subscribeGate.resolve(response({ market: "KR", seq: "4", complete: true, note: "", live: { state: "active", registrationId: REGISTRATION_A }, rows: [] }));

    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "/api/conditions/KR/unsubscribe")).toHaveLength(1));
  });

  it("clears a late accepted registration after an active true-to-false-to-true tab transition", async () => {
    const subscribeGate = deferred<Response>();
    const request = fetcher();
    request.mockImplementation((path: string) => path === "/api/conditions/KR/subscribe"
      ? subscribeGate.promise
      : fetcher()(path));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const view = render(<ConditionPanel instrument={samsung} active />);
    await loadAndSelect(user);
    await user.click(screen.getByRole("button", { name: "실시간 등록" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/subscribe")).toBe(true));

    view.rerender(<ConditionPanel instrument={samsung} active={false} />);
    view.rerender(<ConditionPanel instrument={samsung} active />);
    subscribeGate.resolve(response({ market: "KR", seq: "4", complete: true, note: "", live: { state: "active", registrationId: REGISTRATION_A }, rows: [{ item: "A005930", name: "늦은 응답", fields: { lateField: "stale" } }] }));

    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "/api/conditions/KR/unsubscribe")).toHaveLength(1));
    expect(request.mock.calls.some(([path]) => path === "/api/conditions/KR/status?seq=4")).toBe(false);
    expect(screen.queryByText("늦은 응답")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실시간 해제" })).toBeDisabled();
  });

  it("keeps a US AAPL condition code intact when opening the direct venue-qualified row", async () => {
    const request = vi.fn((path: string) => {
      if (path === "/api/conditions/US/list") return Promise.resolve(response({ market: "US", conditions: [{ seq: "8", name: "US 조건" }] }));
      if (path === "/api/conditions/US/result?seq=8") return Promise.resolve(response({ market: "US", seq: "8", complete: true, note: "", rows: [{ item: "AAPL", name: "조건 Apple", exchange: "ND", fields: {} }] }));
      return Promise.resolve(response({ detail: "unexpected" }, 500));
    });
    const onPick = vi.fn();
    const search = vi.spyOn(api, "searchSymbols");
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ConditionPanel instrument={apple} onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: "조건식 목록 새로고침" }));
    await user.click(await screen.findByRole("button", { name: /US 조건/ }));
    await user.click(await screen.findByRole("button", { name: "종목 열기" }));

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick.mock.calls[0][0]).toEqual(expect.objectContaining({ market: "US", stkCd: "AAPL", stexTp: "ND", listingVenue: "NASDAQ" }));
    expect(search).not.toHaveBeenCalled();
  });

  it("resolves a noncurrent Korean condition row through exact asynchronous search and keeps its KOSDAQ listing", async () => {
    const request = vi.fn((path: string) => {
      if (path === "/api/conditions/KR/list") return Promise.resolve(response({ market: "KR", conditions: [{ seq: "9", name: "다른 시장 조건" }] }));
      if (path === "/api/conditions/KR/result?seq=9") return Promise.resolve(response({ market: "KR", seq: "9", complete: true, note: "", rows: [{ item: "A123456", name: "코스닥 예시", fields: {} }] }));
      return Promise.resolve(response({ detail: "unexpected" }, 500));
    });
    const kosdaq = { ...samsung, stkCd: "123456", stkNm: "코스닥 예시", listingVenue: "KOSDAQ" as const };
    const onPick = vi.fn();
    const search = vi.spyOn(api, "searchSymbols").mockResolvedValue({ results: [kosdaq], complete: true, note: "" });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ConditionPanel instrument={samsung} onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: "조건식 목록 새로고침" }));
    await user.click(await screen.findByRole("button", { name: /다른 시장 조건/ }));
    await user.click(await screen.findByRole("button", { name: "종목 열기" }));

    await waitFor(() => expect(search).toHaveBeenCalledWith("123456", "KR"));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(kosdaq));
    expect(onPick.mock.calls[0][0]).toEqual(expect.objectContaining({ stkCd: "123456", listingVenue: "KOSDAQ", stexTp: "KRX" }));
  });
});
