import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Actions, Model, type TabNode } from "flexlayout-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockPanel, resolvePanelInstrument } from "./DockPanel";
import { createWorkstation } from "@/lib/workstation";
import { workspaceLayout } from "@/lib/workspace";
import { samsung, apple, fixtureQuote } from "@/test/fixtures";
import type { Instrument } from "@/lib/types";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const live = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/useLiveQuote", () => ({ useLiveQuote: (instrument: Instrument, key: number, active: boolean) => { live.read(instrument, key, active); return { quote: fixtureQuote(instrument), quoteError: "" }; } }));
vi.mock("./PriceChart", () => ({ PriceChart: ({ instrument, active, onSelectPrice }: { instrument: Instrument; active: boolean; onSelectPrice: (price: number) => void }) => <section aria-label="test chart">{instrument.stkCd} {instrument.currency} {instrument.environment} {String(active)}<button onClick={() => onSelectPrice(123)}>Select price</button></section> }));
vi.mock("./WatchlistPanel", () => ({ WatchlistPanel: () => <section>watch-content</section> }));
vi.mock("./TickerSearch", () => ({ TickerSearch: ({ onPick }: { onPick: (item: Instrument) => void }) => <button onClick={() => onPick(apple)}>찾은 종목 선택</button> }));
vi.mock("./OrderBook", () => ({ OrderBook: ({ selectedPrice }: { selectedPrice: number | null }) => <section>book-price:{String(selectedPrice)}</section> }));
vi.mock("./MarketAlertsPanel", () => ({ MarketAlertsPanel: () => null }));
vi.mock("./MarketAnalyticsPanel", () => ({ RankingsPanel: () => null, InvestorFlowPanel: () => null }));
vi.mock("./AnalysisPanels", () => ({ DetailsPanel: () => null, HistoryPanel: () => null, NotesPanel: () => null }));

function setup(nodeId = "chart-1", visible = true) {
  const workspace = createWorkstation("fixture").workspaces[0];
  workspace.preset = "terminal";
  workspace.layout = workspaceLayout("terminal");
  workspace.instruments["2"] = apple;
  const model = Model.fromJson(workspace.layout);
  const node = model.getNodeById(nodeId) as TabNode;
  vi.spyOn(node, "isVisible").mockReturnValue(visible);
  return { workspace, model, node, environment: "real" as const, refreshKey: 0, selection: null, onPrice: vi.fn(), onInstrument: vi.fn() };
}

describe("HTS panel linkage", () => {
  it("uses the chart search for its linked group or its own pin without changing another chart", () => {
    const props = setup();
    const view = render(<DockPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "찾은 종목 선택" }));
    expect(props.onInstrument).toHaveBeenLastCalledWith(apple, "1");
    props.onInstrument.mockClear();
    props.model.doAction(Actions.updateNodeAttributes(props.node.getId(), { config: { instrument: samsung, linkGroup: "2" } }));
    view.rerender(<DockPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "찾은 종목 선택" }));
    expect(props.node.getConfig().instrument.stkCd).toBe("AAPL");
    expect(props.onInstrument).not.toHaveBeenCalled();
  });
  it("resolves group identity, pin identity, and runtime environment independently", () => {
    const { workspace } = setup();
    expect(resolvePanelInstrument({ linkGroup: "2" }, workspace, "real").instrument).toEqual({ ...apple, environment: "real" });
    expect(resolvePanelInstrument({ linkGroup: "2", instrument: samsung }, workspace, "real")).toMatchObject({ group: "2", pinned: true, instrument: { stkCd: "005930", currency: "KRW" } });
    expect(resolvePanelInstrument({ linkGroup: "invalid", instrument: { stkCd: "bad" } }, workspace, "real")).toMatchObject({ group: "1", pinned: false, instrument: { stkCd: "005930" } });
  });
  it("binds a chart to group2, pins it through group changes, and resumes after release", () => {
    const props = setup();
    const view = render(<DockPanel {...props} />);
    fireEvent.change(screen.getByLabelText("차트 1 연동 그룹"), { target: { value: "2" } });
    view.rerender(<DockPanel {...props} />);
    expect(screen.getByLabelText("test chart")).toHaveTextContent("AAPL USD real");
    fireEvent.click(screen.getByRole("button", { name: "종목 고정" }));
    view.rerender(<DockPanel {...props} />);
    const changed = { ...props.workspace, instruments: { ...props.workspace.instruments, "2": samsung } };
    view.rerender(<DockPanel {...props} workspace={changed} />);
    expect(screen.getByLabelText("test chart")).toHaveTextContent("AAPL USD real");
    fireEvent.click(screen.getByRole("button", { name: "고정 해제" }));
    view.rerender(<DockPanel {...props} workspace={changed} />);
    expect(screen.getByLabelText("test chart")).toHaveTextContent("005930 KRW real");
  });
  it("does not mount hidden data panels or subscribe their quotes", () => {
    const props = setup("watch", false);
    render(<DockPanel {...props} />);
    expect(screen.queryByText("watch-content")).not.toBeInTheDocument();
    expect(live.read).toHaveBeenLastCalledWith(expect.objectContaining({ stkCd: "005930" }), 0, false);
  });
  it("keeps selected prices tied to the full instrument identity", () => {
    const props = setup("book");
    const view = render(<DockPanel {...props} selection={{ instrument: { ...apple, environment: "real" }, price: 210 }} />);
    expect(screen.getByText("book-price:null")).toBeInTheDocument();
    view.rerender(<DockPanel {...props} selection={{ instrument: { ...samsung, environment: "real" }, price: 70000 }} />);
    expect(screen.getByText("book-price:70000")).toBeInTheDocument();
  });
  it("duplicates a panel with its own retained group and pin configuration", () => {
    const props = setup();
    props.model.doAction(Actions.updateNodeAttributes(props.node.getId(), { config: { linkGroup: "2", instrument: apple } }));
    render(<DockPanel {...props} />);
    fireEvent.click(screen.getByLabelText("차트 1 창 복제"));
    const configs: unknown[] = [];
    props.model.visitNodes((node) => { if (node.getType() === "tab" && (node as TabNode).getComponent() === "chart") configs.push((node as TabNode).getConfig()); });
    expect(configs).toHaveLength(2);
    expect(configs[1]).toEqual(configs[0]);
    expect(configs[1]).not.toBe(configs[0]);
  });
});
