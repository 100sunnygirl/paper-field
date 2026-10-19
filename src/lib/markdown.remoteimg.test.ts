import { describe, expect, it, vi, beforeEach } from "vitest";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));
vi.mock("./util", async (orig) => ({ ...(await orig<object>()), isTauri: () => true }));

import { classifyImgSrc, onMarkdownClick, renderMarkdown, REMOTE_IMG_ATTR } from "./markdown";

function mount(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

async function click(el: Element) {
  const preventDefault = vi.fn();
  onMarkdownClick({ target: el, preventDefault });
  await new Promise((r) => setTimeout(r, 0));
  return preventDefault;
}

beforeEach(() => openUrl.mockReset());

describe("remote images", () => {
  it("replaces an http(s) image with a placeholder and an open button", async () => {
    const root = mount(renderMarkdown("![图 1](https://example.com/a.png)"));
    expect(root.querySelector("img")).toBeNull();
    const box = root.querySelector(".ef-md-remote-img")!;
    expect(box.textContent).toContain("远程图片未加载（图 1）");
    const btn = box.querySelector(`[${REMOTE_IMG_ATTR}]`)!;
    expect(btn.getAttribute(REMOTE_IMG_ATTR)).toBe("https://example.com/a.png");
    expect((await click(btn))).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a.png");
  });

  it("opens an http(s) link outside the webview and blocks javascript and file", async () => {
    const root = mount(
      '<a href="https://example.com/paper">paper</a><a href="javascript:alert(1)">js</a><a href="file:///tmp/a.pdf">file</a>',
    );
    const [paper, js, file] = Array.from(root.querySelectorAll("a"));
    expect(await click(paper)).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/paper");
    openUrl.mockClear();
    // SEC-016：其他协议既不打开，也不让主 webview 跟随跳转。
    expect(await click(js)).toHaveBeenCalled();
    expect(await click(file)).toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["relative", '<a href="other.html">x</a>'],
    ["root-relative", '<a href="/index.html">x</a>'],
    ["protocol-relative", '<a href="//evil.example/x">x</a>'],
    ["no scheme host", '<a href="evil.example">x</a>'],
    ["area", '<map name="m"><area href="other.html" alt="x"></map>'],
  ])("keeps %s links from navigating the main webview", async (_n, html) => {
    const root = mount(html);
    const link = root.querySelector("a, area")!;
    expect(await click(link)).toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("intercepts clicks on elements nested inside a link", async () => {
    const root = mount(renderMarkdown("[**bold**](other.md) [*x*](https://example.com/n)"));
    expect(await click(root.querySelector("strong")!)).toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(await click(root.querySelector("em")!)).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/n");
  });

  it("leaves in-page # anchors to the browser", async () => {
    const root = mount('<a href="#sec">x</a><a href=" #y">y</a>');
    for (const a of Array.from(root.querySelectorAll("a"))) expect(await click(a)).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps data: and asset: images untouched", () => {
    const root = mount(renderMarkdown("![d](data:image/png;base64,AAAA) ![a](asset://localhost/x.png)"));
    const srcs = Array.from(root.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    // asset: src is already dropped by DOMPurify before this change; behaviour is unchanged here.
    expect(srcs).toEqual(["data:image/png;base64,AAAA", null]);
    expect(root.querySelector(".ef-md-remote-img")).toBeNull();
  });

  it("leaves no event attributes on a replaced remote image", () => {
    const html = renderMarkdown('<img src="https://e.com/x.png" onerror="alert(1)" onload="alert(2)">');
    expect(html).not.toMatch(/onerror|onload|alert/);
    expect(mount(html).querySelector(".ef-md-remote-img")).not.toBeNull();
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///etc/passwd"],
  ])("refuses to open %s urls smuggled into the attribute", async (_n, url) => {
    const root = mount(renderMarkdown(`<button ${REMOTE_IMG_ATTR}="${url}">x</button>`));
    const btn = root.querySelector("button");
    if (btn) await click(btn);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not turn javascript:/file: image sources into open buttons", () => {
    for (const src of ["javascript:alert(1)", "file:///etc/passwd"]) {
      const root = mount(renderMarkdown(`<img src="${src}">`));
      expect(root.querySelector(`[${REMOTE_IMG_ATTR}]`)).toBeNull();
    }
  });

  it("ignores clicks outside placeholders", async () => {
    const root = mount(renderMarkdown("plain **text**"));
    expect(await click(root.querySelector("strong")!)).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["//host/x.png", "remote"],
    ["HtTpS://e.com/a.png", "remote"],
    [" https://e.com/a.png", "remote"],
    ["http://e.com/a.png", "remote"],
    ["/abs.png", "unsaved"],
    ["images/a.jpg", "unsaved"],
    ["./images/a.jpg", "unsaved"],
    ["images/A.JPEG?v=1", "unsaved"],
    ["x", "keep"],
    ["data:image/png;base64,AAAA", "keep"],
    ["blob:http://localhost/1234", "keep"],
    ["http://asset.localhost/C%3A/lib/x.png", "keep"],
    ["asset://localhost/x.png", "keep"],
    ["", "keep"],
  ])("classifies %j as %s", (src, kind) => {
    expect(classifyImgSrc(src)).toBe(kind);
  });

  it("shows an unsaved placeholder without an open button for relative images", () => {
    const root = mount(renderMarkdown("![fig 2](images/abc.jpg)"));
    expect(root.querySelector("img")).toBeNull();
    const box = root.querySelector(".ef-md-remote-img")!;
    expect(box.textContent).toBe("图片未随解析结果保存（fig 2）");
    expect(box.querySelector(`[${REMOTE_IMG_ATTR}]`)).toBeNull();
  });

  it("opens protocol-relative images over https", async () => {
    const root = mount(renderMarkdown("![](//cdn.example.com/a.png)"));
    await click(root.querySelector(`[${REMOTE_IMG_ATTR}]`)!);
    expect(openUrl).toHaveBeenCalledWith("https://cdn.example.com/a.png");
  });

  it("keeps http://asset.localhost images as images", () => {
    const root = mount(renderMarkdown('<img src="http://asset.localhost/x.png" alt="x">'));
    expect(root.querySelector("img")?.getAttribute("src")).toBe("http://asset.localhost/x.png");
    expect(root.querySelector(".ef-md-remote-img")).toBeNull();
  });
});

describe("unsaved images: API paths and unloadable schemes", () => {
  const NOTE = "图片未随解析结果保存";

  function expectUnsaved(md: string, alt: string) {
    const root = mount(renderMarkdown(md));
    expect(root.querySelector("img")).toBeNull();
    const box = root.querySelector(".ef-md-remote-img");
    expect(box?.textContent).toBe(alt ? `${NOTE}（${alt}）` : NOTE);
    expect(root.querySelector(`[${REMOTE_IMG_ATTR}]`)).toBeNull();
  }

  it("API source relative path shows the unsaved notice without an open button", () => {
    expectUnsaved("![图 1](images/abc.jpg)", "图 1");
  });

  const schemes = [
    "doc:89500a3/tier:hi/p1.jpg",
    "doc:x",
    "DOC:x",
    "foo:bar",
    "file:///Users/a/fig.png",
    "C:\\fig.png",
  ];
  it.each(schemes.flatMap((src) => [[src, "图"], [src, ""]]))("%s (alt=%j) shows the unsaved notice", (src, alt) => {
    expectUnsaved(`![${alt}](<${src}>)`, alt);
  });

  // Verbatim links from the SSH (doclib) source, refetched for pr41: no file
  // extension and several colons in the path.
  it.each([
    ["Image block", "doc:89500a3/tier:standard/page:5/block:3"],
    ["Chart block", "doc:89500a3/tier:standard/page:11/block:3"],
  ])("real doclib link (%s) shows the unsaved notice", (alt, src) => {
    expectUnsaved(`![${alt}](${src})`, alt);
  });

  it("leading whitespace in an HTML src is still recognised", () => {
    const root = mount(renderMarkdown('<img src="  doc:x" alt="图">'));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".ef-md-remote-img")?.textContent).toBe(`${NOTE}（图）`);
  });

  it("keeps handled schemes as before (data:, asset:, http://asset.localhost, https)", () => {
    const root = mount(
      renderMarkdown(
        "![d](data:image/png;base64,AAAA) ![a](asset://localhost/x.png) ![h](http://asset.localhost/x.png) ![r](https://e.com/a.png)",
      ),
    );
    const srcs = Array.from(root.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["data:image/png;base64,AAAA", null, "http://asset.localhost/x.png"]);
    const boxes = Array.from(root.querySelectorAll(".ef-md-remote-img")).map((b) => b.textContent ?? "");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toContain("远程图片未加载（r）");
    expect(boxes.join("")).not.toContain(NOTE);
  });

  it("strips event handlers and javascript: from unloadable images", () => {
    const html = renderMarkdown('<img src="doc:x" onerror="alert(1)"> ![j](javascript:alert(1))');
    expect(html).not.toMatch(/onerror|alert|javascript:/i);
  });

  it("removes its sanitize hook after rendering", async () => {
    const { default: DOMPurify } = await import("dompurify");
    const add = vi.spyOn(DOMPurify, "addHook");
    const remove = vi.spyOn(DOMPurify, "removeHook");
    renderMarkdown("![f](doc:x)");
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(add.mock.calls[0][0], add.mock.calls[0][1]);
    add.mockRestore();
    remove.mockRestore();
  });

  it("a hand-written mark is stripped and changes nothing", () => {
    const html = renderMarkdown('<img data-pf-unsaved-ref src="https://e.com/a.png"> <img data-pf-unsaved-ref src="data:image/png;base64,AAAA">');
    expect(html).not.toContain("data-pf-unsaved-ref");
    const root = mount(html);
    // 远程图仍按远程处理（按钮 URL 来自我们自己的校验），data: 图保持原样。
    expect(root.querySelector(".ef-md-remote-img")?.textContent).toContain("远程图片未加载");
    expect(root.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });
});
