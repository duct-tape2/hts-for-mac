import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketAlertsPanel, MarketAlertsProvider } from "@/components/MarketAlertsPanel";
import type { AlertLockManager } from "@/components/alertOwnership";
import { ALERT_STORAGE_KEY, createAlertRule, writeAlertStorage } from "@/components/marketAlerts";
import { quoteKey, useLiveQuotes } from "@/lib/useLiveQuote";
import { apple, fixtureQuote, samsung } from "@/test/fixtures";
import type { Instrument, Quote } from "@/lib/types";

vi.mock("@/lib/useLiveQuote", () => ({
  quoteKey: (instrument: { market: string; stkCd: string; listingVenue: string; quoteVenue: string; environment: string }) =>
    JSON.stringify({
      market: instrument.market,
      stkCd: instrument.stkCd,
      listingVenue: instrument.listingVenue,
      quoteVenue: instrument.quoteVenue,
      environment: instrument.environment,
    }),
  useLiveQuotes: vi.fn(),
}));

function installLocks() {
  const locks: AlertLockManager = {
    request: async (_name, _options, callback) => callback({}),
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
}

beforeEach(() => { localStorage.clear(); installLocks(); });
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  Reflect.deleteProperty(navigator, "locks");
});

function AlertsHarness({ instrument, quote, environment = instrument.environment }: { instrument: Instrument; quote: Quote | null; environment?: "fixture" | "demo" | "real" }) {
  return (
    <MarketAlertsProvider environment={environment}>
      <MarketAlertsPanel instrument={instrument} quote={quote} />
    </MarketAlertsProvider>
  );
}

function PersistentProviderHarness() {
  const [show, setShow] = useState(true);
  return (
    <MarketAlertsProvider environment="fixture">
      <button type="button" onClick={() => setShow((value) => !value)}>{show ? "패널 숨기기" : "패널 표시"}</button>
      {show && <MarketAlertsPanel instrument={samsung} quote={null} />}
    </MarketAlertsProvider>
  );
}

describe("MarketAlertsPanel", () => {
  it("uses the instrument currency in a persisted local threshold", async () => {
    const user = userEvent.setup();
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: {} });
    render(<AlertsHarness instrument={apple} quote={null} />);

    await screen.findByText("발동 기록이 없습니다.");
    await user.type(screen.getByLabelText("알림 기준값"), "220");
    await user.click(screen.getByRole("button", { name: "추가" }));

    expect(screen.getByText("가격 ≥ $220.00")).toBeInTheDocument();
  });

  it("fires only after a fresh verified same-feed quote, marks fixtures, and does not duplicate the event", async () => {
    const user = userEvent.setup();
    let quotes: Record<string, Quote> = {};
    vi.mocked(useLiveQuotes).mockImplementation(() => ({ quotes, errors: {} }));
    const initial = render(<AlertsHarness instrument={samsung} quote={null} />);

    await screen.findByText("발동 기록이 없습니다.");
    await user.type(screen.getByLabelText("알림 기준값"), "70000");
    await user.click(screen.getByRole("button", { name: "추가" }));

    const fresh = fixtureQuote(samsung, { last: 70000, receivedAt: new Date().toISOString() });
    quotes = { [quoteKey(samsung)]: fresh };
    initial.rerender(<AlertsHarness instrument={samsung} quote={fresh} />);
    await waitFor(() => expect(screen.getByText("샘플 · 가격 이상 70,000원 · 샘플")).toBeInTheDocument());
    expect(screen.getByText("발동됨")).toBeInTheDocument();

    initial.rerender(<AlertsHarness instrument={samsung} quote={fresh} />);
    await waitFor(() => expect(screen.getAllByText("샘플 · 가격 이상 70,000원 · 샘플")).toHaveLength(1));
  });

  it("does not repeatedly evaluate one unchanged fresh receipt when no rule fires", async () => {
    const rule = createAlertRule({ feedKey: quoteKey(samsung), instrument: samsung, kind: "above", threshold: 80000 });
    writeAlertStorage({ rules: [rule], history: [] });
    const receipt = fixtureQuote(samsung, { last: 70000, receivedAt: new Date().toISOString() });
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: { [quoteKey(samsung)]: receipt }, errors: {} });
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    render(<AlertsHarness instrument={samsung} quote={receipt} />);

    await waitFor(() => expect(getItem).toHaveBeenCalledTimes(2)); // hydrate + one engine evaluation
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
    expect(getItem).toHaveBeenCalledTimes(2);
  });

  it("does not fire while the quote is stale", async () => {
    const user = userEvent.setup();
    let quotes: Record<string, Quote> = {};
    vi.mocked(useLiveQuotes).mockImplementation(() => ({ quotes, errors: {} }));
    const view = render(<AlertsHarness instrument={samsung} quote={null} />);

    await screen.findByText("발동 기록이 없습니다.");
    await user.type(screen.getByLabelText("알림 기준값"), "70000");
    await user.click(screen.getByRole("button", { name: "추가" }));

    const stale = fixtureQuote(samsung, { last: 70000, status: "stale", receivedAt: "2026-10-24T01:00:01Z" });
    quotes = { [quoteKey(samsung)]: stale };
    view.rerender(<AlertsHarness instrument={samsung} quote={stale} />);
    await waitFor(() => expect(screen.getByText("지연·미수신·오류 시세에서는 알림을 발동하지 않습니다.")).toBeInTheDocument());
    expect(screen.getByText("발동 기록이 없습니다.")).toBeInTheDocument();
  });

  it("resets safely across feed changes and fires only when the original feed later becomes fresh", async () => {
    const user = userEvent.setup();
    let quotes: Record<string, Quote> = {};
    vi.mocked(useLiveQuotes).mockImplementation(() => ({ quotes, errors: {} }));
    const view = render(<AlertsHarness instrument={samsung} quote={null} />);

    await screen.findByText("발동 기록이 없습니다.");
    await user.type(screen.getByLabelText("알림 기준값"), "70000");
    await user.click(screen.getByRole("button", { name: "추가" }));
    await waitFor(() => expect(vi.mocked(useLiveQuotes).mock.calls.some(([instruments]) => instruments.some((entry) => entry.stkCd === "005930"))).toBe(true));

    const appleFresh = fixtureQuote(apple, { receivedAt: new Date().toISOString() });
    quotes = { [quoteKey(samsung)]: appleFresh };
    view.rerender(<AlertsHarness instrument={apple} quote={appleFresh} />);
    await waitFor(() => expect(screen.getByText("발동 기록이 없습니다.")).toBeInTheDocument());

    const stale = fixtureQuote(samsung, { last: 70000, status: "stale", receivedAt: "2026-10-24T01:00:02Z" });
    quotes = { [quoteKey(samsung)]: stale };
    view.rerender(<AlertsHarness instrument={samsung} quote={stale} />);
    await waitFor(() => expect(screen.getByText("지연·미수신·오류 시세에서는 알림을 발동하지 않습니다.")).toBeInTheDocument());

    const samsungFresh = fixtureQuote(samsung, { last: 70000, receivedAt: new Date().toISOString() });
    quotes = { [quoteKey(samsung)]: samsungFresh };
    view.rerender(<AlertsHarness instrument={samsung} quote={samsungFresh} />);
    await waitFor(() => expect(screen.getByText("샘플 · 가격 이상 70,000원 · 샘플")).toBeInTheDocument());
  });

  it("keeps the provider-owned rules while the panel unmounts", async () => {
    const user = userEvent.setup();
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: {} });
    render(<PersistentProviderHarness />);

    await screen.findByText("발동 기록이 없습니다.");
    await user.type(screen.getByLabelText("알림 기준값"), "70000");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByText("가격 ≥ 70,000원")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "패널 숨기기" }));
    expect(screen.queryByLabelText("시세 알림")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "패널 표시" }));
    expect(await screen.findByText("가격 ≥ 70,000원")).toBeInTheDocument();
  });

  it("retains off-environment rules in storage without subscribing them in the active environment", async () => {
    const fixtureRule = createAlertRule({ feedKey: quoteKey(samsung), instrument: samsung, kind: "above", threshold: 70000 });
    writeAlertStorage({ rules: [fixtureRule], history: [] });
    const realSamsung = { ...samsung, environment: "real" as const };
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: {} });

    render(<AlertsHarness instrument={realSamsung} quote={null} environment="real" />);

    await screen.findByText("발동 기록이 없습니다.");
    await waitFor(() => expect(vi.mocked(useLiveQuotes).mock.calls.every(([instruments]) => instruments.length === 0)).toBe(true));
  });

  it("synchronizes rules and history written by another same-origin tab", async () => {
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: {} });
    render(<AlertsHarness instrument={samsung} quote={null} />);
    const remote = createAlertRule({ feedKey: quoteKey(samsung), instrument: samsung, kind: "above", threshold: 71000 });
    writeAlertStorage({ rules: [remote], history: [] });
    window.dispatchEvent(new StorageEvent("storage", { key: ALERT_STORAGE_KEY, newValue: localStorage.getItem(ALERT_STORAGE_KEY), storageArea: localStorage }));

    expect(await screen.findByText("가격 ≥ 71,000원")).toBeInTheDocument();
  });

  it("disables monitoring honestly when the browser lock API is unavailable", async () => {
    const rule = createAlertRule({ feedKey: quoteKey(samsung), instrument: samsung, kind: "above", threshold: 70000 });
    writeAlertStorage({ rules: [rule], history: [] });
    Reflect.deleteProperty(navigator, "locks");
    vi.mocked(useLiveQuotes).mockReturnValue({ quotes: {}, errors: {} });

    render(<AlertsHarness instrument={samsung} quote={null} />);

    expect(await screen.findByText(/브라우저 잠금 미지원: 중복 방지 감시는 중지/)).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(useLiveQuotes).mock.calls.every(([instruments]) => instruments.length === 0)).toBe(true));
  });
});
