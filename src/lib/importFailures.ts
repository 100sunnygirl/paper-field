// 导入失败清单（localStorage 键 paper-field.import-failures）。
//
// 与 jobJournal.ts 的分工：jobJournal 记「论文批次」——一次解析 / 补全提交了哪些
// paperId、逐篇结果如何，键是 paperId；导入失败的文件根本没有入库、没有 paperId，
// 重试的键是文件路径与当时的目标领域，语义不同，因此另立这一份而不是复用
// （口径同样：只存本机浏览器存储，重启可看、可重试，但不随备份走）。
// 作用：toast 上的「重试」入口随通知消失，错过就得重走选文件流程；这份清单让失败
// 文件长期留在 INTAKE 页，逐条可见原因，随时「仅重试失败文件」。

export interface ImportFailureEntry {
  /** 失败文件的原始路径：重试与去重的键。 */
  path: string;
  /** 展示用文件名。 */
  name: string;
  /** 当时的目标领域：重试按原领域导入，不落到当前选中领域。 */
  domainId: string;
  /** 失败原因（入库时已用 shortReason 截断，不存整段路径日志）。 */
  message: string;
  /** 最近一次失败的时间戳。 */
  at: number;
}

const KEY = "paper-field.import-failures";
/** 最多保留的失败条数（写入时裁剪，控制 localStorage 体积）。 */
const LIMIT = 40;

function isEntry(value: unknown): value is ImportFailureEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ImportFailureEntry>;
  return (
    typeof entry.path === "string" &&
    entry.path.trim().length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.domainId === "string" &&
    typeof entry.message === "string" &&
    typeof entry.at === "number"
  );
}

export function listImportFailures(): ImportFailureEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isEntry);
  } catch {
    return [];
  }
}

function write(entries: ImportFailureEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-LIMIT)));
  } catch {
    // 存不下（隐私模式 / 超配额）不影响导入：清单只留在本次会话的 store 状态里。
  }
}

/** 记录一批失败（同路径覆盖旧记录，保留最新原因与时间）。 */
export function recordImportFailures(entries: ImportFailureEntry[]): void {
  if (!entries.length) return;
  const byPath = new Map(listImportFailures().map((entry) => [entry.path, entry]));
  for (const entry of entries) byPath.set(entry.path, entry);
  write([...byPath.values()]);
}

/** 重试落定（成功入库或确认重复）后移出清单；不在清单里的路径忽略。 */
export function resolveImportFailures(paths: string[]): void {
  if (!paths.length) return;
  const done = new Set(paths);
  write(listImportFailures().filter((entry) => !done.has(entry.path)));
}

/** 逐条移除（用户明确放弃这个文件）。 */
export function removeImportFailure(path: string): void {
  write(listImportFailures().filter((entry) => entry.path !== path));
}

/** 测试与「全部放弃」用：清空清单。 */
export function resetImportFailures(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
