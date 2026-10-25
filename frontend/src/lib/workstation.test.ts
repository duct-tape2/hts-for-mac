import { describe, expect, it } from "vitest";
import { Actions, DockLocation, Model, TabNode } from "flexlayout-react";
import { defaultInstrument } from "./symbols";
import {
  createWorkstation,
  instrumentForMarket,
  readWorkstation,
  renameWorkspace,
  selectWorkspace,
  setGroupInstrument,
  updateWorkspace,
} from "./workstation";
import { workspaceLayout } from "./workspace";

describe("HTS workstation persistence", () => {
  it("creates four independent named workspaces and isolates link groups", () => {
    const state = createWorkstation("fixture");
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-1",
      "workspace-2",
      "workspace-3",
      "workspace-4",
    ]);
    expect(state.workspaces.map((workspace) => workspace.name)).toEqual([
      "국내 관찰",
      "미국 관찰",
      "비교 분석",
      "자유 화면",
    ]);
    expect(state.workspaces.map((workspace) => workspace.preset)).toEqual([
      "rankings",
      "terminal",
      "dual",
      "quad",
    ]);
    const freshModel = Model.fromJson(state.workspaces[0].layout);
    const screens: string[] = [];
    freshModel.visitNodes((node) => {
      if (node instanceof TabNode) {
        screens.push(node.getComponent() === "capture" ? node.getConfig().screen : node.getComponent() === "watch" ? "0130" : "0601");
      }
    });
    expect(new Set(screens)).toEqual(new Set(["0198", "0187", "0186", "0184", "0162", "0130", "0601", "0602", "0211", "0780", "2797", "0200", "0700"]));
    expect(state.workspaces[0].instruments["1"]).not.toBe(
      state.workspaces[0].instruments["2"],
    );
    expect(state.workspaces[0].instruments["1"]).not.toBe(
      state.workspaces[1].instruments["1"],
    );

    const selected = defaultInstrument("US", "fixture");
    const next = setGroupInstrument(state, "workspace-1", "2", selected);
    expect(next).not.toBe(state);
    expect(next.workspaces[0].instruments["2"]).toEqual(selected);
    expect(next.workspaces[0].instruments["1"].stkCd).toBe("005930");
    expect(next.workspaces[1].instruments["2"].stkCd).toBe("AAPL");
    expect(state.workspaces[0].instruments["2"].stkCd).toBe("005930");
  });

  it("renames, switches, and serializes an updated workspace without mutation", () => {
    const initial = createWorkstation("demo");
    const withLayout = updateWorkspace(initial, "workspace-3", {
      layout: workspaceLayout("quad"),
      activeGroup: "3",
    });
    const renamed = renameWorkspace(withLayout, "workspace-3", "  비교 저장소 이름이 긴 경우  ");
    const selected = selectWorkspace(renamed, "workspace-3");
    const restored = readWorkstation(JSON.stringify(selected));

    expect(initial.workspaces[2].name).toBe("비교 분석");
    expect(selected.activeId).toBe("workspace-3");
    expect(selected.workspaces[2].name).toBe("비교 저장소 이름이 긴 경우");
    expect(selected.workspaces[2].activeGroup).toBe("3");
    expect(restored).toEqual(selected);
    expect(selectWorkspace(selected, "missing-workspace")).toBe(selected);
    expect(renameWorkspace(selected, "workspace-3", "   ")).toBe(selected);
  });

  it("remembers each link group's last selection per market without crossing workspaces", () => {
    const initial = createWorkstation("fixture");
    const skHynix = {
      ...defaultInstrument("KR", "fixture"),
      stkCd: "000660",
      stkNm: "SK하이닉스",
    };
    const apple = defaultInstrument("US", "fixture");
    const krSelected = setGroupInstrument(
      initial,
      "workspace-1",
      "1",
      skHynix,
    );
    const usSelected = setGroupInstrument(
      krSelected,
      "workspace-1",
      "1",
      apple,
    );
    const first = usSelected.workspaces[0];

    expect(
      instrumentForMarket(first, "1", "KR", "demo"),
    ).toMatchObject({ market: "KR", stkCd: "000660", environment: "demo" });
    expect(
      instrumentForMarket(first, "1", "US", "demo"),
    ).toMatchObject({ market: "US", stkCd: "AAPL", environment: "demo" });
    expect(usSelected.workspaces[0].marketHistory?.["2"]).toEqual(
      initial.workspaces[0].marketHistory?.["2"],
    );
    expect(usSelected.workspaces[1].marketHistory).toEqual(
      initial.workspaces[1].marketHistory,
    );
    expect(readWorkstation(JSON.stringify(usSelected))).toEqual(usSelected);
  });

  it("accepts old v2 records without market history and rejects invalid histories", () => {
    const oldV2 = createWorkstation("fixture");
    for (const workspace of oldV2.workspaces) delete workspace.marketHistory;
    const restored = readWorkstation(JSON.stringify(oldV2));
    expect(restored).toEqual(oldV2);
    expect(restored?.workspaces[0]).not.toHaveProperty("marketHistory");
    expect(
      instrumentForMarket(restored!.workspaces[0], "1", "US", "demo"),
    ).toEqual(defaultInstrument("US", "demo"));

    const unknownGroup = createWorkstation("fixture");
    unknownGroup.workspaces[0].marketHistory = {
      "5": { KR: defaultInstrument("KR", "fixture") },
    } as never;
    expect(readWorkstation(JSON.stringify(unknownGroup))).toBeNull();

    const unknownMarket = createWorkstation("fixture");
    unknownMarket.workspaces[0].marketHistory = {
      "1": { JP: defaultInstrument("KR", "fixture") },
    } as never;
    expect(readWorkstation(JSON.stringify(unknownMarket))).toBeNull();

    const mismatchedInstrument = createWorkstation("fixture");
    mismatchedInstrument.workspaces[0].marketHistory = {
      "1": { KR: defaultInstrument("US", "fixture") },
    };
    expect(readWorkstation(JSON.stringify(mismatchedInstrument))).toBeNull();

    const malformedInstrument = createWorkstation("fixture");
    malformedInstrument.workspaces[0].marketHistory = {
      "1": {
        KR: { ...defaultInstrument("KR", "fixture"), currency: "USD" },
      } as never,
    };
    expect(readWorkstation(JSON.stringify(malformedInstrument))).toBeNull();
  });

  it("imports a v1 layout without losing moved or pinned chart configuration", () => {
    const legacy = Model.fromJson(workspaceLayout("dual"));
    const pinned = defaultInstrument("US", "fixture");
    legacy.doAction(
      Actions.updateNodeAttributes("chart-1", {
        config: { instrument: pinned, preferences: { interval: "W" } },
      }),
    );
    legacy.doAction(
      Actions.moveNode("chart-2", "data-set", DockLocation.CENTER, -1),
    );

    const state = createWorkstation("fixture", legacy.toJson(), pinned);
    const restored = readWorkstation(JSON.stringify(state));
    expect(state.workspaces[0].preset).toBe("dual");
    expect(
      createWorkstation("fixture", workspaceLayout("quad")).workspaces[0]
        .preset,
    ).toBe("quad");
    const layout = Model.fromJson(restored!.workspaces[0].layout);
    expect(
      (layout.getNodeById("chart-1") as TabNode).getConfig().instrument.stkCd,
    ).toBe("AAPL");
    expect(
      (layout.getNodeById("chart-1") as TabNode).getConfig().preferences.interval,
    ).toBe("W");
    expect(layout.getNodeById("chart-2")?.getParent()?.getId()).toBe("data-set");
    expect(restored!.workspaces[0].instruments["1"]).toEqual(pinned);
  });

  it("rejects malformed, oversized, duplicate, unknown, and invalid persisted data", () => {
    expect(readWorkstation("not JSON")).toBeNull();
    expect(readWorkstation("x".repeat(1_000_001))).toBeNull();

    const duplicateWorkspace = createWorkstation("fixture");
    duplicateWorkspace.workspaces[3].id = duplicateWorkspace.workspaces[0].id;
    expect(readWorkstation(JSON.stringify(duplicateWorkspace))).toBeNull();

    const duplicateNode = createWorkstation("fixture");
    const root = duplicateNode.workspaces[0].layout.layout.children!;
    (root[0].children![0] as { id: string }).id = "chart-1";
    expect(readWorkstation(JSON.stringify(duplicateNode))).toBeNull();

    const invalidInstrument = createWorkstation("fixture");
    invalidInstrument.workspaces[0].instruments["4"].currency = "USD";
    expect(readWorkstation(JSON.stringify(invalidInstrument))).toBeNull();

    const unknownFloatingPanel = createWorkstation("fixture");
    unknownFloatingPanel.workspaces[0].layout.subLayouts = {
      "floating-orders": {
        type: "float",
        rect: { x: 10, y: 20, width: 500, height: 350 },
        layout: {
          type: "row",
          children: [
            {
              type: "tabset",
              children: [
                { type: "tab", id: "orders", component: "orders" },
              ],
            },
          ],
        },
      },
    };
    expect(readWorkstation(JSON.stringify(unknownFloatingPanel))).toBeNull();
  });
});
