import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEngine, type TestEngineHandle } from "./test/helpers";
import type { SqlEngine } from "./lib/engine";
import { repo } from "./lib/repo";
import { useField } from "./store";

const holder = vi.hoisted(() => ({ engine: null as SqlEngine | null }));
vi.mock("./lib/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/engine")>()),
  getEngine: () => Promise.resolve(holder.engine!),
}));

let handle: TestEngineHandle;
let domainId: string;
let paperId: string;

beforeEach(async () => {
  handle = await makeTestEngine();
  holder.engine = handle.engine;
  domainId = (await repo.createDomain({ name: "多模态", code: "MM-01" })).id;
  paperId = (await repo.createPaper({ domainId, title: "visual-instruction-tuning.pdf" })).id;
  useField.setState(useField.getInitialState(), true);
  useField.setState({
    selectedDomainId: domainId,
    selectedPaperId: paperId,
    paper: await repo.getPaper(paperId),
    dialog: "move-paper",
    dialogPaperId: paperId,
  });
});

afterEach(() => {
  handle.close();
});

describe("reading holds on the store", () => {
  it("saves every open draft once, including an empty string that does not write", async () => {
    const updateNote = vi.spyOn(repo, "updateNote");
    useField.getState().setNoteDraft(paperId, "summary", "");
    useField.getState().setNoteDraft(paperId, "highlights", "要点");
    await useField.getState().saveOpenDrafts(paperId);
    const paper = (await repo.getPaper(paperId))!;
    expect(paper.notes.summary.userEdited).toBe(false);
    expect(paper.notes.summary.content).toBe("");
    expect(paper.notes.highlights.content).toBe("要点");
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateNote).toHaveBeenCalledWith(paperId, "highlights", "要点", "manual", true);
    expect(useField.getState().drafts[paperId]).toBeUndefined();
    expect(useField.getState().flash?.text).toBe("笔记已保存。");
    updateNote.mockRestore();
  });

  it("keeps a failed draft and still saves the other block in one toast", async () => {
    const real = repo.updateNote.bind(repo);
    const updateNote = vi.spyOn(repo, "updateNote").mockImplementation(async (id, kind, content, source, edited) => {
      if (kind === "summary") throw new Error("写库失败");
      return real(id, kind, content, source, edited);
    });
    useField.getState().setNoteDraft(paperId, "summary", "没写上");
    useField.getState().setNoteDraft(paperId, "highlights", "要点");
    await useField.getState().saveOpenDrafts(paperId);
    updateNote.mockRestore();
    const paper = (await repo.getPaper(paperId))!;
    expect(paper.notes.highlights.content).toBe("要点");
    expect(paper.notes.summary.content).toBe("");
    expect(useField.getState().drafts[paperId]?.summary).toBe("没写上");
    expect(useField.getState().drafts[paperId]?.highlights).toBeUndefined();
    expect(useField.getState().flash?.text).toContain("总结");
    expect(useField.getState().flash?.text).toContain("草稿仍保留");
  });

  it("does not latch a note when the text did not change", async () => {
    await useField.getState().saveNote(paperId, "summary", "");
    const paper = (await repo.getPaper(paperId))!;
    expect(paper.notes.summary.userEdited).toBe(false);
    expect(paper.userNotesTouched).toBe(false);
    expect(paper.notes.summary.rev ?? 0).toBe(0);
  });

  it("creates a domain and moves the locked paper into it", async () => {
    await useField.getState().createDomainAndMove("对齐");
    const paper = (await repo.getPaper(paperId))!;
    const domains = await repo.listDomains();
    const created = domains.find((domain) => domain.name === "对齐");
    expect(created).toBeTruthy();
    expect(paper.domainId).toBe(created!.id);
    expect(useField.getState().selectedPaperId).toBe(paperId);
    expect(useField.getState().dialog).toBeNull();
  });

  it("undoes an accidental mark-read back to unread", async () => {
    useField.setState({ dialog: null, dialogPaperId: null });
    await useField.getState().markRead(paperId);
    expect((await repo.getPaper(paperId))!.readingStatus).toBe("read");
    const gen = useField.getState().pendingReadingUndo?.gen;
    expect(gen).toBeTypeOf("number");
    await useField.getState().undoMarkRead(gen!);
    const paper = (await repo.getPaper(paperId))!;
    expect(paper.readingStatus).toBe("unread");
    expect(paper.readAt).toBeNull();
  });

  it("restores a null stamp when 在读 was marked read", async () => {
    await repo.setReadingStatus(paperId, "reading");
    useField.setState({ dialog: null, dialogPaperId: null, paper: await repo.getPaper(paperId) });
    await useField.getState().markRead(paperId);
    expect((await repo.getPaper(paperId))!.readAt).not.toBeNull();
    await useField.getState().undoMarkRead(useField.getState().pendingReadingUndo!.gen);
    const paper = (await repo.getPaper(paperId))!;
    expect(paper.readingStatus).toBe("reading");
    expect(paper.readAt).toBeNull();
  });
});
