import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchScreens } from "@/lib/screenCatalog";
import { ScreenLauncher } from "@/components/ScreenLauncher";

afterEach(cleanup);

describe("ScreenLauncher", () => {
  it("opens a supported screen by exact number or name", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<ScreenLauncher market="KR" onOpen={onOpen} />);
    const input = screen.getByRole("combobox", { name: "화면번호·이름" });

    await user.type(input, "0101");
    await user.click(screen.getByRole("button", { name: "화면 열기" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ code: "0101", component: "book", market: "KR" }));

    await user.click(input);
    await user.type(input, "종목별투자자");
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ code: "0796", component: "investors" }));
  });

  it("supports arrow selection, escape, and a clear unknown state", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<ScreenLauncher market="KR" onOpen={onOpen} />);
    const input = screen.getByRole("combobox", { name: "화면번호·이름" });

    await user.click(input);
    await user.type(input, "차트");
    expect(screen.getByRole("option", { name: /0600 키움종합차트/ })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: searchScreens("차트", "KR")[1].id }));

    await user.click(input);
    await user.type(input, "지원되지않는화면");
    expect(screen.getByRole("status")).toHaveTextContent("찾지 못했습니다");
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("can open an explicit other-market shortcut", () => {
    const onOpen = vi.fn();
    render(<ScreenLauncher market="KR" onOpen={onOpen} />);
    const input = screen.getByRole("combobox", { name: "화면번호·이름" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2010" } });
    fireEvent.submit(input.closest("form")!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ code: "2010", market: "US" }));
  });
  it("focuses screen search with Home while preserving editing keys in other inputs", () => {
    render(<><ScreenLauncher market="KR" onOpen={vi.fn()} /><input aria-label="memo editing" /></>);
    const search = screen.getByRole("combobox", { name: "화면번호·이름" });
    fireEvent.keyDown(document.body, { key: "Home" });
    expect(search).toHaveFocus();
    const editor = screen.getByLabelText("memo editing");
    editor.focus();
    fireEvent.keyDown(editor, { key: "Home" });
    expect(editor).toHaveFocus();
  });

});
