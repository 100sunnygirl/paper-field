import { useEffect, useState } from "react";
import { modLabel } from "../lib/util";
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
    <section className="ef-stage" id="stage" aria-labelledby="system-title">
      <div className="ef-stage-guide" aria-hidden="true" />
      <div className="ef-watermark">SYS</div>
      <div className="ef-stage-body" style={{ overflow: "auto" }}>
        <p className="ef-kicker">System / endpoint · export · contract</p>
        <h1 className="ef-stage-title" id="system-title">
          System
          <span>API Key 只存在本机。无 Key 时仍可完整手录。</span>
        </h1>

        <article className="page-block">
          <h3>LLM endpoint</h3>
          <p style={{ marginTop: 0, color: "var(--muted)" }}>
            OpenAI-compatible Chat Completions。桌面端通过 Tauri 存储写入本地 store；浏览器预览回退到
            localStorage。
          </p>
          <Field light label="Base URL">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
          <Field light label="Model">
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field light label={`API Key ${settings.hasKey ? "(stored · leave blank to keep)" : "(empty)"}`}>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings.hasKey ? "••••••••" : "sk-..."}
              autoComplete="off"
            />
          </Field>
          <Button
            primary
            type="button"
            onClick={() =>
              void saveLlmSettings({
                baseUrl,
                model,
                apiKey: apiKey.trim() ? apiKey.trim() : undefined,
              })
            }
          >
            SAVE KEY
          </Button>
        </article>

        <article className="page-block">
          <h3>Export</h3>
          <p style={{ color: "var(--muted)" }}>
            将当前领域导出为 Markdown 文件夹（README + 每篇论文一个文件）。浏览器预览会下载合并文档。
          </p>
          <Button type="button" ink onClick={() => void exportCurrentDomain()}>
            EXPORT {domain?.code ?? "FIELD"}
          </Button>
        </article>

        <article className="page-block">
          <h3>Keyboard</h3>
          <p>
            <span className="kbd">↑</span> <span className="kbd">↓</span> 论文列表 ·{" "}
            <span className="kbd">{modLabel()}N</span> 新论文 ·{" "}
            <span className="kbd">{modLabel()}R</span> 标记已读 ·{" "}
            <span className="kbd">Esc</span> 关闭对话框
          </p>
        </article>

      </div>
    </section>
  );
}
