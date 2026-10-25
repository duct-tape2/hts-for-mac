import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Model, TabNode } from "flexlayout-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradingDesk2 } from "./TradingDesk2";
import { readRecent } from "@/lib/recent";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/lib/store", () => ({ useStore: () => ({ state: { mode: "fixture", kiwoom: "disconnected" } }) }));
vi.mock("@/lib/useLiveQuote", () => ({ useLiveQuote: () => ({ quote: null, quoteError: "" }) }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<Record<string, unknown>>()), api: { searchSymbols: search } }));
vi.mock("./CredentialSettings", () => ({ CredentialSettings: () => null }));
vi.mock("./MarketAlertsPanel", () => ({ MarketAlertsProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("flexlayout-react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  Layout: ({ model }: { model: Model }) => {
    const tabs: string[] = [];
    model.visitNodes((node) => { if (node.getType() === "tab") tabs.push((node as TabNode).getComponent()!); });
    return <div data-testid="layout-components">{tabs.join(",")}</div>;
  },
}));

beforeEach(() => { localStorage.clear(); search.mockReset(); });
afterEach(cleanup);

function searchInput() { return screen.getByLabelText("국내 종목 검색"); }
function launch(code: string) {
  const launcher = screen.getByRole("combobox", { name: "화면번호·이름" });
  fireEvent.change(launcher, { target: { value: code } });
  fireEvent.submit(launcher.closest("form")!);
}

describe("workstation toolbar integration", () => {
  it("keeps the selected symbol on same-market click and restores KR/US history", async () => {
    render(<TradingDesk2 />);
    await waitFor(() => expect(screen.getByTestId("layout-components")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "SK하이닉스" }));
    expect(searchInput()).toHaveValue("000660");
    fireEvent.click(screen.getByRole("button", { name: "국내주식" }));
    expect(searchInput()).toHaveValue("000660");
    fireEvent.click(screen.getByRole("button", { name: "NVDA" }));
    expect(screen.getByLabelText("미국 종목 검색")).toHaveValue("NVDA");
    fireEvent.click(screen.getByRole("button", { name: "국내주식" }));
    expect(searchInput()).toHaveValue("000660");
    fireEvent.click(screen.getByRole("button", { name: "미국주식" }));
    expect(screen.getByLabelText("미국 종목 검색")).toHaveValue("NVDA");
    expect(search).not.toHaveBeenCalled();
    expect(readRecent().map((item) => item.stkCd)).toContain("000660");
  });

  it("reuses a chart shortcut and opening US watchlists preserves the active KR symbol", async () => {
    render(<TradingDesk2 />);
    await waitFor(() => expect(screen.getByTestId("layout-components")).toBeInTheDocument());
    const before = screen.getByTestId("layout-components").textContent;
    launch("0600"); launch("0600");
    expect(screen.getByTestId("layout-components").textContent).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "SK하이닉스" }));
    launch("2020");
    expect(searchInput()).toHaveValue("000660");
    expect(screen.getByRole("button", { name: "국내주식" })).toHaveAttribute("aria-pressed", "true");
  });
});
