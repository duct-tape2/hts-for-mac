"use client";

import { useEffect, useRef, useState } from "react";
import { Model } from "flexlayout-react";
import { parseInstrument } from "./api";
import { WORKSPACE_KEY, readWorkspace, workspaceLayout, type WorkspacePreset } from "./workspace";
import {
  WORKSTATION_KEY, createWorkstation, readWorkstation, updateWorkspace,
  selectWorkspace, setGroupInstrument, renameWorkspace,
  type LinkGroup, type WorkstationState, type WorkstationWorkspace,
} from "./workstation";
import type { Environment, Instrument } from "./types";

/** Only the active space owns mounted panels; saved spaces contain data, never subscriptions. */
export function useWorkstation(environment: Environment) {
  const [bundle, setBundle] = useState(() => createWorkstation(environment));
  const current = useRef(bundle);
  const [model, setModel] = useState(() => Model.fromJson(bundle.workspaces[0].layout));
  const modelRef = useRef(model);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState("작업공간은 자동 저장됩니다");
  const workspace = bundle.workspaces.find((w) => w.id === bundle.activeId)!;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKSTATION_KEY);
      let loaded = readWorkstation(raw);
      if (!loaded) {
        let legacyInstrument: Instrument | null = null;
        try {
          const value = localStorage.getItem("kiwoom-hts-selected-v1");
          if (value) legacyInstrument = parseInstrument(JSON.parse(value));
        } catch { /* A bad old selection must not discard a valid old layout. */ }
        const legacy = readWorkspace(localStorage.getItem(WORKSPACE_KEY));
        loaded = createWorkstation(environment, legacy, legacyInstrument);
        if (raw) setNote("저장된 작업공간을 읽지 못했습니다. 이전 배치를 복구했습니다");
        else if (legacy) setNote("기존 배치를 첫 작업공간으로 가져왔습니다");
      } else setNote("마지막 작업공간과 종목 연동을 복원했습니다");
      const active = loaded.workspaces.find((w) => w.id === loaded.activeId)!;
      const restored = Model.fromJson(active.layout);
      current.current = loaded;
      modelRef.current = restored;
      setBundle(loaded);
      setModel(restored);
    } catch { setNote("저장소를 읽지 못했습니다. 현재 창에서 계속 사용할 수 있습니다"); }
    setReady(true);
    // The application environment is fixed by the runtime gate before this hook mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit(next: WorkstationState) {
    let serialized: string;
    try {
      serialized = JSON.stringify(next);
      if (!readWorkstation(serialized)) { setNote("배치를 저장할 수 없습니다. 창 개수나 배치를 줄여 주세요. 마지막 저장본은 유지됩니다"); return false; }
    } catch { setNote("잘못된 배치 변경을 취소했습니다. 마지막 배치를 유지합니다"); return false; }
    current.current = next;
    setBundle(next);
    try {
      localStorage.setItem(WORKSTATION_KEY, serialized); return true;
    }
    catch { setNote("저장 실패 · 현재 배치는 유지됩니다. 브라우저 저장 공간을 확인하세요"); return false; }
  }
  function updateCurrent(patch: Partial<Omit<WorkstationWorkspace, "id">>) {
    return commit(updateWorkspace(current.current, current.current.activeId, patch));
  }
  function saveModel(changed: Model, ownerId: string) {
    // Ignore late callbacks from a just-unmounted space/model.
    if (ownerId !== current.current.activeId || changed !== modelRef.current) return;
    const previous = current.current;
    const saved = updateCurrent({ layout: changed.toJson() });
    if (!saved && current.current === previous) {
      const restored = Model.fromJson(previous.workspaces.find((w) => w.id === ownerId)!.layout);
      modelRef.current = restored;
      setModel(restored);
    }
    return saved;
  }
  function switchTo(id: string) {
    if (id === current.current.activeId || !current.current.workspaces.some((w) => w.id === id)) return;
    let next = updateWorkspace(current.current, current.current.activeId, { layout: modelRef.current.toJson() });
    next = selectWorkspace(next, id);
    const saved = commit(next);
    if (current.current !== next) return;
    const active = next.workspaces.find((w) => w.id === id)!;
    const restored = Model.fromJson(active.layout);
    modelRef.current = restored;
    setModel(restored);
    if (saved) setNote(`${active.name} · 독립 종목과 배치 복원`);
  }
  function setPreset(preset: WorkspacePreset, reset = false) {
    const active = current.current.workspaces.find((item) => item.id === current.current.activeId)!;
    if (active.preset === preset && !reset) return;
    const savedLayouts = { ...active.savedLayouts, [active.preset]: modelRef.current.toJson() };
    const layout = !reset && savedLayouts[preset] ? savedLayouts[preset]! : workspaceLayout(preset);
    const replacement = Model.fromJson(layout);
    const before = current.current;
    const saved = updateCurrent({ preset, layout, savedLayouts });
    if (current.current === before) return;
    modelRef.current = replacement;
    setModel(replacement);
    if (saved) setNote("이전 배치를 보관하고 선택한 보기를 열었습니다");
  }
  function restoreBundle(next: WorkstationState) {
    const checked = readWorkstation(JSON.stringify(next));
    if (!checked) throw new Error("작업공간 파일 형식이 올바르지 않습니다.");
    const active = checked.workspaces.find((item) => item.id === checked.activeId)!;
    const restored = Model.fromJson(active.layout);
    // Import is transactional: a storage failure must not partially switch the visible workspace.
    try { localStorage.setItem(WORKSTATION_KEY, JSON.stringify(checked)); }
    catch { throw new Error("저장 공간에 작업공간을 복원하지 못했습니다. 기존 배치를 유지합니다."); }
    current.current = checked;
    setBundle(checked);
    modelRef.current = restored;
    setModel(restored);
  }
  function selectInstrument(instrument: Instrument, group?: LinkGroup) {
    const active = current.current.workspaces.find((w) => w.id === current.current.activeId)!;
    const target = group ?? active.activeGroup;
    const next = setGroupInstrument(current.current, active.id, target, { ...instrument, environment });
    commit(next);
  }
  function rename(name: string) {
    commit(renameWorkspace(current.current, current.current.activeId, name));
  }
  return { bundle, workspace, model, ready, note, setNote, updateCurrent, saveModel, switchTo, setPreset, selectInstrument, rename, restoreBundle };
}
