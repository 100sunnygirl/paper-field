import type { Domain, NoteKind, PaperDetail } from "./types";
import { NOTE_LABELS, NOTE_KINDS } from "./types";
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

  const notes = NOTE_KINDS.map((kind: NoteKind) => {
    const block = paper.notes[kind];
    const label = NOTE_LABELS[kind];
    return `## ${label.zh} / ${label.en}\n\n${block.content || "_empty_"}\n`;
  }).join("\n");

  return `# ${paper.title}

${paper.titleZh ? `> ${paper.titleZh}\n` : ""}
- Status: ${paper.readingStatus}${paper.readAt ? ` (${paper.readAt})` : ""}
- Year: ${paper.year ?? "—"}
- Venue: ${paper.venue ?? "—"}
- DOI: ${paper.doi ?? "—"}
- arXiv: ${paper.arxivId ?? "—"}
- Open source: ${paper.codeOpenSource}
- PDF: ${paper.pdfUrl ?? "—"}
- Code: ${paper.codeUrl ?? "—"}
- Project: ${paper.projectPage ?? "—"}
- Tags: ${paper.tags.join(", ") || "—"}

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
  const index = `# ${domain.name} / ${domain.code}

${domain.summary ?? ""}

${papers
  .map(
    (paper, i) =>
      `${i + 1}. [${paper.title}](./${slug(`${paper.year ?? "n"}-${paper.title}`)}.md) — ${paper.readingStatus}`,
  )
  .join("\n")}
`;
  const files: ExportFile[] = [{ relativePath: `${folder}/README.md`, content: index }];
  for (const paper of papers) {
    files.push({
      relativePath: `${folder}/${slug(`${paper.year ?? "n"}-${paper.title}`)}.md`,
      content: paperMarkdown(paper),
    });
  }
  return files;
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(domain.code)}-export.md`;
  a.click();
  URL.revokeObjectURL(url);
  return "download";
}
