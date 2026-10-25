import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { StoreProvider, useStore } from "@/lib/store";
import { samsung } from "@/test/fixtures";
import type { ReadonlyState } from "@/lib/types";

function Probe() {
  const { state, dispatch, isWatchlistPending } = useStore();
  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "groups" }, state.watchlists.length),
    createElement("output", { "data-testid": "items" }, state.items.length),
    createElement("output", { "data-testid": "selected" }, state.selectedWatchlistId),
    createElement("output", { "data-testid": "pending" }, String(isWatchlistPending)),
    createElement("output", { "data-testid": "note" }, state.watchlistNote),
    createElement("button", { type: "button", onClick: () => dispatch({ type: "addWatchlist", name: "테스트 그룹" }) }, "그룹 추가"),
    createElement("button", { type: "button", onClick: () => dispatch({ type: "addItem", watchlistId: state.selectedWatchlistId, instrument: samsung }) }, "종목 추가"),
  );
}

function baseState(): ReadonlyState {
  return { mode: "fixture", kiwoom: "disconnected", kiwoomError: "", watchlists: [{ id: "wl_default", name: "내 관심종목", source: "app" }], items: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("server-confirmed local watchlists", () => {
  it("selects the server group id before enabling an item mutation", async () => {
    const user = userEvent.setup();
    let remote = baseState();
    const delayedStartup = deferred<ReadonlyState>();
    vi.spyOn(api, "state").mockImplementationOnce(() => delayedStartup.promise).mockImplementation(() => Promise.resolve(remote));
    vi.spyOn(api, "addWatchlist").mockImplementation(async (name) => {
      remote = { ...remote, watchlists: [...remote.watchlists, { id: "server-group-17", name, source: "app" }] };
      return remote;
    });
    const addItem = vi.spyOn(api, "addItem").mockImplementation(async (watchlistId, instrument) => {
      remote = {
        ...remote,
        items: [
          ...remote.items,
          { ...instrument, id: "server-item-4", watchlistId, enabled: true, last: null, prevClose: null, open: null, changePct: null },
        ],
      };
      return remote;
    });

    const first = render(createElement(StoreProvider, null, createElement(Probe)));
    await waitFor(() => expect(screen.getByTestId("groups")).toHaveTextContent("1"));
    await user.click(screen.getByRole("button", { name: "그룹 추가" }));
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("server-group-17"));
    expect(screen.getByTestId("pending")).toHaveTextContent("false");

    delayedStartup.resolve(baseState());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("selected")).toHaveTextContent("server-group-17");

    await user.click(screen.getByRole("button", { name: "종목 추가" }));
    await waitFor(() => expect(addItem).toHaveBeenCalledWith("server-group-17", samsung));
    await waitFor(() => expect(screen.getByTestId("items")).toHaveTextContent("1"));
    first.unmount();

    render(createElement(StoreProvider, null, createElement(Probe)));
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("server-group-17"));
    await waitFor(() => expect(screen.getByTestId("items")).toHaveTextContent("1"));
  });

  it("does not claim a failed mutation was saved locally", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "state").mockResolvedValue(baseState());
    vi.spyOn(api, "addWatchlist").mockRejectedValue(new Error("offline"));
    render(createElement(StoreProvider, null, createElement(Probe)));
    await waitFor(() => expect(screen.getByTestId("groups")).toHaveTextContent("1"));
    await user.click(screen.getByRole("button", { name: "그룹 추가" }));
    await waitFor(() => expect(screen.getByTestId("note")).toHaveTextContent("변경은 적용되지 않았습니다."));
    expect(screen.getByTestId("groups")).toHaveTextContent("1");
  });
});
