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

export function buildDomainExport(domain: Domain, papers: PaperDetail[]): ExportFile[] {
  const folder = slug(domain.code || domain.name);
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
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const dir = await open({ directory: true, multiple: false, title: "Export domain markdown" });
    if (!dir || Array.isArray(dir)) throw new Error("EXPORT_CANCELLED");
    await invoke("export_files", { root: dir, files });
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
