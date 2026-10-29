import type { Domain, NoteKind, PaperDetail } from "./types";
import { NOTE_LABELS, NOTE_DISPLAY_ORDER, noteSourceLabel } from "./types";
import { isTauri } from "./util";

/**
 * 导出的 .md 会在 Typora / Obsidian 等编辑器里渲染，元数据来自外部 API 或 AI 补全，
 * 不能按 markdown 原样写入：单行字段压成一行（换行会注入标题 / 列表），
 * 再转义行内 markdown 与 HTML 元字符（链接、强调、原始 HTML 标签）。
 */
function inlineText(value: string | number | null | undefined): string {
  return escapeMarkdown(String(value ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim());
}

function escapeMarkdown(line: string): string {
  return line
    .replace(/[\\`*_[\]<>~]/g, "\\$&")
    // 行首的块级标记（标题、引用、列表、分隔线、表格、代码围栏）
    .replace(/^(\s*)([#>+\-=|]|\d+[.)])/, "$1\\$2");
}

/** 多行纯文本（摘要、领域简介）：保留换行，逐行转义。 */
function blockText(value: string | null | undefined): string {
  return (value ?? "").split(/\r\n?|\n/).map(escapeMarkdown).join("\n");
}

/**
 * 笔记正文本来就是 markdown（手写或 AI 起草），保留其格式；但 AI 草稿可能复述
 * 论文全文里的注入内容，所以中和原始 HTML 标签 / 注释（`<` 前加反斜杠，渲染成字面文本）。
 * 只有顶格的代码围栏内原样保留：开栏判定只认顶格、闭栏判定放宽到缩进 3 格以内
 * 和带尾巴的行，判定偏差只会多转义、不会漏转义。行内代码里的 `<` 也会被转义（显示多一个 `\`），
 * 换来不用猜 code span 的边界。
 */
function neutralizeHtml(markdown: string): string {
  let fence: string | null = null;
  // \r 单独也算换行；统一成 \n，围栏判定与 markdown 的分行一致。
  return markdown
    .split(/\r\n?|\n/)
    .map((line) => {
      if (fence) {
        const close = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
        return line;
      }
      const open = /^(`{3,}|~{3,})(.*)$/.exec(line);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = open[1];
        return line;
      }
      return line.replace(/<(?=[A-Za-z/!?])/g, "\\<");
    })
    .join("\n");
}

/** 只导出库内文件名：本机绝对路径会泄露用户名与目录结构。 */
function fileBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function paperMarkdown(paper: PaperDetail): string {
  const authors = paper.authors
    .map((author, index) => {
      const bits = [`${index + 1}. ${inlineText(author.name)}`];
      if (author.affiliation) bits.push(inlineText(author.affiliation));
      if (author.lab) bits.push(inlineText(author.lab));
      if (author.isCorresponding) bits.push("corresponding");
      return bits.join(" — ");
    })
    .join("\n");

  const labs = paper.labs.map((lab) => `${inlineText(lab.name)} (${inlineText(lab.institution)})`).join("; ");

  const notes = NOTE_DISPLAY_ORDER.map((kind: NoteKind) => {
    const block = paper.notes[kind];
    const label = NOTE_LABELS[kind];
    return `## ${label.zh} / ${label.en} · ${noteSourceLabel(block)}\n\n${block.content ? neutralizeHtml(block.content) : "_empty_"}\n`;
  }).join("\n");

  const pdf = paper.pdfPath ? fileBaseName(paper.pdfPath) : paper.pdfUrl;
  const field = (value: string | number | null | undefined) => (value == null || value === "" ? "—" : inlineText(value));
  // 链接用 <…> 自动链接原样写出（转义会把 a_b 变成 a\_b，链接失效）；不是干净的 http(s) 地址才按文本转义。
  const link = (value: string | null | undefined) =>
    value && /^https?:\/\/[^\s<>]+$/i.test(value.trim()) ? `<${value.trim()}>` : field(value);

  return `# ${inlineText(paper.title)}

${paper.titleZh ? `> ${inlineText(paper.titleZh)}\n` : ""}
- Status: ${inlineText(paper.readingStatus)}${paper.readAt ? ` (${inlineText(paper.readAt)})` : ""}
- Year: ${field(paper.year)}
- Venue: ${field(paper.venue)}
- DOI: ${field(paper.doi)}
- arXiv: ${field(paper.arxivId)}
- Open source: ${inlineText(paper.codeOpenSource)}
- PDF: ${link(pdf)}
- Code: ${link(paper.codeUrl)}
- Project: ${link(paper.projectPage)}
- Tags: ${paper.tags.map(inlineText).join(", ") || "—"}
- Labs: ${labs || "—"}

## Authors

${authors || "_none_"}

## Abstract

${paper.abstract ? blockText(paper.abstract) : "_none_"}

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
  // README 索引与实际文件都使用这份分配结果。macOS / Windows 文件名不区分大小写，按小写去重。
  const used = new Set<string>();
  const taken = (name: string) => used.has(name.toLowerCase());
  const fileNames = papers.map((paper) => {
    const base = slug(`${paper.year ?? "n"}-${paper.title}`);
    let name = base;
    if (taken(name)) name = `${base}-${paper.id.slice(0, 4).toLowerCase()}`;
    let n = 2;
    while (taken(name)) {
      name = `${base}-${paper.id.slice(0, 4).toLowerCase()}-${n}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    return `${name}.md`;
  });
  const index = `# ${inlineText(domain.name)} / ${inlineText(domain.code)}

${blockText(domain.summary)}

${papers
  .map(
    (paper, i) =>
      `${i + 1}. [${inlineText(paper.title)}](./${fileNames[i]}) — ${inlineText(paper.readingStatus)}`,
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

/** Same collision rule as paper filenames: base, then base-id4, then base-id4-2. Case-insensitive. */
export function assignExportFolders(groups: Array<{ domainId: string; files: ExportFile[] }>): ExportFile[] {
  const used = new Set<string>();
  const taken = (name: string) => used.has(name.toLowerCase());
  const out: ExportFile[] = [];
  for (const group of groups) {
    const folder = group.files[0]?.relativePath.split("/")[0] ?? "export";
    let name = folder;
    if (taken(name)) name = `${folder}-${group.domainId.slice(0, 4).toLowerCase()}`;
    let n = 2;
    while (taken(name)) {
      name = `${folder}-${group.domainId.slice(0, 4).toLowerCase()}-${n}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    for (const file of group.files) {
      const rest = file.relativePath.slice(folder.length);
      out.push({ relativePath: `${name}${rest}`, content: file.content });
    }
  }
  return out;
}

/** Browser download name. Shown in the success toast instead of the word "download". */
export function browserExportFilename(domain: Pick<Domain, "code" | "name">): string {
  const base = slug(domain.code || domain.name).toLowerCase();
  return `${base}-export.md`;
}

export function libraryExportFilename(now: Date): string {
  return `paper-field-${exportStamp(now)}.md`;
}

/** One export_files invocation, or one browser download. A null folder choice is EXPORT_CANCELLED. */
export async function deliverExport(files: ExportFile[], downloadName: string): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const dir = await invoke<string | null>("export_files", { files });
    if (!dir) throw new Error("EXPORT_CANCELLED");
    return dir;
  }

  const blob = new Blob(
    [files.map((file) => `--- ${file.relativePath} ---\n${file.content}`).join("\n\n")],
    { type: "text/markdown;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  a.click();
  URL.revokeObjectURL(url);
  return downloadName;
}

export async function exportDomain(domain: Domain, papers: PaperDetail[]): Promise<string> {
  return deliverExport(buildDomainExport(domain, papers), browserExportFilename(domain));
}
