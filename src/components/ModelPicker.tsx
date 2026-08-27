// THE model field, shared by the Backends editor, the Profiles editor and the
// Transcribe screen. An editable combobox rather than a plain select: the server
// list (GET /v1/models via the connection test) suggests, but a backend accepts
// any well-formed model id — custom/HF-repo names must stay typeable, and a
// saved name must never be dropped just because the server is down or stopped
// listing it.
//
// Commit semantics: the draft is local while typing; the parent's onChange fires
// only on a suggestion pick, Enter, or focus leaving the picker — so call sites
// that persist/reset on change aren't hammered per keystroke.

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Combobox } from "@/components/Combobox";
import type { ServerModel } from "@/lib/types";

export function ModelPicker({
  value,
  onChange,
  models,
  defaultLabel,
  placeholder,
  ariaLabel = "Model",
  disabled,
  hideReset,
}: {
  value: string;
  onChange: (v: string) => void;
  /** What the server advertised on the last connection test; empty = untested/unreachable. */
  models: ServerModel[];
  /** Inherit mode: when set, "" is a valid stored value meaning "use the
   *  inherited default", and this names it (e.g. "Default · large-v3") — shown
   *  as the empty field's placeholder, with a reset affordance when overridden. */
  defaultLabel?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Suppress the built-in "use default" reset under the field — for call
   *  sites that render their own reset in the field's label row (grid layouts,
   *  where a hint below one cell breaks the row's baseline). */
  hideReset?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (v: string) => {
    const t = v.trim();
    setDraft(t);
    if (t !== value) onChange(t);
  };

  const ids = models.map((m) => m.id);
  const loaded = new Set(models.filter((m) => m.loaded).map((m) => m.id));
  // Only claim "custom" when there IS a list to be absent from.
  const isCustom = value !== "" && ids.length > 0 && !ids.includes(value);

  return (
    <div
      onBlur={(e) => {
        // React's onBlur is focusout (bubbles); only commit once focus leaves
        // the whole picker — not when it moves within it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit(draft);
      }}
      onKeyDown={(e) => {
        // Enter on a highlighted suggestion is handled (and preventDefault'ed)
        // by the Combobox; a plain Enter commits the typed text.
        if (e.key === "Enter" && !e.defaultPrevented) commit(draft);
      }}
    >
      <Combobox
        value={draft}
        onChange={setDraft}
        onSelect={commit}
        suggestions={ids}
        disabled={disabled}
        ariaLabel={ariaLabel}
        placeholder={defaultLabel ?? placeholder ?? "large-v3 / org/repo"}
        footerLabel="models on this server"
        suffix={(id) => (loaded.has(id) ? <span className="ml-1.5 text-ok">●</span> : null)}
      />
      {(isCustom || (!hideReset && defaultLabel !== undefined && value !== "")) && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-faint">
          {isCustom && <span>custom — not in the server’s list, sent as typed</span>}
          {!hideReset && defaultLabel !== undefined && value !== "" && (
            <button
              type="button"
              onClick={() => commit("")}
              title={defaultLabel}
              className="ring-signal ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1 hover:text-text"
            >
              <RotateCcw className="size-3" /> use default
            </button>
          )}
        </div>
      )}
    </div>
  );
}
