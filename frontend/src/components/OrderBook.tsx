"use client";

import { changeClass, formatPct, formatPrice, formatQty, formatReceivedAt } from "@/lib/format";
import type { BookLevel, Environment, Quote, QuoteStatus } from "@/lib/types";

type Props = {
  quote: Quote;
  selectedPrice: number | null;
  onSelectPrice: (price: number) => void;
};

const DEPTH_LEVELS = 10;

/** Market depth only. Clicking a price marks it for inspection; it cannot create an order. */
export function OrderBook({ quote, selectedPrice, onSelectPrice }: Props) {
  const asks = depthLevels(quote.asks, "ask");
  const bids = depthLevels(quote.bids, "bid");
  const maxQty = Math.max(...asks.map((level) => level.qty ?? 0), ...bids.map((level) => level.qty ?? 0), 1);
  const base = quote.prevClose !== null && quote.prevClose > 0 ? quote.prevClose : null;
  const bestAsk = asks.length ? Math.min(...asks.map((level) => level.price)) : null;
  const bestBid = bids.length ? Math.max(...bids.map((level) => level.price)) : null;
  const spread = bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null;
  const crossedBook = spread !== null && spread < 0;

  return (
    <section className="panel flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#101925]" aria-label="호가">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-800 px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="text-xs font-semibold text-cream-50">호가 10단</h2>
          <span className="truncate text-[10px] text-cream-500" title={quote.bookNote || "호가 클릭은 가격 참조만 합니다."} aria-label={quote.bookNote || "호가 클릭은 가격 참조만 합니다."}>
            ⓘ
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[10px]">
          <span className="bg-ink-800 px-1 py-0.5 text-cream-300">{sourceLabel(quote.source)}</span>
          <span className="bg-ink-800 px-1 py-0.5 text-cream-300">{environmentLabel(quote.environment)}</span>
          <span className={quote.bookLive ? "bg-up/15 px-1 py-0.5 text-up" : quote.status === "stale" || quote.status === "error" ? "bg-brass-500/15 px-1 py-0.5 text-brass-400" : "bg-ink-800 px-1 py-0.5 text-cream-300"}>
            {quote.bookLive ? "실시간" : statusLabel(quote.status)}
          </span>
        </div>
      </div>
      {(quote.tradeReceivedAt || quote.bookReceivedAt) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-800 bg-ink-950/50 px-2 py-0.5 text-[10px] text-cream-500">
          {quote.tradeReceivedAt && <span title="체결 시세 수신 시각">체결 {formatReceivedAt(quote.tradeReceivedAt)}</span>}
          {quote.bookReceivedAt && <span title="호가 수신 시각">호가 {formatReceivedAt(quote.bookReceivedAt)}</span>}
        </div>
      )}

      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_7.35rem_minmax(0,1fr)] bg-ink-800 px-2 py-0.5 text-[10px] text-cream-500">
        <span className="text-right">매도잔량</span>
        <span className="text-center">호가 · 전일비</span>
        <span>매수잔량</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {depthSlots(asks).map((level, index) => (
          <DepthRow
            key={"ask-" + (level?.price ?? index)}
            side="ask"
            level={level}
            base={base}
            maxQty={maxQty}
            quote={quote}
            selectedPrice={selectedPrice}
            bestPrice={bestAsk}
            onSelectPrice={onSelectPrice}
          />
        ))}

        <button
          type="button"
          className="flex h-7 w-full shrink-0 items-center justify-center gap-2 border-y border-ink-700 bg-ink-950 px-2 text-[11px] hover:bg-ink-800 disabled:cursor-default"
          disabled={quote.last === null}
          onClick={() => quote.last !== null && onSelectPrice(quote.last)}
          aria-label={quote.last === null ? "체결가 미수신" : "체결가 " + formatPrice(quote.last, quote.currency) + " 가격 참조"}
        >
          <span className="text-cream-500">체결</span>
          <span className="font-mono text-[#e5ad39]">{formatPrice(quote.last, quote.currency)}</span>
          <span className={"font-mono " + changeClass(quote.change ?? quote.changePct)}>{formatPct(quote.changePct)}</span>
        </button>

        {depthSlots(bids).map((level, index) => (
          <DepthRow
            key={"bid-" + (level?.price ?? index)}
            side="bid"
            level={level}
            base={base}
            maxQty={maxQty}
            quote={quote}
            selectedPrice={selectedPrice}
            bestPrice={bestBid}
            onSelectPrice={onSelectPrice}
          />
        ))}
      </div>

      <div className="grid shrink-0 grid-cols-3 border-t border-ink-800 bg-ink-950 px-2 py-1 text-[10px] text-cream-500">
        <span>매도합 <b className="font-mono font-medium text-cream-300">{formatTotal(asks)}</b></span>
        <span className="text-center">스프레드 <b className={"font-mono font-medium " + (crossedBook ? "text-up" : "text-[#e5ad39]")} title={crossedBook ? "최우선 매도호가가 최우선 매수호가보다 낮은 교차 호가입니다." : undefined}>{crossedBook ? "교차" : formatPrice(spread, quote.currency)}</b></span>
        <span className="text-right">매수합 <b className="font-mono font-medium text-cream-300">{formatTotal(bids)}</b></span>
      </div>
    </section>
  );
}

function depthLevels(levels: BookLevel[], side: "ask" | "bid") {
  const rows = levels
    .filter((row) => Number.isFinite(row.price) && row.price > 0)
    .sort((left, right) => right.price - left.price);

  // Keep the ten closest prices to the touch. Ask rows run high-to-low above the trade;
  // bid rows run best-to-worse below it.
  return side === "ask" ? rows.slice(-DEPTH_LEVELS) : rows.slice(0, DEPTH_LEVELS);
}

function depthSlots(levels: BookLevel[]) {
  return [...levels, ...Array<BookLevel | null>(Math.max(0, DEPTH_LEVELS - levels.length)).fill(null)];
}

function formatTotal(levels: BookLevel[]) {
  if (!levels.length || levels.every((level) => level.qty === null)) return "—";
  if (levels.some((level) => level.qty === null)) return "일부 미수신";
  return formatQty(levels.reduce((total, level) => total + (level.qty ?? 0), 0));
}

function DepthRow({
  side,
  level,
  base,
  maxQty,
  quote,
  selectedPrice,
  bestPrice,
  onSelectPrice,
}: {
  side: "ask" | "bid";
  level: BookLevel | null;
  base: number | null;
  maxQty: number;
  quote: Quote;
  selectedPrice: number | null;
  bestPrice: number | null;
  onSelectPrice: (price: number) => void;
}) {
  if (!level) {
    return (
      <div className="grid h-5 grid-cols-[minmax(0,1fr)_7.35rem_minmax(0,1fr)] items-center px-2 text-[10px] text-cream-500" aria-label={side === "ask" ? "매도 호가 미수신" : "매수 호가 미수신"}>
        <span className="text-right">—</span>
        <span className="text-center">—</span>
        <span>—</span>
      </div>
    );
  }

  const qty = level.qty ?? 0;
  const width = Math.max(0, Math.min(100, (qty / maxQty) * 100)) + "%";
  const pct = base === null ? null : ((level.price - base) / base) * 100;
  const selected = selectedPrice === level.price;
  const best = bestPrice === level.price;
  const tint = best ? (side === "ask" ? "bg-up/10" : "bg-down/10") : "";

  return (
    <button
      type="button"
      className={"grid h-5 w-full grid-cols-[minmax(0,1fr)_7.35rem_minmax(0,1fr)] items-center px-2 text-[11px] hover:bg-ink-800 " + tint + " " + (selected ? "bg-ink-800 ring-1 ring-inset ring-[#e5ad39]" : "")}
      onClick={() => onSelectPrice(level.price)}
      aria-label={(side === "ask" ? "매도" : "매수") + " 호가 " + formatPrice(level.price, quote.currency) + " 가격 참조"}
    >
      <span className="relative h-5 overflow-hidden text-right">
        {side === "ask" && <span className="absolute inset-y-0 right-0 bg-up/20" style={{ width }} />}
        <span className={"relative pr-1 font-mono " + (side === "ask" ? "text-up" : "text-cream-500")}>{side === "ask" ? formatQty(level.qty) : ""}</span>
      </span>
      <span className={"px-1 text-center font-mono " + changeClass(pct)}>
        {formatPrice(level.price, quote.currency)} <span className="text-[9px]">{formatPct(pct)}</span>
      </span>
      <span className="relative h-5 overflow-hidden">
        {side === "bid" && <span className="absolute inset-y-0 left-0 bg-down/20" style={{ width }} />}
        <span className={"relative pl-1 font-mono " + (side === "bid" ? "text-down" : "text-cream-500")}>{side === "bid" ? formatQty(level.qty) : ""}</span>
      </span>
    </button>
  );
}

function statusLabel(status: QuoteStatus) {
  return { snapshot: "스냅샷", live: "실시간", stale: "지연", missing: "미수신", error: "오류" }[status];
}

function sourceLabel(source: Quote["source"]) {
  return source === "kiwoom" ? "키움" : "샘플";
}

function environmentLabel(environment: Environment) {
  return { fixture: "샘플 환경", demo: "데모 환경", real: "실환경" }[environment];
}
