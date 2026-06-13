import { useState } from "react";
import { Segmented, TextInput } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { DecodeOverrides } from "@/lib/types";

// Decode-param editor shared by the Backend (defaults) and Profile (override)
// editors. Every field is OPTIONAL: an empty input means "inherit" (the server
// falls back to its per-model config). Booleans are tri-state (Inherit/On/Off)
// because an unset boolean must stay distinct from an explicit false. The backend
// clamps every value, so the ranges shown here are guidance, not hard gates.

type NumField = {
  key: keyof DecodeOverrides;
  label: string;
  kind: "number";
  hint: string;
  min?: number;
  max?: number;
  step?: number;
  advanced?: boolean;
};
type BoolField = { key: keyof DecodeOverrides; label: string; kind: "bool"; advanced?: boolean };
type TextField = { key: keyof DecodeOverrides; label: string; kind: "text"; hint: string; advanced?: boolean };
type Field = NumField | BoolField | TextField;

const FIELDS: Field[] = [
  // ── curated (always visible) ──
  { key: "beam_size", label: "Beam size", kind: "number", hint: "inherit · 1–20", min: 1, max: 20, step: 1 },
  { key: "temperature", label: "Temperature", kind: "number", hint: "inherit · 0–1", min: 0, max: 1, step: 0.1 },
  { key: "condition_on_previous_text", label: "Condition on previous text", kind: "bool" },
  { key: "vad_filter", label: "Voice-activity filter", kind: "bool" },
  { key: "vad_threshold", label: "VAD threshold", kind: "number", hint: "inherit · 0–1", min: 0, max: 1, step: 0.05 },
  { key: "no_speech_threshold", label: "No-speech threshold", kind: "number", hint: "inherit · 0–1", min: 0, max: 1, step: 0.05 },
  { key: "hotwords", label: "Hotwords", kind: "text", hint: "inherit — bias terms" },
  { key: "prepend_punctuations", label: "Prepend punctuation", kind: "text", hint: "inherit" },
  { key: "append_punctuations", label: "Append punctuation", kind: "text", hint: "inherit" },
  // ── advanced (behind disclosure) ──
  { key: "best_of", label: "Best of", kind: "number", hint: "inherit · 1–20", min: 1, max: 20, step: 1, advanced: true },
  { key: "vad_min_silence_duration_ms", label: "VAD min silence (ms)", kind: "number", hint: "inherit · 0–10000", min: 0, max: 10000, step: 50, advanced: true },
  { key: "vad_speech_pad_ms", label: "VAD speech pad (ms)", kind: "number", hint: "inherit · 0–2000", min: 0, max: 2000, step: 10, advanced: true },
  { key: "log_prob_threshold", label: "Log-prob threshold", kind: "number", hint: "inherit · -10–0", min: -10, max: 0, step: 0.5, advanced: true },
  { key: "compression_ratio_threshold", label: "Compression-ratio threshold", kind: "number", hint: "inherit · 0–10", min: 0, max: 10, step: 0.1, advanced: true },
  { key: "suppress_tokens", label: "Suppress tokens", kind: "text", hint: "inherit — comma-separated ids", advanced: true },
  { key: "patience", label: "Patience", kind: "number", hint: "inherit · 0.5–5", min: 0.5, max: 5, step: 0.1, advanced: true },
  { key: "length_penalty", label: "Length penalty", kind: "number", hint: "inherit · 0.1–5", min: 0.1, max: 5, step: 0.1, advanced: true },
  { key: "repetition_penalty", label: "Repetition penalty", kind: "number", hint: "inherit · 0.5–5", min: 0.5, max: 5, step: 0.1, advanced: true },
  { key: "no_repeat_ngram_size", label: "No-repeat n-gram", kind: "number", hint: "inherit · 0–10", min: 0, max: 10, step: 1, advanced: true },
];

export function DecodeFields({
  value,
  onChange,
}: {
  value: DecodeOverrides;
  onChange: (v: DecodeOverrides) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(
    FIELDS.some((f) => f.advanced && value[f.key] !== undefined),
  );

  const setField = (key: keyof DecodeOverrides, v: number | boolean | string | undefined) => {
    const next: DecodeOverrides = { ...value };
    if (v === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = v;
    onChange(next);
  };

  const renderField = (f: Field) => {
    const cur = value[f.key];
    if (f.kind === "bool") {
      const v = cur === true ? "on" : cur === false ? "off" : "inherit";
      return (
        <Segmented
          value={v}
          onChange={(nv) => setField(f.key, nv === "inherit" ? undefined : nv === "on")}
          options={[
            { value: "inherit", label: "Inherit" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      );
    }
    if (f.kind === "number") {
      return (
        <TextInput
          type="number"
          min={f.min}
          max={f.max}
          step={f.step}
          value={cur === undefined ? "" : String(cur)}
          placeholder={f.hint}
          onChange={(e) => {
            const s = e.target.value;
            if (s === "") return setField(f.key, undefined);
            const n = Number(s);
            setField(f.key, Number.isNaN(n) ? undefined : n);
          }}
        />
      );
    }
    return (
      <TextInput
        value={cur === undefined ? "" : String(cur)}
        placeholder={f.hint}
        onChange={(e) => setField(f.key, e.target.value === "" ? undefined : e.target.value)}
      />
    );
  };

  // NB: this is a plain render helper, NOT a nested component. Rendering it as
  // <FieldGrid/> would give it a fresh identity on every keystroke, so React
  // would remount the subtree and the focused <input> would lose focus after a
  // single character. Calling it as a function reconciles the inputs in place.
  const fieldGrid = (fields: Field[]) => (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {fields.map((f) => (
        <div key={f.key}>
          <label className="mb-1.5 block text-[12px] font-medium text-dim">{f.label}</label>
          {renderField(f)}
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {fieldGrid(FIELDS.filter((f) => !f.advanced))}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="ring-signal mt-4 inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-dim hover:text-text"
      >
        <span className={cn("transition-transform", showAdvanced && "rotate-90")}>›</span>
        Advanced decode params
      </button>
      {showAdvanced && <div className="mt-3">{fieldGrid(FIELDS.filter((f) => f.advanced))}</div>}
    </div>
  );
}
