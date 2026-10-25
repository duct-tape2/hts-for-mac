import { describe, expect, it } from "vitest";
import { Actions, Model } from "flexlayout-react";
import { createWorkstation } from "./workstation";
import { WORKSPACE_PRESETS, workspaceLayout } from "./workspace";
import { createWorkspaceTransfer, MAX_WORKSPACE_TRANSFER_BYTES, parseWorkspaceTransfer } from "./workspaceTransfer";
import type { ReadonlyState } from "./types";

function state(): ReadonlyState {
  return {
    mode: "fixture", kiwoom: "disconnected", kiwoomError: "",
    watchlists: [{ id: "local-group-id", name: "장기 관찰", source: "app" }],
    items: [{ id: "quote-row", watchlistId: "local-group-id", enabled: true, market: "US", stkCd: "AAPL", stkNm: "Apple", stexTp: "ND", listingVenue: "NASDAQ", quoteVenue: "ND", currency: "USD", environment: "fixture", last: 123.45, prevClose: 121, open: 122, changePct: 1.2 }],
  };
}

describe("secret-free workspace transfer", () => {
  it("round-trips validated ranking conditions and rejects malformed local thresholds", () => {
    const bundle = createWorkstation("fixture");
    const model = Model.fromJson(workspaceLayout("capture"));
    const capturePreferences = { session: "regular", stock: "excludeEtfEtn", credit: "creditA", volumeBand: "100k", priceBand: "over10k", valueBand: "100m", limitSort: "changePct", managed: "exclude", direction: "previousUpLimit", localNameOrCode: "삼성", localMinPrice: "10000", localMinVolume: "", localMinMarketCap: "1000.5", localMinValue: "100" };
    model.doAction(Actions.updateNodeAttributes("capture-0184", { config: { screen: "0184", capturePreferences } }));
    bundle.workspaces[0].preset = "capture";
    bundle.workspaces[0].layout = model.toJson();
    const transfer = createWorkspaceTransfer(bundle, state());
    const restored = parseWorkspaceTransfer(JSON.stringify(transfer), "real");
    const node = Model.fromJson(restored.workstation.workspaces[0].layout).getNodeById("capture-0184") as any;
    expect(node.getConfig().capturePreferences).toMatchObject(capturePreferences);
    model.doAction(Actions.updateNodeAttributes("capture-0184", { config: { screen: "0184", capturePreferences: { localMinPrice: "Infinity" } } }));
    bundle.workspaces[0].layout = model.toJson();
    expect(() => createWorkspaceTransfer(bundle, state())).toThrow(/localMinPrice/);
  });
  it("accepts FlexLayout Model JSON from every supported preset", () => {
    for (const preset of WORKSPACE_PRESETS) {
      const bundle = createWorkstation("fixture");
      bundle.workspaces[0].preset = preset;
      bundle.workspaces[0].layout = Model.fromJson(workspaceLayout(preset)).toJson();
      const transfer = createWorkspaceTransfer(bundle, state());
      expect(() => parseWorkspaceTransfer(JSON.stringify(transfer), "fixture")).not.toThrow();
    }
  });

  it("round-trips real FlexLayout JSON, saved layouts, display preferences, and rebinds the environment", () => {
    const bundle = createWorkstation("fixture");
    bundle.workspaces.forEach((workspace, index) => {
      const preset = ["terminal", "dual", "quad", "capture"] as const;
      workspace.preset = preset[index];
      workspace.layout = Model.fromJson(workspaceLayout(preset[index])).toJson();
    });
    const chart = (bundle.workspaces[0].layout.layout as any).children[1].children[0].children[0] as Record<string, unknown>;
    chart.config = {
      linkGroup: "2",
      instrument: { market: "US", stkCd: "AAPL", stkNm: "Apple", stexTp: "ND", listingVenue: "NASDAQ", quoteVenue: "ND", currency: "USD", environment: "fixture" },
      preferences: { interval: "W", displayMode: "line", volumeRatio: 0.35, showRsi: true, showMacd: false, showBollingerBands: true, movingAverages: { 5: true, 20: false, 60: true, 120: true, 240: false } },
    };
    const captureModel = Model.fromJson(bundle.workspaces[3].layout);
    captureModel.doAction(Actions.updateNodeAttributes("capture-0198", { config: { linkGroup: "1", screen: "0198", sector: "001", capturePreferences: { market: "all", venue: "ALL", start: "", end: "", period: "1", autoRefresh: true } } }));
    bundle.workspaces[3].layout = captureModel.toJson();
    bundle.workspaces[0].savedLayouts = { quad: Model.fromJson(workspaceLayout("quad")).toJson() };

    const transfer = createWorkspaceTransfer(bundle, state());
    const raw = JSON.stringify(transfer);
    const restored = parseWorkspaceTransfer(raw, "demo");

    expect(raw).not.toContain("quote-row");
    expect(raw).not.toContain("123.45");
    expect(raw).not.toContain("local-group-id");
    expect(raw).not.toContain('"environment"');
    expect(restored.workstation.workspaces).toHaveLength(4);
    expect(restored.workstation.workspaces[0].instruments["1"].environment).toBe("demo");
    const restoredChart = (restored.workstation.workspaces[0].layout.layout as any).children[1].children[0].children[0] as { config: { instrument: { environment: string }; preferences: { volumeRatio: number } } };
    expect(restoredChart.config.instrument.environment).toBe("demo");
    expect(restoredChart.config.preferences.volumeRatio).toBe(0.35);
    expect(restored.workstation.workspaces[0].savedLayouts?.quad).toBeDefined();
    const restoredCapture = (Model.fromJson(restored.workstation.workspaces[3].layout).getNodeById("capture-0198") as any).getConfig() as { capturePreferences: { start: string; end: string; autoRefresh: boolean } };
    expect(restoredCapture.capturePreferences).toMatchObject({ start: "", end: "", autoRefresh: true });
    expect(restored.watchlists[0]).toMatchObject({ name: "장기 관찰", instruments: [{ stkCd: "AAPL", currency: "USD" }] });
  });

  it("rejects secret-shaped fields, invalid identity, and oversize input before restore", () => {
    const workstation = createWorkstation("fixture");
    workstation.workspaces[0].preset = "terminal";
    workstation.workspaces[0].layout = workspaceLayout("terminal");
    const transfer = createWorkspaceTransfer(workstation, state());
    const malicious = structuredClone(transfer) as Record<string, unknown>;
    const maliciousTab = (malicious.workstation as any).workspaces[0].layout.layout.children[1].children[0].children[0];
    maliciousTab.config.apiKey = "never-import";
    expect(() => parseWorkspaceTransfer(JSON.stringify(malicious), "fixture")).toThrow(/허용되지 않은/);

    const wrongIdentity = structuredClone(transfer) as { watchlists: Array<{ instruments: Array<Record<string, unknown>> }> };
    wrongIdentity.watchlists[0].instruments[0].currency = "KRW";
    expect(() => parseWorkspaceTransfer(JSON.stringify(wrongIdentity), "fixture")).toThrow(/식별자/);
    expect(() => parseWorkspaceTransfer("x".repeat(MAX_WORKSPACE_TRANSFER_BYTES + 1), "fixture")).toThrow(/1MiB/);
  });
});

it("preserves analysis selection and comparison companions without copying runtime credentials or environment", () => {
  const bundle = createWorkstation("fixture");
  bundle.workspaces[0].layout = Model.fromJson({ layout: { type: "row", children: [{ type: "tabset", children: [
    { type: "tab", name: "체결정보", component: "analysis", config: { featureId: "kr_tape", linkGroup: "1" } },
    { type: "tab", name: "비교", component: "comparison", config: { companions: [state().items[0]], linkGroup: "1" } },
  ] }] } }).toJson();
  const transfer = createWorkspaceTransfer(bundle, state());
  const restored = parseWorkspaceTransfer(JSON.stringify(transfer), "demo");
  const json = JSON.stringify(restored.workstation.workspaces[0].layout);
  expect(json).toContain('"featureId":"kr_tape"');
  expect(json).toContain('"stkCd":"AAPL"');
  expect(json).toContain('"environment":"demo"');
  expect(json).not.toContain('123.45');
  expect(json).not.toContain('quote-row');
});
