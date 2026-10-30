import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperListItem } from "../lib/types";
import { useField } from "../store";
import { PaperMatrix, titleStillFromFile } from "./PaperMatrix";

function item(overrides: Partial<PaperListItem> = {}): PaperListItem {
  return {
    id: "p-1",
    domainId: "d-1",
    title: "1706.03762 attention is all you need",
    titleZh: null,
    abstract: "",
    year: null,
    venue: null,
    doi: null,
    arxivId: null,
    pdfUrl: null,
    pdfPath: "/papers/a.pdf",
    codeUrl: null,
    codeOpenSource: "unknown",
    projectPage: null,
    readingStatus: "unread",
    readAt: null,
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: false,
    userMetaTouched: false,
    fieldSources: { title: "file" },
    mineruStatus: null,
    mineruParseId: null,
    mineruDocRef: null,
    mineruError: null,
    mineruParseIds: [],
    mineruProvider: null,
    mineruCredFingerprint: null,
    tags: [],
    labs: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    firstAuthor: null,
    authorCount: 0,
    domainName: "多模态",
    domainCode: "MM-01",
    ...overrides,
  };
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

describe("titleStillFromFile", () => {
  it("只认 title 来源为 file 的论文", () => {
    expect(titleStillFromFile({ title: "file" })).toBe(true);
    expect(titleStillFromFile({ title: "api" })).toBe(false);
    expect(titleStillFromFile({ title: "user" })).toBe(false);
    expect(titleStillFromFile(undefined)).toBe(false);
  });
});

describe("PaperRow · 标题待确认徽标", () => {
  it("标题来源为文件名的行显示徽标，点击打开编辑论文信息", () => {
    render(
      <PaperMatrix papers={[item()]} selectedId={null} onSelect={() => undefined} />,
    );
    const badge = screen.getByRole("button", { name: "标题待确认" });
    expect(badge).toBeInTheDocument();
    fireEvent.click(badge);
    expect(useField.getState().dialog).toBe("edit-paper");
    expect(useField.getState().dialogPaperId).toBe("p-1");
  });

  it("文献库或用户改过标题的行不再显示徽标；点徽标不触发行选中", () => {
    const onSelect = vi.fn();
    render(
      <PaperMatrix
        papers={[item({ fieldSources: { title: "api" } })]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.queryByRole("button", { name: "标题待确认" })).toBeNull();

    render(
      <PaperMatrix papers={[item()]} selectedId={null} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "标题待确认" }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
