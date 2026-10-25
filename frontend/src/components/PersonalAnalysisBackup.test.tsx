import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersonalAnalysisBackup } from "@/components/PersonalAnalysisBackup";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("PersonalAnalysisBackup", () => {
  it("reads the narrow note list only after the explicit refresh action", () => {
    localStorage.setItem("hts-note:KR:005930", "지지선 확인");
    localStorage.setItem("unrelated-secret", "not shown");
    render(<PersonalAnalysisBackup />);
    expect(screen.queryByText("지지선 확인")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장된 분석 목록 새로고침" }));
    expect(screen.getByText("지지선 확인")).toBeInTheDocument();
    expect(screen.queryByText("not shown")).not.toBeInTheDocument();
  });
});
