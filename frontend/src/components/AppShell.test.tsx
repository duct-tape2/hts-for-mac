import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { StoreProvider } from "@/lib/store";
import type { ReadonlyState } from "@/lib/types";
import { AppShell } from "./AppShell";

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it("does not expose a fixture workspace before the backend attests the real environment", async () => {
  let resolve!: (state: ReadonlyState) => void;
  vi.spyOn(api, "state").mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<StoreProvider><AppShell><div>시장 화면</div></AppShell></StoreProvider>);
  expect(screen.queryByText("시장 화면")).not.toBeInTheDocument();
  expect(screen.queryByText("테스트 데이터")).not.toBeInTheDocument();
  resolve({ mode: "real", kiwoom: "connected", kiwoomError: "", watchlists: [], items: [] });
  await waitFor(() => expect(screen.getByText("시장 화면")).toBeInTheDocument());
  expect(screen.getByText("키움 연결")).toBeInTheDocument();
});

it("keeps the unknown environment out of the workspace when startup fails", async () => {
  vi.spyOn(api, "state").mockRejectedValue(new Error("offline"));
  render(<StoreProvider><AppShell><div>시장 화면</div></AppShell></StoreProvider>);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("연결하지 못했습니다"));
  expect(screen.queryByText("시장 화면")).not.toBeInTheDocument();
  expect(screen.queryByText("테스트 데이터")).not.toBeInTheDocument();
});
