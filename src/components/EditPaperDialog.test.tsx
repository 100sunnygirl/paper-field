import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repo } from "../lib/repo";
import { useField } from "../store";
import type { NoteKind, PaperDetail } from "../lib/types";
import { ConfirmMetaDialog, EditPaperDialog } from "./Dialogs";

function noteBlock(paperId: string, kind: NoteKind, content = ""): PaperDetail["notes"][NoteKind] {
  return { id: `n-${kind}`, paperId, kind, content, source: "manual", userEdited: false, revisedAt: null };
}

function fakeDetail(overrides: Partial<PaperDetail> = {}): PaperDetail {
  const id = "paper-1";
  return {
    id,
    domainId: "d-1",
    title: "Visual Instruction Tuning",
    titleZh: "视觉指令微调",
    abstract: "abstract text",
    year: 2023,
    venue: "NeurIPS",
    doi: "10.4/x",
    arxivId: "2304.08485",
    pdfUrl: "https://arxiv.org/pdf/2304.08485",
    pdfPath: "/local/llava.pdf",
    codeUrl: "https://github.com/haotian-liu/LLaVA",
    codeOpenSource: "open",
    projectPage: null,
    readingStatus: "reading",
    readAt: null,
    llmPreparedAt: null,
    notesDraftedByLlm: false,
    userNotesTouched: false,
    userMetaTouched: false,
    mineruStatus: null,
    mineruParseId: null,
    mineruDocRef: null,
    mineruError: null,
    mineruParseIds: [],
    mineruProvider: null,
    mineruCredFingerprint: null,
    tags: ["llava"],
    labs: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    authors: [
      {
        id: "au-1",
        name: "Haotian Liu",
        nameZh: null,
        affiliation: "UW-Madison",
        lab: "Liu Lab",
        homepage: null,
        orcid: null,
        order: 0,
        isCorresponding: true,
      },
    ],
    notes: {
      remarks: noteBlock(id, "remarks"),
      summary: noteBlock(id, "summary"),
      highlights: noteBlock(id, "highlights"),
      weaknesses: noteBlock(id, "weaknesses"),
      implications: noteBlock(id, "implications"),
    },
    domain: { id: "d-1", name: "多模态", code: "MM-01", summary: null, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z" },
    parsedMarkdown: "",
    ...overrides,
  };
}

function openWith(paper: PaperDetail) {
  useField.setState({
    dialog: "edit-paper",
    paper,
    selectedPaperId: paper.id,
    savePaperPatch: vi.fn(async (_patch: Parameters<typeof repo.updatePaper>[1]) => undefined),
    saveAuthors: vi.fn(async (_authors: PaperDetail["authors"]) => undefined),
  });
}

function backdropOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".ef-backdrop");
  expect(el).not.toBeNull();
  return el!;
}

beforeEach(() => {
  useField.setState(useField.getInitialState(), true);
});

afterEach(() => {
  window.removeEventListener("keydown", noopWindowKeydown);
});

let noopWindowKeydown = () => {};

describe("EditPaperDialog · 年份校验（F9：NaN 不落库）", () => {
  it('年份输入 "abc" 显示行内错误并禁用保存', () => {
    openWith(fakeDetail());
    render(<EditPaperDialog />);
    const year = screen.getByLabelText("年份");
    fireEvent.change(year, { target: { value: "abc" } });
    expect(year).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/年份需为数字，例如 2024。当前输入不会被保存。/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存论文信息" })).toBeDisabled();
  });

  it('改回 "2024" 后可保存且提交数字年份', async () => {
    const detail = fakeDetail();
    openWith(detail);
    render(<EditPaperDialog />);
    const year = screen.getByLabelText("年份");
    fireEvent.change(year, { target: { value: "abc" } });
    fireEvent.change(year, { target: { value: "2024" } });
    expect(screen.queryByText(/年份需为数字/)).toBeNull();
    const save = screen.getByRole("button", { name: "保存论文信息" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(useField.getState().savePaperPatch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(useField.getState().savePaperPatch).mock.calls[0]![0]).toMatchObject({ year: 2024 });
  });

  it("年份清空保存为 null（允许留空）", async () => {
    openWith(fakeDetail());
    render(<EditPaperDialog />);
    fireEvent.change(screen.getByLabelText("年份"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存论文信息" }));
    await waitFor(() => expect(useField.getState().savePaperPatch).toHaveBeenCalled());
    expect(vi.mocked(useField.getState().savePaperPatch).mock.calls[0]![0]).toMatchObject({ year: null });
  });
});

describe("EditPaperDialog · dirty 关闭否决（F8）", () => {
  it("dirty 时点击 backdrop 不关闭并出现 warn 提示；第二次点击放行", async () => {
    openWith(fakeDetail());
    const { container } = render(<EditPaperDialog />);
    // 制造 dirty：修改英文标题
    fireEvent.change(screen.getByLabelText("英文标题"), { target: { value: "Changed Title" } });

    fireEvent.mouseDown(backdropOf(container));
    expect(useField.getState().dialog).toBe("edit-paper");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useField.getState().flash).toMatchObject({
      tone: "warn",
      text: "论文信息尚未保存。点击「保存论文信息」保存，或再按一次 Esc 放弃修改。",
    });

    fireEvent.mouseDown(backdropOf(container));
    await waitFor(() => expect(useField.getState().dialog).toBeNull());
  });

  it("非 dirty 时点击 backdrop 直接关闭", async () => {
    openWith(fakeDetail());
    const { container } = render(<EditPaperDialog />);
    fireEvent.mouseDown(backdropOf(container));
    await waitFor(() => expect(useField.getState().dialog).toBeNull());
  });

  it("dirty 时 Esc 不关闭、不穿透 App 级关闭；第二次 Esc 放行", async () => {
    openWith(fakeDetail());
    const { container } = render(<EditPaperDialog />);
    fireEvent.change(screen.getByLabelText("英文标题"), { target: { value: "Changed Title" } });

    // 模拟 App.tsx:61-66 的 window 级无条件 closeDialog：若否决分支丢失
    // stopPropagation，这里会被触发导致对话框被外部关闭。
    const appLevelClose = vi.fn();
    window.addEventListener("keydown", appLevelClose);
    try {
      fireEvent.keyDown(document, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", appLevelClose);
    }

    expect(appLevelClose).not.toHaveBeenCalled();
    expect(useField.getState().dialog).toBe("edit-paper");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useField.getState().flash).toMatchObject({ tone: "warn" });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(useField.getState().dialog).toBeNull());
  });

  it("非 dirty 时一次 Esc 即关闭", async () => {
    openWith(fakeDetail());
    render(<EditPaperDialog />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(useField.getState().dialog).toBeNull());
  });

  it("保存后 dirty 解除：Esc 一次即关闭（不再否决）", async () => {
    const detail = fakeDetail();
    const savePaperPatch = vi.fn(async (_patch: Parameters<typeof repo.updatePaper>[1]) => undefined);
    // 模拟保存成功后 store.refresh 带回新 paper 的闭环。
    useField.setState({ dialog: "edit-paper", paper: detail, selectedPaperId: detail.id, savePaperPatch });
    render(<EditPaperDialog />);
    fireEvent.change(screen.getByLabelText("英文标题"), { target: { value: "Saved Title" } });
    fireEvent.click(screen.getByRole("button", { name: "保存论文信息" }));
    await waitFor(() => expect(savePaperPatch).toHaveBeenCalledTimes(1));
    // store 层保存后 paper 未变（mock 未刷新），组件仍 dirty —— 由第二次放行语义关闭。
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useField.getState().dialog).toBe("edit-paper");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(useField.getState().dialog).toBeNull());
  });
});

describe("EditPaperDialog · 作者编辑", () => {
  it("展示作者与机构，进入编辑可改机构并保存", async () => {
    const detail = fakeDetail();
    openWith(detail);
    render(<EditPaperDialog />);
    expect(screen.getByText(/Haotian Liu · 通讯/)).toBeInTheDocument();
    expect(screen.getByText(/UW-Madison \/ Liu Lab/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编辑作者" }));
    const inputs = screen.getAllByLabelText("机构");
    fireEvent.change(inputs[0], { target: { value: "MIT" } });
    fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
    await waitFor(() => expect(useField.getState().saveAuthors).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(useField.getState().saveAuthors).mock.calls[0]![0];
    expect(saved[0].affiliation).toBe("MIT");
  });
});

describe("ConfirmMetaDialog · 覆盖顺序", () => {
  it("说明文献库先写、模型只补仍空字段", () => {
    useField.setState({ dialog: "confirm-meta", paper: fakeDetail(), selectedPaperId: "paper-1" });
    render(<ConfirmMetaDialog />);
    expect(screen.getByRole("dialog").textContent).toContain("文献库先写、模型只补仍空字段");
  });
});

describe("EditPaperDialog · 按打开快照保存（M7）", () => {
  it("只改标题时，后台补上的摘要不进入保存载荷", async () => {
    const detail = fakeDetail({ abstract: "", fieldSources: {} });
    openWith(detail);
    render(<EditPaperDialog />);
    fireEvent.change(screen.getByLabelText("英文标题"), { target: { value: "User Title" } });

    act(() => {
      useField.setState({
        paper: { ...detail, abstract: "filled by llm", fieldSources: { abstract: "llm" } },
      });
    });

    expect(screen.getByLabelText("英文标题")).toHaveValue("User Title");
    expect(screen.getByLabelText("摘要")).toHaveValue("filled by llm");
    fireEvent.click(screen.getByRole("button", { name: "保存论文信息" }));
    await waitFor(() => expect(useField.getState().savePaperPatch).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(useField.getState().savePaperPatch).mock.calls[0]![0];
    expect(patch).toEqual({ title: "User Title" });
    expect(patch).not.toHaveProperty("abstract");
    expect(useField.getState().saveAuthors).not.toHaveBeenCalled();
  });

  it("刷新保留已改标题和脏标记，未改的摘要跟随库", async () => {
    const detail = fakeDetail({ abstract: "" });
    openWith(detail);
    const { container } = render(<EditPaperDialog />);
    fireEvent.change(screen.getByLabelText("英文标题"), { target: { value: "Dirty Title" } });

    act(() => {
      useField.setState({
        paper: { ...detail, abstract: "library abstract", updatedAt: "2024-06-01T00:00:00.000Z" },
      });
    });

    expect(screen.getByLabelText("英文标题")).toHaveValue("Dirty Title");
    expect(screen.getByLabelText("摘要")).toHaveValue("library abstract");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useField.getState().dialog).toBe("edit-paper");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useField.getState().flash).toMatchObject({ tone: "warn" });
  });
});
