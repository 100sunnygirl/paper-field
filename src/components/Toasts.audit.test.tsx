// 「弹窗通知」模块第 1 轮检测（独立复核用例，不与实现侧 Toasts.test.tsx 共享断言口径）：
// 1) 多条堆叠互不覆盖 + 上限淘汰后新条仍能入列；
// 2) 按级别自动消退的毫秒级边界（4199/4200、7999/8000）与 dismiss:auto；
// 3) 手动关闭只移除目标条；
// 4) 无障碍语义：error=alert、ok/warn=status（隐式 aria-live）、sr-only 级别前缀、关闭按钮可访问名；
// 5) 浮于对话框之上：DOM 顺序（backdrop 之后）+ CSS 层叠口径（--pf-z-toast > skip-link > backdrop/dock）；
// 6) 既有 flash 调用方零迁移：setFlash 桥接后照样弹 toast、同文案去重、null 清空；
// 7) 任务节点通知触达：runMineruBatch 批次完成的 host.flash 经 setFlash→notify 落到 DOM。
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// App / mineruRun 都依赖 repo：给一个覆盖两条链路的宽桩（init 走通、批次用 getPaper/createJob）。
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
    listFailedMineru: vi.fn(async () => [] as string[]),
    listPendingMineru: vi.fn(async () => [] as string[]),
    listReadyForMeta: vi.fn(async () => [] as string[]),
    searchAll: vi.fn(async () => []),
    startJob: vi.fn(async () => ({ id: "job-audit-1", status: "running" })),
    finishJob: vi.fn(async () => true),
    jobStatus: vi.fn(async () => "running"),
    ownsMineru: vi.fn(async () => true),
    activeJobIds: vi.fn(async () => []),
    paperIdsInDomain: vi.fn(async () => []),
    setMineruState: vi.fn(async () => true),
    saveParsedMarkdown: vi.fn(async () => undefined),
  },
}));

// 只替换 mineruRun 直接调用的两个 IPC 函数，其余（DEFAULT_MINERU / 探测 / 设置）保持真实模块。
vi.mock("../lib/mineru", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mineru")>()),
  mineruSubmit: vi.fn(async () => ({
    provider: "local",
    remotePath: "/remote/a.pdf",
    shortId: "doc-audit-1",
    parseIds: [],
    status: "done",
    tier: "standard",
    credFingerprint: "pf-cred-v1:match",
  })),
  mineruMarkdown: vi.fn(async () => "# 解析结果\n正文。"),
}));

import App from "../App";
import { useField } from "../store";
import { runMineruBatch } from "../lib/mineruRun";
import { repo } from "../lib/repo";
import { DEFAULT_MINERU } from "../lib/mineru";
import { Toasts } from "./Toasts";
import { TOAST_DURATION, bindToastLog, dismissAll, notify, type ToastLogEvent } from "../toasts";
import type { PaperDetail } from "../lib/types";

// jsdom 不加载 CSS：层叠口径按源文件文本核对。
const css = readFileSync(resolve(process.cwd(), "src/styles/workstation.css"), "utf8");

let events: ToastLogEvent[] = [];

beforeEach(() => {
  events = [];
  bindToastLog(null);
  act(() => {
    dismissAll("manual");
  });
  bindToastLog((event) => events.push(event));
});

afterEach(() => {
  act(() => {
    bindToastLog(null);
    dismissAll("manual");
  });
  cleanup();
  vi.useRealTimers();
});

describe("堆叠与自动消退", () => {
  it("多条不同通知共存，每条独立成节点；关掉中间一条不影响其余", () => {
    render(<Toasts />);
    act(() => {
      notify("ok", "第一条");
      notify("warn", "第二条");
      notify("error", "第三条");
      notify("ok", "第四条");
    });
    const rows = document.querySelectorAll(".ef-toast");
    expect(rows).toHaveLength(4);
    // 四条文本同时在 DOM：堆叠不互相顶掉。
    for (const text of ["第一条", "第二条", "第三条", "第四条"]) {
      expect(screen.getByText(text)).not.toBeNull();
    }
    fireEvent.click(screen.getByText("第二条").closest(".ef-toast")!.querySelector("button")!);
    expect(screen.queryByText("第二条")).toBeNull();
    expect(document.querySelectorAll(".ef-toast")).toHaveLength(3);
    for (const text of ["第一条", "第三条", "第四条"]) {
      expect(screen.getByText(text)).not.toBeNull();
    }
  });

  it("超上限淘汰最旧非 error 后，第 6 条仍能正常入列展示", () => {
    render(<Toasts />);
    act(() => {
      notify("ok", "旧成功"); // 最旧非 error，应被逐出
      notify("error", "错误甲");
      notify("error", "错误乙");
      notify("warn", "提醒丙");
      notify("ok", "新成功"); // 触发淘汰
    });
    expect(document.querySelectorAll(".ef-toast")).toHaveLength(4);
    expect(screen.queryByText("旧成功")).toBeNull();
    act(() => {
      notify("ok", "第六条");
    });
    // 第 6 条入列同样触发淘汰：此时最旧非 error 是「提醒丙」。
    expect(document.querySelectorAll(".ef-toast")).toHaveLength(4);
    expect(screen.getByText("第六条")).not.toBeNull();
    expect(events.filter((e) => e.action === "evict").map((e) => e.text)).toEqual(["旧成功", "提醒丙"]);
    expect(screen.queryByText("提醒丙")).toBeNull();
  });

  it("级别时长边界：ok/warn 4200ms、error 8000ms，差 1ms 都不提前消失", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => {
      notify("warn", "提醒级");
      notify("error", "错误级");
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION.warn - 1);
    });
    // 4199ms：两条都未到期。
    expect(screen.getByText("提醒级")).not.toBeNull();
    expect(screen.getByText("错误级")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // 4200ms 整：warn 到期消失，error 不受影响（独立计时）。
    expect(screen.queryByText("提醒级")).toBeNull();
    expect(screen.getByText("错误级")).not.toBeNull();
    expect(events.find((e) => e.action === "dismiss" && e.text === "提醒级")).toMatchObject({
      reason: "auto",
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION.error - TOAST_DURATION.warn - 1);
    });
    // 7999ms：error 仍在场。
    expect(screen.getByText("错误级")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // 8000ms 整：error 消失。
    expect(screen.queryByText("错误级")).toBeNull();
    expect(events.find((e) => e.action === "dismiss" && e.text === "错误级")).toMatchObject({
      reason: "auto",
    });
  });

  it("手动关闭记 dismiss:manual，自动到期记 dismiss:auto（同一用例内对照）", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => {
      notify("ok", "手动关我");
      notify("ok", "自动走的");
    });
    fireEvent.click(screen.getByText("手动关我").closest(".ef-toast")!.querySelector("button")!);
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION.ok);
    });
    const manual = events.find((e) => e.action === "dismiss" && e.text === "手动关我")!;
    const auto = events.find((e) => e.action === "dismiss" && e.text === "自动走的")!;
    expect(manual.reason).toBe("manual");
    expect(auto.reason).toBe("auto");
  });
});

describe("无障碍语义", () => {
  it("每条都有 role：error→alert（assertive），ok/warn→status（polite），并带级别前缀与可访问关闭钮", () => {
    render(<Toasts />);
    act(() => {
      notify("ok", "已保存");
      notify("warn", "请注意");
      notify("error", "出错了");
    });
    const roles = [...document.querySelectorAll(".ef-toast")].map((el) => el.getAttribute("role"));
    expect(roles).toHaveLength(3);
    expect(roles.filter((r) => r === "alert" || r === "status")).toHaveLength(3);
    expect(screen.getByRole("alert").textContent).toContain("出错了");
    expect(screen.getByRole("alert").querySelector(".sr-only")!.textContent).toBe("错误：");
    const statuses = screen.getAllByRole("status");
    const okRow = statuses.find((el) => el.textContent?.includes("已保存"))!;
    const warnRow = statuses.find((el) => el.textContent?.includes("请注意"))!;
    expect(okRow.querySelector(".sr-only")!.textContent).toBe("成功：");
    expect(warnRow.querySelector(".sr-only")!.textContent).toBe("提醒：");
    expect(screen.getAllByRole("button", { name: "关闭通知" })).toHaveLength(3);
  });
});

describe("浮于对话框之上", () => {
  it("打开对话框后通知仍在其 backdrop 之后渲染（DOM 顺序）且层叠值更高（CSS 口径）", async () => {
    render(<App />);
    await waitFor(() => expect(useField.getState().ready).toBe(true));
    act(() => {
      notify("error", "对话框之上的通知");
    });
    const stack = document.querySelector(".ef-toast-stack")!;
    expect(stack).not.toBeNull();
    // 未开对话框：容器是 shell 的最后一个元素子节点。
    const shell = document.querySelector(".ef-shell")!;
    expect(shell.lastElementChild).toBe(stack);
    act(() => {
      useField.getState().openDialog("paper");
    });
    const backdrop = (await screen.findByRole("dialog")).closest(".ef-backdrop")!;
    expect(backdrop).not.toBeNull();
    // stack 在 backdrop 之后：同一父级下后者源顺序居后 + 更高 z-index → 视觉在上。
    expect(stack.compareDocumentPosition(backdrop)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    // CSS 口径：120 > skip-link 100 > backdrop 30 / dock 30，且 stack 是 fixed 定位。
    const z = (pattern: RegExp) => Number(css.match(pattern)![1]);
    const toastZ = z(/--pf-z-toast:\s*(\d+)/);
    const skipZ = z(/\.skip-link\s*\{[^}]*z-index:\s*(\d+)/);
    const backdropZ = z(/\.ef-backdrop\s*\{[^}]*z-index:\s*(\d+)/);
    const dockZ = z(/\.ef-dock\s*\{[^}]*z-index:\s*(\d+)/);
    expect(toastZ).toBeGreaterThan(skipZ);
    expect(skipZ).toBeGreaterThan(backdropZ);
    expect(toastZ).toBeGreaterThan(dockZ);
    const stackRule = css.match(/\.ef-toast-stack\s*\{[^}]*\}/s)![0];
    expect(stackRule).toContain("position: fixed");
    expect(stackRule).toContain("var(--pf-z-toast)");
  });
});

describe("既有 flash 调用方零迁移", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
  });

  it("setFlash 非 null → 弹出对应 toast 且镜像照写；同文案重复 → 去重不叠加；null → 清空堆叠", () => {
    render(<Toasts />);
    act(() => {
      useField.getState().setFlash({ tone: "error", text: "保存失败：磁盘只读" });
    });
    expect(useField.getState().flash).toEqual({ tone: "error", text: "保存失败：磁盘只读" });
    expect(screen.getByText("保存失败：磁盘只读").closest(".ef-toast")).not.toBeNull();
    act(() => {
      useField.getState().setFlash({ tone: "error", text: "保存失败：磁盘只读" });
    });
    // 同 (tone,text) 去重：仍 1 条，事件序列 emit→refresh。
    expect(document.querySelectorAll(".ef-toast")).toHaveLength(1);
    expect(events.map((e) => e.action)).toEqual(["emit", "refresh"]);
    act(() => {
      useField.getState().setFlash({ tone: "ok", text: "第二条通知" });
    });
    expect(document.querySelectorAll(".ef-toast")).toHaveLength(2);
    act(() => {
      useField.getState().setFlash(null);
    });
    expect(document.querySelector(".ef-toast-stack")).toBeNull();
    expect(useField.getState().flash).toBeNull();
    // 清空 = 逐条记关闭。
    expect(events.filter((e) => e.action === "dismiss")).toHaveLength(2);
  });
});

describe("任务节点通知触达（runMineruBatch → setFlash → notify → DOM）", () => {
  beforeEach(() => {
    useField.setState(useField.getInitialState(), true);
    vi.mocked(repo.getPaper).mockReset();
  });

  it("解析批次成功完成：host.flash 的完成文案以 error→alert 之外的 status 通知弹到界面", async () => {
    const paper = {
      id: "p-audit",
      pdfPath: "/papers/a.pdf",
      mineruStatus: null,
      parsedMarkdown: "",
      llmPreparedAt: null,
    } as PaperDetail;
    vi.mocked(repo.getPaper).mockResolvedValue(paper);
    render(<Toasts />);
    // 与 store.ts 的 mineruHost().flash 完全同构的接线：任务层只认 host.flash。
    const host = {
      mineru: () => ({ ...DEFAULT_MINERU, configured: true }),
      hasKey: () => true,
      refresh: async () => undefined,
      flash: (tone: "ok" | "warn" | "error", text: string) =>
        useField.getState().setFlash({ tone, text }),
      prepare: async () => undefined,
    };
    await act(async () => {
      await runMineruBatch(host, ["p-audit"], false);
    });
    const row = await screen.findByText("MinerU 解析完成 1 篇。阅读状态未改动。");
    expect(row.closest(".ef-toast")).not.toBeNull();
    expect(row.closest(".ef-toast")!.getAttribute("role")).toBe("status");
    expect(events.at(-1)).toMatchObject({ action: "emit", tone: "ok" });
  });

  it("批次熔断：连续失败触发的 error 文案以 alert 语义弹到界面", async () => {
    // 无 PDF 的论文直接返回 skip 不计失败；用「提交即失败」制造连续失败：mineruSubmit 抛错 ×3 后熔断。
    const { mineruSubmit } = await import("../lib/mineru");
    vi.mocked(mineruSubmit).mockRejectedValue(new Error("源不可用"));
    const papers = ["f1", "f2", "f3", "f4"].map(
      (id) =>
        ({
          id,
          pdfPath: `/papers/${id}.pdf`,
          mineruStatus: null,
          parsedMarkdown: "",
          llmPreparedAt: null,
        }) as PaperDetail,
    );
    const byId = new Map(papers.map((p) => [p.id, p]));
    vi.mocked(repo.getPaper).mockImplementation(async (id: string) => byId.get(id) ?? null);
    render(<Toasts />);
    const host = {
      mineru: () => ({ ...DEFAULT_MINERU, configured: true }),
      hasKey: () => false,
      refresh: async () => undefined,
      flash: (tone: "ok" | "warn" | "error", text: string) =>
        useField.getState().setFlash({ tone, text }),
      prepare: async () => undefined,
    };
    await act(async () => {
      await runMineruBatch(host, papers.map((p) => p.id), false);
    });
    const row = await screen.findByText(/MinerU 解析连续失败 3 篇，已暂停剩余 1 篇/);
    expect(row.closest(".ef-toast")!.getAttribute("role")).toBe("alert");
    expect(events.at(-1)).toMatchObject({ action: "emit", tone: "error" });
  });
});
