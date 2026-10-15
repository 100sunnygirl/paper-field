import DOMPurify from "dompurify";
import { marked } from "marked";
import { openExternal, safeHttpUrl } from "./urls";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Attribute on the placeholder button holding the original image URL.
 * DOMPurify lets `data-*` through, so user markdown can set it too: never read
 * it directly; always go through `onMarkdownClick` (which re-checks via `openExternal`).
 */
export const REMOTE_IMG_ATTR = "data-remote-src";

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

type ImgKind = "remote" | "unsaved" | "keep";

/** Same parser as `safeHttpUrl`, so case, whitespace and `//host` are judged alike. */
export function classifyImgSrc(raw: string): ImgKind {
  const src = raw.trim();
  if (!src) return "keep";
  let url: URL;
  try {
    url = new URL(src.startsWith("//") ? `https:${src}` : src);
  } catch {
    // No scheme: a path such as MinerU's `images/x.jpg`. Only image-file paths count,
    // so other bare values keep the existing sanitized <img> unchanged.
    return IMG_EXT.test(src.split(/[?#]/)[0]) ? "unsaved" : "keep";
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    // Tauri serves local files as http://asset.localhost on Windows; allowed by CSP.
    return url.hostname === "asset.localhost" ? "keep" : "remote";
  }
  return "keep"; // data:, blob:, asset:, and anything DOMPurify already handled
}

/**
 * The CSP (`img-src 'self' data: blob: asset: http://asset.localhost`) blocks remote
 * images silently, and parsed papers reference image files that were never saved.
 * Replace both with a visible placeholder instead of a broken image.
 */
function replaceImages(html: string): string {
  if (!/<img/i.test(html)) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const img of Array.from(tpl.content.querySelectorAll("img"))) {
    const raw = img.getAttribute("src") ?? "";
    const kind = classifyImgSrc(raw);
    if (kind === "keep") continue;
    const box = document.createElement("span");
    box.className = "ef-md-remote-img";
    box.append(kind === "remote" ? "远程图片未加载" : "图片未随解析结果保存");
    const alt = img.getAttribute("alt")?.trim();
    if (alt) box.append(`（${alt}）`);
    const url = kind === "remote" ? safeHttpUrl(raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw) : null;
    if (url) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "ef-md-remote-open";
      link.setAttribute(REMOTE_IMG_ATTR, url);
      link.textContent = "在浏览器中打开";
      box.append(" ", link);
    }
    img.replaceWith(box);
  }
  return tpl.innerHTML;
}

export function renderMarkdown(source: string): string {
  const html = marked.parse(source || "") as string;
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["iframe", "object", "embed", "form", "style"],
    FORBID_ATTR: ["style"],
  });
  return replaceImages(clean);
}

/** Delegated click handler for rendered markdown containers. */
export function onMarkdownClick(event: { target: EventTarget | null; preventDefault(): void }): void {
  const el = event.target instanceof Element ? event.target.closest(`[${REMOTE_IMG_ATTR}]`) : null;
  if (!el) return;
  event.preventDefault();
  void openExternal(el.getAttribute(REMOTE_IMG_ATTR));
}
