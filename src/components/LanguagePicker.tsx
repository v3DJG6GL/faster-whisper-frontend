// The two language pickers (D87) on the ListPicker shell: the spoken language (one value — a
// language, Auto-detect, Multiple languages, or the inherit row of an override field) and the
// translation targets (several, grouped by what the translation model supports). Rows, groups
// and search come from lib/languages; Recent lives in the settings and re-sorts only when a
// picker closes, so rows never move under the pointer. Both take a renderTrigger, so a chip
// row, a form field or a table's "Add language" row opens the same list.

import { useRef, type ReactNode } from "react";
import { Check } from "lucide-react";
import { KeyHint, ListPicker, type TriggerProps } from "@/components/ListPicker";
import { FieldTrigger } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  WHISPER_LANGUAGES, languageLabel, namedLanguage, nativeName, spokenLabel, spokenSections, targetSections,
  toggleCode, untestedTitle, type LangRow,
} from "@/lib/languages";
import { cleanRecent, rememberRecent } from "@/lib/recent";
import { safeDisplayText } from "@/lib/sanitize";
import { useApp } from "@/lib/store";

/** Name, native name and code — the body of one language row. */
function LanguageRow({ code, label, mark, untested }: { code?: string; label: string; mark: ReactNode; untested?: boolean }) {
  return (
    <>
      <span className="grid size-4 shrink-0 place-items-center">{mark}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className={untested ? "text-dim" : "text-text"}>{label}</span>
        {code && nativeName(code) && <span className="ml-1.5 text-[11.5px] text-faint">{nativeName(code)}</span>}
      </span>
      {untested && (
        <span className="shrink-0 rounded-md border border-warn/45 px-1.5 text-[10.5px] text-warn">not tested</span>
      )}
      {code && <span className="shrink-0 font-mono text-[10.5px] text-faint">{safeDisplayText(code, 12)}</span>}
    </>
  );
}

/** The tick box of a multi-select row; LangPick draws its digit inside it. */
export function TickBox({ on, children }: { on: boolean; children?: ReactNode }) {
  return (
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] border font-mono text-[10px]",
        on ? "border-accent bg-accent text-accent-ink" : "border-line-strong text-faint",
      )}
    >
      {children ?? (on ? <Check className="size-3" strokeWidth={3} /> : null)}
    </span>
  );
}

/** A language row of the multi-select lists (the target picker and LangPick). */
export function TargetRow({ row, on, mark }: { row: LangRow; on: boolean; mark?: ReactNode }) {
  return (
    <LanguageRow code={row.value} label={languageLabel(row.value)} untested={row.untested} mark={<TickBox on={on}>{mark}</TickBox>} />
  );
}

/** The hint line of a multi-select list. */
const MULTI_KEYS = (
  <>
    <KeyHint k="↑↓">move</KeyHint>
    <KeyHint k="Space">tick</KeyHint>
    <KeyHint k="Enter">tick and close</KeyHint>
    <KeyHint k="Esc">close</KeyHint>
  </>
);

/** Recent picks: read from the settings, remembered on close. */
function useRecent(key: "recentSpokenLanguages" | "recentTranslationTargets") {
  const recent = cleanRecent(useApp((s) => s.settings[key]));
  const used = useRef<string[]>([]);
  return {
    recent,
    use: (code: string) => {
      used.current = [code, ...used.current.filter((c) => c !== code)];
    },
    flush: () => {
      rememberRecent(key, used.current);
      used.current = [];
    },
  };
}

export function SpokenLanguagePicker({
  value,
  onChange,
  inheritLabel,
  multi,
  ariaLabel = "Language",
  disabled,
}: {
  /** A language code, "auto", MULTI_LANGUAGE, or "" (inherit — only with `inheritLabel`). */
  value: string;
  onChange: (v: string) => void;
  /** Override fields: offer the "" row under this label ("Inherit · German"). */
  inheritLabel?: string;
  /** Offer "Multiple languages". */
  multi?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const { recent, use, flush } = useRecent("recentSpokenLanguages");
  const labelOf = (v: string) => (v === "" ? inheritLabel ?? "Inherit" : spokenLabel(v));
  const current = labelOf(value);
  return (
    <ListPicker<LangRow>
      label={ariaLabel}
      sections={(query) => spokenSections({ query, recent, inherit: inheritLabel !== undefined, multi })}
      rowKey={(r) => r.value || "inherit"}
      isSelected={(r) => r.value === value}
      onPick={(r) => {
        if (WHISPER_LANGUAGES.includes(r.value)) use(r.value);
        onChange(r.value);
      }}
      onClose={flush}
      renderRow={(r, { selected }) => {
        const code = namedLanguage(r.value) ? r.value : undefined;
        return (
          <LanguageRow
            code={code}
            label={labelOf(r.value)}
            mark={selected ? <Check className="size-3.5 text-accent" /> : null}
          />
        );
      }}
      renderTrigger={(p) => (
        <FieldTrigger {...p} open={p["aria-expanded"]} aria-label={`${ariaLabel}: ${current}`}>
          {current}
        </FieldTrigger>
      )}
      placeholder={`Search ${WHISPER_LANGUAGES.length} languages — name, native name or code`}
      noun="language"
      keys={
        <>
          <KeyHint k="↑↓">move</KeyHint>
          <KeyHint k="Enter">pick</KeyHint>
          <KeyHint k="Home End">jump</KeyHint>
          <KeyHint k="Esc">close</KeyHint>
        </>
      }
      disabled={disabled}
    />
  );
}

export function TargetLanguagePicker({
  value,
  onChange,
  supported,
  modelName,
  exclude,
  max,
  ariaLabel = "Translate into",
  disabled,
  renderTrigger,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** The translation model's languages (translationLanguages); null = unknown, offer all untagged. */
  supported: string[] | null;
  /** Names the "Supported by …" group. */
  modelName?: string;
  /** The known source language — translating into it is a no-op. */
  exclude?: string;
  max: number;
  ariaLabel?: string;
  disabled?: boolean;
  renderTrigger?: (p: TriggerProps) => ReactNode;
}) {
  const { recent, use, flush } = useRecent("recentTranslationTargets");
  // At the server's cap the "+ language" button rests: remove a chip to pick another.
  const full = value.length >= max;
  const fullTitle = `This server translates into at most ${max} languages`;
  return (
    <ListPicker<LangRow>
      label={ariaLabel}
      multi
      sections={(query) => targetSections({ query, recent, supported, modelName, exclude })}
      rowKey={(r) => r.value}
      isSelected={(r) => value.includes(r.value)}
      onPick={(r) => {
        // The multi popover stays open at the cap, where a tick is a no-op: only a code that
        // was really added counts as a Recent target.
        const next = toggleCode(value, r.value, max);
        if (next.includes(r.value) && !value.includes(r.value)) use(r.value);
        onChange(next);
      }}
      onClose={flush}
      renderRow={(r, { selected }) => <TargetRow row={r} on={selected} />}
      rowTitle={untestedTitle}
      renderTrigger={
        renderTrigger ??
        ((p) => (
          // The tooltip sits on a wrapper: a disabled button shows none in some webviews.
          <span title={full ? fullTitle : undefined} className="inline-flex">
            <button
              {...p}
              aria-label={full ? `Add a target language — ${fullTitle}` : "Add a target language"}
              className={cn(
                "ring-signal h-7 rounded-pill border border-dashed border-line-strong px-2.5 text-[11.5px] text-dim hover:text-text",
                p["aria-expanded"] && "border-accent/55 text-text",
                p.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              + language
            </button>
          </span>
        ))
      }
      placeholder="Search languages"
      noun="language"
      keys={MULTI_KEYS}
      // A custom trigger (the site-subtitles "Choose a language…") is not capped here.
      disabled={disabled || (full && !renderTrigger)}
    />
  );
}
