import { beforeEach, describe, expect, it } from "vitest";
import { READ_NEXT_LIMIT, readNextAdd, readNextList, readNextMove, readNextRemove } from "./readNext";

beforeEach(() => {
  localStorage.removeItem("paper-field.read-next");
});

describe("readNext · 接下来读短队列（本机）", () => {
  it("加入去重（已存在保持原位）、移除、清空后为空数组", () => {
    expect(readNextList()).toEqual([]);
    readNextAdd("a");
    readNextAdd("b");
    readNextAdd("a");
    expect(readNextList()).toEqual(["a", "b"]);
    readNextRemove("b");
    expect(readNextList()).toEqual(["a"]);
    readNextRemove("a");
    expect(readNextList()).toEqual([]);
  });

  it("置顶 / 上移 / 下移调整顺序；非法移动原样返回", () => {
    readNextAdd("a");
    readNextAdd("b");
    readNextAdd("c");
    expect(readNextMove("c", "top")).toEqual(["c", "a", "b"]);
    expect(readNextMove("c", "down")).toEqual(["a", "c", "b"]);
    expect(readNextMove("c", "up")).toEqual(["c", "a", "b"]);
    // c 已在顶：再上移无效。
    expect(readNextMove("c", "up")).toEqual(["c", "a", "b"]);
    expect(readNextMove("missing", "up")).toEqual(["c", "a", "b"]);
    expect(readNextMove("a", "up")).toEqual(["a", "c", "b"]);
  });

  it(`上限 ${READ_NEXT_LIMIT}：超出裁最旧`, () => {
    for (let i = 0; i < READ_NEXT_LIMIT + 3; i += 1) readNextAdd(`p${i}`);
    const ids = readNextList();
    expect(ids).toHaveLength(READ_NEXT_LIMIT);
    expect(ids[0]).toBe("p3");
    expect(ids[ids.length - 1]).toBe(`p${READ_NEXT_LIMIT + 2}`);
  });

  it("坏数据容错：非数组 / 非字符串元素被丢弃", () => {
    localStorage.setItem("paper-field.read-next", JSON.stringify(["a", 3, null, "b"]));
    expect(readNextList()).toEqual(["a", "b"]);
    localStorage.setItem("paper-field.read-next", "{oops");
    expect(readNextList()).toEqual([]);
  });
});
