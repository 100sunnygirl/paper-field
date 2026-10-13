import { useEffect, useId, useState, type KeyboardEvent } from "react";

/**
 * Free-text model id with a candidate list. Replaces `<input list>` + `<datalist>`,
 * which filters candidates by the current value: once a model is filled in, the
 * native list shows only that model (or nothing) and looks like it will not open.
 * The ▾ button and ArrowDown always list every option; typing filters them.
 */
export function ModelCombobox({
  value,
  options,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name; the wrapping <label> text also includes the toggle and list. */
  label: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);

  const needle = value.trim().toLowerCase();
  const shown = filtering && needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options;
  const expanded = open && shown.length > 0;

  const openAll = () => {
    setFiltering(false);
    // A custom id highlights nothing, so ↓ then Enter cannot silently replace it.
    setActive(options.indexOf(value));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  // A refetched list may reorder items under `active`; start over instead.
  const optionsKey = options.join("\n");
  useEffect(() => close(), [optionsKey]);

  const pick = (model: string) => {
    onChange(model);
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!expanded) return openAll();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === "Enter" && expanded && active >= 0 && active < shown.length) {
      e.preventDefault();
      pick(shown[active]!);
    } else if (e.key === "Escape" && expanded) {
      e.preventDefault();
      close();
    }
  };

  return (
    <span className="ef-combobox">
      <input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setFiltering(true);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <button
        type="button"
        className="ef-combobox-toggle"
        aria-label="展开模型列表"
        aria-expanded={expanded}
        aria-controls={listId}
        tabIndex={-1}
        disabled={options.length === 0}
        // Keep focus in the input so blur does not immediately close the list.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (expanded ? close() : openAll())}
      >
        ▾
      </button>
      <ul id={listId} role="listbox" aria-label="候选模型" className="ef-combobox-list" hidden={!expanded}>
        {shown.map((model, i) => (
          <li
            key={model}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={model === value}
            data-active={i === active || undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(model)}
          >
            {model}
          </li>
        ))}
      </ul>
    </span>
  );
}
