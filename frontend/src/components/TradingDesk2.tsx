"use client";
import { useEffect, useMemo, useState } from "react";
import { Actions, DockLocation, Layout, I18nLabelDefaults, type TabNode } from "flexlayout-react";
import { TickerSearch } from "./TickerSearch";
import { MarketAlertsProvider } from "./MarketAlertsPanel";
import { ScreenLauncher } from "./ScreenLauncher";
import { PersonalAnalysisBackup } from "./PersonalAnalysisBackup";
import { CompanyDataSettings } from "./CompanyDataSettings";
import { CredentialSettings } from "./CredentialSettings";
import { WorkspaceTransfer } from "./WorkspaceTransfer";
import { DockPanel, PanelHeaderControls, type PriceSelection } from "./DockPanel";
import type { ScreenDefinition } from "@/lib/screenCatalog";
import { changeClass, formatPct, formatPrice, formatReceivedAt, formatSignedPrice, formatVol } from "@/lib/format";
import { pushRecent } from "@/lib/recent";
import { useStore } from "@/lib/store";
import { sameFeed } from "@/lib/types";
import { useLiveQuote } from "@/lib/useLiveQuote";
import { useWorkstation } from "@/lib/useWorkstation";
import { createPopoutCloseReconciler } from "@/lib/popoutRecovery";
import { instrumentForMarket, LINK_GROUPS, type LinkGroup } from "@/lib/workstation";
import { isCapturePreset, type WorkspacePreset } from "@/lib/workspace";
import type { Instrument, Market, Quote } from "@/lib/types";
const quickSymbols = [
  {
    market: "KR",
    stkCd: "005930",
    stkNm: "삼성전자",
    stexTp: "KRX",
    listingVenue: "KOSPI",
    quoteVenue: "KRX",
    currency: "KRW",
  },
  {
    market: "KR",
    stkCd: "000660",
    stkNm: "SK하이닉스",
    stexTp: "KRX",
    listingVenue: "KOSPI",
    quoteVenue: "KRX",
    currency: "KRW",
  },
  {
    market: "US",
    stkCd: "NVDA",
    stkNm: "NVIDIA",
    stexTp: "ND",
    listingVenue: "NASDAQ",
    quoteVenue: "ND",
    currency: "USD",
  },
  {
    market: "US",
    stkCd: "AAPL",
    stkNm: "Apple",
    stexTp: "ND",
    listingVenue: "NASDAQ",
    quoteVenue: "ND",
    currency: "USD",
  },
  {
    market: "US",
    stkCd: "BRK.B",
    stkNm: "Berkshire Hathaway B",
    stexTp: "NY",
    listingVenue: "NYSE",
    quoteVenue: "NY",
    currency: "USD",
  },
] as const;


export function TradingDesk2() {
  const { state } = useStore();
  const desk = useWorkstation(state.mode);
  const { workspace, model, ready } = desk;
  const popoutRecovery = useMemo(() => createPopoutCloseReconciler(model), [model]);
  const [searchValue, setSearchValue] = useState("005930");
  const [selection, setSelection] = useState<PriceSelection>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const groupInstrument = workspace.instruments[workspace.activeGroup];
  const activeInstrument = useMemo(() => ({ ...groupInstrument, environment: state.mode }), [groupInstrument, state.mode]);
  const { quote, quoteError } = useLiveQuote(activeInstrument, refreshKey, ready);
  const visibleQuote = quote && sameFeed(quote, activeInstrument) ? quote : null;
  useEffect(() => { setSearchValue(activeInstrument.stkCd); setSelection(null); }, [activeInstrument, workspace.id]);
  useEffect(() => {
    popoutRecovery.start();
    return () => popoutRecovery.dispose();
  }, [popoutRecovery]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || target?.closest("input,textarea,select,[contenteditable=true]")) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < desk.bundle.workspaces.length) {
        event.preventDefault(); desk.switchTo(desk.bundle.workspaces[index].id); setEditingName(false);
      }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });
  function selectInstrument(next: Instrument, group?: LinkGroup) {
    desk.selectInstrument(next, group);
    pushRecent(next);
    if (!group || group === workspace.activeGroup) { setSelection(null); setSearchValue(next.stkCd); }
  }
  function changeMarket(market: Market) {
    if (market === activeInstrument.market) return;
    selectInstrument(instrumentForMarket(workspace, workspace.activeGroup, market, state.mode));
  }
  async function captureWorkspace() {
    const element = document.querySelector<HTMLElement>(".terminal-shell");
    if (!element || capturing) return;
    setCapturing(true);
    try {
      const { toPng } = await import("html-to-image");
      const url = await toPng(element, { pixelRatio: 1, skipFonts: true, backgroundColor: "#070b12" });
      const link = document.createElement("a");
      link.download = `kiwoom-desk-${state.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      link.href = url; link.click(); desk.setNote("현재 작업공간 이미지를 저장했습니다");
    } catch { desk.setNote("화면 저장에 실패했습니다. 브라우저 화면 캡처를 사용하세요"); }
    finally { setCapturing(false); }
  }
  function openScreen(screen: ScreenDefinition) {
    if (screen.component !== "watch" && screen.market && screen.market !== activeInstrument.market) changeMarket(screen.market);
    let existing: string | undefined;
    model.visitNodes((node) => {
      if (node.getType() !== "tab") return;
      const tab = node as TabNode, config = tab.getConfig() ?? {};
      if (tab.getComponent() === screen.component && (screen.component !== "capture" || config.screen === screen.code) && (screen.component !== "analysis" || !screen.featureId || config.featureId === screen.featureId) && (config.linkGroup ?? "1") === workspace.activeGroup && !config.instrument) existing = tab.getId();
    });
    if (existing) model.doAction(Actions.selectTab(existing));
    else {
      const target = model.getActiveTabset() ?? model.getNodeById("data-set") ?? model.getNodeById("book-set");
      if (target) model.doAction(Actions.addNode({ type: "tab", component: screen.component, name: screen.code ? `[${screen.code}] ${screen.name}` : screen.name, config: { linkGroup: workspace.activeGroup, ...(screen.component === "capture" ? { screen: screen.code, sector: "001" } : {}), ...(screen.featureId ? { featureId: screen.featureId } : {}) } }, target.getId(), DockLocation.CENTER, -1));
    }
    if (desk.saveModel(model, workspace.id)) desk.setNote(`${screen.code ? screen.code + " · " : ""}${screen.name} · 지원 조회 기능 열림`);
  }
  const factory = (node: TabNode) => <DockPanel node={node} model={model} workspace={workspace} environment={state.mode} refreshKey={refreshKey} selection={selection} onPrice={setSelection} onInstrument={selectInstrument} showHeader={false} />;
  return <MarketAlertsProvider environment={state.mode}>
    <div className="hts-workspace">
      <nav className="workspace-menu workspace-commandbar" aria-label="작업공간 구성">
        <ScreenLauncher market={activeInstrument.market} onOpen={openScreen} />
        <div className="workspace-tabs" role="group" aria-label="가상 작업공간">
          {desk.bundle.workspaces.map((item, index) => <button key={item.id} aria-pressed={item.id === workspace.id} className={item.id === workspace.id ? "active" : ""} title={`Ctrl+${index + 1} · 독립된 배치와 종목`} onClick={() => { desk.switchTo(item.id); setEditingName(false); }}><span className="workspace-number">{index + 1}</span>{item.name}</button>)}
        </div>
        <label className="workspace-preset"><span className="sr-only">배치</span><select className="hts-btn" aria-label="현재 작업공간 배치" value={workspace.preset} onChange={(event) => desk.setPreset(event.target.value as WorkspacePreset)}><option value="rankings">13종 · 순위</option><option value="charts">차트 집중</option><option value="markets">시장종합</option><option value="news">뉴스 집중</option><option value="capture">기존 13종 배치</option><option value="terminal">종합</option><option value="dual">2차트</option><option value="quad">4차트</option></select></label>
        <details className="workspace-tools"><summary className="hts-btn">작업공간 ▾</summary><div className="workspace-tools-menu">
          <button className="hts-btn" onClick={() => { changeMarket("KR"); desk.setPreset("rankings"); }}>캡처 13종 열기</button>
          <button className="hts-btn" onClick={() => { setNameDraft(workspace.name); setEditingName(true); }}>이름 변경</button>
          <button className="hts-btn" onClick={() => { if (desk.saveModel(model, workspace.id)) desk.setNote("작업공간·종목 연동·배치를 저장했습니다"); }}>배치 저장</button>
          <button className="hts-btn" onClick={() => desk.setPreset(workspace.preset, true)}>현재 배치 초기화</button>
          <button className="hts-btn" onClick={() => desk.setPreset("terminal")}>종합 배치</button>
          <button className="hts-btn" onClick={() => setShowHelp((v) => !v)} aria-expanded={showHelp}>사용 안내</button>
          <CompanyDataSettings environment={state.mode} />
          <PersonalAnalysisBackup />
          <WorkspaceTransfer bundle={desk.bundle} onRestore={desk.restoreBundle} onNote={desk.setNote} />
        </div></details>
        <button className="hts-btn capture-workspace-button" disabled={capturing} onClick={captureWorkspace}>{capturing ? "이미지 생성 중" : "화면 저장"}</button>
        <CredentialSettings environment={state.mode} onConnected={() => setRefreshKey((v) => v + 1)} />
      </nav>
      {editingName && <form className="workspace-rename" onSubmit={(event) => { event.preventDefault(); if (nameDraft.trim()) { desk.rename(nameDraft); setEditingName(false); } }}>
        <input aria-label="작업공간 이름" maxLength={24} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} autoFocus onKeyDown={(event) => { if (event.key === "Escape") setEditingName(false); }} />
        <button className="hts-btn" disabled={!nameDraft.trim()}>저장</button><button type="button" className="hts-btn" onClick={() => setEditingName(false)}>취소</button>
      </form>}
      {showHelp && <div className="workspace-help"><b>조회 작업공간</b><span>Home: 화면 검색 · Ctrl+1~4: 작업공간 전환 · 탭 드래그/경계선: 배치·크기 · 더블클릭: 최대화</span><span>같은 연동 번호만 종목을 공유합니다. 고정한 창은 유지되며, ＋로 같은 화면을 하나 더 엽니다. 화면번호는 지원 조회 기능의 단축 경로입니다.</span><span>개별 종목 호가는 KRX 기준입니다. 캡처 화면의 거래소·제공자·기준 시각은 각 화면에 표시됩니다. {state.mode === "fixture" ? "현재 합성 테스트 데이터입니다." : "실시간/스냅샷 상태와 수신 시각을 확인하세요."}</span></div>}
      <section className="instrument-toolbar" aria-label="조회 종목 선택">
        <label className="toolbar-link-group">연동 <select aria-label="조회 대상 연동 그룹" className="hts-btn" value={workspace.activeGroup} onChange={(event) => desk.updateCurrent({ activeGroup: event.target.value as LinkGroup })}>{LINK_GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}</select></label>
        <div className="market-switch" aria-label="시장 선택">{(["KR", "US"] as const).map((market) => <button key={market} aria-pressed={activeInstrument.market === market} className={activeInstrument.market === market ? "active" : ""} onClick={() => changeMarket(market)}>{market === "KR" ? "국내주식" : "미국주식"}</button>)}</div>
        <div className="workspace-search"><TickerSearch market={activeInstrument.market} value={searchValue} selectedValue={activeInstrument.stkCd} showRecent onChange={setSearchValue} onPick={selectInstrument} /></div>
        <button className="hts-btn" onClick={() => setRefreshKey((v) => v + 1)} title="활성 화면 시세·차트 다시 조회">↻ 새로고침</button>
        <div className="symbol-shortcuts" aria-label="빠른 종목 선택">{quickSymbols.map((item) => <button key={item.stkCd} className={activeInstrument.stkCd === item.stkCd ? "active" : ""} onClick={() => selectInstrument({ ...item, environment: state.mode })}>{item.market === "KR" ? item.stkNm : item.stkCd}</button>)}</div>
        <span className={`data-mode ${state.mode === "fixture" ? "fixture" : ""}`}>{state.mode === "fixture" ? "TEST · 합성 데이터" : state.mode === "demo" ? "모의 서버" : "실서버"}</span>
      </section>
      {!isCapturePreset(workspace.preset) && workspace.preset !== "quad" && <QuoteSummary instrument={activeInstrument} quote={visibleQuote} error={quoteError} selectedPrice={selection && sameFeed(selection.instrument, activeInstrument) ? selection.price : null} />}
      <div className="dock-area" data-testid="hts-dock">{ready ? <Layout key={workspace.id} model={model} factory={factory} onRenderTabSet={(tabset, values) => { const selected = tabset.getSelectedNode(); if (selected) values.buttons.unshift(<PanelHeaderControls key={selected.getId()} node={selected} model={model} workspace={workspace} environment={state.mode} />); }} realtimeResize supportsPopout={true} popoutURL="/popout.html" onPopoutOpen={(layout, popup) => popoutRecovery.track(layout.getLayoutId(), popup)} onPopoutClose={(layout) => popoutRecovery.untrack(layout.getLayoutId())} onModelChange={(changed) => desk.saveModel(changed, workspace.id)} i18nTranslator={(key) => ({ "flexlayout.ui.maximize.tabset": "최대화", "flexlayout.ui.restore.tabset": "복원", "flexlayout.ui.close.tab": "탭 닫기", "flexlayout.ui.popout.tab.float": "분리 창", "flexlayout.ui.dock.float.to.layout": "작업공간으로 복원", "flexlayout.ui.splitter": "패널 크기 조절" })[key] ?? I18nLabelDefaults[key] ?? key} /> : <div className="panel-empty">작업공간 여는 중…</div>}</div>
      <footer className="workspace-status"><span className={`connection-dot ${state.kiwoom === "connected" ? "connected" : ""}`} /><span>{state.mode === "fixture" ? "키움 미연결 · 테스트 화면" : state.kiwoom === "connected" ? "키움 API 연결" : "키움 연결 대기"}</span><span>{activeInstrument.market === "KR" ? "KRX · 체결/호가 구독" : "미국 · 체결/호가 구독"}</span><span>작업공간 {desk.bundle.workspaces.indexOf(workspace) + 1} · 연동 {workspace.activeGroup}</span><span className="workspace-save-note" role="status">{desk.note}</span><span className="ml-auto">{state.mode === "fixture" ? "실제 시세가 아닙니다" : "수신: " + formatReceivedAt(visibleQuote?.receivedAt ?? null)}</span><span>조회·분석 전용</span></footer>
    </div>
  </MarketAlertsProvider>;
}

export function QuoteSummary({
  instrument,
  quote,
  error,
  selectedPrice,
}: {
  instrument: Instrument;
  quote: Quote | null;
  error: string;
  selectedPrice: number | null;
}) {
  return (
    <section className="quote-ribbon" aria-label="선택 종목 현재가">
      <div className="quote-name">
        <div>
          <span className="venue-tag">{instrument.listingVenue}</span>
          <span>{instrument.stkCd}</span>
        </div>
        <h1>{instrument.stkNm}</h1>
      </div>
      <div className="quote-main">
        <strong className={changeClass(quote?.change ?? null)}>
          {formatPrice(quote?.last ?? null, instrument.currency)}
        </strong>
        <span className={changeClass(quote?.change ?? null)}>
          {formatSignedPrice(quote?.change ?? null, instrument.currency)}{" "}
          <b>{formatPct(quote?.changePct ?? null)}</b>
        </span>
      </div>
      <dl className="quote-stat-grid">
        <div>
          <dt>시가</dt>
          <dd>{formatPrice(quote?.open ?? null, instrument.currency)}</dd>
        </div>
        <div>
          <dt>고가</dt>
          <dd className="text-up">
            {formatPrice(quote?.high ?? null, instrument.currency)}
          </dd>
        </div>
        <div>
          <dt>저가</dt>
          <dd className="text-down">
            {formatPrice(quote?.low ?? null, instrument.currency)}
          </dd>
        </div>
        <div>
          <dt>전일</dt>
          <dd>{formatPrice(quote?.prevClose ?? null, instrument.currency)}</dd>
        </div>
        <div>
          <dt>거래량</dt>
          <dd>{formatVol(quote?.volume ?? null)}</dd>
        </div>
        <div>
          <dt>선택 가격</dt>
          <dd className="text-brass-400">
            {selectedPrice === null
              ? "—"
              : formatPrice(selectedPrice, instrument.currency)}
          </dd>
        </div>
      </dl>
      <div className="quote-provenance">
        <span>
          {quote?.source === "fixture"
            ? "테스트 시세"
            : quote?.status === "live"
              ? "실시간 체결"
              : quote?.status === "stale" ? "수신 지연"
              : quote?.status === "error" ? "시세 오류"
              : !quote || quote.status === "missing" ? "미수신" : "스냅샷"}
        </span>
        <span>출처 {quote?.source ?? "미수신"}</span>
        <span>{quote ? formatReceivedAt(quote.tradeReceivedAt ?? quote.receivedAt) : "수신 대기"}</span>
        {quote?.last === null && <span>체결가 미수신</span>}
        {error && (
          <span role="alert" className="text-brass-400">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
