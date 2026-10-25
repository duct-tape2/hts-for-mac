import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTransfer } from "./WorkspaceTransfer";
import { StoreProvider } from "@/lib/store";
import { api } from "@/lib/api";
import { createWorkstation } from "@/lib/workstation";
import { createWorkspaceTransfer } from "@/lib/workspaceTransfer";
import type { ReadonlyState } from "@/lib/types";

function state(): ReadonlyState {
  return { mode: "fixture", kiwoom: "disconnected", kiwoomError: "", watchlists: [{ id: "wl_default", name: "내 관심종목", source: "app" }], items: [] };
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("WorkspaceTransfer", () => {
  it("backs up, restores the checked workspace, then uses the Store mutation transaction", async () => {
    const user = userEvent.setup();
    const bundle = createWorkstation("fixture");
    const transfer = createWorkspaceTransfer(bundle, state());
    vi.spyOn(api, "state").mockResolvedValue(state());
    const imported = vi.spyOn(api, "importLocalWatchlists").mockResolvedValue({ ...state(), watchlistNote: "merged" });
    const onRestore = vi.fn();
    const onNote = vi.fn();
    render(<StoreProvider><WorkspaceTransfer bundle={bundle} onRestore={onRestore} onNote={onNote} /></StoreProvider>);

    await user.upload(screen.getByLabelText("작업공간 전송 파일"), new File([JSON.stringify(transfer)], "workspace.json", { type: "application/json" }));

    await waitFor(() => expect(imported).toHaveBeenCalledWith({ version: 1, watchlists: transfer.watchlists }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore.mock.calls[0][0].workspaces[0].instruments["1"].environment).toBe("fixture");
    expect(localStorage.getItem("kiwoom-hts-workspace-transfer-backup-v1")).not.toBeNull();
    expect(onNote).toHaveBeenLastCalledWith(expect.stringContaining("안전하게 병합"));
  });

  it("restores the previous browser workspace and never reports success when the server response fails", async () => {
    const user = userEvent.setup();
    const bundle = createWorkstation("fixture");
    const transfer = createWorkspaceTransfer(bundle, state());
    vi.spyOn(api, "state").mockResolvedValue(state());
    vi.spyOn(api, "importLocalWatchlists").mockRejectedValue(new Error("offline"));
    const onRestore = vi.fn();
    const onNote = vi.fn();
    render(<StoreProvider><WorkspaceTransfer bundle={bundle} onRestore={onRestore} onNote={onNote} /></StoreProvider>);

    await user.upload(screen.getByLabelText("작업공간 전송 파일"), new File([JSON.stringify(transfer)], "workspace.json", { type: "application/json" }));

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(2));
    expect(onRestore.mock.calls[1][0]).toBe(bundle);
    expect(onNote).toHaveBeenLastCalledWith(expect.stringContaining("서버 반영 여부"));
    expect(onNote.mock.calls.flat().join(" ")).not.toContain("안전하게 병합");
  });
});
