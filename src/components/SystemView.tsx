import { useEffect, useState } from "react";
import { testMineru, type MineruMode, type MineruTier } from "../lib/mineru";
import { shortcut } from "../lib/util";
import { useField } from "../store";
import { Button, Field } from "./ui";

export function SystemView() {
  const settings = useField((s) => s.settings);
  const saveLlmSettings = useField((s) => s.saveLlmSettings);
  const exportCurrentDomain = useField((s) => s.exportCurrentDomain);
  const domains = useField((s) => s.domains);
  const selectedDomainId = useField((s) => s.selectedDomainId);
  const domain = domains.find((d) => d.id === selectedDomainId);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
  }, [settings.baseUrl, settings.model]);

  return (
    <section className="ef-read" id="stage" aria-labelledby="system-title">
      <div className="ef-system">
        <div className="ef-system-inner">
          <h1 id="system-title">系统</h1>
          <p className="lede">
            API Key 只存在本机。没有 Key 时仍可完整手录论文与笔记。LLM 永远不会把论文标成已读。
          </p>

          <article className="page-block">
            <h3>AI 服务设置</h3>
            <p>
              OpenAI 兼容的 Chat Completions。桌面端写入本机存储；浏览器预览回退到
              localStorage。保存后才会启用「补全论文信息」和「起草阅读笔记」。
            </p>
            <Field label="Base URL">
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            <Field label="模型">
              <input value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
            <Field label={`API Key ${settings.hasKey ? "（已保存 · 留空则保持）" : "（尚未配置）"}`}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.hasKey ? "••••••••" : "sk-..."}
                autoComplete="off"
              />
            </Field>
            <Button
              variant="primary"
              type="button"
              onClick={() =>
                void saveLlmSettings({
                  baseUrl,
                  model,
                  apiKey: apiKey.trim() ? apiKey.trim() : undefined,
                })
              }
            >
              保存设置
            </Button>
          </article>

          <MineruSettings />

          <article className="page-block">
            <h3>数据导出</h3>
            <p>将当前领域导出为 Markdown 文件夹（README + 每篇论文一个文件）。浏览器预览会下载合并文档。</p>
            <Button type="button" onClick={() => void exportCurrentDomain()}>
              导出 {domain?.name ?? "当前领域"}
            </Button>
          </article>

          <article className="page-block">
            <h3>快捷键</h3>
            <p>
              <span className="kbd">↑</span> <span className="kbd">↓</span> 论文列表 ·{" "}
              <span className="kbd">{shortcut("N")}</span> 导入 PDF ·{" "}
              <span className="kbd">{shortcut("R")}</span> 标记已读 ·{" "}
              <span className="kbd">{shortcut("K")}</span> 搜索 · <span className="kbd">Esc</span> 关闭对话框
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

function MineruSettings() {
  const saved = useField((s) => s.mineru);
  const saveMineru = useField((s) => s.saveMineruSettings);
  const [mode, setMode] = useState<MineruMode>(saved.mode);
  const [socketPath, setSocketPath] = useState(saved.socketPath);
  const [sshHost, setSshHost] = useState(saved.sshHost);
  const [sshPort, setSshPort] = useState(String(saved.sshPort || 22));
  const [sshUser, setSshUser] = useState(saved.sshUser);
  const [identityFile, setIdentityFile] = useState(saved.identityFile);
  const [remoteInbox, setRemoteInbox] = useState(saved.remoteInbox);
  const [tier, setTier] = useState<MineruTier>(saved.tier);
  const [pageRange, setPageRange] = useState(saved.pageRange);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "error">("ok");

  useEffect(() => {
    setMode(saved.mode);
    setSocketPath(saved.socketPath);
    setSshHost(saved.sshHost);
    setSshPort(String(saved.sshPort || 22));
    setSshUser(saved.sshUser);
    setIdentityFile(saved.identityFile);
    setRemoteInbox(saved.remoteInbox);
    setTier(saved.tier);
    setPageRange(saved.pageRange);
  }, [saved]);

  function current() {
    return {
      mode,
      socketPath,
      sshHost,
      sshPort: Number(sshPort) || 22,
      sshUser,
      identityFile,
      remoteInbox,
      tier,
      pageRange,
      configured: false,
    };
  }

  return (
    <article className="page-block">
      <h3>MinerU 4.0</h3>
      <p>
        导入 PDF 后会立刻送到这里解析。文档库只接受它所在电脑上的文件路径：同一台电脑用本机 socket，另一台电脑用 SSH，应用会先把 PDF 拷到暂存目录。
        {saved.configured ? " 当前已配置。" : " 当前未配置，导入仍会入库，但不会解析。"}
      </p>
      <div className="filter-row" role="group" aria-label="MinerU 连接方式">
        {(
          [
            ["off", "不使用"],
            ["local", "本机"],
            ["ssh", "SSH"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            className={mode === value ? "is-active" : ""}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {mode === "local" ? (
        <Field label="Socket 路径">
          <input value={socketPath} onChange={(e) => setSocketPath(e.target.value)} placeholder="~/.mineru/doclib.sock" />
        </Field>
      ) : null}
      {mode === "ssh" ? (
        <>
          <Field label="主机">
            <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="imac" />
          </Field>
          <Field label="端口">
            <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
          </Field>
          <Field label="用户">
            <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="user" />
          </Field>
          <Field label="私钥路径">
            <input
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
              placeholder="~/.ssh/id_ed25519，留空则用 SSH 配置"
            />
          </Field>
          <Field label="远程暂存目录">
            <input
              value={remoteInbox}
              onChange={(e) => setRemoteInbox(e.target.value)}
              placeholder="~/.mineru/paper-field-inbox"
            />
          </Field>
        </>
      ) : null}
      {mode !== "off" ? (
        <>
          <Field label="解析档位">
            <select value={tier} onChange={(e) => setTier(e.target.value as MineruTier)} aria-label="解析档位">
              <option value="flash">flash</option>
              <option value="basic">basic</option>
              <option value="standard">standard</option>
              <option value="advanced">advanced</option>
            </select>
          </Field>
          <Field label="页码">
            <input value={pageRange} onChange={(e) => setPageRange(e.target.value)} placeholder="all" />
          </Field>
        </>
      ) : null}
      <div className="ef-import-actions">
        <Button
          variant="primary"
          type="button"
          onClick={() => {
            setMessage(null);
            void saveMineru(current()).catch((err: unknown) => {
              setTone("error");
              setMessage(err instanceof Error ? err.message : String(err));
            });
          }}
        >
          保存 MinerU
        </Button>
        <Button
          type="button"
          disabled={mode === "off"}
          onClick={() => {
            setMessage(null);
            void testMineru(current())
              .then((text) => {
                setTone("ok");
                setMessage(text);
              })
              .catch((err: unknown) => {
                setTone("error");
                setMessage(err instanceof Error ? err.message : String(err));
              });
          }}
        >
          测试连接
        </Button>
      </div>
      {message ? <p style={{ color: tone === "error" ? "var(--pf-danger)" : "var(--pf-success)" }}>{message}</p> : null}
    </article>
  );
}
