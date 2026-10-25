"use client";

import { useMemo, useRef, useState } from "react";
import {
  backupConflicts,
  backupCounts,
  createPersonalAnalysisBackup,
  PERSONAL_ANALYSIS_BACKUP_MAX_BYTES,
  parsePersonalAnalysisBackup,
  restorePersonalAnalysisBackup,
  type PersonalAnalysisBackup as Backup,
  type PersonalAnalysisCounts,
  type PersonalAnalysisConflicts,
} from "@/lib/personalAnalysisBackup";
import "./personalAnalysisBackup.css";

type Preview = { backup: Backup; counts: PersonalAnalysisCounts; conflicts: PersonalAnalysisConflicts };

function browserStorage() { return typeof window === "undefined" ? null : window.localStorage; }
function errorText(error: unknown) { return error instanceof Error ? error.message : "작업을 완료하지 못했습니다."; }

export function PersonalAnalysisBackup() {
  const [notes, setNotes] = useState<Backup["notes"]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("저장된 분석 목록은 새로고침할 때만 읽습니다.");
  const inputRef = useRef<HTMLInputElement>(null);
  const shownNotes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle ? notes : notes.filter((note) => `${note.market} ${note.stkCd} ${note.text}`.toLocaleLowerCase().includes(needle));
  }, [notes, query]);

  function readLocal() {
    const storage = browserStorage();
    if (!storage) { setStatus("브라우저 저장소를 사용할 수 없습니다."); return; }
    try {
      const backup = createPersonalAnalysisBackup(storage);
      setNotes(backup.notes);
      setStatus(`검증된 분석 메모 ${backup.notes.length}개와 차트 범위 ${Object.keys(backup.chartTools.scopes).length}개를 찾았습니다.`);
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  function download() {
    const storage = browserStorage();
    if (!storage) { setStatus("브라우저 저장소를 사용할 수 없습니다."); return; }
    try {
      const backup = createPersonalAnalysisBackup(storage);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "kiwoom-personal-analysis-backup.json";
      anchor.click();
      URL.revokeObjectURL(href);
      setNotes(backup.notes);
      setStatus(`개인 분석 백업을 만들었습니다. 메모 ${backup.notes.length}개, 차트 범위 ${Object.keys(backup.chartTools.scopes).length}개입니다.`);
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  async function selectFile(file: File | null | undefined) {
    if (!file) return;
    try {
      if (file.size > PERSONAL_ANALYSIS_BACKUP_MAX_BYTES) throw new Error("백업 파일이 1 MiB 제한을 넘습니다.");
      const backup = parsePersonalAnalysisBackup(await file.text());
      const storage = browserStorage();
      if (!storage) throw new Error("브라우저 저장소를 사용할 수 없습니다.");
      setPreview({ backup, counts: backupCounts(backup), conflicts: backupConflicts(storage, backup) });
      setStatus("백업 파일을 검증했습니다. 아래 내용을 확인한 뒤 복원하세요.");
    } catch (error) {
      setPreview(null);
      setStatus(errorText(error));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function restore() {
    if (!preview) return;
    const storage = browserStorage();
    if (!storage) { setStatus("브라우저 저장소를 사용할 수 없습니다."); return; }
    try {
      const counts = restorePersonalAnalysisBackup(storage, preview.backup);
      const local = createPersonalAnalysisBackup(storage);
      setNotes(local.notes);
      setPreview(null);
      setStatus(`복원했습니다. 메모 ${counts.notes}개와 차트 범위 ${counts.scopes}개를 현재 데이터와 병합했습니다.`);
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  return (
    <section className="personal-analysis-backup" aria-label="개인 분석 백업">
      <div className="personal-analysis-backup-title"><strong>개인 분석 백업</strong><span>메모·차트 도구만</span></div>
      <p className="personal-analysis-backup-disclosure">`hts-note:시장:종목코드` 메모와 차트 그리기·지표 템플릿만 대상입니다. API 키, 제공자 연락처, 시세, 알림, 계정 정보는 읽거나 내보내지 않습니다.</p>
      <div className="personal-analysis-backup-actions">
        <button type="button" onClick={readLocal}>저장된 분석 목록 새로고침</button>
        <button type="button" onClick={download}>JSON 백업 다운로드</button>
        <label>JSON 파일 선택 <input ref={inputRef} type="file" accept="application/json,.json" onChange={(event) => void selectFile(event.target.files?.[0])} /></label>
      </div>
      <p className="personal-analysis-backup-status" role="status">{status}</p>

      {preview && <div className="personal-analysis-backup-preview" role="region" aria-label="복원 미리보기">
        <strong>복원 미리보기</strong>
        <span>메모 {preview.counts.notes} · 차트 범위 {preview.counts.scopes} · 그리기 {preview.counts.drawings} · 템플릿 {preview.counts.templates}</span>
        <span>기존 항목 충돌: 메모 {preview.conflicts.notes} · 범위 {preview.conflicts.scopes} · 그리기 {preview.conflicts.drawings} · 템플릿 {preview.conflicts.templates}</span>
        <button type="button" onClick={restore}>검증한 내용 복원</button>
        <button type="button" onClick={() => setPreview(null)}>취소</button>
      </div>}

      <div className="personal-analysis-backup-search">
        <label>메모 검색 <input aria-label="메모 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="시장·코드·내용" /></label>
        <span>{shownNotes.length}/{notes.length}개</span>
      </div>
      <div className="personal-analysis-backup-list">
        {shownNotes.length ? shownNotes.map((note) => <article key={`${note.market}:${note.stkCd}`}>
          <header>{note.market} · {note.stkCd}</header><p>{note.text}</p>
        </article>) : <p>새로고침 후 검증된 저장 메모를 여기에서 검색할 수 있습니다.</p>}
      </div>
    </section>
  );
}
