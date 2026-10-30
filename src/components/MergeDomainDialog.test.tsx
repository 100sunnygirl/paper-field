import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useField } from "../store";
import { MergeDomainDialog } from "./MergeDomainDialog";

const DOMAINS = [
  { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
  { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-02T00:00:00.000Z" },
  { id: "d-3", name: "强化学习", code: "RL-03", summary: null, sortOrder: 3, createdAt: "2024-01-03T00:00:00.000Z" },
];

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("MergeDomainDialog · 合并领域", () => {
  it("默认来源=当前领域、目标=另一领域；预览显示两边论文数与同名条目", async () => {
    const previewDomainMerge = vi.fn(async () => ({
      fromName: "多模态",
      intoName: "指令对齐",
      fromCount: 9,
      intoCount: 4,
      duplicates: [{ title: "Same Paper" }, { title: "Same Paper 2" }],
    }));
    useField.setState({
      dialog: "merge-domain",
      domains: DOMAINS,
      selectedDomainId: "d-1",
      previewDomainMerge,
    });
    render(<MergeDomainDialog />);
    expect(screen.getByLabelText("来源领域")).toHaveValue("d-1");
    expect(screen.getByLabelText("目标领域")).toHaveValue("d-2");
    await waitFor(() => expect(previewDomainMerge).toHaveBeenCalledWith("d-1", "d-2"));
    const block = await screen.findByText(/9/);
    const previewBlock = block.closest(".ef-merge-preview")!;
    expect(previewBlock.textContent).toContain("多模态");
    expect(previewBlock.textContent).toContain("指令对齐");
    expect(previewBlock.textContent).toContain("9 篇");
    expect(screen.getByText(/两边有 2 篇同名论文/)).toBeInTheDocument();
    expect(screen.getByText("Same Paper")).toBeInTheDocument();
    expect(screen.getByText(/另有 0 篇同名论文未逐条列出/)).toBeNull();
  });

  it("确认合并调用 mergeDomains；来源=目标时报错且不可提交", async () => {
    const mergeDomains = vi.fn(async () => undefined);
    const previewDomainMerge = vi.fn(async () => ({
      fromName: "多模态",
      intoName: "指令对齐",
      fromCount: 1,
      intoCount: 1,
      duplicates: [],
    }));
    useField.setState({
      dialog: "merge-domain",
      domains: DOMAINS,
      selectedDomainId: "d-1",
      previewDomainMerge,
      mergeDomains,
    });
    render(<MergeDomainDialog />);
    await screen.findByText(/两边没有同名论文/);
    const confirm = screen.getByRole("button", { name: "确认合并" });
    fireEvent.click(confirm);
    await waitFor(() => expect(mergeDomains).toHaveBeenCalledWith("d-1", "d-2"));

    // 来源=目标：目标下拉里没有来源域这一项，改来源到与目标相同来触发校验。
    fireEvent.change(screen.getByLabelText("来源领域"), { target: { value: "d-2" } });
    await screen.findByText("来源与目标不能是同一个领域。");
    expect(screen.getByRole("button", { name: "确认合并" })).toBeDisabled();
    expect(mergeDomains).toHaveBeenCalledTimes(1);
  });

  it("同名条目超过 8 条时提示剩余数量", async () => {
    const previewDomainMerge = vi.fn(async () => ({
      fromName: "多模态",
      intoName: "指令对齐",
      fromCount: 10,
      intoCount: 10,
      duplicates: Array.from({ length: 10 }, (_, i) => ({ title: `D${i}` })),
    }));
    useField.setState({ dialog: "merge-domain", domains: DOMAINS, selectedDomainId: "d-1", previewDomainMerge });
    render(<MergeDomainDialog />);
    expect(await screen.findByText(/另有 2 篇同名论文未逐条列出/)).toBeInTheDocument();
  });
});
