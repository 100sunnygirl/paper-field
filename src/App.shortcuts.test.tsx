import { act } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { menuHandlers } = vi.hoisted(() => ({
  menuHandlers: {} as Record<string, (event: { payload: string }) => void>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: string }) => void) => {
    menuHandlers[name] = cb;
    return Promise.resolve(() => {
      delete menuHandlers[name];
    });
  },
}));

vi.mock("./lib/repo", () => ({
  repo: {
    init: vi.fn(async () => undefined),
    setReadingStatus: vi.fn(async () => undefined),
    getPaper: vi.fn(async () => null),
    getDomain: vi.fn(async () => null),
    stats: vi.fn(async () => ({ read: 0, total: 0, openSource: 0, queued: 0, running: 0 })),
    listJobs: vi.fn(async () => []),
    listDomains: vi.fn(async () => []),
    listPapers: vi.fn(async () => []),
    listArchive: vi.fn(async () => []),
    listIntake: vi.fn(async () => []),
    listPendingMineru: vi.fn(async () => []),
    searchAll: vi.fn(async () => []),
  },
}));

import App from "./App";
import { repo } from "./lib/repo";
import { useField } from "./store";

async function readyApp() {
  render(<App />);
  await waitFor(() => expect(useField.getState().ready).toBe(true));
  act(() => {
    useField.setState({ selectedPaperId: "p-1", dialog: null });
  });
  vi.mocked(repo.setReadingStatus).mockClear();
}

function pressRead(target: Element, mod: "meta" | "ctrl") {
  return fireEvent.keyDown(target, {
    key: "r",
    metaKey: mod === "meta",
    ctrlKey: mod === "ctrl",
    bubbles: true,
    cancelable: true,
  });
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  for (const key of Object.keys(menuHandlers)) delete menuHandlers[key];
});

describe("requestMarkRead", () => {
  it("does not mark read from a textarea, a dialog, or contenteditable", async () => {
    await readyApp();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    expect(pressRead(textarea, "meta")).toBe(true);
    expect(pressRead(textarea, "ctrl")).toBe(true);

    textarea.blur();
    act(() => useField.setState({ dialog: "paper" }));
    expect(pressRead(document.body, "meta")).toBe(true);
    expect(pressRead(document.body, "ctrl")).toBe(true);

    act(() => useField.setState({ dialog: null }));
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    document.body.appendChild(editable);
    editable.focus();
    expect(pressRead(editable, "meta")).toBe(true);
    expect(pressRead(editable, "ctrl")).toBe(true);

    expect(repo.setReadingStatus).not.toHaveBeenCalled();
  });

  it("does not mark read from an input or a select", async () => {
    await readyApp();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(pressRead(input, "meta")).toBe(true);
    const select = document.createElement("select");
    document.body.appendChild(select);
    select.focus();
    expect(pressRead(select, "ctrl")).toBe(true);
    expect(repo.setReadingStatus).not.toHaveBeenCalled();
  });

  it("menu mark-read does not write while an input is focused", async () => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    await readyApp();
    await waitFor(() => expect(menuHandlers["menu://action"]).toBeTypeOf("function"));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    act(() => menuHandlers["menu://action"]({ payload: "mark-read" }));
    expect(repo.setReadingStatus).not.toHaveBeenCalled();
  });

  it("does not preventDefault or mark read when no paper is selected", async () => {
    await readyApp();
    act(() => useField.setState({ selectedPaperId: null }));
    (document.body as HTMLElement).focus();
    expect(pressRead(document.body, "meta")).toBe(true);
    expect(pressRead(document.body, "ctrl")).toBe(true);
    expect(repo.setReadingStatus).not.toHaveBeenCalled();
  });

  it("marks the selected paper read from the body", async () => {
    await readyApp();
    (document.body as HTMLElement).focus();
    expect(pressRead(document.body, "meta")).toBe(false);
    await waitFor(() => expect(repo.setReadingStatus).toHaveBeenCalledWith("p-1", "read"));
  });
});
