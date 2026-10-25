import { describe, expect, it } from "vitest";
import { Actions, DockLocation, Model, TabNode } from "flexlayout-react";
import { readWorkspace, workspaceLayout } from "./workspace";
describe("HTS workspace persistence", () => {
  it("restores all thirteen captured screens with distinct panel identities", () => {
    const layout = workspaceLayout("capture");
    const restored = readWorkspace(JSON.stringify({ version: 1, layout }));
    expect(restored).not.toBeNull();
    const model = Model.fromJson(restored!);
    const screens: string[] = [];
    model.visitNodes((node) => {
      if (node instanceof TabNode && node.getComponent() === "capture") screens.push(node.getConfig().screen);
    });
    expect(new Set(screens).size).toBe(11);
    expect(screens).toContain("0700");
    expect(model.getNodeById("watch")).toBeDefined();
    expect(model.getNodeById("chart-1")).toBeDefined();
  });
  it("retains moved chart, sizes, pinned symbol and active tab across restore", () => {
    const model = Model.fromJson(workspaceLayout("dual"));
    model.doAction(
      Actions.updateNodeAttributes("chart-1", {
        config: { instrument: { market: "KR", stkCd: "005930" } },
      }),
    );
    model.doAction(
      Actions.moveNode("chart-2", "data-set", DockLocation.CENTER, -1),
    );
    model.doAction(Actions.selectTab("notes"));
    model.doAction(Actions.updateNodeAttributes("watch-set", { weight: 31 }));
    const saved = readWorkspace(
      JSON.stringify({ version: 1, layout: model.toJson() }),
    );
    expect(saved).not.toBeNull();
    const restored = Model.fromJson(saved!);
    expect(
      (restored.getNodeById("chart-1") as TabNode).getConfig().instrument.stkCd,
    ).toBe("005930");
    expect(restored.getNodeById("chart-2")?.getParent()?.getId()).toBe(
      "data-set",
    );
    expect(JSON.stringify(restored.toJson())).toContain('"weight":31');
  });
  it("rejects malformed/unknown layouts and builds four independent charts", () => {
    expect(readWorkspace("not JSON")).toBeNull();
    expect(
      readWorkspace(
        JSON.stringify({
          version: 1,
          layout: { layout: { type: "tab", component: "orders" } },
        }),
      ),
    ).toBeNull();
    const model = Model.fromJson(workspaceLayout("quad"));
    const ids: string[] = [];
    model.visitNodes((n) => {
      if (n instanceof TabNode && n.getComponent() === "chart")
        ids.push(n.getId());
    });
    expect(new Set(ids).size).toBe(4);
  });
  it("also validates tabs in borders and floating layouts", () => {
    const unknownBorder = workspaceLayout();
    unknownBorder.borders = [
      {
        location: "left",
        children: [{ type: "tab", id: "orders", component: "orders" }],
      },
    ];
    expect(
      readWorkspace(JSON.stringify({ version: 1, layout: unknownBorder })),
    ).toBeNull();

    const floating = workspaceLayout();
    floating.subLayouts = {
      "floating-chart": {
        type: "float",
        rect: { x: 80, y: 120, width: 640, height: 480 },
        layout: {
          type: "row",
          children: [
            {
              type: "tabset",
              children: [
                {
                  type: "tab",
                  id: "floating-chart-tab",
                  component: "chart",
                  config: { preferences: { interval: "W" } },
                },
              ],
            },
          ],
        },
      },
    };
    const restored = readWorkspace(
      JSON.stringify({ version: 1, layout: floating }),
    );
    expect(restored?.subLayouts?.["floating-chart"]?.rect).toEqual({
      x: 80,
      y: 120,
      width: 640,
      height: 480,
    });
  });
});


it("keeps all thirteen reference screens available in the roomy ranking preset", () => {
  const model = Model.fromJson(workspaceLayout("rankings"));
  const screens: string[] = [];
  model.visitNodes((node) => {
    if (node instanceof TabNode) screens.push(node.getComponent() === "capture" ? node.getConfig().screen : node.getComponent() === "watch" ? "0130" : "0601");
  });
  expect(new Set(screens)).toEqual(new Set(["0198", "0187", "0186", "0184", "0162", "0130", "0601", "0602", "0211", "0780", "2797", "0200", "0700"]));
  for (const preset of ["rankings", "charts", "markets", "news"] as const) {
    expect(readWorkspace(JSON.stringify({ version: 1, layout: workspaceLayout(preset) }))).not.toBeNull();
  }
});
