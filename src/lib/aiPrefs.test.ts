import { beforeEach, describe, expect, it } from "vitest";
import { loadTaskPrimary, saveTaskPrimary, taskChainFor } from "./aiPrefs";

beforeEach(() => {
  localStorage.removeItem("paper-field.task-primary.meta");
  localStorage.removeItem("paper-field.task-primary.notes");
});


describe("任务首选模型（本机偏好）", () => {
  it("保存/读取 per-task 首选；置 null 恢复跟随全局", () => {
    saveTaskPrimary("meta", "p1");
    saveTaskPrimary("notes", "p2");
    expect(loadTaskPrimary("meta")).toBe("p1");
    expect(loadTaskPrimary("notes")).toBe("p2");
    saveTaskPrimary("meta", null);
    expect(loadTaskPrimary("meta")).toBeNull();
    saveTaskPrimary("notes", null);
  });

  it("taskChainFor：首选置顶、其余按全局顺序；未设置返回 null", () => {
    saveTaskPrimary("meta", "b");
    const providers = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(taskChainFor("meta", providers)).toEqual(["b", "a", "c"]);
    expect(taskChainFor("notes", providers)).toBeNull();
    saveTaskPrimary("meta", null);
    expect(taskChainFor("meta", providers)).toBeNull();
  });

  it("首选 id 不在可用列表里时返回 null（不产生空链）", () => {
    saveTaskPrimary("notes", "gone");
    expect(taskChainFor("notes", [{ id: "a" }])).toBeNull();
    saveTaskPrimary("notes", null);
  });
});
