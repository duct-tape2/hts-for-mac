import { describe, expect, it } from "vitest";
import { calculateMarket, formatCalculatorMoney, formatCalculatorPct } from "@/lib/marketCalculator";

const input = {
  startPrice: "100",
  endPrice: "110",
  quantity: "2",
  currency: "USD" as const,
  fee: "1",
  exchangeRate: "1350",
};

describe("local market calculator", () => {
  it("calculates prices, notionals, explicit cost, and only user-supplied FX", () => {
    const result = calculateMarket(input);
    expect(result).toMatchObject({ priceChange: 10, priceChangePct: 10, startNotional: 200, endNotional: 220, fee: 1, netDifference: 19, convertedCurrency: "KRW", convertedNetDifference: 25650 });
  });

  it("keeps an explicitly optional blank fee at zero but rejects missing required values", () => {
    expect(calculateMarket({ ...input, fee: "", exchangeRate: "" }).fee).toBe(0);
    expect(() => calculateMarket({ ...input, startPrice: "" })).toThrow("시작가");
    expect(() => calculateMarket({ ...input, quantity: "0" })).toThrow("수량");
    expect(() => calculateMarket({ ...input, exchangeRate: "0" })).toThrow("환율");
  });

  it("does not divide by zero for percent change", () => {
    const result = calculateMarket({ ...input, startPrice: "0", endPrice: "10", exchangeRate: "" });
    expect(result.priceChangePct).toBeNull();
    expect(formatCalculatorPct(result.priceChangePct)).toBe("시작가 0: 계산 불가");
  });

  it("uses currency-consistent presentation rounding", () => {
    expect(formatCalculatorMoney(1234.6, "KRW")).toBe("1,235 KRW");
    expect(formatCalculatorMoney(12.345, "USD", true)).toBe("+12.35 USD");
  });
});
