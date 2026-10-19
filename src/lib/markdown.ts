import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";
import { openExternal, safeHttpUrl } from "./urls";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Attribute on the placeholder button holding the original image URL. Incoming
 * `data-*` is stripped by the sanitizer, so only `replaceImages` sets it; the
 * click handler still re-checks the URL via `openExternal`.
 */
export const REMOTE_IMG_ATTR = "data-remote-src";

/**
 * Images whose `src` uses a scheme the webview cannot load (e.g. MinerU's
 * SSH-source internal refs such as `doc:…`; the exact format is not relied on).
 * DOMPurify drops unknown schemes, which would leave a bare `<img>` with no
 * placeholder; the hook records them here before that happens so `replaceImages`
 * shows the same "unsaved" notice as API-source `images/x.jpg`. Schemes with
 * existing handling (http/https, data:, blob:, asset:) are left alone. Kept out
 * of the DOM so user markdown cannot set the mark itself.
 */
let unsavedRefs = new WeakSet<Element>();
const HANDLED_SCHEMES = new Set(["http:", "https:", "data:", "blob:", "asset:"]);

function isUnloadableScheme(raw: string): boolean {
  const src = raw.trim();
  if (!src || src.startsWith("//")) return false;
  try {
    return !HANDLED_SCHEMES.has(new URL(src).protocol);
  } catch {
    return false; // no scheme: relative path, handled by classifyImgSrc
  }
}

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
 * Replace both with a visible placeholder instead of a broken image. Runs on the
 * sanitized fragment (DOMPurify's inert document), so the HTML is serialized once
 * and our own `class` / `data-remote-src` are added after the sanitizer stripped
 * every incoming one.
 */
function replaceImages(root: DocumentFragment): void {
  const doc = root.ownerDocument;
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const raw = img.getAttribute("src") ?? "";
    const kind = unsavedRefs.has(img) ? "unsaved" : classifyImgSrc(raw);
    if (kind === "keep") continue;
    const box = doc.createElement("span");
    box.className = "ef-md-remote-img";
    box.append(kind === "remote" ? "远程图片未加载" : "图片未随解析结果保存");
    const alt = img.getAttribute("alt")?.trim();
    if (alt) box.append(`（${alt}）`);
    const url = kind === "remote" ? safeHttpUrl(raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw) : null;
    if (url) {
      const link = doc.createElement("button");
      link.type = "button";
      link.className = "ef-md-remote-open";
      link.setAttribute(REMOTE_IMG_ATTR, url);
      link.textContent = "在浏览器中打开";
      box.append(" ", link);
    }
    img.replaceWith(box);
  }
}

function markUnloadableImg(node: Element): void {
  if (node.nodeName === "IMG" && isUnloadableScheme(node.getAttribute("src") ?? "")) {
    unsavedRefs.add(node);
  }
}

/**
 * 只放行 HTML 配置：SVG / MathML 有 mXSS 历史，论文正文用不到。
 * class / id / data-* 全部剥掉：不让外部 markdown 借用应用的 `ef-*` 样式伪造界面、
 * 用 id 抢占目录锚点（#abstract、#fulltext），或伪造 `data-remote-src` 按钮。
 */
const PURIFY_CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["iframe", "object", "embed", "form", "style"],
  FORBID_ATTR: ["style", "class", "id"],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

export function renderMarkdown(source: string): string {
  const html = marked.parse(source || "") as string;
  // Hooks are global on the DOMPurify instance; scope this one to this call and
  // remove exactly this function so other hooks of the same kind survive.
  DOMPurify.addHook("beforeSanitizeAttributes", markUnloadableImg);
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(html, PURIFY_CONFIG);
    replaceImages(fragment);
  } finally {
    DOMPurify.removeHook("beforeSanitizeAttributes", markUnloadableImg);
    unsavedRefs = new WeakSet();
  }
  const out = fragment.ownerDocument.createElement("div");
  out.append(fragment);
  return out.innerHTML;
}

/**
 * Delegated click handler for rendered markdown containers. Every link click is
 * kept out of the main webview (relative, `//host`, `<area>` and odd schemes
 * included); only http(s) goes on to the system browser, and in-page `#` anchors
 * keep their default.
 */
export function onMarkdownClick(event: { target: EventTarget | null; preventDefault(): void }): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const remote = target.closest(`[${REMOTE_IMG_ATTR}]`);
  if (remote) {
    event.preventDefault();
    void openExternal(remote.getAttribute(REMOTE_IMG_ATTR));
    return;
  }
  const link = target.closest("a, area");
  if (!link) return;
  const href = (link.getAttribute("href") ?? "").trim();
  if (href.startsWith("#")) return;
  event.preventDefault();
  if (/^https?:/i.test(href)) void openExternal(href);
}
