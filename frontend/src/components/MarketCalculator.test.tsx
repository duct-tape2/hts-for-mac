import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketCalculator } from "@/components/MarketCalculator";

describe("MarketCalculator", () => {
  it("shows only local explicit-cost calculation and no result before required input", () => {
    render(<MarketCalculator />);
    expect(screen.getByText(/주문·보유수량·세금·실시간 환율/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("시작가"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("종료가"), { target: { value: "110" } });
    fireEvent.change(screen.getByLabelText("수량"), { target: { value: "2" } });
    expect(screen.getByText("+10 KRW")).toBeInTheDocument();
    expect(screen.getByText("+20 KRW")).toBeInTheDocument();
    expect(screen.getByText("사용자 환율 입력 시 표시")).toBeInTheDocument();
  });
});
