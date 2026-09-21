import { MODE_LABELS, type AppMode, type Domain } from "../lib/types";
import { modLabel, pad2 } from "../lib/util";
import { useField } from "../store";
import { Button } from "./ui";

export function Rail({
  mode,
  domains,
  selectedDomainId,
  domainIndex,
}: {
  mode: AppMode;
  domains: Domain[];
  selectedDomainId: string | null;
  domainIndex: number;
}) {
  const setMode = useField((s) => s.setMode);
  const selectDomain = useField((s) => s.selectDomain);
  const openDialog = useField((s) => s.openDialog);

  return (
    <nav className="ef-rail" aria-label="Primary">
      <div className="ef-rail-modes">
        {(Object.keys(MODE_LABELS) as AppMode[]).map((id) => {
          const item = MODE_LABELS[id];
          return (
            <button
              key={id}
              type="button"
              className={`ef-mode ${mode === id ? "is-active" : ""}`}
              aria-current={mode === id ? "page" : undefined}
              onClick={() => void setMode(id)}
            >
              <span className="idx">{item.index}</span>
              <strong>{item.zh}</strong>
              <small>{item.en}</small>
            </button>
          );
        })}
      </div>
      <div className="ef-domains" aria-label="Domains">
        {domains.map((domain) => (
          <button
            key={domain.id}
            type="button"
            className={`ef-domain-chip ${domain.id === selectedDomainId ? "is-active" : ""}`}
            onClick={() => void selectDomain(domain.id)}
            title={domain.name}
          >
            {domain.code}
          </button>
        ))}
      </div>
      <button type="button" className="ef-rail-add" onClick={() => openDialog("domain")}>
        + FIELD
      </button>
      <div className="ef-rail-index" aria-hidden="true">
        {pad2(domainIndex)}
      </div>
    </nav>
  );
}

export function Dock({
  domain,
  search,
}: {
  domain: Domain | null;
  search: string;
}) {
  const setSearch = useField((s) => s.setSearch);
  const openDialog = useField((s) => s.openDialog);
  const mode = useField((s) => s.mode);

  return (
    <header className="ef-dock">
      <div className="ef-brand">
        <span className="ef-mark" aria-hidden="true" />
        <span>
          <strong>PAPER FIELD</strong>
          <small>论文现场 / {domain ? `${domain.code} · ${domain.name}` : "UNASSIGNED"}</small>
        </span>
      </div>
      {mode !== "system" ? (
        <label className="ef-search">
          <span>SCAN</span>
          <input
            value={search}
            onChange={(e) => void setSearch(e.target.value)}
            placeholder="标题 / 作者 / 标签 / DOI"
            aria-label="Search papers"
          />
        </label>
      ) : (
        <div style={{ flex: 1 }} />
      )}
      {mode === "field" ? (
        <Button primary type="button" onClick={() => openDialog("paper")}>
          + PAPER
        </Button>
      ) : (
        <span style={{ fontFamily: "var(--tech)", fontSize: 10, letterSpacing: "0.14em" }}>
          {modLabel()}N NEW
        </span>
      )}
    </header>
  );
}

export function StatusStrip() {
  const stats = useField((s) => s.stats);
  const settings = useField((s) => s.settings);
  const mode = useField((s) => s.mode);
  return (
    <footer className="ef-status">
      <span>
        READ <b>{stats.read}</b>/{stats.total}
      </span>
      <span className="ok">
        OPEN SRC <b>{stats.openSource}</b>
      </span>
      <span className={stats.running || stats.queued ? "busy" : ""}>
        LLM {stats.running ? <i className="ef-pulse" aria-hidden="true" /> : null}
        QUEUE <b>{stats.running}</b> RUN / <b>{stats.queued}</b> WAIT
      </span>
      <span>{settings.hasKey ? "KEY READY" : "NO KEY · MANUAL"}</span>
      <span style={{ marginLeft: "auto" }}>
        {MODE_LABELS[mode].en}
      </span>
    </footer>
  );
}
