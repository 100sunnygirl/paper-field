import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Domain, DomainCensus } from "../lib/types";
import { useField } from "../store";
import { DomainMenu } from "./DomainMenu";

vi.mock("../lib/repo", () => ({
  repo: {
    domainCensus: vi.fn(async () => [] as DomainCensus[]),
  },
}));

import { repo } from "../lib/repo";

const DOMAINS: Domain[] = [
  { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
  { id: "d-2", name: "指令对齐", code: "AL-02", summary: null, sortOrder: 2, createdAt: "2024-01-02T00:00:00.000Z" },
  { id: "d-3", name: "强化学习", code: "RL-03", summary: null, sortOrder: 3, createdAt: "2024-01-03T00:00:00.000Z" },
];

const CENSUS: DomainCensus[] = [
  { domainId: "d-1", total: 12, unread: 8, reading: 2, read: 2, lastReadAt: "2024-10-01T00:00:00.000Z", lastActivityAt: "2024-10-02T00:00:00.000Z", weekCount: 3 },
  { domainId: "d-2", total: 5, unread: 5, reading: 0, read: 0, lastReadAt: null, lastActivityAt: null, weekCount: 0 },
];

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  vi.mocked(repo.domainCensus).mockReset();
  vi.mocked(repo.domainCensus).mockResolvedValue(CENSUS);
});

describe("DomainMenu · 领域快捷切换下拉", () => {
  it("点领域名就地展开下拉，列出各领域与阅读进度，当前领域高亮", async () => {
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1" });
    render(<DomainMenu />);
    fireEvent.click(screen.getByRole("button", { name: "切换研究领域：多模态" }));
    const menu = screen.getByRole("menu", { name: "领域快捷切换" });
    expect(within(menu).getByText("指令对齐")).toBeInTheDocument();
    // 进度异步读取：等待聚合结果渲染。
    expect(await within(menu).findByText("AL-02 · 已读 0 / 5")).toBeInTheDocument();
    expect(within(menu).getByText("MM-01 · 已读 2 / 12")).toBeInTheDocument();
    expect(document.querySelector(".ef-domain-menu-item.is-current")?.textContent).toContain("多模态");
  });

  it("点击其他领域行直接切换（一步完成），不再先进对话框", () => {
    const selectDomain = vi.fn(async () => undefined);
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1", selectDomain });
    render(<DomainMenu />);
    fireEvent.click(screen.getByRole("button", { name: "切换研究领域：多模态" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /强化学习/ }));
    expect(selectDomain).toHaveBeenCalledTimes(1);
    expect(selectDomain).toHaveBeenCalledWith("d-3");
  });

  it("点当前领域不重复切换（只收起菜单）；「管理领域…」进入领域选择对话框", () => {
    const selectDomain = vi.fn(async () => undefined);
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1", selectDomain });
    render(<DomainMenu />);
    fireEvent.click(screen.getByRole("button", { name: "切换研究领域：多模态" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /多模态/ }));
    expect(selectDomain).not.toHaveBeenCalled();
    // 点当前领域只收起菜单；重新展开走「管理领域…」。
    fireEvent.click(screen.getByRole("button", { name: "切换研究领域：多模态" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /管理领域/ }));
    expect(useField.getState().dialog).toBe("pick-domain");
    expect(screen.queryByRole("menu", { name: "领域快捷切换" })).toBeNull();
  });

  it("Esc 与外部点击收起下拉；快捷键提示可见", () => {
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1" });
    render(<DomainMenu />);
    const trigger = screen.getByRole("button", { name: "切换研究领域：多模态" });
    fireEvent.click(trigger);
    expect(screen.getByText(/⌘1-9 直达/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "领域快捷切换" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "领域快捷切换" })).toBeNull();
  });

  it("进度读取失败时降级：只显示名称与短码，不显示已读计数", async () => {
    vi.mocked(repo.domainCensus).mockRejectedValue(new Error("no engine"));
    useField.setState({ domains: DOMAINS, selectedDomainId: "d-1" });
    render(<DomainMenu />);
    fireEvent.click(screen.getByRole("button", { name: "切换研究领域：多模态" }));
    await waitFor(() => expect(screen.getByText("MM-01")).toBeInTheDocument());
    expect(screen.queryByText(/已读/)).toBeNull();
  });
});

describe("DomainMenu · 领域强调色点", () => {
  it("设置了强调色的领域行显示色点，当前行迷你进度条同色", async () => {
    vi.mocked(repo.domainCensus).mockResolvedValue([
      { domainId: "d-1", total: 2, unread: 1, reading: 0, read: 1, lastReadAt: null, lastActivityAt: null, weekCount: 0 },
    ]);
    useField.setState({
      domains: DOMAINS.map((d) => (d.id === "d-2" ? { ...d, accent: "indigo" } : d)),
      selectedDomainId: "d-1",
    });
    render(<DomainMenu />);
    fireEvent.click(screen.getByRole("button", { name: "切换研究领域：多模态" }));
    const menu = screen.getByRole("menu", { name: "领域快捷切换" });
    const rows = within(menu).getAllByRole("menuitem");
    expect(within(rows[1]).getByText("指令对齐")).toBeInTheDocument();
    const dot = rows[1].querySelector(".ef-domain-menu-dot") as HTMLElement | null;
    expect(dot?.getAttribute("style")).toContain("var(--pf-accent-indigo)");
    expect(rows[0].querySelector(".ef-domain-menu-dot")).toBeNull();
  });
});
