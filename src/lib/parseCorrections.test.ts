import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCorrections,
  clearCorrections,
  getCorrections,
  removeCorrection,
  resetCorrections,
  saveCorrection,
} from "./parseCorrections";

const MD = "# 引言\n\n引言正文。\n\n## 方法\n\n方法正文（有误）。\n\n## 实验\n\n实验正文。\n";

beforeEach(() => {
  resetCorrections();
});

describe("人工校正层", () => {
  it("保存校正 → getCorrections 命中；applyCorrections 替换该小节正文，标题保留", () => {
    saveCorrection({
      paperId: "p1",
      markdown: MD,
      sectionId: "ft-sec-2",
      sectionLabel: "§2 方法",
      note: "表 2 数字错位",
      fixed: "方法正文（已校正）。",
    });
    const record = getCorrections("p1", MD);
    expect(record?.corrections).toHaveLength(1);
    expect(record?.corrections[0]).toMatchObject({ sectionId: "ft-sec-2", note: "表 2 数字错位" });
    const applied = applyCorrections(MD, record);
    expect(applied).toContain("## 方法");
    expect(applied).toContain("方法正文（已校正）。");
    expect(applied).not.toContain("有误");
    // 其他小节不受影响
    expect(applied).toContain("实验正文。");
  });

  it("仅标记有误（fixed 留空）：记录存在但不改写正文", () => {
    saveCorrection({ paperId: "p1", markdown: MD, sectionId: "ft-sec-2", sectionLabel: "§2", note: "公式编号错", fixed: "" });
    const record = getCorrections("p1", MD);
    expect(record?.corrections).toHaveLength(1);
    expect(applyCorrections(MD, record)).toBe(MD);
  });

  it("重新解析后全文变化：旧校正自动作废（返回 null）", () => {
    saveCorrection({ paperId: "p1", markdown: MD, sectionId: "ft-sec-2", sectionLabel: "§2", note: "n", fixed: "f" });
    expect(getCorrections("p1", MD)).not.toBeNull();
    expect(getCorrections("p1", `${MD}\n\n新解析多出的一段。`)).toBeNull();
  });

  it("同小节重复保存覆盖旧校正；删除单条与放弃全部", () => {
    saveCorrection({ paperId: "p1", markdown: MD, sectionId: "ft-sec-2", sectionLabel: "§2", note: "a", fixed: "a1" });
    saveCorrection({ paperId: "p1", markdown: MD, sectionId: "ft-sec-2", sectionLabel: "§2", note: "b", fixed: "b1" });
    expect(getCorrections("p1", MD)?.corrections).toHaveLength(1);
    removeCorrection("p1", "ft-sec-2");
    expect(getCorrections("p1", MD)).toBeNull();
    saveCorrection({ paperId: "p1", markdown: MD, sectionId: "ft-sec-2", sectionLabel: "§2", note: "c", fixed: "c1" });
    clearCorrections("p1");
    expect(getCorrections("p1", MD)).toBeNull();
  });

  it("不同论文互不影响", () => {
    saveCorrection({ paperId: "p1", markdown: MD, sectionId: "ft-sec-1", sectionLabel: "§1", note: "n", fixed: "f" });
    expect(getCorrections("p2", MD)).toBeNull();
  });
});
