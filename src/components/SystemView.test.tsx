import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SystemView } from "./SystemView";
import { useField } from "../store";
import { DEFAULT_MINERU, type MineruSaveInput, type MineruSettingsV2 } from "../lib/mineru";
import type { ProviderHealth } from "../lib/mineru";

function mineruState(overrides: Partial<MineruSettingsV2> = {}): MineruSettingsV2 {
  return {
    ...DEFAULT_MINERU,
    local: { enabled: true, socketPath: "~/.mineru/doclib.sock" },
    ssh: { ...DEFAULT_MINERU.ssh, enabled: true, host: "imac" },
    api: { ...DEFAULT_MINERU.api, hasToken: true },
    configured: true,
    ...overrides,
  };
}

function healths(list: Array<[ProviderHealth["provider"], boolean, string]>): ProviderHealth[] {
  return list.map(([provider, ok, message]) => ({ provider, ok, latencyMs: ok ? 15 : 0, message }));
}

describe("SystemView · MinerU 三源卡片", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("渲染三张来源卡片：本地 CLI / SSH 远程 / 官方 API，各带测试连接按钮", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    render(<SystemView />);
    for (const label of ["本地 CLI", "SSH 远程", "官方 API"]) {
      expect(screen.getByRole("region", { name: label })).toBeInTheDocument();
    }
    const buttons = screen.getAllByRole("button", { name: "测试连接" });
    expect(buttons).toHaveLength(3);
  });

  it("SSH 卡片保留 doclib.sock 兼容字段（主机/端口/私钥/远程 Socket/暂存目录）", () => {
    useField.setState({ mineru: mineruState() });
    render(<SystemView />);
    const ssh = screen.getByRole("region", { name: "SSH 远程" });
    for (const label of ["主机", "端口", "用户", "私钥路径", "远程 Socket 路径", "远程暂存目录"]) {
      expect(within(ssh).getByText(label)).toBeInTheDocument();
    }
    expect(
      within(ssh).getByText(/连接另一台电脑上已部署的 MinerU，PDF 会先复制到远程暂存目录/),
    ).toBeInTheDocument();
  });

  it("生效源显示「当前生效」与卡片「生效中」徽章", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "ssh" });
    render(<SystemView />);
    expect(screen.getByText(/当前生效：/)).toHaveTextContent("SSH 远程");
    const sshCard = screen.getByRole("region", { name: "SSH 远程" });
    expect(within(sshCard).getByText("生效中")).toBeInTheDocument();
  });

  it("已启用但全部探测失败：显示失败原因聚合（分号分隔，含各源中文标签）", () => {
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: null,
      mineruHealth: healths([
        ["local", false, "socket 文件不存在"],
        ["ssh", false, "连接超时"],
        ["api", false, "Token 无效"],
      ]),
    });
    render(<SystemView />);
    expect(screen.getByText(/已启用的解析源均未通过探测/)).toBeInTheDocument();
    expect(
      screen.getByText(/本地 CLI：socket 文件不存在；SSH 远程：连接超时；官方 API：Token 无效/),
    ).toBeInTheDocument();
  });

  it("未启用任何源：显示「尚未启用任何解析源，导入仅入库。」", () => {
    useField.setState({ mineru: mineruState({ configured: false, local: { enabled: false, socketPath: "~/.mineru/doclib.sock" }, ssh: { ...DEFAULT_MINERU.ssh }, api: { ...DEFAULT_MINERU.api } }) });
    render(<SystemView />);
    expect(screen.getByText("尚未启用任何解析源，导入将只入库、不解析。")).toBeInTheDocument();
  });

  it("探测成功的源显示延迟毫秒数", () => {
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: "local",
      mineruHealth: healths([["local", true, "doclib 可达"]]),
    });
    render(<SystemView />);
    expect(screen.getByText(/doclib 可达/)).toHaveTextContent("15ms");
  });
});

describe("SystemView · 回退顺序调整", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  function orderChips(): string[] {
    const group = screen.getByRole("group", { name: "回退顺序" });
    return Array.from(group.querySelectorAll(".ef-order-chip")).map(
      (chip) => chip.textContent?.replace(/↑|↓/g, "") ?? "",
    );
  }

  it("按 order 渲染顺序 chips，首位无上移、末位无下移", () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    render(<SystemView />);
    expect(orderChips()).toEqual(["本地 CLI", "SSH 远程", "官方 API"]);
    expect(screen.getByRole("button", { name: "上移本地 CLI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移官方 API" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上移SSH 远程" })).toBeEnabled();
  });

  it("点击「上移SSH 远程」立即保存新顺序（顺序即回退优先级）", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    useField.setState({
      mineru: mineruState(),
      effectiveProvider: "local",
      saveMineruSettings,
    });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "上移SSH 远程" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    const input = saveMineruSettings.mock.calls[0]![0]!;
    expect(input.order).toEqual(["ssh", "local", "api"]);
    // chips 立即反映新顺序
    expect(orderChips()).toEqual(["SSH 远程", "本地 CLI", "官方 API"]);
  });

  it("点击「下移本地 CLI」相邻交换保存 [ssh, local, api]；再下移到末尾得 [ssh, api, local]", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    useField.setState({ mineru: mineruState(), effectiveProvider: null, saveMineruSettings });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "下移本地 CLI" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    expect(saveMineruSettings.mock.calls[0]![0].order).toEqual(["ssh", "local", "api"]);
    // 本地 CLI 现在排第二，继续下移到末尾。
    fireEvent.click(screen.getByRole("button", { name: "下移本地 CLI" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(2));
    expect(saveMineruSettings.mock.calls[1]![0].order).toEqual(["ssh", "api", "local"]);
  });

  it("「重新探测全部」触发 probeMineru", async () => {
    const probeMineru = vi.fn(async () => []);
    useField.setState({ mineru: mineruState(), effectiveProvider: "local", probeMineru });
    render(<SystemView />);
    fireEvent.click(screen.getByRole("button", { name: "重新探测全部" }));
    await waitFor(() => expect(probeMineru).toHaveBeenCalledTimes(1));
  });

  it("「测试连接」失败时在对应卡片显示中文错误（浏览器预览不可连）", async () => {
    useField.setState({ mineru: mineruState(), effectiveProvider: "local" });
    render(<SystemView />);
    const localCard = screen.getByRole("region", { name: "本地 CLI" });
    fireEvent.click(within(localCard).getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(within(localCard).getByText(/浏览器预览无法连接 MinerU，请使用桌面应用/)).toBeInTheDocument(),
    );
  });

  it("保存设置按钮调用 saveMineruSettings 并显示已启用来源数", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    useField.setState({ mineru: mineruState(), effectiveProvider: "local", saveMineruSettings });
    render(<SystemView />);
    const mineruBlock = screen.getByText("MinerU 解析源").closest("article") as HTMLElement;
    fireEvent.click(within(mineruBlock).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/MinerU 设置已保存（已启用 3 个解析源）/)).toBeInTheDocument();
  });
});
