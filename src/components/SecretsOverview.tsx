import { useState } from "react";
import type { BiblioSaveInput } from "../lib/biblio";
import type { MineruSaveInput } from "../lib/mineru";
import type { LlmSettings } from "../lib/types";
import { useField } from "../store";
import { Button } from "./ui";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RowStatus = "saved" | "absent" | "unreadable";

interface SecretRow {
  /** 定位到哪张设置卡（SystemView 的锚点 id）。 */
  anchor: string;
  label: string;
  status: RowStatus;
  /** 两步确认后执行的清除动作；absent 行没有该动作。 */
  clear?: () => Promise<void>;
}

const STATUS_LABELS: Record<RowStatus, string> = {
  saved: "已保存",
  absent: "未配置",
  unreadable: "读取失败",
};

/**
 * 密钥与令牌总览：集中显示 AI Key、MinerU Token 与文献库 Key 的保存状态，
 * 支持定位到对应卡片、逐项清除与全部清除（均两步确认）。清除走各自的保存
 * 动作（传空串），与卡片内的清除按钮同一条路径。
 */
export function SecretsOverview({ focused = false }: { focused?: boolean }) {
  const settings = useField((s) => s.settings);
  const mineru = useField((s) => s.mineru);
  const biblio = useField((s) => s.biblio);
  const saveLlmSettings = useField((s) => s.saveLlmSettings);
  const saveMineruSettings = useField((s) => s.saveMineruSettings);
  const saveBiblioSettings = useField((s) => s.saveBiblioSettings);
  const openSystemCard = useField((s) => s.openSystemCard);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  /** 清某个 AI 提供商的已存 Key：该行传空串，其余行保持 null（保留已存）。 */
  function clearLlmKey(providerId: string): Promise<void> {
    const providers = settings.providers.map((provider) => ({
      id: provider.id,
      presetId: provider.presetId,
      label: provider.label,
      baseUrl: provider.baseUrl,
      model: provider.model,
      enabled: provider.enabled,
      requiresKey: provider.requiresKey,
      apiKey: provider.id === providerId ? "" : null,
    }));
    return saveLlmSettings({ providers });
  }

  /** 清官方 API Token：其余字段按已保存值原样提交，Token 传空串。 */
  function clearMineruToken(): Promise<void> {
    const input: MineruSaveInput = {
      order: mineru.order,
      local: { enabled: mineru.local.enabled, socketPath: mineru.local.socketPath },
      ssh: {
        enabled: mineru.ssh.enabled,
        host: mineru.ssh.host,
        port: mineru.ssh.port,
        user: mineru.ssh.user,
        identityFile: mineru.ssh.identityFile,
        socketPath: mineru.ssh.socketPath,
        inboxDir: mineru.ssh.inboxDir,
      },
      api: {
        token: "",
        modelVersion: mineru.api.modelVersion,
        language: mineru.api.language,
        enableFormula: mineru.api.enableFormula,
        enableTable: mineru.api.enableTable,
      },
      tier: mineru.tier,
      pageRange: mineru.pageRange,
    };
    return saveMineruSettings(input);
  }

  function clearBiblioKey(which: "openalex" | "s2"): Promise<void> {
    const input: BiblioSaveInput = {
      email: biblio.email,
      openalexKey: which === "openalex" ? "" : null,
      s2Key: which === "s2" ? "" : null,
    };
    return saveBiblioSettings(input);
  }

  const rows: SecretRow[] = [
    ...settings.providers.map((provider) => ({
      anchor: "llm",
      label: `AI Key · ${provider.label}`,
      status: (provider.keyState === "unreadable" ? "unreadable" : provider.hasKey ? "saved" : "absent") as RowStatus,
      clear: provider.hasKey ? () => clearLlmKey(provider.id) : undefined,
    })),
    {
      anchor: "mineru",
      label: "MinerU Token · 官方 API",
      status: mineru.api.hasToken ? "saved" : "absent",
      clear: mineru.api.hasToken ? clearMineruToken : undefined,
    },
    {
      anchor: "biblio",
      label: "OpenAlex API Key",
      status: biblio.hasOpenalexKey ? "saved" : "absent",
      clear: biblio.hasOpenalexKey ? () => clearBiblioKey("openalex") : undefined,
    },
    {
      anchor: "biblio",
      label: "Semantic Scholar API Key",
      status: biblio.hasS2Key ? "saved" : "absent",
      clear: biblio.hasS2Key ? () => clearBiblioKey("s2") : undefined,
    },
  ];

  const savedRows = rows.filter((row) => row.status === "saved");

  async function runClear(row: SecretRow) {
    setConfirming(null);
    setMessage(null);
    try {
      await row.clear?.();
      setMessage({ tone: "ok", text: `已清除「${row.label}」。` });
    } catch (err) {
      setMessage({ tone: "error", text: `清除「${row.label}」失败：${errText(err)}。` });
    }
  }

  async function clearAll() {
    setConfirmingAll(false);
    setMessage(null);
    let cleared = 0;
    const failures: string[] = [];
    for (const row of savedRows) {
      try {
        await row.clear?.();
        cleared += 1;
      } catch {
        failures.push(row.label);
      }
    }
    if (failures.length) {
      setMessage({
        tone: "error",
        text: `已清除 ${cleared} 项，失败 ${failures.length} 项：${failures.join("、")}。`,
      });
    } else {
      setMessage({ tone: "ok", text: `已全部清除（${cleared} 项）。本机不再保存任何 AI Key、MinerU Token 与文献库 Key。` });
    }
  }

  return (
    <article
      id="settings-secrets"
      className={`page-block pf-stagger${focused ? " is-focused" : ""}`}
      aria-label="密钥与令牌"
    >
      <header className="ef-block-head">
        <h3>密钥与令牌</h3>
        <p>
          集中查看本机保存的全部密钥状态。桌面版保存在系统钥匙串，浏览器预览保存在本页
          localStorage；清除立即生效，不影响其他设置。
        </p>
      </header>
      <ul className="ef-secrets-list">
        {rows.map((row) => (
          <li key={row.label} className={`ef-secrets-row is-${row.status}`}>
            <span className="ef-secrets-label">{row.label}</span>
            <span className={`ef-secrets-status ${row.status === "saved" ? "is-ok" : row.status === "unreadable" ? "is-error" : ""}`}>
              {STATUS_LABELS[row.status]}
            </span>
            <span className="ef-secrets-actions">
              <Button
                type="button"
                size="sm"
                aria-label={`定位 ${row.label}`}
                onClick={() => openSystemCard(row.anchor)}
              >
                定位
              </Button>
              {row.clear ? (
                confirming === row.label ? (
                  <Button
                    type="button"
                    size="sm"
                    className="ef-btn-danger-solid"
                    aria-label={`确认清除 ${row.label}`}
                    onClick={() => void runClear(row)}
                  >
                    确认清除
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    aria-label={`清除 ${row.label}`}
                    onClick={() => setConfirming(row.label)}
                  >
                    清除…
                  </Button>
                )
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <footer className="ef-block-foot">
        {savedRows.length ? (
          confirmingAll ? (
            <Button type="button" className="ef-btn-danger-solid" onClick={() => void clearAll()}>
              确认全部清除（{savedRows.length} 项）
            </Button>
          ) : (
            <Button type="button" variant="danger" onClick={() => setConfirmingAll(true)}>
              全部清除…
            </Button>
          )
        ) : (
          <span className="ef-secrets-empty">当前没有已保存的密钥与令牌。</span>
        )}
        {message ? <span className={`ef-foot-msg is-${message.tone}`}>{message.text}</span> : null}
      </footer>
    </article>
  );
}

/** 供测试与诊断包复用：从设置状态汇总已保存的密钥条目数。 */
export function countSavedSecrets(
  settings: Pick<LlmSettings, "providers">,
  mineru: { api: { hasToken: boolean } },
  biblio: { hasOpenalexKey: boolean; hasS2Key: boolean },
): number {
  return (
    settings.providers.filter((provider) => provider.hasKey).length +
    (mineru.api.hasToken ? 1 : 0) +
    (biblio.hasOpenalexKey ? 1 : 0) +
    (biblio.hasS2Key ? 1 : 0)
  );
}
