"use client";

import { useEffect, useMemo, useState } from "react";
import {
  calculateMarket,
  formatCalculatorMoney,
  formatCalculatorNumber,
  formatCalculatorPct,
  type CalculatorCurrency,
  type MarketCalculatorInput,
} from "@/lib/marketCalculator";
import type { Instrument } from "@/lib/types";
import "./marketCalculator.css";

export type MarketCalculatorProps = { instrument?: Instrument };

function defaults(currency: CalculatorCurrency): MarketCalculatorInput {
  return { startPrice: "", endPrice: "", quantity: "", currency, fee: "0", exchangeRate: "" };
}

export function MarketCalculator({ instrument }: MarketCalculatorProps) {
  const [input, setInput] = useState<MarketCalculatorInput>(() => defaults(instrument?.currency ?? "KRW"));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched && instrument?.currency) setInput(defaults(instrument.currency));
  }, [instrument?.currency, touched]);

  const calculation = useMemo(() => {
    try {
      return { result: calculateMarket(input), error: null };
    } catch (error) {
      return { result: null, error: touched ? (error instanceof Error ? error.message : "입력값을 확인하세요.") : null };
    }
  }, [input, touched]);
  const result = calculation.result;

  function change<K extends keyof MarketCalculatorInput>(key: K, value: MarketCalculatorInput[K]) {
    setTouched(true);
    setInput((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    setInput(defaults(instrument?.currency ?? "KRW"));
    setTouched(false);
  }

  return (
    <section className="market-calculator" aria-label="시장 계산기">
      <div className="market-calculator-title">
        <strong>시장 계산기</strong>
        {instrument && <span>{instrument.stkNm} · {instrument.stkCd} 참고</span>}
        <button type="button" onClick={reset}>지우기</button>
      </div>
      <p className="market-calculator-disclosure">입력값만 계산합니다. 주문·보유수량·세금·실시간 환율을 사용하거나 추정하지 않습니다.</p>

      <div className="market-calculator-inputs">
        <label>통화
          <select aria-label="통화" value={input.currency} onChange={(event) => change("currency", event.target.value as CalculatorCurrency)}>
            <option value="KRW">KRW</option><option value="USD">USD</option>
          </select>
        </label>
        <label>시작가 <input aria-label="시작가" inputMode="decimal" value={input.startPrice} onChange={(event) => change("startPrice", event.target.value)} placeholder="필수" /></label>
        <label>종료가 <input aria-label="종료가" inputMode="decimal" value={input.endPrice} onChange={(event) => change("endPrice", event.target.value)} placeholder="필수" /></label>
        <label>수량 <input aria-label="수량" inputMode="decimal" value={input.quantity} onChange={(event) => change("quantity", event.target.value)} placeholder="필수" /></label>
        <label>사용자 비용 <input aria-label="사용자 비용" inputMode="decimal" value={input.fee} onChange={(event) => change("fee", event.target.value)} /></label>
      </div>
      <div className="market-calculator-fx">
        <label>사용자 환율 (선택) <input aria-label="사용자 환율" inputMode="decimal" value={input.exchangeRate} onChange={(event) => change("exchangeRate", event.target.value)} placeholder="1 USD = ? KRW" /></label>
        <span>환산 기준: 1 USD = 입력값 KRW · 실시간 환율이 아닙니다.</span>
      </div>
      {calculation.error && <p className="market-calculator-error" role="alert">{calculation.error}</p>}

      <dl className="market-calculator-results">
        <div><dt>가격 변화</dt><dd className={result && result.priceChange !== 0 ? (result.priceChange > 0 ? "up" : "down") : ""}>{result ? formatCalculatorMoney(result.priceChange, result.currency, true) : "—"}</dd></div>
        <div><dt>등락률</dt><dd className={result && result.priceChangePct !== null ? (result.priceChangePct > 0 ? "up" : result.priceChangePct < 0 ? "down" : "") : ""}>{result ? formatCalculatorPct(result.priceChangePct) : "—"}</dd></div>
        <div><dt>시작 금액</dt><dd>{result ? formatCalculatorMoney(result.startNotional, result.currency) : "—"}</dd></div>
        <div><dt>종료 금액</dt><dd>{result ? formatCalculatorMoney(result.endNotional, result.currency) : "—"}</dd></div>
        <div><dt>사용자 비용</dt><dd>{result ? formatCalculatorMoney(result.fee, result.currency) : "—"}</dd></div>
        <div><dt>비용 반영 차이</dt><dd className={result && result.netDifference !== 0 ? (result.netDifference > 0 ? "up" : "down") : ""}>{result ? formatCalculatorMoney(result.netDifference, result.currency, true) : "—"}</dd></div>
        <div><dt>환산 비용 반영 차이</dt><dd className={result && result.convertedNetDifference !== null && result.convertedNetDifference !== 0 ? (result.convertedNetDifference > 0 ? "up" : "down") : ""}>{result?.convertedNetDifference !== null && result ? formatCalculatorMoney(result.convertedNetDifference, result.convertedCurrency!) : "사용자 환율 입력 시 표시"}</dd></div>
        <div><dt>계산 수량</dt><dd>{result ? formatCalculatorNumber(result.quantity) : "—"}</dd></div>
      </dl>
    </section>
  );
}
