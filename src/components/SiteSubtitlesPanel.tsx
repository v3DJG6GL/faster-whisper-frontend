// The link card's "Download existing subtitles" panel (D86, LinkSubs mockup v39): the switch,
// the Existing-subtitles presets, and the "Subtitles" table — one row per language with its
// source badges (Whisper / the site's / machine translation; active, idle = greyed, off =
// struck), a trash button for languages the site lacks, and "Add language" last. Every rule
// lives in lib/siteSubtitles; this file only draws derive() and routes clicks back.

import { Loader2, Trash2 } from "lucide-react";
import { TargetLanguagePicker } from "@/components/LanguagePicker";
import { FieldTrigger, IconButton, Segmented, Toggle } from "@/components/ui";
import { cn } from "@/lib/cn";
import { sourceTone } from "@/lib/sourceTone";
import {
  SITE_POLICIES, addLanguage, derive, flip, listedLanguages, pickPolicy, removeLanguage,
  type SiteBadge, type SiteChange, type SiteSubsInput, type SiteSubsState,
} from "@/lib/siteSubtitles";

/** The three badge states: idle greys out, off strikes through. */
const stateTone = (state: SiteBadge["state"]) =>
  state === "idle" ? "opacity-45 grayscale" : state === "off" ? "opacity-40 line-through" : "";

export function SiteSubtitlesPanel({
  input,
  state,
  onChange,
  detecting,
  mt,
  supported,
  modelName,
  disabled,
}: {
  input: SiteSubsInput;
  state: SiteSubsState;
  onChange: (ch: SiteChange) => void;
  /** The spoken-language check is running: the table waits for it. */
  detecting: boolean;
  /** The server machine-translates (caps.translation_enabled). */
  mt: boolean;
  /** The translation model's languages, for "Add language". */
  supported: string[] | null;
  modelName?: string;
  disabled?: boolean;
}) {
  const v = derive(input, state);
  const keep = (ch: Partial<SiteSubsState>): SiteChange => ({ state: { ...state, ...ch }, targets: [...input.targets] });
  const hasAuto = input.tracks.some((t) => t.kind === "auto");
  const listed = listedLanguages(input, state);
  const { used, of, existing } = v.counter;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="inline-flex items-center gap-2 text-[12.5px] text-text">
          <Toggle
            checked={state.subs}
            onChange={(subs) => onChange(keep({ subs }))}
            disabled={disabled}
            ariaLabel="Download existing subtitles"
          />
          Download existing subtitles
        </label>
        <span
          className="text-[12px] text-faint"
          title={state.subs && used < of ? "The rest aren't used with this setting" : undefined}
        >
          {state.subs
            ? `${used} of ${of} used`
            : `${existing} existing ${existing === 1 ? "subtitle" : "subtitles"} on this link`}
        </span>
      </div>
      {state.subs && (
        <div className="flex flex-col gap-2.5 pl-14">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[12px] font-medium text-dim">Existing subtitles</span>
            <Segmented
              ariaLabel="Existing subtitles"
              value={state.policy}
              options={SITE_POLICIES}
              disabled={disabled}
              onChange={(p) => onChange(pickPolicy(input, state, p))}
            />
          </div>
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="flex min-h-10 items-center gap-3 bg-surface-2/60 px-3 py-1.5 text-[12px] font-medium text-dim">
              <span className="flex-1">Subtitles</span>
              {hasAuto && (
                <label className="inline-flex items-center gap-2 font-normal text-text">
                  <Toggle
                    checked={state.auto}
                    onChange={(auto) => onChange(keep({ auto }))}
                    disabled={disabled}
                    ariaLabel="Include auto-generated subtitles"
                  />
                  Include auto-generated subtitles
                </label>
              )}
            </div>
            {detecting ? (
              <div className="flex items-center gap-2.5 border-t border-line px-3.5 py-5 text-[12.5px] text-dim">
                <Loader2 className="size-4 animate-spin" /> Detecting the spoken language…
              </div>
            ) : (
              <>
                {v.rows.map((row) => (
                  <div
                    key={row.code ?? "orig"}
                    className={cn(
                      "grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_2rem] items-center gap-3.5 border-t border-line px-3 py-2 text-[12.5px]",
                      row.code === null && "bg-accent-soft/30",
                    )}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-text">{row.label}</span>
                      <small className="truncate text-[11px] text-faint">{row.sub}</small>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {row.badges
                        .filter((b) => mt || b.kind !== "mt")
                        .map((b, i) => (
                          <button
                            key={b.key ?? i}
                            type="button"
                            aria-pressed={b.state === "active"}
                            disabled={disabled || !b.key}
                            title={b.title}
                            onClick={() => b.key && onChange(flip(input, state, b.key))}
                            className={cn(
                              "ring-signal rounded-md px-2 py-0.5 text-[11.5px] enabled:hover:brightness-125",
                              sourceTone(b.kind, b.hoh),
                              stateTone(b.state),
                              b.tentative && "border border-dotted border-current bg-transparent",
                            )}
                          >
                            {b.text}
                          </button>
                        ))}
                    </div>
                    <div className="flex justify-end">
                      {row.deletable && row.code && (
                        <IconButton
                          label={`Remove ${row.label} from the list`}
                          size="sm"
                          danger
                          disabled={disabled}
                          onClick={() => onChange(removeLanguage(input, state, row.code!))}
                        >
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      )}
                    </div>
                  </div>
                ))}
                {mt && (
                  <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_2rem] items-center gap-3.5 border-t border-line px-3 py-2 text-[12.5px]">
                    <span className="text-text">Add language</span>
                    <div className="w-56">
                      <TargetLanguagePicker
                        ariaLabel="Add language"
                        value={listed}
                        onChange={(next) => {
                          const code = next.find((c) => !listed.includes(c));
                          if (code) onChange(addLanguage(input, state, code));
                        }}
                        supported={supported}
                        modelName={modelName}
                        exclude={input.spoken ?? undefined}
                        max={Number.MAX_SAFE_INTEGER}
                        disabled={disabled}
                        renderTrigger={(p) => (
                          <FieldTrigger {...p} open={p["aria-expanded"]} size="sm">
                            Choose a language…
                          </FieldTrigger>
                        )}
                      />
                    </div>
                    <span />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
