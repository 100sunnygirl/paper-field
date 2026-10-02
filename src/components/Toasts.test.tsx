// 通知堆叠（toasts 收口层 + Toasts 组件）的检测用例：
// 多条共存不互顶、同 (tone,text) 去重刷新、上限淘汰（优先非 error）、手动关闭、
// 假时钟自动消退（dismiss:auto）、aria 语义（error=alert / ok,warn=status + sr-only
// 级别前缀）、悬停暂停接续，以及 App 挂载顺序（各 Dialog 之后）与层叠 z-index 口径。
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// 本文件直接用 react 的 act 包裹组件外的 store 更新（notify / openDialog），
// 需显式声明 act 环境（其余测试只经 RTL 的 render/fireEvent，不触发本警告）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// vitest 默认不处理 CSS（css: false，?raw 导入为空）：层叠口径断言直接读源文件文本。
const css = readFileSync(resolve(process.cwd(), "src/styles/workstation.css"), "utf8");

// 渲染 <App/>（挂载顺序断言）需要 store.init 成链：repo 全量打桩。
vi.mock("../lib/repo", () => ({
  repo: {
    init: vi.fn(async () => undefined),
    getPaper: vi.fn(async () => null),
    getDomain: vi.fn(async () => null),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    searchAll: vi.fn(async () => []),
  },
}));

import App from "../App";
import { useField } from "../store";
import { Toasts } from "./Toasts";
import {
  MAX_TOASTS,
  TOAST_DURATION,
  bindToastLog,
  dismissAll,
  getToasts,
  notify,
  type ToastLogEvent,
} from "../toasts";

let events: ToastLogEvent[] = [];

function lastEvent(): ToastLogEvent {
  return events.at(-1)!;
}

beforeEach(() => {
  events = [];
  // 堆叠是模块级单例：清残留并接入事件收集 sink。
  bindToastLog(null);
  dismissAll("manual");
  bindToastLog((event) => events.push(event));
});

afterEach(() => {
  // 组件可能仍挂载：堆叠更新会触发重渲染，须包 act 并在之后清理 DOM。
  act(() => {
    bindToastLog(null);
    dismissAll("manual");
  });
  cleanup();
});

describe("toasts 收口层 × Toasts 组件", () => {
  it("多条通知共存不互顶（取代旧「全局单条」语义）", () => {
    render(<Toasts />);
    act(() => {
      notify("ok", "已导入 3 篇。");
      notify("error", "MinerU 解析失败 1 篇。");
      notify("warn", "尚未配置 AI 服务。");
    });
    expect(screen.getAllByText(/已导入 3 篇|解析失败 1 篇|尚未配置/)).toHaveLength(3);
    expect(document.querySelectorAll(".ef-toast")).toHaveLength(3);
    expect(events.filter((e) => e.action === "emit")).toHaveLength(3);
  });

  it("同 (tone,text) 去重：不重复入列，只刷新停留计时并记 refresh 事件", () => {
    vi.useFakeTimers();
    try {
      render(<Toasts />);
      act(() => {
        notify("warn", "请先保存或取消正在编辑的笔记。");
        vi.advanceTimersByTime(TOAST_DURATION.warn - 200);
        notify("warn", "请先保存或取消正在编辑的笔记。");
      });
      expect(document.querySelectorAll(".ef-toast")).toHaveLength(1);
      expect(events.map((e) => e.action)).toEqual(["emit", "refresh"]);
      // 若计时未重置，累计已超单次时长；刷新后距上次 notify 不足时长，应仍在场。
      act(() => {
        vi.advanceTimersByTime(TOAST_DURATION.warn - 200);
      });
      expect(document.querySelector(".ef-toast")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(document.querySelector(".ef-toast")).toBeNull();
      expect(lastEvent()).toMatchObject({ action: "dismiss", reason: "auto" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("超上限淘汰最旧非 error：error 通知尽量保留，全为 error 才淘汰最旧", () => {
    render(<Toasts />);
    act(() => {
      notify("error", "错误一");
      notify("error", "错误二");
      notify("ok", "成功一");
      notify("error", "错误三");
      // 第 5 条触发淘汰：最旧非 error（成功一）被逐出，4 条 error 全保留。
      notify("error", "错误四");
    });
    const texts = getToasts().map((t) => t.text);
    expect(texts).toEqual(["错误一", "错误二", "错误三", "错误四"]);
    expect(events.find((e) => e.action === "evict")).toMatchObject({ text: "成功一", tone: "ok" });
    act(() => {
      notify("error", "错误五");
    });
    expect(getToasts().map((t) => t.text)).toEqual(["错误二", "错误三", "错误四", "错误五"]);
  });

  it("手动关闭：点击关闭按钮移除该条并记 dismiss:manual", () => {
    render(<Toasts />);
    act(() => {
      notify("ok", "论文已删除。");
      notify("ok", "笔记已保存。");
    });
    fireEvent.click(screen.getAllByRole("button", { name: "关闭通知" })[0]!);
    expect(screen.queryByText("论文已删除。")).toBeNull();
    expect(screen.getByText("笔记已保存。")).not.toBeNull();
    expect(lastEvent()).toMatchObject({ action: "dismiss", reason: "manual", text: "论文已删除。" });
  });

  it("假时钟自动消退：ok/warn 4200ms、error 8000ms，记 dismiss:auto", () => {
    vi.useFakeTimers();
    try {
      render(<Toasts />);
      act(() => {
        notify("ok", "成功提示");
        notify("error", "错误提示");
      });
      act(() => {
        vi.advanceTimersByTime(TOAST_DURATION.ok);
      });
      expect(screen.queryByText("成功提示")).toBeNull();
      expect(screen.getByText("错误提示")).not.toBeNull();
      expect(events.find((e) => e.action === "dismiss" && e.text === "成功提示")).toMatchObject({
        reason: "auto",
      });
      act(() => {
        vi.advanceTimersByTime(TOAST_DURATION.error - TOAST_DURATION.ok);
      });
      expect(screen.queryByText("错误提示")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aria 语义：error 用 assertive 的 alert，ok/warn 用 polite 的 status，sr-only 级别前缀", () => {
    render(<Toasts />);
    act(() => {
      notify("error", "保存失败");
      notify("ok", "已保存");
      notify("warn", "请注意");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("alert").querySelector(".sr-only")).toHaveTextContent("错误");
    // jsdom 不为 live region 计算 name-from-content，按文本定位再核前缀。
    const statuses = screen.getAllByRole("status");
    const okRow = statuses.find((el) => el.textContent?.includes("已保存"))!;
    const warnRow = statuses.find((el) => el.textContent?.includes("请注意"))!;
    expect(okRow.querySelector(".sr-only")).toHaveTextContent("成功");
    expect(warnRow.querySelector(".sr-only")).toHaveTextContent("提醒");
    expect(screen.getAllByRole("button", { name: "关闭通知" })).toHaveLength(3);
  });

  it("悬停暂停自动消退，移开后接续剩余时长（不重置全时长）", () => {
    vi.useFakeTimers();
    try {
      render(<Toasts />);
      act(() => {
        notify("ok", "悬停我");
      });
      const row = screen.getByText("悬停我").closest(".ef-toast") as HTMLElement;
      fireEvent.mouseEnter(row);
      act(() => {
        // 已过单次时长，但处于暂停态不应消退。
        vi.advanceTimersByTime(TOAST_DURATION.ok + 5000);
      });
      expect(screen.getByText("悬停我")).not.toBeNull();
      fireEvent.mouseLeave(row);
      act(() => {
        // 接续的是暂停时冻结的剩余时长（≈0），再走完全程即消退。
        vi.advanceTimersByTime(TOAST_DURATION.ok);
      });
      expect(screen.queryByText("悬停我")).toBeNull();
      expect(lastEvent()).toMatchObject({ action: "dismiss", reason: "auto" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("durationMs=0 不自动消退（长驻错误需手动关闭）", () => {
    vi.useFakeTimers();
    try {
      render(<Toasts />);
      act(() => {
        notify("error", "存储无法写入", { durationMs: 0 });
        vi.advanceTimersByTime(120_000);
      });
      expect(screen.getByText("存储无法写入")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
      expect(screen.queryByText("存储无法写入")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App 挂载顺序与层叠（DOM 结构 × CSS 口径）", () => {
  it("Toasts 容器挂载在各 Dialog 之后（.ef-shell 的最后一个元素子节点）", async () => {
    render(<App />);
    await waitFor(() => expect(useField.getState().ready).toBe(true));
    act(() => {
      notify("ok", "挂载顺序验证");
    });
    const shell = document.querySelector(".ef-shell")!;
    const stack = document.querySelector(".ef-toast-stack")!;
    expect(shell).not.toBeNull();
    expect(stack).not.toBeNull();
    // Dialog 空态渲染 null：容器是 shell 的最后一个元素子节点即「在全部 Dialog 之后」。
    expect(shell.lastElementChild).toBe(stack);
    // 打开一个对话框出 DOM 后再验证相对顺序：backdrop 在通知容器之前。
    act(() => {
      useField.getState().openDialog("paper");
    });
    const backdrop = await screen.findByRole("dialog");
    expect(backdrop.closest(".ef-backdrop")!.compareDocumentPosition(stack)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("层叠口径：--pf-z-toast 高于 skip-link（100）与对话框 backdrop（30），窄屏底部反转堆叠", () => {
    const toastZ = Number(css.match(/--pf-z-toast:\s*(\d+)/)![1]);
    const skipZ = Number(css.match(/\.skip-link\s*\{[^}]*z-index:\s*(\d+)/)![1]);
    const backdropZ = Number(css.match(/\.ef-backdrop\s*\{[^}]*z-index:\s*(\d+)/)![1]);
    expect(toastZ).toBeGreaterThan(skipZ);
    expect(skipZ).toBeGreaterThan(backdropZ);
    expect(css.match(/\.ef-toast-stack\s*\{[^}]*\}/s)![0]).toContain("var(--pf-z-toast)");
    // ≤700px 断点：底部堆叠 + column-reverse（最新一条贴屏幕底边）。
    const narrow = css.match(/@media \(max-width: 700px\)\s*\{([\s\S]*)\}/)![1];
    const stackRule = narrow.match(/\.ef-toast-stack\s*\{[^}]*\}/s)![0];
    expect(stackRule).toContain("column-reverse");
    expect(stackRule).toContain("bottom:");
    // 堆叠上限是产品语义的一部分：CSS 口径与数据层常量一致由组件保证，此处固定为 4。
    expect(MAX_TOASTS).toBe(4);
  });
});
