"use client";

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode } from "react";
import { api } from "./api";
import type { Environment, Instrument, ReadonlyState, Health } from "./types";
import type { LocalWatchlistImport } from "./workspaceTransfer";

export type AppState = ReadonlyState & {
  selectedWatchlistId: string;
};

type Action =
  | { type: "hydrate"; state: ReadonlyState; selectedWatchlistId?: string }
  | { type: "runtime"; health: Health }
  | { type: "selectWatchlist"; id: string }
  | { type: "addWatchlist"; name: string }
  | { type: "removeWatchlist"; id: string }
  | { type: "addItem"; watchlistId: string; instrument: Instrument }
  | { type: "removeItem"; id: string }
  | { type: "saveWatchlist"; id: string }
  | { type: "importKiwoom"; id: string; market?: "KR" | "US" }
  | { type: "setWatchlistNote"; note: string };

const STORAGE_KEY = "kiwoom-readonly-watchlists-v1";
const DEFAULT_WATCHLIST_ID = "wl_default";

const seed: AppState = {
  mode: "fixture",
  kiwoom: "disconnected",
  kiwoomError: "",
  watchlists: [{ id: DEFAULT_WATCHLIST_ID, name: "내 관심종목", source: "app" }],
  items: [],
  selectedWatchlistId: DEFAULT_WATCHLIST_ID,
  watchlistNote: "",
};

function selectedId(watchlists: AppState["watchlists"], requested: string) {
  return watchlists.some((list) => list.id === requested) ? requested : watchlists[0]?.id ?? "";
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "runtime":
      return { ...state, mode: action.health.mode, kiwoom: action.health.kiwoom, kiwoomError: action.health.error };
    case "hydrate": {
      const requested = action.selectedWatchlistId ?? state.selectedWatchlistId;
      return { ...action.state, selectedWatchlistId: selectedId(action.state.watchlists, requested) };
    }
    case "selectWatchlist":
      return state.watchlists.some((list) => list.id === action.id) ? { ...state, selectedWatchlistId: action.id } : state;
    case "setWatchlistNote":
      return { ...state, watchlistNote: action.note };
    default:
      // Mutations are intentionally server-confirmed; no temporary ids or local success state.
      return state;
  }
}

type PersistedState = Pick<AppState, "watchlists" | "items" | "selectedWatchlistId">;

function readLocalState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedState>;
    if (!Array.isArray(value.watchlists) || !Array.isArray(value.items) || typeof value.selectedWatchlistId !== "string") return null;
    return value as PersistedState;
  } catch {
    return null;
  }
}

function writeLocalState(state: AppState) {
  try {
    const data: PersistedState = { watchlists: state.watchlists, items: state.items, selectedWatchlistId: state.selectedWatchlistId };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Browser cache is only a read fallback; server-confirmed mutations own persistence.
  }
}

type StoreContextValue = {
  state: AppState;
  dispatch: Dispatch<Action>;
  isWatchlistPending: boolean;
  runtimeReady: boolean;
  runtimeError: boolean;
  importLocalWatchlists: (payload: LocalWatchlistImport) => Promise<void>;
};

const StoreContext = createContext<StoreContextValue | null>(null);

function localStateAsReadonly(local: PersistedState, mode: Environment): ReadonlyState {
  return {
    mode,
    kiwoom: "disconnected",
    kiwoomError: "",
    watchlists: local.watchlists,
    items: local.items,
    watchlistNote: "캐시한 관심종목을 불러왔습니다. 서버 연결 전에는 변경할 수 없습니다.",
  };
}

function requestFor(action: Action, before: AppState): Promise<ReadonlyState> | null {
  switch (action.type) {
    case "addWatchlist":
      return action.name.trim() ? api.addWatchlist(action.name.trim()) : null;
    case "removeWatchlist":
      return action.id === DEFAULT_WATCHLIST_ID ? null : api.removeWatchlist(action.id);
    case "addItem":
      if (!before.watchlists.some((list) => list.id === action.watchlistId)) return null;
      if (before.items.some((item) => item.watchlistId === action.watchlistId && item.market === action.instrument.market && item.stkCd === action.instrument.stkCd && item.listingVenue === action.instrument.listingVenue && item.quoteVenue === action.instrument.quoteVenue)) return null;
      return api.addItem(action.watchlistId, action.instrument);
    case "removeItem": {
      const item = before.items.find((row) => row.id === action.id);
      return item ? api.removeItem(item.watchlistId, item.id) : null;
    }
    case "saveWatchlist":
      return before.watchlists.some((list) => list.id === action.id) ? api.saveWatchlist(action.id) : null;
    case "importKiwoom":
      return before.watchlists.some((list) => list.id === action.id) ? (action.market ? api.importKiwoom(action.id, action.market) : api.importKiwoom(action.id)) : null;
    default:
      return null;
  }
}

function successNote(action: Action, next: ReadonlyState) {
  if (next.watchlistNote) return next.watchlistNote;
  switch (action.type) {
    case "addWatchlist":
      return "그룹을 서버에 저장했습니다.";
    case "removeWatchlist":
      return "그룹을 서버에서 제거했습니다.";
    case "addItem":
      return "관심종목을 서버에 저장했습니다.";
    case "removeItem":
      return "관심종목을 서버에서 제거했습니다.";
    case "importKiwoom":
      return "미국 HTS 관심종목을 가져왔습니다.";
    case "saveWatchlist":
      return "서버에 저장했습니다.";
    default:
      return "";
  }
}

function pendingNote(action: Action) {
  return action.type === "importKiwoom" ? `${action.market === "KR" ? "국내" : "미국"} HTS 관심종목을 가져오는 중…` : "서버에 저장하는 중…";
}

function selectionAfterResponse(action: Action, before: AppState, next: ReadonlyState) {
  if (action.type === "addWatchlist") {
    const knownIds = new Set(before.watchlists.map((list) => list.id));
    const name = action.name.trim();
    const created = next.watchlists.find((list) => !knownIds.has(list.id) && list.name === name) ?? next.watchlists.find((list) => !knownIds.has(list.id));
    return selectedId(next.watchlists, created?.id ?? before.selectedWatchlistId);
  }
  return selectedId(next.watchlists, before.selectedWatchlistId);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, seed);
  const stateRef = useRef(state);
  const pendingRef = useRef(false);
  const mutationGenerationRef = useRef(0);
  const [storageReady, setStorageReady] = useState(false);
  const [isWatchlistPending, setIsWatchlistPending] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState(false);
  stateRef.current = state;

  useEffect(() => {
    const local = readLocalState();
    if (local) dispatch({ type: "hydrate", state: localStateAsReadonly(local, stateRef.current.mode), selectedWatchlistId: local.selectedWatchlistId });
    setStorageReady(true);

    const controller = new AbortController();
    const requestGeneration = mutationGenerationRef.current;
    void api
      .state(controller.signal)
      .then((next) => {
        // A delayed startup response must not overwrite a completed mutation.
        if (!controller.signal.aborted && requestGeneration === mutationGenerationRef.current) {
          dispatch({ type: "hydrate", state: next, selectedWatchlistId: local?.selectedWatchlistId ?? stateRef.current.selectedWatchlistId });
          setRuntimeReady(true);
          setRuntimeError(false);
        }
      })
      .catch(() => {
        // Existing cache remains readable. Failed server calls never manufacture a local success.
        if (!controller.signal.aborted) setRuntimeError(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (storageReady) writeLocalState(state);
  }, [state, storageReady]);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const health = await api.health(controller.signal);
        if (!stopped) {
          dispatch({ type: "runtime", health });
          setRuntimeReady(true);
          setRuntimeError(false);
        }
      } catch { /* A transport outage does not change the selected environment. */ }
      if (!stopped) timer = setTimeout(check, 15000);
    };
    timer = setTimeout(check, 15000);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, []);

  const value = useMemo(() => {
    const wrapped: Dispatch<Action> = (action) => {
      if (action.type === "selectWatchlist" || action.type === "hydrate" || action.type === "runtime" || action.type === "setWatchlistNote") {
        dispatch(action);
        return;
      }
      if (action.type === "removeWatchlist" && action.id === DEFAULT_WATCHLIST_ID) {
        dispatch({ type: "setWatchlistNote", note: "기본 관심종목 그룹은 제거할 수 없습니다." });
        return;
      }
      if (pendingRef.current) {
        dispatch({ type: "setWatchlistNote", note: "이전 관심종목 변경을 서버에 저장하는 중입니다." });
        return;
      }

      const before = stateRef.current;
      const request = requestFor(action, before);
      if (!request) {
        const note = action.type === "addItem" ? "이미 추가했거나 선택한 그룹을 찾을 수 없습니다." : "저장할 변경이 없습니다.";
        dispatch({ type: "setWatchlistNote", note });
        return;
      }

      pendingRef.current = true;
      mutationGenerationRef.current += 1;
      setIsWatchlistPending(true);
      dispatch({ type: "setWatchlistNote", note: pendingNote(action) });
      void request
        .then((next) => {
          dispatch({ type: "hydrate", state: next, selectedWatchlistId: selectionAfterResponse(action, before, next) });
          dispatch({ type: "setWatchlistNote", note: successNote(action, next) });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "저장에 실패했습니다.";
          dispatch({ type: "setWatchlistNote", note: `서버 저장 실패: ${message}. 변경은 적용되지 않았습니다.` });
        })
        .finally(() => {
          pendingRef.current = false;
          setIsWatchlistPending(false);
        });
    };
    const importLocalWatchlists = async (payload: LocalWatchlistImport) => {
      if (pendingRef.current) {
        const error = new Error("이전 관심종목 변경을 서버에 저장하는 중입니다.");
        dispatch({ type: "setWatchlistNote", note: error.message });
        throw error;
      }
      const before = stateRef.current;
      pendingRef.current = true;
      mutationGenerationRef.current += 1;
      setIsWatchlistPending(true);
      dispatch({ type: "setWatchlistNote", note: "전송 파일의 관심종목을 서버에 병합하는 중입니다…" });
      try {
        const next = await api.importLocalWatchlists(payload);
        dispatch({ type: "hydrate", state: next, selectedWatchlistId: selectedId(next.watchlists, before.selectedWatchlistId) });
        dispatch({ type: "setWatchlistNote", note: next.watchlistNote || "전송 파일의 관심종목을 서버에 병합했습니다." });
      } catch (error) {
        // A response can be lost after the local atomic write, so callers must
        // not claim the server definitely rejected this idempotent merge.
        dispatch({ type: "setWatchlistNote", note: "전송 관심종목의 서버 반영 여부를 다시 확인해야 합니다." });
        throw error;
      } finally {
        pendingRef.current = false;
        setIsWatchlistPending(false);
      }
    };
    return { state, dispatch: wrapped, isWatchlistPending, runtimeReady, runtimeError, importLocalWatchlists };
  }, [isWatchlistPending, state, runtimeReady, runtimeError]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("StoreProvider missing");
  return ctx;
}
