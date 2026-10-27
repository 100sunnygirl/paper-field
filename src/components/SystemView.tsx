import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ModelCombobox } from "./ModelCombobox";
import {
  testMineru,
  type MineruLanguage,
  type MineruModelVersion,
  type MineruProviderKind,
  type MineruSaveInput,
  type MineruTier,
  type ProviderHealth,
} from "../lib/mineru";
import { providerLabel, summarizeHealths } from "../lib/mineruPlan";
import {
  hasUsableProvider,
  LLM_PRESETS,
  listLlmModels,
  presetById,
  testLlmProvider,
  type LlmSaveInput,
} from "../lib/settings";
import type { LlmProviderView } from "../lib/types";
import { MODE_LABELS } from "../lib/types";
import { biblioEmailConfigured, type BiblioSaveInput } from "../lib/biblio";
import { BACKUP_STALE_DAYS, daysSinceBackup, readLastBackup, type BackupRecord } from "../lib/backup";
import type { ExportContentOptions } from "../lib/export";
import { repo } from "../lib/repo";
import { checkForAppUpdate } from "../lib/updater";
import { openExternal } from "../lib/urls";
import { formatDate, pad2, shortcut, uid } from "../lib/util";
import { useField } from "../store";
import { LogPanel } from "./LogPanel";
import { PreRestoreList } from "./PreRestoreList";
import { SecretsOverview } from "./SecretsOverview";
import { Button, Dialog, Field, Icon } from "./ui";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- 设置页离开守卫：三块表单注册 isDirty / save / discard，setMode 离开前询问 ----------

interface SettingsGuardEntry {
  id: string;
  title: string;
  isDirty: () => boolean;
  save: () => Promise<void>;
  discard: () => void;
}

/** 模块级注册表：SystemView 的三块表单各注册一条；守卫函数在决策时刻实时读取。 */
const settingsGuards: SettingsGuardEntry[] = [];

function registerSettingsGuard(entry: SettingsGuardEntry): () => void {
  settingsGuards.push(entry);
  return () => {
    const index = settingsGuards.indexOf(entry);
    if (index >= 0) settingsGuards.splice(index, 1);
  };
}

export function dirtySettingsCards(): SettingsGuardEntry[] {
  return settingsGuards.filter((entry) => entry.isDirty());
}

/** 注册一条守卫；isDirty/save/discard 每次渲染刷新到 ref，注册本身只做一次。 */
function useSettingsGuard(
  id: string,
  title: string,
  handlers: Pick<SettingsGuardEntry, "isDirty" | "save" | "discard">,
): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const entry: SettingsGuardEntry = {
      id,
      title,
      isDirty: () => ref.current.isDirty(),
      save: () => ref.current.save(),
      discard: () => ref.current.discard(),
    };
    return registerSettingsGuard(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

// ---------- 非敏感草稿：dirty 时写 localStorage（不含 Key / Token），挂载时恢复 ----------

/** 三块表单的草稿键；Key 与 Token 永不写入草稿。 */
const LLM_DRAFT_KEY = "paper-field.settings-draft.llm";
const MINERU_DRAFT_KEY = "paper-field.settings-draft.mineru";
const BIBLIO_DRAFT_KEY = "paper-field.settings-draft.biblio";

function readSettingsDraft<T>(key: string): T | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return value && typeof value === "object" ? (value as T) : null;
  } catch {
    return null;
  }
}

function writeSettingsDraft(key: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 写不进（隐私模式等）：草稿只是额外保护，不影响表单本身。
  }
}

/**
 * 设置页卡片清单：锚点目录、搜索过滤与深链（openSystemCard 的 anchor）共用的
 * 唯一事实来源，顺序即页面顺序。keywords 是搜索的补充词表（标题之外的常用叫法）。
 */
const SYSTEM_CARDS = [
  { id: "setup", title: "上手清单", keywords: ["上手", "新手", "清单", "向导", "最小", "入门"] },
  {
    id: "llm",
    title: "AI 服务设置",
    keywords: ["AI", "Key", "API Key", "提供商", "模型", "Base URL", "用量", "补全", "openai", "deepseek", "ollama"],
  },
  {
    id: "secrets",
    title: "密钥与令牌",
    keywords: ["密钥", "Key", "Token", "令牌", "清除", "钥匙串", "机密"],
  },
  { id: "export", title: "数据导出", keywords: ["导出", "Markdown", "分享", "md"] },
  { id: "backup", title: "备份与恢复", keywords: ["备份", "恢复", "zip", "原数据", "文库"] },
  { id: "shortcuts", title: "快捷键", keywords: ["快捷键", "键盘", "⌘", "shortcut"] },
  { id: "update", title: "软件更新", keywords: ["更新", "版本", "升级", "重启"] },
  {
    id: "mineru",
    title: "MinerU 解析源",
    keywords: ["MinerU", "解析", "PDF", "SSH", "Token", "doclib", "回退", "本地"],
  },
  {
    id: "biblio",
    title: "文献库",
    keywords: ["文献库", "OpenAlex", "Crossref", "Semantic Scholar", "arXiv", "邮箱", "著录", "API Key"],
  },
  { id: "logs", title: "运行日志", keywords: ["日志", "log", "错误", "警告", "排查", "复制"] },
] as const;

type SystemCardId = (typeof SYSTEM_CARDS)[number]["id"];

/** 搜索匹配：标题或关键词任一命中即保留该卡片；空查询保留全部。 */
export function settingsCardMatches(
  card: { title: string; keywords: readonly string[] },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    card.title.toLowerCase().includes(q) ||
    card.keywords.some((keyword) => keyword.toLowerCase().includes(q))
  );
}

/** 与 App 的 ⌘K 同款：等列表栏挂载后再聚焦论文搜索框（设置页会先切回阅读模式）。 */
function focusGlobalSearchSoon(): void {
  const step = () => {
    const input = document.getElementById("global-search") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(step));
  } else {
    window.setTimeout(step, 32);
  }
}

export function SystemView() {
  const systemFocus = useField((s) => s.systemFocus);
  const setMode = useField((s) => s.setMode);
  const selectPaper = useField((s) => s.selectPaper);
  const clearSystemFocus = useField((s) => s.clearSystemFocus);
  const setSettingsLeaveGuard = useField((s) => s.setSettingsLeaveGuard);
  const pendingMode = useField((s) => s.pendingMode);
  const continuePendingMode = useField((s) => s.continuePendingMode);
  const cancelPendingMode = useField((s) => s.cancelPendingMode);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [activeCard, setActiveCard] = useState<SystemCardId>("llm");
  const [focusedCard, setFocusedCard] = useState<SystemCardId | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visibleCards = SYSTEM_CARDS.filter((card) => settingsCardMatches(card, query));
  const show = (id: SystemCardId) => visibleCards.some((card) => card.id === id);

  // 滚动高亮当前卡片（目录 is-active）。jsdom 没有 IntersectionObserver：跳过高亮，目录仍可点击。
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const root = scrollRef.current;
    if (!root) return;
    const elements = SYSTEM_CARDS.filter((card) => settingsCardMatches(card, query))
      .map((card) => document.getElementById(`settings-${card.id}`))
      .filter((el): el is HTMLElement => el !== null);
    if (!elements.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0]?.target.id;
        if (top) setActiveCard(top.replace("settings-", "") as SystemCardId);
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [query]);

  // 深链：从通知「去设置」等入口跳进来时，滚动到对应卡片并短暂高亮。
  useEffect(() => {
    if (!systemFocus) return;
    const el = document.getElementById(`settings-${systemFocus.anchor}`);
    if (!el) return;
    el.scrollIntoView?.({ block: "start" });
    setFocusedCard(systemFocus.anchor as SystemCardId);
    const timer = window.setTimeout(() => setFocusedCard(null), 2400);
    return () => window.clearTimeout(timer);
  }, [systemFocus]);

  async function returnToPrevious() {
    const target = systemFocus?.returnTo;
    if (!target) return;
    clearSystemFocus();
    try {
      await setMode(target.mode);
      if (target.paperId) await selectPaper(target.paperId);
    } catch {
      // 返回途中出错不影响已清除的深链状态；模式切换失败有各自的提示。
    }
  }

  // 离开守卫：setMode 离开设置页前询问（有未保存修改时记 pendingMode，本页弹三选）。
  useEffect(() => {
    setSettingsLeaveGuard(() => settingsGuards.some((entry) => entry.isDirty()));
    return () => setSettingsLeaveGuard(null);
  }, [setSettingsLeaveGuard]);

  // 关窗 / 刷新前的最后保护（浏览器预览生效；桌面端以离开拦截为主）。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (settingsGuards.some((entry) => entry.isDirty())) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  async function saveAllAndLeave() {
    setLeaveError(null);
    const dirty = dirtySettingsCards();
    try {
      for (const entry of dirty) await entry.save();
      await continuePendingMode();
    } catch (err) {
      setLeaveError(`保存失败：${errText(err)}。可以重试、放弃修改，或留在此页。`);
    }
  }

  function discardAllAndLeave() {
    for (const entry of dirtySettingsCards()) entry.discard();
    setLeaveError(null);
    void continuePendingMode();
  }

  const dirtyCards = pendingMode !== null ? dirtySettingsCards() : [];

  const backLabel = systemFocus?.returnTo
    ? systemFocus.returnTo.paperId
      ? "返回原论文"
      : `返回${MODE_LABELS[systemFocus.returnTo.mode].zh}模式`
    : "";

  return (
    <section className="ef-read" id="stage" aria-labelledby="system-title">
      <div className="ef-system" ref={scrollRef}>
        <div className="ef-system-inner">
          <div className="ef-system-head">
            <h1 id="system-title">设置</h1>
            <p className="lede">
              AI Key 与 MinerU Token 只保存在本机。没有 AI Key 也能完整手动录入论文与笔记；AI 不会自动把论文标成已读。
            </p>
            {systemFocus?.returnTo ? (
              <p className="ef-system-back">
                <Button type="button" size="sm" onClick={() => void returnToPrevious()}>
                  ← {backLabel}
                </Button>
              </p>
            ) : null}
          </div>

          <div className="ef-system-layout">
            <nav className="ef-system-nav" aria-label="设置目录">
              <label className="ef-system-search">
                <span>查找设置</span>
                <input
                  type="search"
                  value={query}
                  placeholder="关键词定位卡片"
                  aria-label="查找设置"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setQuery("");
                  }}
                />
              </label>
              <ul>
                {visibleCards.map((card) => (
                  <li key={card.id}>
                    <a
                      href={`#settings-${card.id}`}
                      className={activeCard === card.id ? "is-active" : ""}
                      aria-current={activeCard === card.id ? "true" : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(`settings-${card.id}`)?.scrollIntoView?.({ block: "start" });
                        setActiveCard(card.id);
                      }}
                    >
                      {card.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="ef-system-blocks">
              {visibleCards.length === 0 ? (
                <p className="ef-system-no-match" role="status">
                  没有找到与「{query.trim()}」相关的设置项。试试「Key」「导出」「解析」等关键词。
                </p>
              ) : null}

              {show("setup") ? <SetupChecklistBlock focused={focusedCard === "setup"} /> : null}

              {show("llm") ? <LlmSettingsBlock focused={focusedCard === "llm"} /> : null}

              {show("secrets") ? <SecretsOverview focused={focusedCard === "secrets"} /> : null}

              {show("export") ? <ExportBlock focused={focusedCard === "export"} /> : null}

              {show("backup") ? <BackupBlock focused={focusedCard === "backup"} /> : null}

              {show("shortcuts") ? <ShortcutsBlock focused={focusedCard === "shortcuts"} /> : null}

              {show("update") ? <UpdateBlock focused={focusedCard === "update"} /> : null}

              {show("mineru") ? <MineruSettings focused={focusedCard === "mineru"} /> : null}

              {show("biblio") ? <BiblioSettings focused={focusedCard === "biblio"} /> : null}

              {show("logs") ? <LogPanel focused={focusedCard === "logs"} /> : null}
            </div>
          </div>
        </div>
      </div>

      {/* 离开守卫三选：保存修改 / 放弃修改 / 留在此页；Esc 与遮罩等同「留在此页」。 */}
      <Dialog
        open={pendingMode !== null}
        title="设置页有未保存的修改"
        onClose={() => {
          setLeaveError(null);
          cancelPendingMode();
        }}
        footer={
          <>
            <Button type="button" variant="primary" onClick={() => void saveAllAndLeave()}>
              保存修改并离开
            </Button>
            <Button type="button" variant="danger" onClick={discardAllAndLeave}>
              放弃修改并离开
            </Button>
            <Button type="button" onClick={() => cancelPendingMode()}>
              留在此页
            </Button>
          </>
        }
      >
        <p>以下设置卡有未保存的修改：</p>
        <ul>
          {dirtyCards.map((entry) => (
            <li key={entry.id}>{entry.title}</li>
          ))}
        </ul>
        <p>离开前想怎么处理？未保存的非敏感草稿已在本机保留（不含 Key 与 Token）。</p>
        {leaveError ? (
          <p className="ef-probe-line is-error" role="alert">
            {leaveError}
          </p>
        ) : null}
      </Dialog>
    </section>
  );
}

/**
 * 上手清单：最小可用配置路径（领域 → 导入论文 → 解析源 → 可选 AI / 文献库邮箱），
 * 每项显示实际状态并提供「去配置」直达入口。只读真实状态，不做假向导。
 */
function SetupChecklistBlock({ focused }: { focused: boolean }) {
  const domains = useField((s) => s.domains);
  const stats = useField((s) => s.stats);
  const mineru = useField((s) => s.mineru);
  const effectiveProvider = useField((s) => s.effectiveProvider);
  const settings = useField((s) => s.settings);
  const biblio = useField((s) => s.biblio);
  const openDialog = useField((s) => s.openDialog);
  const setMode = useField((s) => s.setMode);
  const openSystemCard = useField((s) => s.openSystemCard);

  const aiReady = hasUsableProvider(settings);
  const emailReady = biblioEmailConfigured(biblio.email);

  const items: Array<{
    key: string;
    title: string;
    done: boolean;
    required?: boolean;
    detail: string;
    action: { label: string; run: () => void };
  }> = [
    {
      key: "domain",
      title: "研究领域",
      done: domains.length > 0,
      required: true,
      detail: domains.length ? `已建 ${domains.length} 个领域` : "先建一个领域，论文按领域组织",
      action: { label: "去创建领域", run: () => openDialog("domain") },
    },
    {
      key: "papers",
      title: "导入论文",
      done: stats.total > 0,
      required: true,
      detail: stats.total ? `库内共 ${stats.total} 篇` : "导入 PDF 或手动录入第一篇论文",
      action: {
        label: "去导入论文",
        run: () => {
          void setMode("field")
            .then(() => openDialog("paper"))
            .catch(() => {});
        },
      },
    },
    {
      key: "mineru",
      title: "解析源（可选）",
      done: mineru.configured,
      detail: mineru.configured
        ? effectiveProvider
          ? `已启用，生效来源：${providerLabel(effectiveProvider)}`
          : "已启用，但探测未通过，可查看失败原因"
        : "未启用：导入只入库、不解析，仍可手动阅读与记笔记",
      action: { label: "去配置", run: () => openSystemCard("mineru") },
    },
    {
      key: "ai",
      title: "AI 服务（可选）",
      done: aiReady,
      detail: aiReady
        ? "已配置，可补全论文信息与起草笔记"
        : "未配置：可完整手动录入，AI 只用于预填与起草",
      action: { label: "去配置", run: () => openSystemCard("llm") },
    },
    {
      key: "biblio",
      title: "文献库邮箱（可选）",
      done: emailReady,
      detail: emailReady
        ? "Crossref 走礼貌池，著录查询更快"
        : "未配置：匿名也能查，只是走公共额度",
      action: { label: "去配置", run: () => openSystemCard("biblio") },
    },
  ];

  const doneCount = items.filter((item) => item.done).length;

  return (
    <article
      id="settings-setup"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      aria-label="上手清单"
    >
      <header className="ef-block-head">
        <h3>上手清单</h3>
        <p>
          最小可用路径：领域 → 导入论文 → 解析源 →（可选）AI 服务。前两项是核心，其余按需配置。
        </p>
      </header>
      <ul className="ef-setup-list">
        {items.map((item) => (
          <li key={item.key} className={`ef-setup-item${item.done ? " is-done" : ""}`}>
            <span className="ef-setup-dot" aria-hidden="true" />
            <span className="ef-setup-text">
              <b>{item.title}</b>
              <span className="ef-setup-detail">{item.detail}</span>
            </span>
            <span className="ef-setup-state">{item.done ? "已完成" : item.required ? "待完成" : "可选"}</span>
            {item.done ? null : (
              <Button type="button" size="sm" onClick={item.action.run}>
                {item.action.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="ef-setup-summary">
        进度：<b>{doneCount}</b> / {items.length}
        {doneCount === items.length ? " · 全部就绪，可以开始阅读了。" : " · 没有配置的部分不影响手动录入与阅读。"}
      </p>
    </article>
  );
}

/**
 * 数据导出卡：范围（当前领域 / 全库 / 仅已读 / 勾选集 / 单篇）+ 内容选择（笔记 /
 * 摘要 / 解析全文）+ 导出前预览。桌面端按领域分文件夹写入；浏览器预览下载单个合并文件。
 */
const EXPORT_SCOPES = [
  { id: "current", label: "当前领域" },
  { id: "all", label: "全部领域（按领域分文件夹）" },
  { id: "read", label: "仅已读（全库）" },
  { id: "checked", label: "勾选的论文（批量模式勾选集）" },
  { id: "paper", label: "当前论文" },
] as const;

type ExportScopeId = (typeof EXPORT_SCOPES)[number]["id"];

const EXPORT_FORMATS = [
  { id: "folders", label: "Markdown 文件夹（每篇一个文件）" },
  { id: "merged", label: "单文件 Markdown（合并版，便于分享）" },
  { id: "bibtex", label: "BibTeX（.bib，导入引用管理器）" },
] as const;

type ExportFormatId = (typeof EXPORT_FORMATS)[number]["id"];

function ExportBlock({ focused }: { focused: boolean }) {
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const domain = domains.find((d) => d.id === selectedDomainId);
  const papers = useField((s) => s.papers);
  const stats = useField((s) => s.stats);
  const checkedPaperIds = useField((s) => s.checkedPaperIds);
  const paper = useField((s) => s.paper);
  const exportPapers = useField((s) => s.exportPapers);

  const [scope, setScope] = useState<ExportScopeId>("current");
  const [format, setFormat] = useState<ExportFormatId>("folders");
  const [include, setInclude] = useState<ExportContentOptions>({ notes: true, abstract: true, parsedText: false });

  const scopeLabel = EXPORT_SCOPES.find((item) => item.id === scope)!.label;
  const previewCount =
    scope === "current"
      ? papers.length
      : scope === "all"
        ? stats.total
        : scope === "read"
          ? stats.read
          : scope === "checked"
            ? checkedPaperIds.length
            : paper
              ? 1
              : 0;
  const includeBits =
    [include.notes ? "现场笔记" : null, include.abstract ? "摘要" : null, include.parsedText ? "解析全文" : null]
      .filter(Boolean)
      .join("、") || "仅著录信息";
  const isBibtex = format === "bibtex";

  return (
    <article
      id="settings-export"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 3 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>数据导出</h3>
        <p>导出为 Markdown：每个领域一个文件夹（README + 每篇论文一个文件）。浏览器预览下载单个合并文件。</p>
      </header>
      <div className="ef-field-grid">
        <Field label="导出范围">
          <select aria-label="导出范围" value={scope} onChange={(e) => setScope(e.target.value as ExportScopeId)}>
            {EXPORT_SCOPES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="导出格式">
          <select aria-label="导出格式" value={format} onChange={(e) => setFormat(e.target.value as ExportFormatId)}>
            {EXPORT_FORMATS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {isBibtex ? (
        <p className="ef-export-preview">BibTeX 只包含著录信息（标题 / 作者 / 年份 / 出处 / DOI / arXiv），不含笔记与全文。</p>
      ) : (
        <fieldset className="ef-export-content">
          <legend>导出内容</legend>
          <label>
            <input
              type="checkbox"
              checked={include.notes}
              onChange={(e) => setInclude((prev) => ({ ...prev, notes: e.target.checked }))}
            />
            现场笔记
          </label>
          <label>
            <input
              type="checkbox"
              checked={include.abstract}
              onChange={(e) => setInclude((prev) => ({ ...prev, abstract: e.target.checked }))}
            />
            摘要
          </label>
          <label>
            <input
              type="checkbox"
              checked={include.parsedText}
              onChange={(e) => setInclude((prev) => ({ ...prev, parsedText: e.target.checked }))}
            />
            解析全文
          </label>
        </fieldset>
      )}
      <p className="ef-export-preview">
        将导出 <b>{previewCount}</b> {isBibtex ? "条 BibTeX 条目" : "篇"} · {scopeLabel}
        {!isBibtex ? ` · 内容：${includeBits}` : ""}
        {scope === "paper" && !paper ? "（当前没有打开的论文）" : ""}
      </p>
      <Button
        type="button"
        disabled={previewCount === 0}
        onClick={() => void exportPapers({ scope, format, include })}
      >
        导出{scope === "current" ? ` ${domain?.name ?? "当前领域"}` : ""}
      </Button>
    </article>
  );
}

/**
 * 快捷键说明卡：固定展示全部全局快捷键，可点击「试用」直接触发同一行为
 * （需要论文上下文的动作会先切回阅读模式）。
 */
function ShortcutsBlock({ focused }: { focused: boolean }) {
  const openDialog = useField((s) => s.openDialog);
  const closeDialog = useField((s) => s.closeDialog);
  const setMode = useField((s) => s.setMode);
  const setJobsOpen = useField((s) => s.setJobsOpen);
  const markRead = useField((s) => s.markRead);

  function tryShortcut(id: string) {
    if (id === "add") {
      openDialog("paper");
    } else if (id === "read") {
      void setMode("field")
        .then(() => {
          const state = useField.getState();
          if (state.paper) void markRead(state.paper.id);
          else state.setFlash({ tone: "warn", text: "当前没有选中的论文，无法试用「标记已读」。" });
        })
        .catch(() => {});
    } else if (id === "search") {
      void setMode("field")
        .then(focusGlobalSearchSoon)
        .catch(() => {});
    } else if (id === "jobs") {
      setJobsOpen(!useField.getState().jobsOpen);
    } else if (id === "esc") {
      closeDialog();
      setJobsOpen(false);
    }
  }

  const rows: Array<{ id?: string; label: string; keys: ReactNode }> = [
    { label: "在论文列表中移动", keys: <><span className="kbd">↑</span><span className="kbd">↓</span></> },
    { id: "add", label: "添加论文（导入 PDF / 手动录入）", keys: <span className="kbd">{shortcut("N")}</span> },
    { id: "read", label: "标记已读", keys: <span className="kbd">{shortcut("R")}</span> },
    { id: "search", label: "搜索", keys: <span className="kbd">{shortcut("K")}</span> },
    { id: "jobs", label: "作业面板", keys: <span className="kbd">{shortcut("J")}</span> },
    { label: "关闭对话框 / 抽屉", keys: <span className="kbd">Esc</span> },
  ];

  return (
    <article
      id="settings-shortcuts"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 4 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>快捷键</h3>
      </header>
      <ul className="ef-kbd-list">
        {rows.map((row) => (
          <li key={row.id ?? row.label}>
            <span>{row.label}</span>
            <span>
              {row.keys}
              {row.id ? (
                <button
                  type="button"
                  className="ef-kbd-try"
                  aria-label={`试用：${row.label}`}
                  onClick={() => tryShortcut(row.id!)}
                >
                  试用
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="ef-kbd-note">在设置页按 {shortcut("K")} 会先切回阅读模式，再聚焦论文列表上方的搜索框。</p>
    </article>
  );
}

function BackupBlock({ focused }: { focused: boolean }) {
  const backup = useField((s) => s.backupLibrary);
  const restore = useField((s) => s.restoreLibrary);
  const stats = useField((s) => s.stats);
  const [confirming, setConfirming] = useState(false);
  // 备份预检：论文数来自状态条统计，PDF 数读库（失败降级为 —）。
  const [pdfs, setPdfs] = useState<number | null>(null);
  const [lastBackup, setLastBackup] = useState<BackupRecord | null>(() => readLastBackup());

  useEffect(() => {
    let cancelled = false;
    // 读不到 PDF 数（引擎不可用 / 旧 mock）时降级为 —，不阻塞备份卡。
    Promise.resolve()
      .then(() => repo.pdfCount())
      .then((count) => {
        if (!cancelled) setPdfs(count);
      })
      .catch(() => {
        if (!cancelled) setPdfs(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const days = lastBackup ? daysSinceBackup(lastBackup.at) : null;
  const stale = days !== null && days >= BACKUP_STALE_DAYS;
  const lastBackupAt = lastBackup ? new Date(lastBackup.at) : null;

  async function runBackup() {
    await backup();
    setLastBackup(readLastBackup());
  }

  return (
    <article
      id="settings-backup"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 4 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>备份与恢复</h3>
        <p>打包数据库、文库中的 PDF 和设置。API Key 与 MinerU Token 不写入压缩包。恢复前会先另存当前数据库。</p>
      </header>
      <p className={`ef-backup-status${stale || !lastBackup ? " is-warn" : ""}`} role="status">
        {lastBackup && lastBackupAt && !Number.isNaN(lastBackupAt.getTime()) ? (
          <>
            上次备份：{formatDate(lastBackupAt.toISOString())} {pad2(lastBackupAt.getHours())}:
            {pad2(lastBackupAt.getMinutes())} · 共 {lastBackup.papers} 篇 · 保存于 {lastBackup.where} · 距今{" "}
            {days === 0 ? "不足 1 天" : `${days} 天`}
            {stale ? `（已超过 ${BACKUP_STALE_DAYS} 天，建议再备份一次）` : ""}
          </>
        ) : (
          <>本机还没有成功备份的记录，建议立即备份一次。</>
        )}
      </p>
      <p className="ef-backup-precheck">
        本次将打包：论文 <b>{stats.total}</b> 篇 · PDF <b>{pdfs === null ? "—" : pdfs}</b> 个。预估大小与目标磁盘
        剩余空间由桌面端在写入时校验，空间不足会失败并提示，不会产生半个备份。
      </p>
      <div className="ef-ai-buttons">
        <Button type="button" onClick={() => void runBackup()}>
          备份
        </Button>
        <Button type="button" onClick={() => setConfirming(true)}>
          恢复
        </Button>
      </div>
      {confirming ? (
        <div className="ef-ai-buttons">
          <p>恢复会替换当前文库。当前数据库会先复制一份。</p>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setConfirming(false);
              void restore();
            }}
          >
            确认恢复
          </Button>
          <Button type="button" onClick={() => setConfirming(false)}>
            取消
          </Button>
        </div>
      ) : null}
      <PreRestoreList />
    </article>
  );
}

// ---------- AI 服务设置（多提供商 v2：预设 + 模型发现 + 测试连接 + 顺序回退 + 用量） ----------

/** 预设下拉里「自定义」项的哨兵值（presetId 存 null）。 */
const CUSTOM_PRESET = "__custom__";

/** 可编辑行 = 公共视图 + 本地 Key 草稿（空串 = 留空保持，三态在保存边界统一）。 */
interface ProviderRow extends LlmProviderView {
  apiKeyDraft: string;
}

function toRow(view: LlmProviderView): ProviderRow {
  return { ...view, apiKeyDraft: "" };
}

/** 门禁派生口径（与 hasUsableProvider 对齐）：enabled 且（requiresKey ? 已存或新填 Key : 免 Key）。 */
function rowUsable(row: ProviderRow): boolean {
  return row.enabled && (!row.requiresKey || row.hasKey || row.apiKeyDraft.trim().length > 0);
}

function keyFieldLabel(row: ProviderRow): string {
  if (row.keyState === "unreadable") return "API Key（读取失败，不是未保存）";
  if (!row.requiresKey) return "API Key（免 Key 服务 · 可留空）";
  return row.hasKey ? "API Key（已保存 · 留空保持不变）" : "API Key（尚未配置）";
}

function formatUsedAt(lastUsedAt: number | null | undefined): string {
  if (!lastUsedAt) return "—";
  const date = new Date(lastUsedAt);
  if (Number.isNaN(date.getTime())) return "—";
  return `${formatDate(date.toISOString())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function LlmSettingsBlock({ focused }: { focused: boolean }) {
  const saved = useField((s) => s.settings);
  const saveLlmSettings = useField((s) => s.saveLlmSettings);
  const llmLoadError = useField((s) => s.settingsLoadError.llm);
  const secretsLoadError = useField((s) => s.settingsLoadError.secrets);

  const [rows, setRows] = useState<ProviderRow[]>(saved.providers.map(toRow));
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { tone: "ok" | "error"; text: string }>>({});
  const [modelResults, setModelResults] = useState<Record<string, { tone: "ok" | "error"; text: string }>>({});
  const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClearKeyId, setConfirmClearKeyId] = useState<string | null>(null);
  const [addChoice, setAddChoice] = useState(LLM_PRESETS[0]?.id ?? CUSTOM_PRESET);
  const [draftRestored, setDraftRestored] = useState(false);

  useEffect(() => {
    setRows(saved.providers.map(toRow));
    setConfirmDeleteId(null);
    setConfirmClearKeyId(null);
    // 保存成功（saved 变化）即草稿已被采纳：清掉「已恢复草稿」提示。
    setDraftRestored(false);
  }, [saved]);

  // 恢复上次未保存的非敏感草稿（不含 API Key；按提供商 id 合并到当前行）。
  useEffect(() => {
    const draft = readSettingsDraft<{ providers: Array<Record<string, unknown>> }>(LLM_DRAFT_KEY);
    if (!draft?.providers?.length) return;
    setRows((prev) =>
      prev.map((row) => {
        const item = draft.providers.find((provider) => provider.id === row.id);
        return item ? { ...row, ...item, apiKeyDraft: row.apiKeyDraft } : row;
      }),
    );
    setDraftRestored(true);
    // 只在挂载时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateRow(id: string, patch: Partial<ProviderRow>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function currentInput(nextRows: ProviderRow[] = rows): LlmSaveInput {
    return {
      providers: nextRows.map((row) => ({
        id: row.id,
        presetId: row.presetId,
        label: row.label.trim() || "自定义服务",
        baseUrl: row.baseUrl.trim(),
        model: row.model.trim(),
        enabled: row.enabled,
        requiresKey: row.requiresKey,
        // 留空 = 保留已存（null 三态）；显式清除走「清除 Key」按钮（空串）。
        apiKey: row.apiKeyDraft.trim() ? row.apiKeyDraft.trim() : null,
      })),
    };
  }

  function isDirty(): boolean {
    const cur = currentInput().providers;
    if (cur.length !== saved.providers.length) return true;
    return cur.some((provider, index) => {
      const old = saved.providers[index];
      return (
        !old ||
        old.id !== provider.id ||
        old.presetId !== provider.presetId ||
        old.label !== provider.label ||
        old.baseUrl !== provider.baseUrl ||
        old.model !== provider.model ||
        old.enabled !== provider.enabled ||
        old.requiresKey !== provider.requiresKey ||
        // Key 三态：null=保留已存（不脏）；非空草稿=替换已存（必脏——盘上 Key 不回显，
        // 输入了就是换新，测试连接前须先落盘）；空串=清除（已存才脏）。
        // Key 三态：null=保留已存（不脏）；非空草稿=替换已存（必脏——盘上 Key 不回显，
        // 输入了就是换新，测试连接前须先落盘）；空串=清除（已存才脏）。
        provider.apiKey !== null && (provider.apiKey !== "" || old.hasKey)
      );
    });
  }

  function resetFromSaved(): void {
    setRows(saved.providers.map(toRow));
    setMessage(null);
    // 丢弃 / 保存后草稿已被采纳或放弃：同步清键，不等重渲染（组件可能随即卸载）。
    writeSettingsDraft(LLM_DRAFT_KEY, null);
  }

  // 离开守卫 + 非敏感草稿：dirty 时写本机草稿（不含 Key），干净时清掉。
  const dirty = isDirty();
  useSettingsGuard("llm", "AI 服务设置", {
    isDirty,
    save: async () => {
      await saveLlmSettings(currentInput());
    },
    discard: resetFromSaved,
  });
  useEffect(() => {
    writeSettingsDraft(
      LLM_DRAFT_KEY,
      dirty
        ? {
            providers: rows.map((row) => ({
              id: row.id,
              presetId: row.presetId,
              label: row.label,
              baseUrl: row.baseUrl,
              model: row.model,
              enabled: row.enabled,
              requiresKey: row.requiresKey,
            })),
          }
        : null,
    );
  });

  function applyPreset(id: string, value: string) {
    if (value === CUSTOM_PRESET) {
      // 自定义只换身份，不覆盖手填的地址与模型。
      updateRow(id, { presetId: null, label: "自定义服务" });
      return;
    }
    const preset = presetById(value);
    if (!preset) return;
    updateRow(id, {
      presetId: preset.id,
      label: preset.label,
      baseUrl: preset.baseUrl,
      // 推荐模型直接落到输入框；无推荐（如 Ollama）留空，等「获取模型列表」。
      model: preset.models[0] ?? "",
      requiresKey: preset.requiresKey,
    });
  }

  function addProvider() {
    const preset = presetById(addChoice);
    const row: ProviderRow = {
      id: uid(),
      presetId: preset?.id ?? null,
      label: preset?.label ?? "自定义服务",
      baseUrl: preset?.baseUrl ?? "",
      model: preset?.models[0] ?? "",
      enabled: true,
      hasKey: false,
      requiresKey: preset?.requiresKey ?? true,
      apiKeyDraft: "",
    };
    setRows((prev) => [...prev, row]);
    setMessage(null);
  }

  function moveRow(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setRows(next);
    setMessage(null);
    // 顺序即回退优先级：调整后立即保存（同 Mineru 回退顺序的口径）。
    void saveLlmSettings(currentInput(next)).catch((err: unknown) => {
      setMessage({ tone: "error", text: `保存回退顺序失败：${errText(err)}。` });
    });
  }

  async function removeRow(id: string) {
    const next = rows.filter((row) => row.id !== id);
    setConfirmDeleteId(null);
    setRows(next);
    setMessage(null);
    try {
      await saveLlmSettings(currentInput(next));
    } catch (err) {
      setMessage({ tone: "error", text: `删除提供商失败：${errText(err)}。` });
    }
  }

  async function clearKey(id: string) {
    setConfirmClearKeyId(null);
    setMessage(null);
    try {
      // 三态里的「清除」：该行传空串，其余行保持 null（保留已存）。
      const providers = currentInput().providers.map((provider) =>
        provider.id === id ? { ...provider, apiKey: "" } : provider,
      );
      await saveLlmSettings({ providers });
      updateRow(id, { apiKeyDraft: "", hasKey: false });
      setMessage({ tone: "ok", text: "已清除该提供商在本机保存的 API Key。" });
    } catch (err) {
      setMessage({ tone: "error", text: `清除 Key 失败：${errText(err)}。` });
    }
  }

  async function testRow(row: ProviderRow) {
    setMessage(null);
    setTestingId(row.id);
    try {
      // 表单有未保存修改时先落盘，测试的才是用户眼前这份配置。
      if (isDirty()) await saveLlmSettings(currentInput());
      const result = await testLlmProvider(row.id);
      setTestResults((prev) => ({
        ...prev,
        [row.id]: result.ok
          ? { tone: "ok", text: `${result.message} · ${result.latencyMs}ms` }
          : { tone: "error", text: result.message },
      }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [row.id]: { tone: "error", text: errText(err) } }));
    } finally {
      setTestingId(null);
    }
  }

  async function fetchModels(row: ProviderRow) {
    setMessage(null);
    setFetchingId(row.id);
    try {
      if (isDirty()) await saveLlmSettings(currentInput());
      const models = await listLlmModels(row.id);
      setFetchedModels((prev) => ({ ...prev, [row.id]: models }));
      setModelResults((prev) => ({
        ...prev,
        [row.id]: { tone: "ok", text: `已获取 ${models.length} 个模型，可在「模型」输入框的下拉中选择。` },
      }));
    } catch (err) {
      setModelResults((prev) => ({ ...prev, [row.id]: { tone: "error", text: errText(err) } }));
    } finally {
      setFetchingId(null);
    }
  }

  const enabledCount = rows.filter((row) => row.enabled).length;
  const firstUsable = rows.find(rowUsable);
  const statusTone = firstUsable ? "is-ok" : rows.length ? "is-error" : "";

  return (
    <article
      id="settings-llm"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 0 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>AI 服务设置</h3>
        {dirty ? <span className="ef-dirty-badge">未保存</span> : null}
        <p>
          配置 OpenAI 兼容的 AI 服务，可添加多个提供商并按顺序自动回退；保存后即可使用「补全论文信息」与「起草阅读笔记」。
        </p>
      </header>
      {draftRestored ? (
        <p className="ef-draft-note">
          已恢复上次未保存的草稿（不含 API Key）。
          <Button type="button" size="sm" onClick={() => { resetFromSaved(); setDraftRestored(false); }}>
            丢弃草稿
          </Button>
        </p>
      ) : null}
      {llmLoadError ? (
        <p className="ef-probe-line is-error" role="alert">
          {llmLoadError}
        </p>
      ) : null}
      {secretsLoadError ? (
        <p className="ef-probe-line is-error" role="alert">
          {secretsLoadError}
        </p>
      ) : null}

      <div className={`ef-statusbar ${statusTone}`} aria-live="polite">
        <span className="ef-statusbar-dot" aria-hidden="true" />
        {firstUsable ? (
          <span className="ef-statusbar-text">
            已启用 {enabledCount} 个提供商 · 当前生效：<b>{firstUsable.label}</b>
            <span className="ef-probe-ms">按顺序自动回退</span>
          </span>
        ) : rows.length ? (
          <span className="ef-statusbar-text is-error">
            已添加 {rows.length} 个提供商，但没有可用的：请启用并填写 API Key，或使用免 Key 的本地服务。
          </span>
        ) : (
          <span className="ef-statusbar-text">
            尚未配置任何 AI 服务。可在下方添加提供商，或继续手动录入论文与笔记。
          </span>
        )}
      </div>

      <div className="ef-provider-grid">
        {rows.map((row, index) => {
          const active = firstUsable?.id === row.id;
          const preset = presetById(row.presetId);
          // 模型候选 = 拉取列表 ∪ 预设推荐（去重，拉取的在前列出）。
          const modelOptions = [...new Set([...(fetchedModels[row.id] ?? []), ...(preset?.models ?? [])])];
          return (
            <section
              key={row.id}
              className={`ef-provider-card${row.enabled ? "" : " is-off"}${active ? " is-active" : ""}`}
              aria-label={row.label}
            >
              <header>
                <label className="ef-provider-toggle">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => updateRow(row.id, { enabled: e.target.checked })}
                  />
                  <strong>{row.label}</strong>
                </label>
                {active ? <span className="ef-active-badge">生效中</span> : null}
                <span className="ef-provider-tools">
                  <button
                    type="button"
                    className="ef-sort-btn"
                    aria-label={`上移${row.label}`}
                    disabled={index === 0}
                    onClick={() => moveRow(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ef-sort-btn"
                    aria-label={`下移${row.label}`}
                    disabled={index === rows.length - 1}
                    onClick={() => moveRow(index, 1)}
                  >
                    ↓
                  </button>
                </span>
              </header>
              {/* 四字段共用同一 2×2 栅格：列宽一致、右边缘对齐（窄屏 1 列折叠）。 */}
              <div className="ef-field-grid">
                <Field label="预设">
                  <select
                    value={row.presetId ?? CUSTOM_PRESET}
                    onChange={(e) => applyPreset(row.id, e.target.value)}
                  >
                    {LLM_PRESETS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                    <option value={CUSTOM_PRESET}>自定义</option>
                  </select>
                </Field>
                <Field label="Base URL">
                  <input
                    value={row.baseUrl}
                    onChange={(e) => updateRow(row.id, { baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
                <Field label="模型">
                  <ModelCombobox
                    value={row.model}
                    options={modelOptions}
                    onChange={(model) => updateRow(row.id, { model })}
                    placeholder="model-id"
                    label="模型"
                  />
                </Field>
                <Field label={keyFieldLabel(row)}>
                  <input
                    type="password"
                    value={row.apiKeyDraft}
                    onChange={(e) => updateRow(row.id, { apiKeyDraft: e.target.value })}
                    placeholder={row.hasKey ? "••••••••" : "sk-..."}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="ef-import-actions">
                <Button
                  type="button"
                  size="sm"
                  disabled={testingId === row.id}
                  onClick={() => void testRow(row)}
                >
                  {testingId === row.id ? "测试中…" : "测试连接"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={fetchingId === row.id}
                  onClick={() => void fetchModels(row)}
                >
                  {fetchingId === row.id ? "获取中…" : "获取模型列表"}
                </Button>
                {row.hasKey ? (
                  confirmClearKeyId === row.id ? (
                    <Button
                      type="button"
                      size="sm"
                      className="ef-btn-danger-solid"
                      onClick={() => void clearKey(row.id)}
                    >
                      确认清除 Key
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      onClick={() => setConfirmClearKeyId(row.id)}
                    >
                      清除 Key…
                    </Button>
                  )
                ) : null}
                {confirmDeleteId === row.id ? (
                  <Button
                    type="button"
                    size="sm"
                    className="ef-btn-danger-solid"
                    onClick={() => void removeRow(row.id)}
                  >
                    确认删除
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="danger" onClick={() => setConfirmDeleteId(row.id)}>
                    删除…
                  </Button>
                )}
              </div>
              {testResults[row.id] ? (
                <p className={`ef-probe-line ${testResults[row.id]!.tone === "ok" ? "is-ok" : "is-error"}`}>
                  {testResults[row.id]!.text}
                </p>
              ) : null}
              {modelResults[row.id] ? (
                <p className={`ef-probe-line ${modelResults[row.id]!.tone === "ok" ? "is-ok" : "is-error"}`}>
                  {modelResults[row.id]!.text}
                </p>
              ) : null}
            </section>
          );
        })}
      </div>

      <div className="ef-add-provider" role="group" aria-label="添加提供商">
        <span className="ef-add-label">添加提供商</span>
        <select aria-label="提供商预设" value={addChoice} onChange={(e) => setAddChoice(e.target.value)}>
          {LLM_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
              {preset.requiresKey ? "" : "（免 Key）"}
            </option>
          ))}
          <option value={CUSTOM_PRESET}>自定义…</option>
        </select>
        <Button type="button" size="sm" onClick={addProvider}>
          添加提供商
        </Button>
      </div>

      {saved.providers.length ? (
        <div className="ef-usage">
          <span className="ef-params-label">用量小结</span>
          <table className="ef-usage-table">
            <thead>
              <tr>
                <th>提供商</th>
                <th className="num">请求</th>
                <th className="num">失败</th>
                <th className="num">Tokens 入</th>
                <th className="num">Tokens 出</th>
                <th>最近使用</th>
              </tr>
            </thead>
            <tbody>
              {saved.providers.map((provider) => {
                const usage = saved.usage[provider.id];
                return (
                  <tr key={provider.id}>
                    <td>{provider.label}</td>
                    <td className="num">{usage?.requests ?? 0}</td>
                    <td className="num">{usage?.errors ?? 0}</td>
                    <td className="num">{usage?.inputTokens ?? 0}</td>
                    <td className="num">{usage?.outputTokens ?? 0}</td>
                    <td>{formatUsedAt(usage?.lastUsedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <footer className="ef-block-foot">
        <Button
          variant="primary"
          type="button"
          onClick={() => {
            setMessage(null);
            void saveLlmSettings(currentInput())
              .then(() =>
                setMessage({
                  tone: "ok",
                  text: `AI 服务设置已保存（已启用 ${rows.filter((row) => row.enabled).length} 个提供商）。`,
                }),
              )
              .catch((err: unknown) => {
                setMessage({ tone: "error", text: `保存 AI 服务设置失败：${errText(err)}。` });
              });
          }}
        >
          保存设置
        </Button>
        {message ? (
          <span className={`ef-foot-msg is-${message.tone}`}>
            {message.text}
          </span>
        ) : null}
      </footer>
    </article>
  );
}

function AdvancedFields({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ef-advanced${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="ef-advanced-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="right" />
        高级
      </button>
      {open ? <div className="ef-advanced-body">{children}</div> : null}
    </div>
  );
}

function SettingsLoadError({ which }: { which: "mineru" | "biblio" }) {
  const message = useField((s) => s.settingsLoadError[which]);
  if (!message) return null;
  const name = which === "mineru" ? "MinerU" : "文献库";
  return (
    <p className="ef-probe-line is-error" role="alert">
      {name}设置文件无法读取，下面显示的是默认值，原文件未被改动。保存前请先修复或删除该文件。错误：{message}
    </p>
  );
}

function BiblioSettings({ focused }: { focused: boolean }) {
  const saved = useField((s) => s.biblio);
  const saveBiblio = useField((s) => s.saveBiblioSettings);
  const [email, setEmail] = useState(saved.email);
  const [openalexKey, setOpenalexKey] = useState("");
  const [s2Key, setS2Key] = useState("");
  const [clearOpenalex, setClearOpenalex] = useState(false);
  const [clearS2, setClearS2] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);

  function resetFromSaved(): void {
    writeSettingsDraft(BIBLIO_DRAFT_KEY, null);
    setEmail(saved.email);
    setOpenalexKey("");
    setS2Key("");
    setClearOpenalex(false);
    setClearS2(false);
    setMessage(null);
  }

  useEffect(() => {
    resetFromSaved();
    setDraftRestored(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  // 恢复上次未保存的邮箱草稿（Key 不落盘，没有草稿）。必须在草稿写入效果之前声明：
  // 挂载时写入效果会按「当前不脏」清掉草稿键，读取必须先发生。
  useEffect(() => {
    const draft = readSettingsDraft<{ email: string }>(BIBLIO_DRAFT_KEY);
    if (draft && typeof draft.email === "string") {
      setEmail(draft.email);
      setDraftRestored(true);
    }
    // 只在挂载时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isDirty(): boolean {
    return (
      email.trim() !== saved.email.trim() ||
      Boolean(openalexKey.trim()) ||
      Boolean(s2Key.trim()) ||
      (clearOpenalex && saved.hasOpenalexKey) ||
      (clearS2 && saved.hasS2Key)
    );
  }

  // 离开守卫 + 非敏感草稿：邮箱可丢草稿；Key 永不落盘。
  const dirty = isDirty();
  useSettingsGuard("biblio", "文献库", {
    isDirty,
    save: async () => {
      const input: BiblioSaveInput = {
        email: email.trim(),
        openalexKey: clearOpenalex ? "" : openalexKey.trim() ? openalexKey.trim() : null,
        s2Key: clearS2 ? "" : s2Key.trim() ? s2Key.trim() : null,
      };
      await saveBiblio(input);
    },
    discard: resetFromSaved,
  });
  useEffect(() => {
    writeSettingsDraft(BIBLIO_DRAFT_KEY, dirty && email.trim() !== saved.email.trim() ? { email: email.trim() } : null);
  });

  const crossrefConfigured = biblioEmailConfigured(saved.email);
  const remaining = saved.openalexRemainingUsd;

  return (
    <article
      id="settings-biblio"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 2 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>文献库</h3>
        {dirty ? <span className="ef-dirty-badge">未保存</span> : null}
        <p>不填写也能查询。邮箱和 Key 只改变请求走哪条通道、多快、每天能查多少，不改变查哪些库、按什么顺序查。</p>
      </header>
      {draftRestored ? (
        <p className="ef-draft-note">
          已恢复上次未保存的邮箱草稿。
          <Button type="button" size="sm" onClick={() => { resetFromSaved(); setDraftRestored(false); }}>
            丢弃草稿
          </Button>
        </p>
      ) : null}
      <SettingsLoadError which="biblio" />
      <ul className="ef-kbd-list">
        <li>
          <span>arXiv</span>
          <span>匿名</span>
        </li>
        <li>
          <span>Crossref</span>
          <span>{crossrefConfigured ? "已配置" : "匿名"}</span>
        </li>
        <li>
          <span>OpenAlex</span>
          <span>{saved.hasOpenalexKey ? "已配置" : "匿名"}</span>
        </li>
        <li>
          <span>Semantic Scholar</span>
          <span>{saved.hasS2Key ? "已配置" : "匿名"}</span>
        </li>
      </ul>
      {remaining != null ? (
        <p>
          OpenAlex 今日剩余 {remaining.toFixed(3)} USD
          {saved.openalexLimitUsd != null ? `（上限 ${saved.openalexLimitUsd.toFixed(2)} USD）` : ""}
        </p>
      ) : null}
      <div className="ef-field-grid">
        <Field label="联系邮箱">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            autoComplete="off"
          />
        </Field>
        <Field label="OpenAlex API Key">
          <input
            type="password"
            value={openalexKey}
            onChange={(e) => setOpenalexKey(e.target.value)}
            placeholder={saved.hasOpenalexKey ? "••••••••" : ""}
            autoComplete="off"
          />
        </Field>
        <Field label="Semantic Scholar API Key">
          <input
            type="password"
            value={s2Key}
            onChange={(e) => setS2Key(e.target.value)}
            placeholder={saved.hasS2Key ? "••••••••" : ""}
            autoComplete="off"
          />
        </Field>
      </div>
      <p>联系邮箱只发给 Crossref（mailto 和 User-Agent），不会发给 OpenAlex。OpenAlex Key 同时是 openalex.org 的登录密码，只保存在本机。</p>
      <p>论文标题和 DOI 会发送到这些服务。OpenAlex 会把请求日志保留 90 天。</p>
      <p>
        <button type="button" className="ef-id-link" onClick={() => void openExternal("https://openalex.org/settings/api")}>
          openalex.org/settings/api
        </button>
        {" · "}
        <button
          type="button"
          className="ef-id-link"
          onClick={() => void openExternal("https://www.semanticscholar.org/product/api")}
        >
          semanticscholar.org/product/api
        </button>
      </p>
      {saved.hasOpenalexKey ? (
        <label>
          <input type="checkbox" checked={clearOpenalex} onChange={(e) => setClearOpenalex(e.target.checked)} />
          清除已保存的 OpenAlex Key
        </label>
      ) : null}
      {saved.hasS2Key ? (
        <label>
          <input type="checkbox" checked={clearS2} onChange={(e) => setClearS2(e.target.checked)} />
          清除已保存的 Semantic Scholar Key
        </label>
      ) : null}
      <footer className="ef-block-foot">
        <Button
          type="button"
          onClick={() => {
            const input: BiblioSaveInput = {
              email: email.trim(),
              openalexKey: clearOpenalex ? "" : openalexKey.trim() ? openalexKey.trim() : null,
              s2Key: clearS2 ? "" : s2Key.trim() ? s2Key.trim() : null,
            };
            void saveBiblio(input)
              .then(() => setMessage({ tone: "ok", text: "文献库设置已保存。" }))
              .catch((err: unknown) => setMessage({ tone: "error", text: `保存文献库设置失败：${errText(err)}。` }));
          }}
        >
          保存文献库设置
        </Button>
        {message ? <span className={`ef-foot-msg is-${message.tone}`}>{message.text}</span> : null}
      </footer>
    </article>
  );
}

function MineruSettings({ focused }: { focused: boolean }) {
  const saved = useField((s) => s.mineru);
  const healths = useField((s) => s.mineruHealth);
  const effective = useField((s) => s.effectiveProvider);
  const saveMineru = useField((s) => s.saveMineruSettings);
  const probeMineru = useField((s) => s.probeMineru);

  const [localEnabled, setLocalEnabled] = useState(saved.local.enabled);
  const [localSocket, setLocalSocket] = useState(saved.local.socketPath);
  const [sshEnabled, setSshEnabled] = useState(saved.ssh.enabled);
  const [sshHost, setSshHost] = useState(saved.ssh.host);
  const [sshPort, setSshPort] = useState(String(saved.ssh.port || 22));
  const [sshUser, setSshUser] = useState(saved.ssh.user);
  const [sshKey, setSshKey] = useState(saved.ssh.identityFile);
  const [sshSocket, setSshSocket] = useState(saved.ssh.socketPath);
  const [sshInbox, setSshInbox] = useState(saved.ssh.inboxDir);
  const [apiToken, setApiToken] = useState("");
  const [modelVersion, setModelVersion] = useState<MineruModelVersion>(saved.api.modelVersion);
  const [language, setLanguage] = useState<MineruLanguage>(saved.api.language);
  const [enableFormula, setEnableFormula] = useState(saved.api.enableFormula);
  const [enableTable, setEnableTable] = useState(saved.api.enableTable);
  const [tier, setTier] = useState<MineruTier>(saved.tier);
  const [pageRange, setPageRange] = useState(saved.pageRange);
  const [order, setOrder] = useState<MineruProviderKind[]>(saved.order);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<MineruProviderKind, { tone: "ok" | "error"; text: string }>>>({});
  const [testing, setTesting] = useState<MineruProviderKind | null>(null);
  const [probing, setProbing] = useState(false);
  const [confirmClearToken, setConfirmClearToken] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);

  function resetFromSaved(): void {
    writeSettingsDraft(MINERU_DRAFT_KEY, null);
    setLocalEnabled(saved.local.enabled);
    setLocalSocket(saved.local.socketPath);
    setSshEnabled(saved.ssh.enabled);
    setSshHost(saved.ssh.host);
    setSshPort(String(saved.ssh.port || 22));
    setSshUser(saved.ssh.user);
    setSshKey(saved.ssh.identityFile);
    setSshSocket(saved.ssh.socketPath);
    setSshInbox(saved.ssh.inboxDir);
    setModelVersion(saved.api.modelVersion);
    setLanguage(saved.api.language);
    setEnableFormula(saved.api.enableFormula);
    setEnableTable(saved.api.enableTable);
    setTier(saved.tier);
    setPageRange(saved.pageRange);
    setOrder(saved.order);
    setApiToken("");
    setConfirmClearToken(false);
    setMessage(null);
  }

  useEffect(() => {
    resetFromSaved();
    setDraftRestored(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  // 恢复上次未保存的非敏感草稿（不含 Token）。
  useEffect(() => {
    const draft = readSettingsDraft<Record<string, unknown>>(MINERU_DRAFT_KEY);
    if (!draft) return;
    if (typeof draft.localEnabled === "boolean") setLocalEnabled(draft.localEnabled);
    if (typeof draft.localSocket === "string") setLocalSocket(draft.localSocket);
    if (typeof draft.sshEnabled === "boolean") setSshEnabled(draft.sshEnabled);
    if (typeof draft.sshHost === "string") setSshHost(draft.sshHost);
    if (typeof draft.sshPort === "string") setSshPort(draft.sshPort);
    if (typeof draft.sshUser === "string") setSshUser(draft.sshUser);
    if (typeof draft.sshKey === "string") setSshKey(draft.sshKey);
    if (typeof draft.sshSocket === "string") setSshSocket(draft.sshSocket);
    if (typeof draft.sshInbox === "string") setSshInbox(draft.sshInbox);
    if (draft.modelVersion === "pipeline" || draft.modelVersion === "vlm") setModelVersion(draft.modelVersion);
    if (draft.language === "ch" || draft.language === "en") setLanguage(draft.language);
    if (typeof draft.enableFormula === "boolean") setEnableFormula(draft.enableFormula);
    if (typeof draft.enableTable === "boolean") setEnableTable(draft.enableTable);
    if (draft.tier === "flash" || draft.tier === "basic" || draft.tier === "standard" || draft.tier === "advanced") {
      setTier(draft.tier);
    }
    if (typeof draft.pageRange === "string") setPageRange(draft.pageRange);
    if (Array.isArray(draft.order)) {
      const next = draft.order.filter((item): item is MineruProviderKind => item === "local" || item === "ssh" || item === "api");
      if (next.length) setOrder(next);
    }
    setDraftRestored(true);
    // 只在挂载时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function currentInput(nextOrder?: MineruProviderKind[]): MineruSaveInput {
    return {
      order: nextOrder ?? order,
      local: { enabled: localEnabled, socketPath: localSocket },
      ssh: {
        enabled: sshEnabled,
        host: sshHost,
        port: Number(sshPort) || 22,
        user: sshUser,
        identityFile: sshKey,
        socketPath: sshSocket,
        inboxDir: sshInbox,
      },
      api: {
        // null = 保留已存 Token；空输入框视为未改动。
        token: apiToken.trim() ? apiToken.trim() : null,
        modelVersion,
        language,
        enableFormula,
        enableTable,
      },
      tier,
      pageRange,
    };
  }

  function isDirty(): boolean {
    const cur = currentInput();
    return (
      JSON.stringify(cur.order) !== JSON.stringify(saved.order) ||
      JSON.stringify(cur.local) !== JSON.stringify({ enabled: saved.local.enabled, socketPath: saved.local.socketPath }) ||
      JSON.stringify(cur.ssh) !==
        JSON.stringify({
          enabled: saved.ssh.enabled,
          host: saved.ssh.host,
          port: saved.ssh.port,
          user: saved.ssh.user,
          identityFile: saved.ssh.identityFile,
          socketPath: saved.ssh.socketPath,
          inboxDir: saved.ssh.inboxDir,
        }) ||
      // Token 三态：留空 = 保留已存（不脏）；输入新 Token 才算脏。
      // 清除走「清除已保存的 Token」按钮（立即保存），不经过表单脏检查。
      Boolean(apiToken.trim()) ||
      cur.api.modelVersion !== saved.api.modelVersion ||
      cur.api.language !== saved.api.language ||
      cur.api.enableFormula !== saved.api.enableFormula ||
      cur.api.enableTable !== saved.api.enableTable ||
      cur.tier !== saved.tier ||
      cur.pageRange !== saved.pageRange
    );
  }

  // 离开守卫 + 非敏感草稿（不含 Token）。
  const dirty = isDirty();
  useSettingsGuard("mineru", "MinerU 解析源", {
    isDirty,
    save: async () => {
      await save(currentInput());
    },
    discard: resetFromSaved,
  });
  useEffect(() => {
    writeSettingsDraft(
      MINERU_DRAFT_KEY,
      dirty
        ? {
            localEnabled,
            localSocket,
            sshEnabled,
            sshHost,
            sshPort,
            sshUser,
            sshKey,
            sshSocket,
            sshInbox,
            modelVersion,
            language,
            enableFormula,
            enableTable,
            tier,
            pageRange,
            order,
          }
        : null,
    );
  });

  async function save(input: MineruSaveInput): Promise<void> {
    await saveMineru(input);
  }

  async function testProvider(provider: MineruProviderKind) {
    setMessage(null);
    setTesting(provider);
    try {
      // 表单有未保存修改时先落盘，测试的才是用户眼前这份配置。
      if (isDirty()) await save(currentInput());
      const started = Date.now();
      const text = await testMineru(provider);
      setTestResults((prev) => ({
        ...prev,
        [provider]: { tone: "ok", text: `${text} · ${Date.now() - started}ms` },
      }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [provider]: { tone: "error", text: errText(err) } }));
    } finally {
      setTesting(null);
    }
  }

  async function reprobe() {
    setProbing(true);
    setMessage(null);
    try {
      if (isDirty()) await save(currentInput());
      await probeMineru();
    } catch (err) {
      setMessage({ tone: "error", text: `探测失败：${errText(err)}。` });
    } finally {
      setProbing(false);
    }
  }

  function moveOrder(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setOrder(next);
    // 顺序即回退优先级：调整后立即保存并重探。
    setMessage(null);
    void save(currentInput(next)).catch((err: unknown) => {
      setMessage({ tone: "error", text: `保存回退顺序失败：${errText(err)}。` });
    });
  }

  async function clearToken() {
    setConfirmClearToken(false);
    setMessage(null);
    try {
      await save({ ...currentInput(), api: { ...currentInput().api, token: "" } });
      setApiToken("");
      setMessage({ tone: "ok", text: "已清除官方 API Token。" });
    } catch (err) {
      setMessage({ tone: "error", text: `清除 Token 失败：${errText(err)}。` });
    }
  }

  function healthLine(provider: MineruProviderKind) {
    const item: ProviderHealth | undefined = healths.find((h) => h.provider === provider);
    if (!item) return <p className="ef-probe-line">未探测</p>;
    if (item.ok) {
      return (
        <p className="ef-probe-line is-ok">
          {item.message} <span className="ef-probe-ms">{item.latencyMs}ms</span>
        </p>
      );
    }
    return <p className="ef-probe-line is-error">{item.message}</p>;
  }

  const enabledCount = [localEnabled, sshEnabled, saved.api.hasToken || Boolean(apiToken.trim())].filter(Boolean).length;
  const failureSummary = saved.configured && !effective && healths.length ? summarizeHealths(saved.order, healths) : "";
  const statusTone = probing ? "is-busy" : effective ? "is-ok" : saved.configured ? "is-error" : "is-idle";
  const apiEnabled = saved.api.hasToken || Boolean(apiToken.trim());

  return (
    <article
      id="settings-mineru"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 1 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>MinerU 解析源</h3>
        {dirty ? <span className="ef-dirty-badge">未保存</span> : null}
        <p>导入 PDF 后自动送解析：按回退顺序探测，上方解析源不可用时自动切到下一个。</p>
      </header>
      {draftRestored ? (
        <p className="ef-draft-note">
          已恢复上次未保存的草稿（不含 Token）。
          <Button type="button" size="sm" onClick={() => { resetFromSaved(); setDraftRestored(false); }}>
            丢弃草稿
          </Button>
        </p>
      ) : null}
      <SettingsLoadError which="mineru" />

      <div className={`ef-statusbar ${statusTone}`} aria-live="polite">
        <span className="ef-statusbar-dot" aria-hidden="true" />
        {probing ? (
          <span className="ef-statusbar-text">正在探测各解析源…</span>
        ) : effective ? (
          <span className="ef-statusbar-text">
            当前生效：<b>{providerLabel(effective)}</b>
            <span className="ef-probe-ms">按回退顺序自动选择</span>
          </span>
        ) : saved.configured ? (
          <span className="ef-statusbar-text is-error">已启用的解析源均未通过探测，导入将只入库、不解析。</span>
        ) : (
          <span className="ef-statusbar-text">尚未启用任何解析源，导入将只入库、不解析。</span>
        )}
        <Button type="button" size="sm" disabled={probing} onClick={() => void reprobe()}>
          {probing ? "探测中…" : "重新探测全部"}
        </Button>
      </div>
      {failureSummary ? (
        <p className="ef-probe-line is-error ef-probe-summary">
          {failureSummary}。可修正配置后点击「测试连接」，或到 mineru.net 申请官方 API Token 作为兜底。
        </p>
      ) : null}

      <div className="ef-order-row" role="group" aria-label="回退顺序">
        <span className="ef-order-label">回退顺序</span>
        <span className="ef-order-flow">
          {order.map((provider, index) => (
            <span key={provider} className="ef-order-item">
              <span
                className={`ef-order-chip${effective === provider ? " is-effective" : ""}`}
              >
                {providerLabel(provider)}
                <button
                  type="button"
                  aria-label={`上移${providerLabel(provider)}`}
                  disabled={index === 0}
                  onClick={() => moveOrder(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`下移${providerLabel(provider)}`}
                  disabled={index === order.length - 1}
                  onClick={() => moveOrder(index, 1)}
                >
                  ↓
                </button>
              </span>
              {index < order.length - 1 ? (
                <span className="ef-order-sep" aria-hidden="true">
                  →
                </span>
              ) : null}
            </span>
          ))}
        </span>
      </div>

      <div className="ef-provider-grid">
        <section
          className={`ef-provider-card${localEnabled ? "" : " is-off"}${effective === "local" ? " is-active" : ""}`}
          aria-label="本地 CLI"
        >
          <header>
            <label className="ef-provider-toggle">
              <input
                type="checkbox"
                checked={localEnabled}
                onChange={(e) => setLocalEnabled(e.target.checked)}
              />
              <strong>本地 CLI</strong>
            </label>
            {effective === "local" ? <span className="ef-active-badge">生效中</span> : null}
          </header>
          <p className="ef-provider-desc">
            MinerU 文档库与本应用在同一台电脑时使用。未部署时保持关闭即可——导入会按回退顺序自动落到下一个解析源。
          </p>
          <AdvancedFields>
            <Field label="Socket 路径">
              <input
                value={localSocket}
                onChange={(e) => setLocalSocket(e.target.value)}
                placeholder="~/.mineru/doclib.sock"
              />
            </Field>
          </AdvancedFields>
          <div className="ef-import-actions">
            <Button
              type="button"
              size="sm"
              disabled={testing === "local"}
              onClick={() => void testProvider("local")}
            >
              {testing === "local" ? "测试中…" : "测试连接"}
            </Button>
          </div>
          {testResults.local ? (
            <p className={`ef-probe-line ${testResults.local.tone === "ok" ? "is-ok" : "is-error"}`}>
              {testResults.local.text}
            </p>
          ) : (
            healthLine("local")
          )}
        </section>

        <section
          className={`ef-provider-card ef-ssh-card${sshEnabled ? "" : " is-off"}${effective === "ssh" ? " is-active" : ""}`}
          aria-label="SSH 远程"
        >
          <header>
            <label className="ef-provider-toggle">
              <input
                type="checkbox"
                checked={sshEnabled}
                onChange={(e) => setSshEnabled(e.target.checked)}
              />
              <strong>SSH 远程</strong>
            </label>
            {effective === "ssh" ? <span className="ef-active-badge">生效中</span> : null}
          </header>
          <p className="ef-provider-desc">
            连接另一台电脑上已部署的 MinerU，PDF 会先复制到远程暂存目录再提交解析；私钥留空则使用本机 SSH 默认配置。
          </p>
          <AdvancedFields>
            <div className="ef-field-grid">
              <Field label="主机">
                <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="imac" />
              </Field>
              <Field label="端口">
                <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
            <div className="ef-field-grid">
              <Field label="用户">
                <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="user" />
              </Field>
              <Field label="私钥路径">
                <input
                  value={sshKey}
                  onChange={(e) => setSshKey(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
              </Field>
            </div>
            <div className="ef-field-grid">
              <Field label="远程 Socket 路径">
                <input
                  value={sshSocket}
                  onChange={(e) => setSshSocket(e.target.value)}
                  placeholder="~/.mineru/doclib.sock"
                />
              </Field>
              <Field label="远程暂存目录">
                <input
                  value={sshInbox}
                  onChange={(e) => setSshInbox(e.target.value)}
                  placeholder="~/.mineru/paper-field-inbox"
                />
              </Field>
            </div>
          </AdvancedFields>
          <div className="ef-import-actions">
            <Button
              type="button"
              size="sm"
              disabled={testing === "ssh"}
              onClick={() => void testProvider("ssh")}
            >
              {testing === "ssh" ? "测试中…" : "测试连接"}
            </Button>
          </div>
          {testResults.ssh ? (
            <p className={`ef-probe-line ${testResults.ssh.tone === "ok" ? "is-ok" : "is-error"}`}>
              {testResults.ssh.text}
            </p>
          ) : (
            healthLine("ssh")
          )}
        </section>

        <section
          className={`ef-provider-card${apiEnabled ? "" : " is-off"}${effective === "api" ? " is-active" : ""}`}
          aria-label="官方 API"
        >
          <header>
            <strong className="ef-provider-name">官方 API</strong>
            {effective === "api" ? <span className="ef-active-badge">生效中</span> : null}
          </header>
          <p className="ef-provider-desc">
            mineru.net 云端解析，填入 Token 即启用（限额：单文件 200MB / 200 页，批量 50 篇，每日 1000 页）。
          </p>
          <AdvancedFields>
            <div className="ef-field-grid">
              <Field label={`Token ${saved.api.hasToken ? "（已保存 · 留空保持不变）" : "（在 mineru.net 获取）"}`}>
                <input
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder={saved.api.hasToken ? "••••••••" : "eyJhbGci…"}
                  autoComplete="off"
                />
              </Field>
              <Field label="语言">
                <select
                  aria-label="解析语言"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as MineruLanguage)}
                >
                  <option value="ch">中文</option>
                  <option value="en">英文</option>
                </select>
              </Field>
            </div>
            <Field label="模型版本">
              <select
                aria-label="模型版本"
                value={modelVersion}
                onChange={(e) => setModelVersion(e.target.value as MineruModelVersion)}
              >
                <option value="pipeline">流水线（通用解析，较快）</option>
                <option value="vlm">视觉语言模型（复杂版面更准，较慢）</option>
              </select>
            </Field>
            <p className="ef-advanced-hint">
              pipeline 走通用解析流水线，速度较快；vlm 使用视觉语言模型，版面复杂时更准确，耗时也更长。
            </p>
          </AdvancedFields>
          <div className="ef-import-actions">
            <Button
              type="button"
              size="sm"
              disabled={testing === "api"}
              onClick={() => void testProvider("api")}
            >
              {testing === "api" ? "测试中…" : "测试连接"}
            </Button>
            {saved.api.hasToken ? (
              confirmClearToken ? (
                <Button type="button" size="sm" className="ef-btn-danger-solid" onClick={() => void clearToken()}>
                  确认清除 Token
                </Button>
              ) : (
                <Button type="button" size="sm" variant="danger" onClick={() => setConfirmClearToken(true)}>
                  清除已保存的 Token…
                </Button>
              )
            ) : null}
          </div>
          {testResults.api ? (
            <p className={`ef-probe-line ${testResults.api.tone === "ok" ? "is-ok" : "is-error"}`}>
              {testResults.api.text}
            </p>
          ) : (
            healthLine("api")
          )}
        </section>
      </div>

      {localEnabled || sshEnabled ? (
        <div className="ef-params">
          <AdvancedFields>
          <span className="ef-params-label">解析参数（本地 / SSH）</span>
          <Field label="解析档位">
            <select value={tier} onChange={(e) => setTier(e.target.value as MineruTier)} aria-label="解析档位">
              <option value="flash">flash</option>
              <option value="basic">basic</option>
              <option value="standard">standard</option>
              <option value="advanced">advanced</option>
            </select>
          </Field>
          <Field label="页码范围（默认 all；官方 API 非 all 时按页码提交）">
            <input value={pageRange} onChange={(e) => setPageRange(e.target.value)} placeholder="all" />
          </Field>
          </AdvancedFields>
        </div>
      ) : null}

      <footer className="ef-block-foot">
        <Button
          variant="primary"
          type="button"
          onClick={() => {
            setMessage(null);
            void save(currentInput())
              .then(() => setMessage({ tone: "ok", text: `MinerU 设置已保存（已启用 ${enabledCount} 个解析源）。` }))
              .catch((err: unknown) => {
                setMessage({ tone: "error", text: `保存 MinerU 设置失败：${errText(err)}。` });
              });
          }}
        >
          保存设置
        </Button>
        {message ? (
          <span className={`ef-foot-msg is-${message.tone}`}>
            {message.text}
          </span>
        ) : null}
      </footer>
    </article>
  );
}

function UpdateBlock({ focused }: { focused: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <article
      id="settings-update"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      style={{ "--pf-i": 5 } as CSSProperties}
    >
      <header className="ef-block-head">
        <h3>软件更新</h3>
        <p>从 GitHub Releases 检查新版本。未配置签名公钥时不会联网。</p>
      </header>
      <div className="ef-block-foot">
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            void checkForAppUpdate()
              .then((text) => setMessage(text))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "正在检查…" : "检查更新"}
        </Button>
        {message ? <span className="ef-foot-msg">{message}</span> : null}
      </div>
    </article>
  );
}
