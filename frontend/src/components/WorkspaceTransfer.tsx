"use client";

import { useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type { WorkstationState } from "@/lib/workstation";
import {
  BROWSER_WORKSPACE_BACKUP_KEY,
  MAX_WORKSPACE_TRANSFER_BYTES,
  createWorkspaceTransfer,
  parseWorkspaceTransfer,
} from "@/lib/workspaceTransfer";
import "./workspaceTransfer.css";

export type WorkspaceTransferProps = {
  bundle: WorkstationState;
  onRestore: (next: WorkstationState) => void;
  onNote: (message: string) => void;
};

function message(error: unknown) {
  return error instanceof Error && error.message ? error.message : "가져오기에 실패했습니다.";
}

export function WorkspaceTransfer({ bundle, onRestore, onNote }: WorkspaceTransferProps) {
  const { state, isWatchlistPending, importLocalWatchlists } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [backupAvailable, setBackupAvailable] = useState(() => typeof window !== "undefined" && localStorage.getItem(BROWSER_WORKSPACE_BACKUP_KEY) !== null);

  function download() {
    try {
      const transfer = createWorkspaceTransfer(bundle, state);
      const blob = new Blob([`${JSON.stringify(transfer, null, 2)}\n`], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "kiwoom-hts-workspace.json";
      anchor.click();
      URL.revokeObjectURL(href);
      onNote("안전한 작업공간·관심종목 파일을 저장했습니다. 인증 정보와 시세는 포함하지 않았습니다.");
    } catch (error) {
      onNote(`내보내기에 실패했습니다: ${message(error)}`);
    }
  }

  function downloadBackup() {
    try {
      const raw = localStorage.getItem(BROWSER_WORKSPACE_BACKUP_KEY);
      if (!raw) throw new Error("저장된 이전 백업이 없습니다.");
      // Validate first: never turn arbitrary historical localStorage into a download.
      parseWorkspaceTransfer(raw, state.mode);
      const blob = new Blob([`${raw}\n`], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "kiwoom-hts-workspace-backup.json";
      anchor.click();
      URL.revokeObjectURL(href);
      onNote("이전 작업공간 백업 파일을 저장했습니다.");
    } catch (error) {
      onNote(`이전 백업을 저장하지 못했습니다: ${message(error)}`);
    }
  }

  async function importFile(file: File) {
    if (file.size > MAX_WORKSPACE_TRANSFER_BYTES) {
      onNote("가져올 파일은 1MiB 이하여야 합니다.");
      return;
    }
    if (busyRef.current || isWatchlistPending) {
      onNote("이전 가져오기 또는 관심종목 저장이 끝난 뒤 다시 시도하세요.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    let restored = false;
    try {
      const parsed = parseWorkspaceTransfer(await file.text(), state.mode);
      // Store a sanitized, re-importable checkpoint before changing the live view.
      // This is intentionally not an opaque localStorage copy that might retain
      // historic unknown config fields.
      const backup = createWorkspaceTransfer(bundle, state);
      localStorage.setItem(BROWSER_WORKSPACE_BACKUP_KEY, JSON.stringify(backup));
      if (localStorage.getItem(BROWSER_WORKSPACE_BACKUP_KEY) === null) throw new Error("브라우저 백업을 저장하지 못했습니다.");
      setBackupAvailable(true);

      // restoreBundle is transactional: a storage failure leaves its prior
      // workstation/model intact and throws before the server mutation starts.
      onRestore(parsed.workstation);
      restored = true;
      await importLocalWatchlists({ version: 1, watchlists: parsed.watchlists });
      onNote("작업공간과 관심종목을 안전하게 병합했습니다. 가져온 종목은 이 Mac 환경으로 다시 연결됩니다.");
    } catch (error) {
      if (restored) {
        try {
          onRestore(bundle);
        } catch {
          onNote("관심종목 서버 반영 여부를 다시 확인해야 하며 작업공간 자동 복구에도 실패했습니다. 이전 백업 저장 버튼으로 백업을 내려받아 다시 가져오세요.");
          return;
        }
      }
      onNote(`${restored ? "관심종목 서버 반영 여부를 다시 확인해야 합니다. 작업공간은 이전 상태로 되돌렸습니다." : "가져오기에 실패했습니다."} 완료로 표시하지 않았습니다: ${message(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return <section className="workspace-transfer" aria-label="작업공간 이전">
    <div className="workspace-transfer-actions">
      <button type="button" className="hts-btn" onClick={download} disabled={busy || isWatchlistPending}>내보내기</button>
      <button type="button" className="hts-btn" onClick={() => fileRef.current?.click()} disabled={busy || isWatchlistPending}>{busy ? "가져오는 중…" : "가져오기"}</button>
      <button type="button" className="hts-btn" onClick={downloadBackup} disabled={busy || !backupAvailable}>이전 백업 저장</button>
      <input ref={fileRef} className="sr-only" type="file" accept="application/json,.json" aria-label="작업공간 전송 파일" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void importFile(file);
      }} />
    </div>
    <div className="workspace-transfer-safety">
      <p><b>포함</b> 4개 작업공간, 배치·표시 설정, 관심종목 그룹 이름과 종목 식별자</p>
      <p><b>제외되는 키</b> API 키, 앱 시크릿, 액세스·갱신 토큰, 키체인 항목</p>
      <p><b>새 Mac에서 다시 등록</b> 키움 API 키와 앱 시크릿은 이 파일에 없으므로 해당 Mac에서 별도로 등록해야 합니다.</p>
      <p>계좌·주문·체결·실시간/저장 시세는 이전하지 않습니다. 파일은 최대 1MiB이며, 기존 관심종목은 삭제하지 않고 중복 없이 병합합니다.</p>
    </div>
  </section>;
}
