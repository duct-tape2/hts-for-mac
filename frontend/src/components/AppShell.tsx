"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, runtimeReady, runtimeError } = useStore();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const clock = (timeZone: string) =>
    now?.toLocaleTimeString("en-GB", { timeZone, hour12: false }) ?? "--:--:--";
  return (
    <div className="terminal-shell" data-hts-theme="classic">
      <header className="terminal-header">
        <Link href="/" className="terminal-brand">
          <span className="terminal-logo">H</span>
          <strong>
            HTS <span>for Mac</span>
          </strong>
        </Link>
        <span className="terminal-title">주식 종합 · 분석 워크스테이션</span>
        <div className="terminal-clocks">
          <span>
            SEOUL <b>{clock("Asia/Seoul")}</b>
          </span>
          <span>
            NEW YORK <b>{clock("America/New_York")}</b>
          </span>
        </div>
        <span
          className={`connection-dot ${state.kiwoom === "connected" ? "connected" : ""}`}
        />
        <span className="text-[11px] text-cream-300">
          {!runtimeReady ? "연결 확인 중" : state.mode === "fixture"
            ? "테스트 데이터"
            : state.kiwoom === "connected"
              ? "키움 연결"
              : "키움 미연결"}
        </span>
        <span className="terminal-readonly">조회 전용</span>
      </header>
      <main id="workspace" className="terminal-main">
        {runtimeReady ? children : (
          <div className="p-6 text-sm text-cream-300" role={runtimeError ? "alert" : "status"}>
            {runtimeError ? "화면 서버에 연결하지 못했습니다. 연결을 자동으로 다시 확인합니다." : "실행 환경과 키움 연결을 확인하고 있습니다…"}
          </div>
        )}
      </main>
    </div>
  );
}
