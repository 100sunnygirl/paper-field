import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useField } from "../store";
import { ExportCheckedDialog } from "./Dialogs";

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("ExportCheckedDialog · 批量勾选导出", () => {
  it("默认合并 Markdown：标题写明篇数，内容选择可改，导出走 scope=checked", async () => {
    const exportPapers = vi.fn(async () => undefined);
    useField.setState({ dialog: "export-checked", dialogPaperIds: ["a", "b"], exportPapers });
    render(<ExportCheckedDialog />);
    expect(screen.getByRole("heading", { name: "导出所选 2 篇" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("摘要"));
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => {
      expect(exportPapers).toHaveBeenCalledWith({
        scope: "checked",
        format: "merged",
        include: { notes: true, abstract: false, parsedText: false },
      });
    });
  });

  it("切到 BibTeX：内容选择隐藏、说明只含著录，导出带 bibtex 格式", async () => {
    const exportPapers = vi.fn(async () => undefined);
    useField.setState({ dialog: "export-checked", dialogPaperIds: ["a"], exportPapers });
    render(<ExportCheckedDialog />);
    fireEvent.change(screen.getByLabelText("导出格式"), { target: { value: "bibtex" } });
    expect(screen.queryByLabelText("摘要")).toBeNull();
    expect(screen.getByText(/BibTeX 只含著录信息/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() => {
      expect(exportPapers).toHaveBeenCalledWith({
        scope: "checked",
        format: "bibtex",
        include: { notes: true, abstract: true, parsedText: false },
      });
    });
  });

  it("没有勾选时对话框不打开", () => {
    useField.setState({ dialog: "export-checked", dialogPaperIds: [] });
    const { container } = render(<ExportCheckedDialog />);
    expect(container.querySelector(".ef-dialog")).toBeNull();
  });
});
