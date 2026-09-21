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
              <span className="kbd">{modLabel()}N</span> 添加论文 ·{" "}
              <span className="kbd">{modLabel()}R</span> 标记已读 ·{" "}
              <span className="kbd">{modLabel()}K</span> 搜索 · <span className="kbd">Esc</span> 关闭对话框
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
