#!/usr/bin/env node
/**
 * Drive the Paper Field reading workstation in a headless browser.
 *
 * Journeys (each gets a fresh browser context, so IndexedDB starts empty and the
 * sql.js seed loads again):
 *   reading-shell, paper-list-and-notes, add-paper-manual,
 *   mark-reading-status, system-settings, all
 *
 * Requires env from scripts/_env.sh (PF_TOOLS, PF_URL, PF_EVIDENCE, PLAYWRIGHT_BROWSERS_PATH).
 */
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const tools = process.env.PF_TOOLS || path.join(process.env.HOME || "", ".cache", "pf-verify-tools");
const baseURL = process.env.PF_URL || "http://127.0.0.1:43173";
const evidence =
  process.env.PF_EVIDENCE ||
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "evidence");

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(tools, "browsers");

const JOURNEY_NAMES = [
  "reading-shell",
  "paper-list-and-notes",
  "add-paper-manual",
  "mark-reading-status",
  "system-settings",
];

const CLIP_TITLE = "从自然语言监督中学习可迁移视觉模型";
const LLAVA_TITLE = "视觉指令微调";
const INSTRUCT_TITLE = "用人类反馈训练语言模型遵循指令";
const MANUAL_TITLE = "浏览器预览验收条目";

function loadChromium() {
  const pkg = path.join(tools, "package.json");
  if (!existsSync(path.join(tools, "node_modules", "playwright"))) {
    console.error(`Playwright is not installed in ${tools}. Run scripts/setup-tools.sh`);
    process.exit(2);
  }
  const require = createRequire(pkg);
  return require("playwright").chromium;
}

function parseArgs(argv) {
  const requested = argv.filter((arg) => arg !== "--");
  if (requested.length === 0) return ["reading-shell"];
  if (requested.includes("all")) return [...JOURNEY_NAMES];
  const unknown = requested.filter((name) => !JOURNEY_NAMES.includes(name));
  if (unknown.length) {
    console.error(`Unknown journey: ${unknown.join(", ")}`);
    console.error(`Known: ${JOURNEY_NAMES.join(", ")}, all`);
    process.exit(2);
  }
  return requested;
}

async function shot(page, name) {
  await mkdir(evidence, { recursive: true });
  const file = path.join(evidence, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Wait until the workstation shell is up and the seeded paper list is on screen. */
async function openWorkstation(page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      if (document.querySelector('nav[aria-label="主导航"]')) return true;
      return document.body.innerText.includes("存储无法打开");
    },
    null,
    { timeout: 45000 },
  );
  if (await page.getByRole("heading", { name: "存储无法打开" }).count()) {
    throw new Error(`browser preview failed to open storage:\n${await page.locator("body").innerText()}`);
  }
  await page.getByRole("navigation", { name: "主导航" }).waitFor({ state: "visible" });
  await page.getByRole("listbox", { name: "论文列表" }).waitFor({ state: "visible" });
  await page
    .getByRole("listbox", { name: "论文列表" })
    .getByRole("button", { name: new RegExp(LLAVA_TITLE) })
    .waitFor({ state: "visible" });
}

async function clickMode(page, label) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: label, exact: true }).click();
}

function statusStrip(page) {
  return page.locator("footer.ef-status");
}

function paperList(page) {
  return page.getByRole("listbox", { name: "论文列表" });
}

async function readingShell(page) {
  await openWorkstation(page);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "阅读", exact: true }).waitFor();
  await page.locator("header.ef-dock").filter({ hasText: "论文阅读工作台" }).waitFor();
  await page.getByRole("button", { name: /切换研究领域：多模态/ }).waitFor();
  await statusStrip(page).filter({ hasText: /已读\s*1\s*\/\s*3/ }).waitFor();
  await statusStrip(page).filter({ hasText: "队列空闲" }).waitFor();
  await statusStrip(page).filter({ hasText: "尚未配置 AI 服务" }).waitFor();
  await statusStrip(page).filter({ hasText: "MinerU 未配置" }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(CLIP_TITLE) }).waitFor();

  await clickMode(page, "归档");
  await page.getByRole("heading", { name: "归档", exact: true }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(LLAVA_TITLE) }).waitFor();
  if (await paperList(page).getByRole("button", { name: new RegExp(CLIP_TITLE) }).count()) {
    throw new Error("归档 listed a paper that is still 在读");
  }

  await clickMode(page, "入库");
  await page.getByRole("heading", { name: "入库", exact: true }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(INSTRUCT_TITLE) }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(CLIP_TITLE) }).waitFor();
  if (await paperList(page).getByRole("button", { name: new RegExp(LLAVA_TITLE) }).count()) {
    throw new Error("入库 listed a paper already marked 已读");
  }

  await clickMode(page, "设置");
  await page.getByRole("heading", { name: "设置", level: 1 }).waitFor();

  await clickMode(page, "阅读");
  await page.getByRole("button", { name: /切换研究领域：多模态/ }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(LLAVA_TITLE) }).click();
  await page.getByRole("heading", { name: LLAVA_TITLE, level: 1 }).waitFor();
  await page.getByRole("heading", { name: "阅读笔记" }).waitFor();
}

async function paperListAndNotes(page) {
  await openWorkstation(page);
  await page.getByRole("textbox", { name: "搜索论文" }).fill("CLIP");
  const scope = page.locator('[aria-label="跨领域搜索结果"]');
  await scope.filter({ hasText: "全部领域共匹配" }).waitFor();
  await scope.getByRole("button", { name: new RegExp(CLIP_TITLE) }).click();
  await page.getByRole("heading", { name: CLIP_TITLE, level: 1 }).waitFor();
  await page.getByRole("button", { name: "写总结" }).click();
  const editor = page.getByRole("textbox", { name: "总结内容" });
  await editor.waitFor();
  const sentence = "浏览器验收：对照实验要记下训练数据规模。";
  await editor.fill(sentence);
  await page.getByText("编辑中 · 尚未保存").waitFor();
  await page.getByRole("button", { name: "保存笔记" }).click();
  await page.locator("#note-summary").filter({ hasText: sentence }).waitFor();
  await page.locator("#note-summary").filter({ hasText: "手动笔记" }).waitFor();
}

async function addPaperManual(page) {
  await openWorkstation(page);
  await page.getByRole("button", { name: /添加论文/ }).click();
  const dialog = page.getByRole("dialog", { name: "添加论文" });
  await dialog.waitFor();
  await dialog.getByText("浏览器预览不能读取本机 PDF").waitFor();
  await dialog.getByRole("textbox", { name: "标题（必填）" }).fill(MANUAL_TITLE);
  const created = page.getByText(/已创建「浏览器预览验收条目」/).waitFor();
  await dialog.getByRole("button", { name: "创建论文" }).click();
  await created;
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: MANUAL_TITLE, level: 1 }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(MANUAL_TITLE) }).waitFor();
}

async function markReadingStatus(page) {
  await openWorkstation(page);
  await paperList(page).getByRole("button", { name: new RegExp(CLIP_TITLE) }).click();
  await page.getByRole("heading", { name: CLIP_TITLE, level: 1 }).waitFor();
  const select = page.getByLabel("修改阅读状态");
  await select.waitFor();
  if ((await select.inputValue()) !== "reading") {
    throw new Error(`expected CLIP to start as 在读, select value was ${await select.inputValue()}`);
  }
  await select.selectOption({ label: "已读" });
  await page.getByRole("status").filter({ hasText: "阅读状态已更新为已读" }).waitFor();
  await statusStrip(page).filter({ hasText: /已读\s*2\s*\/\s*3/ }).waitFor();
  await clickMode(page, "归档");
  await page.getByRole("heading", { name: "归档", exact: true }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(CLIP_TITLE) }).waitFor();
  await paperList(page).getByRole("button", { name: new RegExp(LLAVA_TITLE) }).waitFor();
}

async function systemSettings(page) {
  await openWorkstation(page);
  await clickMode(page, "设置");
  await page.getByRole("heading", { name: "设置", level: 1 }).waitFor();
  for (const heading of ["AI 服务设置", "数据导出", "备份与恢复", "快捷键", "MinerU 解析源", "文献库"]) {
    await page.getByRole("heading", { name: heading, exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  }
  await page.getByText("尚未配置任何 AI 服务").waitFor();
  await page.getByRole("region", { name: "本地 CLI" }).waitFor();
  await page.getByRole("region", { name: "SSH 远程" }).waitFor();
  await page.getByRole("region", { name: "官方 API" }).waitFor();
  await page.getByText("添加论文（导入 PDF / 手动录入）").waitFor();
  await page.getByText("标记已读", { exact: true }).waitFor();

  const biblio = page.locator("article").filter({ has: page.getByRole("heading", { name: "文献库", exact: true }) });
  await biblio.getByRole("textbox", { name: "联系邮箱" }).fill("verify-paper-field@example.com");
  await biblio.getByRole("button", { name: "保存文献库设置" }).click();
  await page.getByText("文献库设置已保存。", { exact: true }).waitFor();
  await biblio.locator("li").filter({ hasText: "Crossref" }).filter({ hasText: "已配置" }).waitFor();
}

const JOURNEYS = {
  "reading-shell": readingShell,
  "paper-list-and-notes": paperListAndNotes,
  "add-paper-manual": addPaperManual,
  "mark-reading-status": markReadingStatus,
  "system-settings": systemSettings,
};

async function main() {
  const names = parseArgs(process.argv.slice(2));
  const chromium = loadChromium();
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let failed = false;
  try {
    for (const name of names) {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
        locale: "zh-CN",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(30000);
      const pageErrors = [];
      page.on("pageerror", (err) => pageErrors.push(err instanceof Error ? err.message : String(err)));
      try {
        await JOURNEYS[name](page);
        if (pageErrors.length) {
          throw new Error(`uncaught page error:\n${pageErrors.join("\n")}`);
        }
        const screenshot = await shot(page, name);
        results.push({ name, ok: true, screenshot });
        console.log(`PASS ${name}`);
      } catch (err) {
        failed = true;
        const message = err instanceof Error ? err.message : String(err);
        let screenshot = null;
        try {
          screenshot = await shot(page, `${name}-failed`);
        } catch {
          screenshot = null;
        }
        results.push({ name, ok: false, error: message, screenshot, pageErrors });
        console.error(`FAIL ${name}\n${message}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const report = {
    url: baseURL,
    viewport: "1600x1000",
    ok: !failed,
    results,
  };
  await writeFile(path.join(evidence, "drive-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (failed) process.exit(1);
}

await main();
