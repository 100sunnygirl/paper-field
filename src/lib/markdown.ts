import DOMPurify from "dompurify";
import { marked } from "marked";
import { openExternal, safeHttpUrl } from "./urls";

marked.setOptions({ gfm: true, breaks: true });

/** Attribute on the placeholder link; the click handler opens it via `openExternal`. */
export const REMOTE_IMG_ATTR = "data-remote-src";

/**
 * The CSP (`img-src 'self' data: blob: asset:`) blocks remote images silently.
 * Swap each http(s) <img> for a visible placeholder instead of a broken image.
 */
function replaceRemoteImages(html: string): string {
  if (!/<img/i.test(html)) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const img of Array.from(tpl.content.querySelectorAll("img"))) {
    const raw = img.getAttribute("src") ?? "";
    if (!/^\s*https?:/i.test(raw)) continue;
    const box = document.createElement("span");
    box.className = "ef-md-remote-img";
    box.append("远程图片未加载");
    const alt = img.getAttribute("alt")?.trim();
    if (alt) box.append(`（${alt}）`);
    const url = safeHttpUrl(raw);
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
  return replaceRemoteImages(clean);
}

/** Delegated click handler for rendered markdown containers. */
export function onMarkdownClick(event: { target: EventTarget | null; preventDefault(): void }): void {
  const el = event.target instanceof Element ? event.target.closest(`[${REMOTE_IMG_ATTR}]`) : null;
  if (!el) return;
  event.preventDefault();
  void openExternal(el.getAttribute(REMOTE_IMG_ATTR));
}
