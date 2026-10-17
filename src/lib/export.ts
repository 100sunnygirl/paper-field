import type { Domain, NoteKind, PaperDetail } from "./types";
import { NOTE_LABELS, NOTE_DISPLAY_ORDER, noteSourceLabel } from "./types";
import { isTauri } from "./util";

function paperMarkdown(paper: PaperDetail): string {
  const authors = paper.authors
    .map((author, index) => {
      const bits = [`${index + 1}. ${author.name}`];
      if (author.affiliation) bits.push(author.affiliation);
      if (author.lab) bits.push(author.lab);
      if (author.isCorresponding) bits.push("corresponding");
      return bits.join(" — ");
    })
    .join("\n");

  const labs = paper.labs.map((lab) => `${lab.name} (${lab.institution})`).join("; ");

  const notes = NOTE_DISPLAY_ORDER.map((kind: NoteKind) => {
    const block = paper.notes[kind];
    const label = NOTE_LABELS[kind];
    return `## ${label.zh} / ${label.en} · ${noteSourceLabel(block)}\n\n${block.content || "_empty_"}\n`;
  }).join("\n");

  return `# ${paper.title}

${paper.titleZh ? `> ${paper.titleZh}\n` : ""}
- Status: ${paper.readingStatus}${paper.readAt ? ` (${paper.readAt})` : ""}
- Year: ${paper.year ?? "—"}
- Venue: ${paper.venue ?? "—"}
- DOI: ${paper.doi ?? "—"}
- arXiv: ${paper.arxivId ?? "—"}
- Open source: ${paper.codeOpenSource}
- PDF: ${paper.pdfPath ?? paper.pdfUrl ?? "—"}
- Code: ${paper.codeUrl ?? "—"}
- Project: ${paper.projectPage ?? "—"}
- Tags: ${paper.tags.join(", ") || "—"}
- Labs: ${labs || "—"}

## Authors

${authors || "_none_"}

## Abstract

${paper.abstract || "_none_"}

${notes}
`;
}

function slug(value: string): string {
  return value
    .replace(/[^\w\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "paper";
}

export interface ExportFile {
  relativePath: string;
  content: string;
}

/** Local-time `YYYYMMDD-HHmmss`, so each export lands in a fresh folder. */
export function exportStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export function buildDomainExport(domain: Domain, papers: PaperDetail[], now: Date = new Date()): ExportFile[] {
  // Fixed folder names made a second export overwrite the first one, including
  // any edits the user made to those files; a timestamp suffix never collides.
  const folder = `${slug(domain.code || domain.name)}-${exportStamp(now)}`;
  // 同年同标题的论文会生成相同 slug 互相覆盖；先统一分配唯一文件名，
  // README 索引与实际文件都使用这份分配结果。
  const used = new Set<string>();
  const fileNames = papers.map((paper) => {
    const base = slug(`${paper.year ?? "n"}-${paper.title}`);
    let name = base;
    if (used.has(name)) name = `${base}-${paper.id.slice(0, 4).toLowerCase()}`;
    let n = 2;
    while (used.has(name)) {
      name = `${base}-${paper.id.slice(0, 4).toLowerCase()}-${n}`;
      n += 1;
    }
    used.add(name);
    return `${name}.md`;
  });
  const index = `# ${domain.name} / ${domain.code}

${domain.summary ?? ""}

${papers
  .map(
    (paper, i) =>
      `${i + 1}. [${paper.title}](./${fileNames[i]}) — ${paper.readingStatus}`,
  )
  .join("\n")}
`;
  const files: ExportFile[] = [{ relativePath: `${folder}/README.md`, content: index }];
  papers.forEach((paper, i) => {
    files.push({
      relativePath: `${folder}/${fileNames[i]}`,
      content: paperMarkdown(paper),
    });
  });
  return files;
}

/** Browser download name. Shown in the success toast instead of the word "download". */
export function browserExportFilename(domain: Pick<Domain, "code" | "name">): string {
  const base = slug(domain.code || domain.name).toLowerCase();
  return `${base}-export.md`;
}

export async function exportDomain(domain: Domain, papers: PaperDetail[]): Promise<string> {
  const files = buildDomainExport(domain, papers);
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    // 选择文件夹的对话框由 Rust 侧弹出，导出根目录只来自系统对话框。
    const dir = await invoke<string | null>("export_files", { files });
    if (!dir) throw new Error("EXPORT_CANCELLED");
    return dir;
  }

  const blob = new Blob(
    [
      files
        .map((file) => `--- ${file.relativePath} ---\n${file.content}`)
        .join("\n\n"),
    ],
    { type: "text/markdown;charset=utf-8" },
  );
  const filename = browserExportFilename(domain);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}
