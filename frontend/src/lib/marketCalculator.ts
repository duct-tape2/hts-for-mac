import type { Instrument } from "./types";

export type CalculatorCurrency = Instrument["currency"];

export type MarketCalculatorInput = {
  startPrice: string;
  endPrice: string;
  quantity: string;
  currency: CalculatorCurrency;
  fee: string;
  exchangeRate: string;
};

export type MarketCalculatorResult = {
  currency: CalculatorCurrency;
  startPrice: number;
  endPrice: number;
  quantity: number;
  fee: number;
  priceChange: number;
  priceChangePct: number | null;
  startNotional: number;
  endNotional: number;
  netDifference: number;
  exchangeRate: number | null;
  convertedCurrency: CalculatorCurrency | null;
  convertedNetDifference: number | null;
};

const MAX_INPUT = 1_000_000_000_000_000;
const MAX_EXCHANGE_RATE = 1_000_000_000;

function numberValue(value: string, label: string, { optional = false, maximum = MAX_INPUT }: { optional?: boolean; maximum?: number } = {}) {
  if (!value.trim() && optional) return 0;
  if (!value.trim()) throw new Error(`${label}을(를) 입력하세요.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > maximum) throw new Error(`${label}은(는) 유한한 범위의 숫자여야 합니다.`);
  return parsed;
}

export function calculateMarket(input: MarketCalculatorInput): MarketCalculatorResult {
  const startPrice = numberValue(input.startPrice, "시작가");
  const endPrice = numberValue(input.endPrice, "종료가");
  const quantity = numberValue(input.quantity, "수량");
  const fee = numberValue(input.fee, "사용자 비용", { optional: true });
  if (startPrice < 0 || endPrice < 0) throw new Error("가격은 0 이상이어야 합니다.");
  if (quantity <= 0) throw new Error("수량은 0보다 커야 합니다.");
  if (fee < 0) throw new Error("사용자 비용은 0 이상이어야 합니다.");

  const rawExchangeRate = input.exchangeRate.trim();
  const exchangeRate = rawExchangeRate ? numberValue(rawExchangeRate, "사용자 환율", { maximum: MAX_EXCHANGE_RATE }) : null;
  if (exchangeRate !== null && exchangeRate <= 0) throw new Error("사용자 환율은 0보다 커야 합니다.");

  const priceChange = endPrice - startPrice;
  const startNotional = startPrice * quantity;
  const endNotional = endPrice * quantity;
  const netDifference = endNotional - startNotional - fee;
  if (![priceChange, startNotional, endNotional, netDifference].every(Number.isFinite)) throw new Error("계산 결과가 표시 범위를 벗어났습니다.");
  const convertedCurrency = exchangeRate === null ? null : input.currency === "KRW" ? "USD" : "KRW";
  const convertedNetDifference = exchangeRate === null ? null : input.currency === "KRW" ? netDifference / exchangeRate : netDifference * exchangeRate;
  if (convertedNetDifference !== null && !Number.isFinite(convertedNetDifference)) throw new Error("환산 결과가 표시 범위를 벗어났습니다.");

  return {
    currency: input.currency,
    startPrice,
    endPrice,
    quantity,
    fee,
    priceChange,
    priceChangePct: startPrice === 0 ? null : (priceChange / startPrice) * 100,
    startNotional,
    endNotional,
    netDifference,
    exchangeRate,
    convertedCurrency,
    convertedNetDifference,
  };
}

export function formatCalculatorMoney(value: number | null, currency: CalculatorCurrency, signed = false) {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = signed && value > 0 ? "+" : "";
  const options = currency === "KRW"
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${sign}${new Intl.NumberFormat(currency === "KRW" ? "ko-KR" : "en-US", options).format(value)} ${currency}`;
}

export function formatCalculatorNumber(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 }).format(value);
}

export function formatCalculatorPct(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "시작가 0: 계산 불가";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}
