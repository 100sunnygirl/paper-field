import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { repo } from "../lib/repo";
import { useField } from "../store";
import { ImportTarget } from "./ImportTarget";

vi.mock("../lib/repo", () => ({
  repo: {
    createDomain: vi.fn(),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    getPaper: vi.fn(async () => null),
  },
}));

const createDomain = repo.createDomain as unknown as ReturnType<typeof vi.fn>;

const DOMAINS = [
  { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
  { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-01T00:00:00.000Z" },
];

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  createDomain.mockReset();
});

describe("ImportTarget · 常驻目标领域", () => {
  it("缺省显示当前选中领域，不展开清单", () => {
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1" });
    render(<ImportTarget />);
    expect(screen.getByText("「多模态」")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "选择导入目标领域" })).toBeNull();
  });

  it("点击展开领域清单，选择后改写目标并收起", () => {
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1" });
    render(<ImportTarget />);
    fireEvent.click(screen.getByRole("button", { name: /将导入到/ }));
    const menu = screen.getByRole("group", { name: "选择导入目标领域" });
    expect(menu).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /指令对齐/ }));
    expect(useField.getState().importTargetDomainId).toBe("d-2");
    expect(screen.queryByRole("group", { name: "选择导入目标领域" })).toBeNull();
    expect(screen.getByText("「指令对齐」")).toBeInTheDocument();
  });

  it("就地新建领域：创建成功后刷新并落为新目标（不切走模式、不开对话框）", async () => {
    const created = { id: "d-9", name: "具身智能", code: "EM-03", summary: null, sortOrder: 3, createdAt: "2024-01-01T00:00:00.000Z" };
    createDomain.mockResolvedValue(created);
    const refresh = vi.fn(async () => undefined);
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1", refresh });
    render(<ImportTarget />);
    fireEvent.click(screen.getByRole("button", { name: /将导入到/ }));
    fireEvent.change(screen.getByLabelText("新建领域名称"), { target: { value: "具身智能" } });
    fireEvent.click(screen.getByRole("button", { name: "新建并设为目标" }));
    await waitFor(() => expect(useField.getState().importTargetDomainId).toBe("d-9"));
    expect(createDomain).toHaveBeenCalledWith({ name: "具身智能", code: "", summary: "" });
    expect(refresh).toHaveBeenCalled();
    // 不走 store.createDomain：不切换模式、不开对话框
    expect(useField.getState().mode).toBe("field");
    expect(useField.getState().dialog).toBeNull();
  });

  it("新建失败时保留输入并显示原因", async () => {
    createDomain.mockRejectedValue(new Error("领域名称必填"));
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1" });
    render(<ImportTarget />);
    fireEvent.click(screen.getByRole("button", { name: /将导入到/ }));
    fireEvent.change(screen.getByLabelText("新建领域名称"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "新建并设为目标" }));
    expect(await screen.findByText("领域名称必填")).toBeInTheDocument();
    expect(useField.getState().importTargetDomainId).toBeNull();
  });
});

describe("store · importTargetDomainId", () => {
  it("切换领域后显式目标清空，重新跟随选中", async () => {
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1", importTargetDomainId: "d-2" });
    await useField.getState().selectDomain("d-1");
    expect(useField.getState().importTargetDomainId).toBeNull();
  });
});
