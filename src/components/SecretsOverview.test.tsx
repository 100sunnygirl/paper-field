import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecretsOverview, countSavedSecrets } from "./SecretsOverview";
import { useField } from "../store";
import { DEFAULT_MINERU, type MineruSaveInput } from "../lib/mineru";
import type { BiblioSaveInput } from "../lib/biblio";
import type { LlmSaveInput } from "../lib/settings";

function primeState() {
  useField.setState({
    settings: {
      version: 2,
      usage: {},
      providers: [
        {
          id: "p-1",
          presetId: "deepseek",
          label: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          enabled: true,
          hasKey: true,
          requiresKey: true,
        },
        {
          id: "p-2",
          presetId: null,
          label: "自定义服务",
          baseUrl: "",
          model: "",
          enabled: true,
          hasKey: false,
          requiresKey: true,
        },
      ],
    },
    mineru: {
      ...DEFAULT_MINERU,
      api: { ...DEFAULT_MINERU.api, hasToken: true },
      configured: true,
    },
    biblio: {
      email: "",
      hasOpenalexKey: true,
      hasS2Key: false,
      openalexRemainingUsd: null,
      openalexLimitUsd: null,
    },
  });
}

describe("SecretsOverview · 密钥与令牌总览", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    localStorage.clear();
  });

  it("逐项显示保存状态：已保存 / 未配置，未保存项没有清除按钮", () => {
    primeState();
    render(<SecretsOverview />);
    const block = screen.getByRole("article", { name: "密钥与令牌" });
    expect(withinText(block, "AI Key · DeepSeek")).toMatch(/已保存/);
    expect(withinText(block, "AI Key · 自定义服务")).toMatch(/未配置/);
    expect(withinText(block, "MinerU Token · 官方 API")).toMatch(/已保存/);
    expect(withinText(block, "OpenAlex API Key")).toMatch(/已保存/);
    expect(withinText(block, "Semantic Scholar API Key")).toMatch(/未配置/);
    expect(screen.queryByRole("button", { name: "清除 AI Key · 自定义服务" })).not.toBeInTheDocument();
  });

  it("「定位」跳到对应设置卡（openSystemCard）", () => {
    const openSystemCard = vi.fn();
    useField.setState({ openSystemCard });
    render(<SecretsOverview />);
    fireEvent.click(screen.getByRole("button", { name: "定位 MinerU Token · 官方 API" }));
    expect(openSystemCard).toHaveBeenCalledWith("mineru");
  });

  it("逐项清除：两步确认后走对应保存动作（AI Key 传空串，其余保持 null）", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    primeState();
    useField.setState({ saveLlmSettings });
    render(<SecretsOverview />);
    fireEvent.click(screen.getByRole("button", { name: "清除 AI Key · DeepSeek" }));
    // 第一步只出现确认按钮，尚未保存
    expect(saveLlmSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清除 AI Key · DeepSeek" }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    const input = saveLlmSettings.mock.calls[0]![0]!;
    expect(input.providers.map((p) => p.apiKey)).toEqual(["", null]);
    expect(await screen.findByText(/已清除「AI Key · DeepSeek」/)).toBeInTheDocument();
  });

  it("清除 MinerU Token 按已保存值原样提交其余字段", async () => {
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    primeState();
    useField.setState({ saveMineruSettings });
    render(<SecretsOverview />);
    fireEvent.click(screen.getByRole("button", { name: "清除 MinerU Token · 官方 API" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清除 MinerU Token · 官方 API" }));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    expect(saveMineruSettings.mock.calls[0]![0].api.token).toBe("");
    expect(saveMineruSettings.mock.calls[0]![0].order).toEqual(DEFAULT_MINERU.order);
  });

  it("清除文献库 Key 只清目标一项", async () => {
    const saveBiblioSettings = vi.fn(async (_input: BiblioSaveInput) => undefined);
    primeState();
    useField.setState({ saveBiblioSettings });
    render(<SecretsOverview />);
    fireEvent.click(screen.getByRole("button", { name: "清除 OpenAlex API Key" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清除 OpenAlex API Key" }));
    await waitFor(() => expect(saveBiblioSettings).toHaveBeenCalledTimes(1));
    expect(saveBiblioSettings.mock.calls[0]![0]).toEqual({ email: "", openalexKey: "", s2Key: null });
  });

  it("全部清除：两步确认后逐项清空全部已保存密钥", async () => {
    const saveLlmSettings = vi.fn(async (_input: LlmSaveInput) => undefined);
    const saveMineruSettings = vi.fn(async (_input: MineruSaveInput) => undefined);
    const saveBiblioSettings = vi.fn(async (_input: BiblioSaveInput) => undefined);
    primeState();
    useField.setState({ saveLlmSettings, saveMineruSettings, saveBiblioSettings });
    render(<SecretsOverview />);
    fireEvent.click(screen.getByRole("button", { name: "全部清除…" }));
    expect(screen.getByRole("button", { name: /确认全部清除（3 项）/ })).toBeInTheDocument();
    expect(saveLlmSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /确认全部清除（3 项）/ }));
    await waitFor(() => expect(saveLlmSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveMineruSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveBiblioSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已全部清除（3 项）/)).toBeInTheDocument();
  });

  it("没有已保存密钥时不显示全部清除，显示空态说明", () => {
    render(<SecretsOverview />);
    expect(screen.getByText("当前没有已保存的密钥与令牌。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全部清除…" })).not.toBeInTheDocument();
  });

  it("Key 读取失败（keyState unreadable）标为读取失败", () => {
    useField.setState({
      settings: {
        version: 2,
        usage: {},
        providers: [
          {
            id: "p-1",
            presetId: null,
            label: "本地代理",
            baseUrl: "",
            model: "",
            enabled: true,
            hasKey: false,
            keyState: "unreadable",
            requiresKey: true,
          },
        ],
      },
    });
    render(<SecretsOverview />);
    expect(screen.getByText("读取失败")).toBeInTheDocument();
  });

  it("countSavedSecrets 汇总已保存条目数", () => {
    expect(countSavedSecrets(
      { providers: [{ hasKey: true } as never, { hasKey: false } as never] },
      { api: { hasToken: true } },
      { hasOpenalexKey: false, hasS2Key: true },
    )).toBe(3);
  });
});

/** 行级断言辅助：取包含该文本的行的完整文字。 */
function withinText(container: HTMLElement, text: string): string {
  const row = Array.from(container.querySelectorAll("li")).find((li) => li.textContent?.includes(text));
  return row?.textContent ?? "";
}
