import { useId, useState } from "react";
import { Info } from "lucide-react";
import { DisclosureCard, Segmented, TextInput, SectionLabel } from "@/components/ui";
import { OverrideHeader, OVERRIDE_CONTROL_W } from "@/components/OverrideField";
import type { DecodeOverrides, InheritedValues } from "@/lib/types";
import type { ServerKind } from "@/lib/serverKind";
import { inheritLabel, LOCKED_REASON, type DecodeKey, type InheritWord, type ServerInherited } from "@/lib/inherit";

// Decode-param editor shared by the Backend (defaults) and Profile (override)
// editors and Transcribe. Every field is OPTIONAL: empty = "inherit" (backend default ?? the
// server's resolved default, GET /v1/decode-defaults — see serverInherited). A key the server
// admin locked is read-only and shows the server's value; live dictation's pinned key likewise. Booleans are tri-state (Inherit/On/Off) because an
// unset boolean must stay distinct from an explicit false. The backend clamps
// every value, so the ranges shown here are guidance, not hard gates.
//
// Only the per-request `decode_overrides` keys the backend actually honours live
// here (the full server-managed set — streaming, output wrappers, language
// detection — is reached via a named server override-profile, not per field).
// Layout: ~5 primary fields, then one "Advanced" disclosure with labeled groups.

type Section = "primary" | "vad" | "thresholds" | "sampling" | "vocab";
type Base = { key: keyof DecodeOverrides; label: string; section: Section; wide?: boolean };
type NumField = Base & { kind: "number"; hint: string; min?: number; max?: number; step?: number };
type BoolField = Base & { kind: "bool" };
type TextField = Base & { kind: "text"; hint: string };
type Field = NumField | BoolField | TextField;

const SECTIONS: { id: Exclude<Section, "primary">; title: string }[] = [
  { id: "vad", title: "Voice activity (VAD)" },
  { id: "thresholds", title: "Recognition thresholds" },
  { id: "sampling", title: "Beam & sampling" },
  { id: "vocab", title: "Vocabulary & punctuation" },
];

const FIELDS: Field[] = [
  // ── primary (always visible) ──
  { key: "beam_size", label: "Beam size", section: "primary", kind: "number", hint: "1–20", min: 1, max: 20, step: 1 },
  { key: "temperature", label: "Temperature", section: "primary", kind: "number", hint: "0–1", min: 0, max: 1, step: 0.1 },
  { key: "condition_on_previous_text", label: "Condition on previous text", section: "primary", kind: "bool" },
  { key: "vad_filter", label: "Skip silence (VAD)", section: "primary", kind: "bool" },
  { key: "hotwords", label: "Hotwords", section: "primary", kind: "text", hint: "bias terms", wide: true },
  // ── Voice activity (VAD) ──
  { key: "vad_threshold", label: "VAD threshold", section: "vad", kind: "number", hint: "0–1", min: 0, max: 1, step: 0.05 },
  { key: "vad_min_silence_duration_ms", label: "VAD min silence (ms)", section: "vad", kind: "number", hint: "0–10000", min: 0, max: 10000, step: 50 },
  { key: "vad_speech_pad_ms", label: "VAD speech pad (ms)", section: "vad", kind: "number", hint: "0–2000", min: 0, max: 2000, step: 10 },
  // ── Recognition thresholds ──
  { key: "best_of", label: "Best of", section: "thresholds", kind: "number", hint: "1–20", min: 1, max: 20, step: 1 },
  { key: "no_speech_threshold", label: "No-speech threshold", section: "thresholds", kind: "number", hint: "0–1", min: 0, max: 1, step: 0.05 },
  { key: "log_prob_threshold", label: "Log-prob threshold", section: "thresholds", kind: "number", hint: "-10–0", min: -10, max: 0, step: 0.5 },
  { key: "compression_ratio_threshold", label: "Compression-ratio threshold", section: "thresholds", kind: "number", hint: "0–10", min: 0, max: 10, step: 0.1 },
  // ── Beam & sampling ──
  { key: "patience", label: "Patience", section: "sampling", kind: "number", hint: "0.5–5", min: 0.5, max: 5, step: 0.1 },
  { key: "length_penalty", label: "Length penalty", section: "sampling", kind: "number", hint: "0.1–5", min: 0.1, max: 5, step: 0.1 },
  { key: "repetition_penalty", label: "Repetition penalty", section: "sampling", kind: "number", hint: "0.5–5", min: 0.5, max: 5, step: 0.1 },
  { key: "no_repeat_ngram_size", label: "No-repeat n-gram", section: "sampling", kind: "number", hint: "0–10", min: 0, max: 10, step: 1 },
  // ── Vocabulary & punctuation ──
  { key: "prepend_punctuations", label: "Prepend punctuation", section: "vocab", kind: "text", hint: "" },
  { key: "append_punctuations", label: "Append punctuation", section: "vocab", kind: "text", hint: "" },
  { key: "suppress_tokens", label: "Suppress tokens", section: "vocab", kind: "text", hint: "comma-separated ids", wide: true },
];

export function DecodeFields({
  value,
  onChange,
  inherited,
  sources,
  locked,
  pinned,
  ignored,
  inheritWord = "Inherit",
  serverKind,
  canCustomize,
}: {
  value: DecodeOverrides;
  onChange: (v: DecodeOverrides) => void;
  /** Baseline this editor overrides (Backend defaults and/or a selected server
   *  override-profile's values), ghosted into each control's placeholder/state
   *  so you can see what a blank field will inherit. */
  inherited?: InheritedValues;
  /** Tooltip per key: where the inherited value comes from (serverInherited().sources). */
  sources?: ServerInherited["sources"];
  /** Keys the server admin locked: read-only, showing the server's value. */
  locked?: ReadonlySet<DecodeKey>;
  /** Keys the decode forces whatever is sent (live dictation's condition_on_previous_text). */
  pinned?: ServerInherited["pinned"];
  /** Keys whose value from the layer below the server ignores (locked). */
  ignored?: readonly DecodeKey[];
  /** "Inherit" in override editors (Profile, Backend), "Default" for a per-run choice. */
  inheritWord?: InheritWord;
  /** When "standard", a conventional Whisper server: disable everything the
   *  faster-whisper backend adds (keep only temperature). */
  serverKind?: ServerKind;
  /** Per-identity capability: when false, this caller may not send any custom
   *  decode params — the whole editor is disabled behind one banner. undefined
   *  ("unknown") = permitted (never gate a knob we can't prove is disabled). */
  canCustomize?: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false); // every block starts closed
  const blocked = canCustomize === false; // capability gate: all params disabled
  const standard = serverKind === "standard";
  const isGated = (f: Field) => blocked || (standard && f.key !== "temperature");
  // Per-key server lock / dictation pin. Skipped when the whole editor is blocked: the banner says
  // it once, and every key reads as locked then.
  const pinOf = (f: Field) => (blocked ? undefined : pinned?.[f.key]);
  const isLocked = (f: Field) => !blocked && !pinOf(f) && !!locked?.has(f.key);
  const readOnly = (f: Field) => isGated(f) || isLocked(f) || !!pinOf(f);
  const uid = useId();
  const descId = (f: Field) => `${uid}-${f.key}-src`;
  /** The tooltip / screen-reader line for a field's inherited value. */
  const sourceOf = (f: Field): string | undefined => {
    const pin = pinOf(f);
    if (pin) return pin.reason;
    if (isLocked(f)) return LOCKED_REASON;
    return sources?.[f.key];
  };

  const setField = (key: keyof DecodeOverrides, v: number | boolean | string | undefined) => {
    const next: DecodeOverrides = { ...value };
    if (v === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = v;
    onChange(next);
  };

  // The inherited (baseline) value as a short string, or undefined if none.
  const fmtInherited = (f: Field): string | undefined => {
    const iv = inherited?.[f.key];
    if (iv === undefined || iv === null || iv === "") return undefined;
    if (f.kind === "bool") return iv ? "on" : "off";
    return String(iv);
  };

  // NB: renderControl / fieldCell / grid are plain functions called inline, NOT
  // nested components. Rendering them as <Component/> gives a fresh identity on
  // every keystroke, remounting the focused <input> so it loses focus after one
  // character. Calling them as functions reconciles the inputs in place.
  const renderControl = (f: Field) => {
    const cur = value[f.key];
    const gated = isGated(f);
    const inh = fmtInherited(f); // inherited value as a short string, or undefined
    const pin = pinOf(f);
    const title = sourceOf(f);
    const described = title ? descId(f) : undefined;
    // A locked or pinned key shows the value the server uses, not this layer's (ignored) one.
    const fixedLabel = pin ? `Dictation always · ${pin.value}` : isLocked(f) ? inheritLabel(inh, "Set by server") : undefined;
    if (f.kind === "bool") {
      const v = fixedLabel ? "inherit" : cur === true ? "on" : cur === false ? "off" : "inherit";
      // Ghost the inherited state on the "Inherit" segment, e.g. "Inherit · on".
      return (
        <Segmented
          value={v}
          ariaLabel={f.label}
          disabled={gated || !!fixedLabel}
          onChange={(nv) => setField(f.key, nv === "inherit" ? undefined : nv === "on")}
          options={
            fixedLabel
              ? [{ value: "inherit", label: fixedLabel, title }]
              : [
                  { value: "inherit", label: inheritLabel(inh, inheritWord), title },
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]
          }
        />
      );
    }
    if (f.kind === "number") {
      // Ghost the inherited value into the placeholder when not overridden.
      return (
        <TextInput
          type="number"
          aria-label={f.label}
          aria-describedby={described}
          title={title}
          disabled={gated || !!fixedLabel}
          min={f.min}
          max={f.max}
          step={f.step}
          value={fixedLabel || cur === undefined ? "" : String(cur)}
          placeholder={fixedLabel ?? `${inheritLabel(inh, inheritWord)} · ${f.hint}`}
          onChange={(e) => {
            const s = e.target.value;
            if (s === "") return setField(f.key, undefined);
            const n = Number(s);
            // isFinite (not isNaN) so "1e999" → Infinity also falls back to undefined,
            // instead of being JSON-serialized to null in the request body.
            setField(f.key, Number.isFinite(n) ? n : undefined);
          }}
        />
      );
    }
    return (
      <TextInput
        aria-label={f.label}
        aria-describedby={described}
        title={title}
        disabled={gated || !!fixedLabel}
        value={fixedLabel || cur === undefined ? "" : String(cur)}
        // An explicit empty string is a real override ("clear this — send empty",
        // distinct from inherit), so DON'T coerce "" → undefined here: store the raw
        // value and reach inherit only via the reset button. The accent dot marks the
        // explicit-empty override; a distinct placeholder keeps it from reading as inherit.
        placeholder={
          fixedLabel ??
          (cur === ""
            ? "(cleared — overrides inherited)"
            : inh
              ? inheritLabel(inh, inheritWord)
              : f.hint
                ? `${inheritWord} · ${f.hint}`
                : inheritWord)
        }
        onChange={(e) => setField(f.key, e.target.value)}
      />
    );
  };

  const fieldCell = (f: Field, last: boolean) => {
    const overridden = value[f.key] !== undefined;
    const fixed = isLocked(f) || !!pinOf(f);
    const title = sourceOf(f);
    // The inherited value is ghosted into the control itself (placeholder / "Inherit · on"
    // segment) by renderControl; the row names the field and carries clear / reset.
    return (
      <OverrideHeader
        key={f.key}
        title={f.label}
        env={false}
        overridden={overridden && !fixed}
        lockReason={fixed ? title : undefined}
        describedById={title ? descId(f) : undefined}
        // Text fields can be CLEARED to an explicit empty override (suppress the inherited value).
        onClear={f.kind === "text" && !readOnly(f) ? () => setField(f.key, "") : undefined}
        canClear={value[f.key] !== ""}
        // Reset stays offered on a locked/pinned key: the stored value is ignored, and clearing
        // it is the only thing left to do with it.
        onReset={isGated(f) ? undefined : () => setField(f.key, undefined)}
        note={
          overridden && fixed
            ? pinOf(f)
              ? "Ignored in live dictation"
              : "Ignored · locked by the server"
            : !overridden && !fixed && ignored?.includes(f.key)
              ? "Backend value ignored · locked by the server"
              : undefined
        }
        last={last}
      >
        {f.kind === "bool" ? renderControl(f) : <div className={OVERRIDE_CONTROL_W}>{renderControl(f)}</div>}
      </OverrideHeader>
    );
  };

  const grid = (fields: Field[]) => <div>{fields.map((f, i) => fieldCell(f, i === fields.length - 1))}</div>;

  return (
    <div>
      {blocked ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12px] text-dim">
          <Info className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <div>
            Custom transcription parameters are <span className="text-text">disabled</span> for this
            connection by the server admin. Values below are read-only.
          </div>
        </div>
      ) : standard ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12px] text-dim">
          <Info className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <div>
            This looks like a standard Whisper server — only <span className="text-text">Temperature</span> is
            honoured. The rest are faster-whisper-specific and are disabled here.
          </div>
        </div>
      ) : null}

      {grid(FIELDS.filter((f) => f.section === "primary"))}

      <DisclosureCard
        className="mt-4"
        nested
        open={showAdvanced}
        onToggle={() => setShowAdvanced((v) => !v)}
        title="Advanced decode params"
        summary={(() => {
          const n = FIELDS.filter((f) => f.section !== "primary" && value[f.key] !== undefined).length;
          return n ? <span className="text-accent">· {n} set</span> : undefined;
        })()}
      >
        {/* Guarded at the call site: `children` are built before DisclosureCard runs, so the
            ~19 advanced cells were created on every keystroke in a primary field while
            collapsed (the default). */}
        {showAdvanced && (
          <div className="space-y-5">
            {SECTIONS.map((s) => (
              <div key={s.id}>
                <SectionLabel className="mb-2.5">{s.title}</SectionLabel>
                {grid(FIELDS.filter((f) => f.section === s.id))}
              </div>
            ))}
          </div>
        )}
      </DisclosureCard>
    </div>
  );
}
