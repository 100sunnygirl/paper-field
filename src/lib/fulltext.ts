/**
 * 解析全文的小节基础设施：从 MinerU 输出的 Markdown 提取标题层级、
 * 生成稳定锚点 id 与层级编号（§3.2），并构建摘录引用 / 章节引用文案。
 * 「摘录到笔记」「本页目录二级导航」「全文内检索」共用这一套纯函数。
 */

export interface FulltextHeading {
  /** 1-6，Markdown 标题层级。 */
  level: number;
  /** 去掉行内标记（加粗 / 行内代码 / 链接）后的标题文字。 */
  text: string;
  /** 层级编号，如 "3.2"；文档从深层级开始时按该层为第 1 级起算（去掉前导 0 段）。 */
  number: string;
  /** 稳定锚点 id：按标题出现顺序编号，同一份 Markdown 恒定不变（增删段落不影响）。 */
  id: string;
}

/** 选中的全文片段：文字 + 它所属的小节（选在标题前 / 无标题时为 null）。 */
export interface FulltextSelection {
  text: string;
  heading: FulltextHeading | null;
}

const ATX_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const SETEXT_H1_RE = /^=+\s*$/;
const SETEXT_H2_RE = /^-{2,}\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
/** 标题正文行之前的块级字符：这些行不是 setext 标题的正文。 */
const BLOCK_PREFIX_RE = /^\s*(#|>|[-*+]|\d+[.)])/;

/** 去掉常见的行内标记，取标题纯文字。 */
function stripInline(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/**
 * 提取 Markdown 的小节标题：支持 ATX（# …）与 setext（=== / ---），
 * 跳过围栏代码块里的伪标题；编号按层级递进、深层重置。
 */
export function extractFulltextHeadings(markdown: string): FulltextHeading[] {
  const lines = (markdown || "").split(/\r?\n/);
  const counters = [0, 0, 0, 0, 0, 0];
  const headings: FulltextHeading[] = [];

  const push = (level: number, raw: string) => {
    counters[level - 1] += 1;
    for (let deeper = level; deeper < 6; deeper += 1) counters[deeper] = 0;
    const segments: number[] = [];
    for (let l = 0; l < level; l += 1) segments.push(counters[l]);
    while (segments.length > 1 && segments[0] === 0) segments.shift();
    headings.push({
      level,
      text: stripInline(raw),
      number: segments.join("."),
      id: `ft-sec-${headings.length}`,
    });
  };

  let fenceChar: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);
    if (fence) {
      const mark = fence[1][0];
      if (!fenceChar) fenceChar = mark;
      else if (mark === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar) continue;
    const atx = line.match(ATX_RE);
    if (atx) {
      push(atx[1].length, atx[2]);
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (
      line.trim() &&
      !BLOCK_PREFIX_RE.test(line) &&
      !line.trim().startsWith("#") &&
      (SETEXT_H1_RE.test(next) || SETEXT_H2_RE.test(next))
    ) {
      push(SETEXT_H1_RE.test(next) ? 1 : 2, line);
      i += 1;
    }
  }
  return headings;
}

/**
 * 给渲染出的全文容器里按顺序出现的 h1-h6 挂上稳定锚点 id。
 * renderMarkdown 的消毒层会剥掉外部 id（防止抢占 #abstract 等应用锚点），
 * 所以锚点在渲染后由应用自己按标题序号补写。
 */
export function assignFulltextAnchors(root: ParentNode | null, headings: FulltextHeading[]): void {
  if (!root) return;
  const nodes = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  nodes.forEach((node, index) => {
    const heading = headings[index];
    if (heading) node.id = heading.id;
  });
}

/** 容器里按顺序出现的标题元素（与 extractFulltextHeadings 同序，含代码块跳过规则）。 */
function headingElements(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
}

/** 选中片段属于哪一节：取选中位置之前最近的一个标题。 */
export function headingForSelection(
  root: ParentNode,
  headings: FulltextHeading[],
  node: Node | null,
): FulltextHeading | null {
  if (!node || !headings.length) return null;
  const target = node instanceof Element ? node : node.parentElement;
  if (!target || !root.contains(target)) return null;
  let found: FulltextHeading | null = null;
  headingElements(root).forEach((element, index) => {
    const relation = element.compareDocumentPosition(target);
    const afterOrInside = relation === 0 || Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
    if (afterOrInside && headings[index]) found = headings[index];
  });
  return found;
}

/** 当前文档选区是否落在指定容器内：在则返回选中文本与选区公共节点，否则 null。 */
export function selectionInRoot(root: Node | null): { text: string; node: Node } | null {
  if (!root || typeof document === "undefined" || !document.getSelection) return null;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  if (!element || !root.contains(element)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  return { text, node: container };
}

/** 章节引用（复制用）：如「《论文标题》§3.2 方法」。 */
export function buildSectionCitation(title: string, heading: FulltextHeading): string {
  return `《${title}》§${heading.number} ${heading.text}`.trim();
}

/** 摘录引用（写入笔记用）：blockquote + 可跳回原文的小节锚点链接。 */
export function buildExcerptMarkdown(text: string, heading: FulltextHeading | null): string {
  const quote = text.replace(/\s+/g, " ").trim();
  const source = heading ? `原文（[§${heading.number} ${heading.text}](#${heading.id})）` : "原文";
  return `> ${source}：${quote}`;
}

/** 把摘录追加到笔记块末尾：空块直接落，有内容先空一行。 */
export function appendExcerpt(base: string, quote: string): string {
  const trimmed = base.trimEnd();
  return trimmed ? `${trimmed}\n\n${quote}` : quote;
}

/** 把引用插入编辑框光标处：前后按需补空行，保持 Markdown 段落边界。 */
export function insertQuoteAtCursor(value: string, position: number, quote: string): string {
  if (!value.trim()) return quote;
  const pos = Math.max(0, Math.min(position, value.length));
  const before = value.slice(0, pos);
  const after = value.slice(pos);
  // 光标已在行首（前面以换行结尾）就直接落，行中则先补一个空行。
  const lead = before === "" || before.endsWith("\n") ? "" : "\n\n";
  const tail = after === "" || after.startsWith("\n") ? "" : "\n";
  return `${before}${lead}${quote}${tail}${after}`;
}

/**
 * 全文内检索的命中高亮：在渲染容器的文本节点里大小写不敏感地找 query，
 * 包成 <mark class="ef-ft-hit">；currentOrdinal 指定的命中加 is-current。
 * 先清掉上一轮的 mark（拆回文本节点并 normalize），空 query 只清不标。
 * 返回命中总数。
 */
export function highlightFulltextMatches(
  root: ParentNode | null,
  query: string,
  currentOrdinal = -1,
  options?: { scroll?: boolean },
): number {
  if (!root || typeof document === "undefined") return 0;
  for (const mark of Array.from(root.querySelectorAll("mark.ef-ft-hit"))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
  const needle = query.trim();
  if (!needle) return 0;
  const lowerNeedle = needle.toLowerCase();
  const hits: Element[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    const lowerText = text.toLowerCase();
    if (!lowerText.includes(lowerNeedle)) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let index = lowerText.indexOf(lowerNeedle, cursor);
    while (index >= 0) {
      if (index > cursor) fragment.append(document.createTextNode(text.slice(cursor, index)));
      const mark = document.createElement("mark");
      mark.className = "ef-ft-hit";
      mark.textContent = text.slice(index, index + needle.length);
      fragment.append(mark);
      hits.push(mark);
      cursor = index + needle.length;
      index = lowerText.indexOf(lowerNeedle, cursor);
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
  if (currentOrdinal >= 0 && hits[currentOrdinal]) {
    hits.forEach((mark, ordinal) => mark.classList.toggle("is-current", ordinal === currentOrdinal));
    if (options?.scroll && typeof hits[currentOrdinal].scrollIntoView === "function") {
      hits[currentOrdinal].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
  return hits.length;
}
