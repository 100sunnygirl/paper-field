import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useField } from "../store";
import { DomainTrashCard } from "./DomainTrashCard";

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("DomainTrashCard · 领域回收站", () => {
  it("列出 30 天内删除的领域（论文数 / 删除日期 / 剩余天数），可恢复", async () => {
    const listTrashedDomains = vi.fn(async () => [
      { id: "d-9", name: "误删的领域", code: "D-09", deletedAt: "2026-10-20T00:00:00.000Z", papers: 12, daysLeft: 21 },
    ]);
    const restoreTrashedDomain = vi.fn(async () => undefined);
    useField.setState({ listTrashedDomains, restoreTrashedDomain });
    render(<DomainTrashCard />);
    expect(await screen.findByText("误删的领域")).toBeInTheDocument();
    expect(screen.getByText(/12 篇论文/)).toBeInTheDocument();
    expect(screen.getByText(/剩 21 天/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复领域" }));
    await waitFor(() => expect(restoreTrashedDomain).toHaveBeenCalledWith("d-9"));
    // 恢复后从列表移除
    await waitFor(() => expect(screen.queryByText("误删的领域")).toBeNull());
  });

  it("「彻底删除…」两步确认后才执行；取消不动", async () => {
    const purgeTrashedDomain = vi.fn(async () => undefined);
    const listTrashedDomains = vi.fn(async () => [
      { id: "d-9", name: "旧领域", code: "D-09", deletedAt: "2026-10-20T00:00:00.000Z", papers: 3, daysLeft: 10 },
    ]);
    useField.setState({ listTrashedDomains, purgeTrashedDomain });
    render(<DomainTrashCard />);
    fireEvent.click(await screen.findByRole("button", { name: "彻底删除…" }));
    expect(screen.getByText("快照将不可恢复。")).toBeInTheDocument();
    expect(purgeTrashedDomain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("快照将不可恢复。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "彻底删除…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认彻底删除" }));
    await waitFor(() => expect(purgeTrashedDomain).toHaveBeenCalledWith("d-9"));
  });

  it("回收站为空时列表载入后不渲染整张卡", async () => {
    const listTrashedDomains = vi.fn(async () => []);
    useField.setState({ listTrashedDomains });
    render(<DomainTrashCard />);
    await waitFor(() => expect(listTrashedDomains).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("领域回收站")).toBeNull());
  });
});
