import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindingConflicts,
  bindingLabel,
  currentKeymap,
  DEFAULT_KEYMAP,
  eventMatchesBinding,
  loadKeymap,
  resetKeymap,
  saveKeyBinding,
} from "./keymap";

beforeEach(() => {
  localStorage.clear();
  resetKeymap();
});

afterEach(() => {
  resetKeymap();
});

describe("keymap · 默认与持久化", () => {
  it("默认键位与历史行为一致（⌘/Ctrl + N/R/K/J，笔记保存为 ⌘S）", () => {
    expect(loadKeymap()).toEqual(DEFAULT_KEYMAP);
    expect(DEFAULT_KEYMAP).toEqual({
      addPaper: { key: "n", meta: true },
      markRead: { key: "r", meta: true },
      search: { key: "k", meta: true },
      jobsPanel: { key: "j", meta: true },
      saveNote: { key: "s", meta: true },
    });
  });

  it("保存自定义键位后写入 localStorage，重新读取生效", () => {
    expect(saveKeyBinding("markRead", { key: "m", meta: true }).ok).toBe(true);
    expect(currentKeymap().markRead).toEqual({ key: "m", meta: true });
    expect(JSON.parse(localStorage.getItem("paper-field.keymap")!).markRead).toEqual({ key: "m", meta: true });
    // 模块内当前值与重新加载一致
    expect(loadKeymap().markRead).toEqual({ key: "m", meta: true });
  });

  it("resetKeymap 恢复默认并清掉存储", () => {
    saveKeyBinding("search", { key: "f", meta: true });
    resetKeymap();
    expect(currentKeymap()).toEqual(DEFAULT_KEYMAP);
    expect(localStorage.getItem("paper-field.keymap")).toBeNull();
  });

  it("坏数据 / 非法键位回落默认", () => {
    localStorage.setItem("paper-field.keymap", "not-json");
    expect(loadKeymap()).toEqual(DEFAULT_KEYMAP);
    localStorage.setItem("paper-field.keymap", JSON.stringify({ markRead: { key: "!!!", meta: true } }));
    expect(loadKeymap().markRead).toEqual(DEFAULT_KEYMAP.markRead);
    // 不带修饰键的组合拒绝保存
    const result = saveKeyBinding("search", { key: "f", meta: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("⌘/Ctrl");
  });
});

describe("keymap · 冲突检测", () => {
  it("同一组合被其他动作占用时拒绝并指出占用者", () => {
    const result = saveKeyBinding("markRead", { key: "n", meta: true });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe("addPaper");
    expect(currentKeymap().markRead).toEqual(DEFAULT_KEYMAP.markRead);
  });

  it("bindingConflicts 不把动作自身算作冲突", () => {
    expect(bindingConflicts(DEFAULT_KEYMAP, "search", { key: "k", meta: true })).toBeNull();
    expect(bindingConflicts(DEFAULT_KEYMAP, "search", { key: "j", meta: true })).toBe("jobsPanel");
  });

  it("笔记保存键参与冲突检测：改绑到 ⌘K 被搜索占用拒绝", () => {
    const result = saveKeyBinding("saveNote", { key: "k", meta: true });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe("search");
    expect(currentKeymap().saveNote).toEqual(DEFAULT_KEYMAP.saveNote);
  });
});

describe("keymap · 事件匹配与文案", () => {
  it("⌘ 与 Ctrl 等价，键不区分大小写", () => {
    expect(eventMatchesBinding({ metaKey: true, ctrlKey: false, key: "R" }, DEFAULT_KEYMAP.markRead)).toBe(true);
    expect(eventMatchesBinding({ metaKey: false, ctrlKey: true, key: "r" }, DEFAULT_KEYMAP.markRead)).toBe(true);
    expect(eventMatchesBinding({ metaKey: false, ctrlKey: false, key: "r" }, DEFAULT_KEYMAP.markRead)).toBe(false);
    expect(eventMatchesBinding({ metaKey: true, ctrlKey: false, key: "n" }, DEFAULT_KEYMAP.markRead)).toBe(false);
  });

  it("bindingLabel 展示为「⌘ N」样式", () => {
    expect(bindingLabel({ key: "n", meta: true })).toMatch(/N$/);
    expect(bindingLabel({ key: "n", meta: true })).toMatch(/[⌘C]/);
  });
});
