import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { ConfirmRetryFailedDialog } from "./Dialogs";

function detail(id: string, title: string, mineruStatus: "error" | "pending", domainCode = "MM-01") {
  return {
    id,
    domainId: "d-1",
    title,
    titleZh: null,
    pdfPath: `/papers/${id}.pdf`,
    mineruStatus,
    domain: { id: "d-1", name: "多模态", code: domainCode, summary: null, sortOrder: 1, createdAt: "now" },
  };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("ConfirmRetryFailedDialog · 全部重试影响预览", () => {
  it("显示影响篇数（失败/尚未提交）与跨领域清单，确认按冻结清单重试", async () => {
    vi.spyOn(repo, "listFailedMineru").mockResolvedValue(["a", "b"]);
    vi.spyOn(repo, "getPaper").mockImplementation(async (id: string) =>
      id === "a" ? (detail("a", "失败那篇", "error") as never) : (detail("b", "还没提交的那篇", "pending") as never),
    );
    const retryMineruPapers = vi.fn(async () => undefined);
    useField.setState({ dialog: "confirm-retry", retryMineruPapers });
    render(<ConfirmRetryFailedDialog />);

    expect(screen.getByText("正在统计受影响的论文…")).toBeInTheDocument();
    await waitFor(() => {
      const body = document.querySelector(".ef-dialog-body");
      expect(body?.textContent).toContain("将影响 2 篇（解析失败 1 篇 · 尚未提交 1 篇）");
      expect(body?.textContent).toContain("不只是当前筛选结果");
    });
    expect(screen.getByText("失败那篇")).toBeInTheDocument();
    expect(screen.getByText("还没提交的那篇")).toBeInTheDocument();
    const summary = document.querySelector(".ef-dialog-body");
    expect(summary?.textContent).toContain("不只是当前筛选结果");

    fireEvent.click(screen.getByRole("button", { name: "重试这 2 篇" }));
    await waitFor(() => {
      expect(retryMineruPapers).toHaveBeenCalledWith(["a", "b"]);
    });
    expect(useField.getState().dialog).toBeNull();
  });

  it("清单为空给提示、确认禁用；读取失败给错误文案", async () => {
    vi.spyOn(repo, "listFailedMineru").mockResolvedValue([]);
    useField.setState({ dialog: "confirm-retry" });
    const { unmount } = render(<ConfirmRetryFailedDialog />);
    await waitFor(() => {
      expect(screen.getByText("没有解析失败或尚未提交解析的论文。")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "重试这 0 篇" })).toBeDisabled();
    unmount();

    vi.spyOn(repo, "listFailedMineru").mockRejectedValue(new Error("boom"));
    useField.setState({ dialog: null });
    useField.setState({ dialog: "confirm-retry" });
    render(<ConfirmRetryFailedDialog />);
    await waitFor(() => {
      expect(screen.getByText("读取失败清单出错，请稍后重试。")).toBeInTheDocument();
    });
  });
});
