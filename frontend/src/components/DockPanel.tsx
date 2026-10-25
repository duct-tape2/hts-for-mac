"use client";

import { useEffect, useMemo, useState } from "react";
import { Actions, DockLocation, type Model, type TabNode } from "flexlayout-react";
import { OrderBook } from "./OrderBook";
import { PriceChart, type PriceChartPreferences } from "./PriceChart";
import { WatchlistPanel } from "./WatchlistPanel";
import { MarketAlertsPanel } from "./MarketAlertsPanel";
import { RankingsPanel, InvestorFlowPanel } from "./MarketAnalyticsPanel";
import { DetailsPanel, HistoryPanel, NotesPanel } from "./AnalysisPanels";
import { CapturePanel } from "./CapturePanel";
import { normalizeExtendedIndicatorPeriods } from "@/lib/extendedIndicators";
import { ConditionPanel } from "./ConditionPanel";
import { MarketJournal } from "./MarketJournal";
import { MarketCalculator } from "./MarketCalculator";
import { LocalScanner } from "./LocalScanner";
import { ComparisonChart } from "./ComparisonChart";
import { AnalysisExplorer } from "./AnalysisExplorer";
import { TickerSearch } from "./TickerSearch";
import "./dockPanelSearch.css";
import { parseInstrument } from "@/lib/api";
import { LINK_GROUPS, type LinkGroup, type WorkstationWorkspace } from "@/lib/workstation";
import { useLiveQuote } from "@/lib/useLiveQuote";
import { sameFeed, type Instrument, type Environment, type ChartInterval } from "@/lib/types";

export type PriceSelection = { instrument: Instrument; price: number } | null;

export function resolvePanelInstrument(config: Record<string, unknown>, workspace: WorkstationWorkspace, environment: Environment) {
  const group = LINK_GROUPS.includes(config.linkGroup as LinkGroup) ? config.linkGroup as LinkGroup : "1";
  let pinned: Instrument | null = null;
  try { if (config.instrument) pinned = parseInstrument(config.instrument); } catch { /* Invalid old pin follows its group. */ }
  return { group, pinned: Boolean(pinned), instrument: { ...(pinned ?? workspace.instruments[group]), environment } };
}

export function DockPanel({ node, model, workspace, environment, refreshKey, selection, onPrice, onInstrument, showHeader = true }: {
  node: TabNode; model: Model; workspace: WorkstationWorkspace; environment: Environment; refreshKey: number;
  showHeader?: boolean; selection: PriceSelection; onPrice: (selection: PriceSelection) => void; onInstrument: (instrument: Instrument, group: LinkGroup) => void;
}) {
  const config = node.getConfig() ?? {};
  const { group, instrument, pinned } = useMemo(() => resolvePanelInstrument(config, workspace, environment), [config, workspace, environment]);
  const [chartSearch, setChartSearch] = useState("");
  const [chartSearchMarket, setChartSearchMarket] = useState(instrument.market);
  useEffect(() => { setChartSearch(""); setChartSearchMarket(instrument.market); }, [instrument.market, instrument.stkCd]);
  const visible = useTabVisible(node);
  const component = node.getComponent() ?? "";
  useEffect(() => {
    // Correct only the obsolete generated title; keep the user's layout/config intact.
    if (component === "capture" && config.screen === "2797" && node.getName().includes("누적")) {
      model.doAction(Actions.updateNodeAttributes(node.getId(), { name: "[2797] 업종별 기준일 순매수" }));
    }
  }, [component, config.screen, model, node]);
  const needsQuote = ["chart", "book", "details", "alerts", "journal"].includes(component);
  const { quote, quoteError } = useLiveQuote(instrument, refreshKey, visible && needsQuote);
  const currentQuote = quote && sameFeed(quote, instrument) ? quote : null;
  function updateConfig(patch: Record<string, unknown>) {
    model.doAction(Actions.updateNodeAttributes(node.getId(), { config: { ...node.getConfig(), ...patch } }));
  }
  function selectSector(sector: string) {
    if (!/^\d{3}$/.test(sector)) return;
    const ids: string[] = [];
    model.visitNodes((item) => {
      if (item.getType() !== "tab") return;
      const tab = item as TabNode, other = tab.getConfig() ?? {};
      if (tab.getComponent() === "capture" && ["0602", "0211", "2797"].includes(other.screen) && (other.linkGroup ?? "1") === group && !other.sectorPinned) ids.push(tab.getId());
    });
    for (const id of ids) {
      const other = model.getNodeById(id) as TabNode;
      model.doAction(Actions.updateNodeAttributes(id, { config: { ...other.getConfig(), sector } }));
    }
  }
  const companions: Instrument[] = [];
  if (Array.isArray(config.companions)) for (const item of config.companions.slice(0, 3)) {
    try { companions.push(parseInstrument({ ...item, environment })); } catch { /* Ignore invalid old comparison pins. */ }
  }
  let content;
  // Unmount hidden data panels so they do no background requests. Charts preserve view state but suspend work.
  if (component === "chart") content = <PriceChart instrument={instrument} quote={currentQuote} active={visible} compact={workspace.preset !== "terminal"} preferences={safeChartPreferences(config.preferences)} onPreferencesChange={(preferences) => updateConfig({ preferences })} onSelectPrice={(price) => onPrice({ instrument, price })} refreshKey={refreshKey} />;
  else if (visible) switch (component) {
    case "watch": content = <WatchlistPanel selected={instrument} onSymbol={(item) => onInstrument(item, group)} preferences={config.watchlistPreferences} onPreferencesChange={(watchlistPreferences) => updateConfig({ watchlistPreferences })} />; break;
    case "book": content = currentQuote ? <OrderBook quote={currentQuote} selectedPrice={selection && sameFeed(selection.instrument, instrument) ? selection.price : null} onSelectPrice={(price) => onPrice({ instrument, price })} /> : <div className="panel-empty" role={quoteError ? "alert" : "status"}>{quoteError || "호가 수신 대기"}</div>; break;
    case "history": content = <HistoryPanel instrument={instrument} refreshKey={refreshKey} />; break;
    case "details": content = <DetailsPanel instrument={instrument} quote={currentQuote} />; break;
    case "notes": content = <NotesPanel instrument={instrument} />; break;
    case "alerts": content = <MarketAlertsPanel instrument={instrument} quote={currentQuote} />; break;
    case "rankings": content = <RankingsPanel instrument={instrument} onSelect={(item) => onInstrument(item, group)} />; break;
    case "investors": content = <InvestorFlowPanel instrument={instrument} />; break;
    case "conditions": content = <ConditionPanel instrument={instrument} active={visible} onPick={(item) => onInstrument(item, group)} />; break;
    case "journal": content = <MarketJournal instrument={instrument} active={visible} refreshKey={refreshKey} />; break;
    case "calculator": content = <MarketCalculator instrument={instrument} />; break;
    case "scanner": content = <LocalScanner instrument={instrument} active={visible} refreshKey={refreshKey} onPick={(item) => onInstrument(item, group)} />; break;
    case "comparison": content = <ComparisonChart instrument={instrument} active={visible} refreshKey={refreshKey} companions={companions} onCompanionsChange={(items) => updateConfig({ companions: items })} />; break;
    case "analysis": content = <AnalysisExplorer instrument={instrument} active={visible} refreshKey={refreshKey} initialFeature={typeof config.featureId === "string" ? config.featureId : undefined} onFeatureChange={(featureId) => updateConfig({ featureId })} onPick={(item) => onInstrument(item, group)} />; break;
    case "capture": content = <CapturePanel screen={String(config.screen ?? "0200")} instrument={instrument} active={visible} refreshKey={refreshKey} onPick={(item) => onInstrument(item, group)} sector={String(config.sector ?? "001")} onSector={selectSector} preferences={config.capturePreferences} onPreferences={(capturePreferences) => updateConfig({ capturePreferences })} />; break;
    default: content = <div className="panel-empty">지원하지 않는 화면입니다</div>;
  }
  return <div className="dock-chart linked-panel" data-panel={component} aria-label={`${node.getName()} 패널`}>
    {showHeader && <PanelHeaderControls node={node} model={model} workspace={workspace} environment={environment} />}
    {visible && component === "chart" && <div className="panel-chart-search" role="group" aria-label="이 차트 종목 검색">
      <select aria-label="이 차트 검색 시장" value={chartSearchMarket} onChange={(event) => { setChartSearchMarket(event.target.value as "KR" | "US"); setChartSearch(""); }}><option value="KR">국내</option><option value="US">미국</option></select>
      <div className="panel-chart-search-input"><TickerSearch market={chartSearchMarket} value={chartSearch} onChange={setChartSearch} placeholder="종목코드·이름 검색" onPick={(item) => { if (pinned) updateConfig({ instrument: item }); else onInstrument(item, group); setChartSearch(""); }} /></div>
      <span title={pinned ? "이 고정 차트의 종목만 변경합니다." : "같은 연동 그룹의 종목을 함께 변경합니다."}>{pinned ? "고정창" : `연동 ${group}`}</span>
    </div>}
    {content}
  </div>;
}

/** Header controls live in the FlexLayout title row, without repeating a stock name on market tables. */
export function PanelHeaderControls({ node, model, workspace, environment }: {
  node: TabNode; model: Model; workspace: WorkstationWorkspace; environment: Environment;
}) {
  const config = node.getConfig() ?? {};
  const component = node.getComponent() ?? "";
  const { group, pinned, instrument } = resolvePanelInstrument(config, workspace, environment);
  const sector = component === "capture" && ["0602", "0211", "2797"].includes(config.screen);
  const market = component === "capture" && ["0200", "0780"].includes(config.screen);
  const selecting = ["watch", "rankings", "capture", "analysis", "scanner"].includes(component);
  const update = (patch: Record<string, unknown>) => model.doAction(Actions.updateNodeAttributes(node.getId(), { config: { ...config, ...patch } }));
  const duplicate = () => {
    const parent = node.getParent();
    if (parent) model.doAction(Actions.addNode({ type: "tab", name: node.getName(), component, config: structuredClone(config), enableClose: true }, parent.getId(), DockLocation.CENTER, -1));
  };
  return <div className="panel-title-controls" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    {!market && <select aria-label={`${node.getName()} 연동 그룹`} className="panel-group-select" value={group} onChange={(event) => update({ linkGroup: event.target.value as LinkGroup, instrument: undefined })} title={sector ? "같은 번호의 업종 화면끼리 연동" : "같은 번호의 화면끼리 종목 연동"}>
      {LINK_GROUPS.map((id) => <option key={id} value={id}>{id}</option>)}
    </select>}
    {sector && <span title="연동 업종 코드">{String(config.sector ?? "001")}</span>}
    {!selecting && <button className="hts-btn panel-pin" aria-label={pinned ? "고정 해제" : "종목 고정"} aria-pressed={pinned} title={`${instrument.stkNm} · ${pinned ? "고정 해제" : "종목 고정"}`} onClick={() => update({ instrument: pinned ? undefined : instrument })}>{pinned ? "고정" : "연동"}</button>}
    <button className="hts-btn" aria-label={`${node.getName()} 창 복제`} onClick={duplicate} title="같은 화면 하나 더 열기">＋</button>
    <button className="hts-btn" aria-label={`${node.getName()} 새 창으로 분리`} title="같은 연결을 사용하는 별도 창으로 열기" onClick={() => {
      model.doAction(Actions.updateNodeAttributes(node.getId(), { enablePopout: true }));
      model.doAction(Actions.popoutTab(node.getId(), "window"));
    }}>↗</button>
  </div>;
}

function useTabVisible(node: TabNode) {
  const [visible, setVisible] = useState(node.isVisible());
  useEffect(() => {
    setVisible(node.isVisible());
    node.setEventListener("visibility", ({ visible: next }: { visible: boolean }) => setVisible(next));
    return () => node.removeEventListener("visibility");
  }, [node]);
  return visible;
}

function safeChartPreferences(value: unknown): Partial<PriceChartPreferences> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>, result: Partial<PriceChartPreferences> = {};
  if (["1", "3", "5", "10", "15", "30", "45", "60", "D", "W", "M", "Y"].includes(String(row.interval))) result.interval = row.interval as ChartInterval;
  if (typeof row.volumeRatio === "number" && Number.isFinite(row.volumeRatio)) result.volumeRatio = Math.min(0.45, Math.max(0.15, row.volumeRatio));
  if (row.displayMode === "line" || row.displayMode === "candles") result.displayMode = row.displayMode;
  for (const key of ["showRsi", "showMacd", "showBollingerBands"] as const) if (typeof row[key] === "boolean") result[key] = row[key];
  if (row.extendedIndicatorPeriods && typeof row.extendedIndicatorPeriods === "object") result.extendedIndicatorPeriods = normalizeExtendedIndicatorPeriods(row.extendedIndicatorPeriods);
  if (row.movingAverages && typeof row.movingAverages === "object") {
    const ma = row.movingAverages as Record<string, unknown>;
    result.movingAverages = { 5: typeof ma[5] === "boolean" ? ma[5] : true, 20: typeof ma[20] === "boolean" ? ma[20] : true, 60: typeof ma[60] === "boolean" ? ma[60] : false, 120: typeof ma[120] === "boolean" ? ma[120] : true, 240: typeof ma[240] === "boolean" ? ma[240] : true };
  }
  return result;
}
