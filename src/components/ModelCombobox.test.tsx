import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ModelCombobox } from "./ModelCombobox";

const OPTIONS = ["deepseek-chat", "deepseek-coder", "deepseek-reasoner"];

function Harness({ initial }: { initial: string }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <ModelCombobox value={v} options={OPTIONS} onChange={setV} label="模型" />
      <output data-testid="v">{v}</output>
    </>
  );
}
const names = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("ModelCombobox", () => {
  it("bug: with a model filled in, the toggle still lists every option", () => {
    render(<Harness initial="deepseek-chat" />);
    fireEvent.click(screen.getByRole("button", { name: "展开模型列表" }));
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
    expect(names()).toEqual(OPTIONS);
    fireEvent.click(screen.getByRole("option", { name: "deepseek-reasoner" }));
    expect(screen.getByTestId("v")).toHaveTextContent("deepseek-reasoner");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });
  it("ArrowDown on a filled input also lists every option, starting at the current one", () => {
    render(<Harness initial="deepseek-coder" />);
    const box = screen.getByRole("combobox");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(names()).toEqual(OPTIONS);
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "deepseek-coder" }).id);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("v")).toHaveTextContent("deepseek-reasoner");
  });
  it("typing filters; Escape closes; a custom id is kept as typed", () => {
    render(<Harness initial="" />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "reas" } });
    expect(names()).toEqual(["deepseek-reasoner"]);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(box, { target: { value: "my-custom-model" } });
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("v")).toHaveTextContent("my-custom-model");
  });
  it("custom id: opening highlights nothing and Enter keeps the typed value", () => {
    render(<Harness initial="my-custom-model" />);
    const box = screen.getByRole("combobox");
    fireEvent.click(screen.getByRole("button", { name: "展开模型列表" }));
    expect(names()).toEqual(OPTIONS);
    expect(box).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("v")).toHaveTextContent("my-custom-model");
  });
  it("closes when the option list changes", () => {
    const { rerender } = render(<ModelCombobox value="" options={OPTIONS} onChange={() => {}} label="模型" />);
    fireEvent.click(screen.getByRole("button", { name: "展开模型列表" }));
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
    rerender(<ModelCombobox value="" options={["x", ...OPTIONS]} onChange={() => {}} label="模型" />);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });
});
