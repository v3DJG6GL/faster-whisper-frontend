import { useId, useState } from "react";
import { Info } from "lucide-react";
import { DisclosureCard, Segmented, SetSummary, Stepper, TextInput } from "@/components/ui";
import { OverrideHeader, OverrideText, OVERRIDE_CONTROL_W } from "@/components/OverrideField";
import type { DecodeOverrides, InheritedValues } from "@/lib/types";
import type { ServerKind } from "@/lib/serverKind";
import { inheritLabel, LOCKED_REASON, NOT_ON_SERVER_REASON, type DecodeKey, type InheritWord, type ServerInherited } from "@/lib/inherit";
import { DECODE_SECTIONS, keySpec, parseLadderInput, sectionKeys, stepDecimals, type KeySection } from "@/lib/decodeKeys";
import { envDesc } from "@/lib/settingDesc";

// Decode-param editor shared by the Backend (defaults) and Profile (override) editors and
// Transcribe. Every field is OPTIONAL: empty = "inherit" (backend default ?? the server's resolved
// default, GET /v1/request-default-settings — see serverInherited). A key the server admin locked
// is read-only and shows the server's value; live dictation's pinned key likewise; a key the
// server does not list (an older backend) is disabled. Booleans are tri-state (Inherit/On/Off)
// because an unset boolean must stay distinct from an explicit false. The backend clamps every
// value; the bounds here come from the one key table (decodeKeys.ts) and mirror the server's.
//
// Rows are titled by the server's ENV name with the backend's short description; the primary
// fields are always shown, every other section is its own (closed) block. Live dictation's keys
// have their own block (LiveDictationFields); `multilingual` rides the spoken-language picker.

/** Why the language-detection rows are disabled while a language is pinned. */
const LANG_PINNED_REASON = "Language detection only runs when the language is auto-detected; this one names a language.";

export function DecodeFields({
  value,
  onChange,
  inherited,
  sources,
  locked,
  pinned,
  ignored,
  known,
  languagePinned,
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
  /** The keys the server lists (serverInherited().known); a missing key's row is disabled.
   *  null/undefined = unknown, nothing disabled. */
  known?: ReadonlySet<DecodeKey> | null;
  /** The request names a language: the language-detection rows do nothing and are disabled. */
  languagePinned?: boolean;
  /** "Inherit" in override editors (Profile, Backend), "Default" for a per-run choice. */
  inheritWord?: InheritWord;
  /** When "standard", a conventional Whisper server: disable everything the
   *  faster-whisper backend adds (keep only temperature, a single number). */
  serverKind?: ServerKind;
  /** Per-identity capability: when false, this caller may not send any custom
   *  decode params — the whole editor is disabled behind one banner. undefined
   *  ("unknown") = permitted (never gate a knob we can't prove is disabled). */
  canCustomize?: boolean;
}) {
  // Every block starts closed; its header says how many fields in it are set.
  const [openSection, setOpenSection] = useState<Partial<Record<KeySection, boolean>>>({});
  const blocked = canCustomize === false; // capability gate: all params disabled
  const standard = serverKind === "standard";
  const uid = useId();
  const descId = (k: DecodeKey) => `${uid}-${k}-src`;

  /** Why a whole row can't be used right now (tooltip), or undefined. */
  const unavailable = (k: DecodeKey): string | undefined => {
    if (blocked) return "Custom transcription parameters are disabled for this connection by the server admin.";
    if (standard && k !== "temperature") return "A standard Whisper server honours only TEMPERATURE.";
    if (known && !known.has(k)) return NOT_ON_SERVER_REASON;
    if (languagePinned && keySpec(k).section === "langdetect") return LANG_PINNED_REASON;
    return undefined;
  };
  // Per-key server lock / dictation pin. Skipped when the whole editor is blocked: the banner says
  // it once, and every key reads as locked then.
  const pinOf = (k: DecodeKey) => (blocked ? undefined : pinned?.[k]);
  const isLocked = (k: DecodeKey) => !blocked && !pinOf(k) && !!locked?.has(k);
  /** The tooltip / screen-reader line for a field's inherited value. */
  const sourceOf = (k: DecodeKey): string | undefined => {
    const pin = pinOf(k);
    if (pin) return pin.reason;
    if (isLocked(k)) return LOCKED_REASON;
    return sources?.[k];
  };

  const setField = (key: DecodeKey, v: number | boolean | string | undefined) => {
    const next: DecodeOverrides = { ...value };
    if (v === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = v;
    onChange(next);
  };

  // The inherited (baseline) value as a short string, or undefined if none.
  const fmtInherited = (k: DecodeKey): string | undefined => {
    const iv = inherited?.[k];
    if (iv === undefined || iv === null || iv === "") return undefined;
    if (keySpec(k).kind === "bool") return iv ? "on" : "off";
    return String(iv);
  };

  // NB: renderControl / row are plain functions called inline, NOT nested components. Rendering
  // them as <Component/> gives a fresh identity on every keystroke, remounting the focused
  // <input> so it loses focus after one character.
  const renderControl = (k: DecodeKey) => {
    const spec = keySpec(k);
    const cur = value[k];
    const off = !!unavailable(k);
    const inh = fmtInherited(k);
    const pin = pinOf(k);
    const title = sourceOf(k);
    const described = title ? descId(k) : undefined;
    // A locked or pinned key shows the value the server uses, not this layer's (ignored) one.
    const fixedLabel = pin ? `Dictation always · ${pin.value}` : isLocked(k) ? inheritLabel(inh, "Set by server") : undefined;
    if (spec.kind === "bool") {
      const v = fixedLabel ? "inherit" : cur === true ? "on" : cur === false ? "off" : "inherit";
      // Ghost the inherited state on the "Inherit" segment, e.g. "Inherit · on".
      return (
        <Segmented
          value={v}
          ariaLabel={spec.env}
          disabled={off || !!fixedLabel}
          onChange={(nv) => setField(k, nv === "inherit" ? undefined : nv === "on")}
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
    if (spec.kind === "text") {
      return (
        <OverrideText
          ariaLabel={spec.env}
          describedBy={described}
          title={title}
          disabled={off}
          fixedLabel={fixedLabel}
          value={typeof cur === "string" ? cur : undefined}
          // An explicit empty string is a real override ("send empty", distinct from inherit):
          // "" is stored as typed; inherit is reached only via reset.
          onChange={(s) => setField(k, s)}
          inherited={inh}
          inheritWord={inheritWord}
          maxLength={spec.maxLen}
        />
      );
    }
    const range = spec.min !== undefined && spec.max !== undefined ? `${spec.min}–${spec.max}${spec.unit ? ` ${spec.unit}` : ""}` : undefined;
    if (spec.kind === "ladder") {
      // One number, or a retry ladder "0.0,0.2,0.4" — a standard server takes one number only.
      return (
        <TextInput
          aria-label={spec.env}
          aria-describedby={described}
          title={title ?? (standard ? "One number, 0–1" : "One number, or retry rungs 0–1 separated by commas")}
          disabled={off || !!fixedLabel}
          inputMode="decimal"
          spellCheck={false}
          value={fixedLabel || cur === undefined ? "" : String(cur)}
          placeholder={fixedLabel ?? inheritLabel(inh, inheritWord)}
          className={cur !== undefined && !fixedLabel ? "border-accent/55" : undefined}
          onChange={(e) => {
            // A ladder stored before (e.g. synced from a full backend) can still be edited down.
            const parsed = parseLadderInput(e.target.value, standard && !String(cur ?? "").includes(","));
            if (parsed !== null) setField(k, parsed);
          }}
        />
      );
    }
    // A locked or pinned number shows the server's value, read-only.
    if (fixedLabel)
      return <TextInput aria-label={spec.env} aria-describedby={described} title={title} disabled value="" placeholder={fixedLabel} />;
    // The app's own −/+ stepper (never the browser's spinner); unset = the inherited value, greyed.
    const inhNum = typeof inherited?.[k] === "number" ? (inherited[k] as number) : undefined;
    return (
      <div aria-describedby={described} title={[title, range].filter(Boolean).join(" · ") || undefined}>
        <Stepper
          className="w-full"
          value={typeof cur === "number" ? cur : undefined}
          onChange={(n) => setField(k, n)}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          decimals={stepDecimals(spec.step)}
          unit={spec.unit}
          zeroLabel={spec.nullText && spec.min === 0 ? spec.nullText : undefined}
          inherited={inhNum}
          inheritedText={inhNum === undefined ? (inh ?? inheritWord) : undefined}
          ariaLabel={spec.env}
          disabled={off}
        />
      </div>
    );
  };

  const row = (k: DecodeKey, last: boolean) => {
    const spec = keySpec(k);
    const overridden = value[k] !== undefined;
    const fixed = isLocked(k) || !!pinOf(k);
    const why = unavailable(k);
    const title = sourceOf(k);
    return (
      <OverrideHeader
        key={k}
        title={spec.env}
        desc={envDesc(spec.env)}
        overridden={overridden && !fixed}
        lockReason={fixed ? title : undefined}
        describedById={title ? descId(k) : undefined}
        // Text fields can be CLEARED to an explicit empty override (suppress the inherited value).
        onClear={spec.kind === "text" && !fixed && !why ? () => setField(k, "") : undefined}
        canClear={value[k] !== ""}
        // Reset stays offered on a locked/pinned/unavailable key while it holds a value: the
        // stored value is ignored, and clearing it is the only thing left to do with it.
        onReset={blocked ? undefined : () => setField(k, undefined)}
        disabled={!!why && !overridden}
        disabledTitle={why}
        note={
          overridden && fixed
            ? pinOf(k)
              ? "Ignored in live dictation"
              : "Ignored · locked by the server"
            : overridden && why
              ? "Ignored here"
              : !overridden && !fixed && ignored?.includes(k)
                ? "Backend value ignored · locked by the server"
                : undefined
        }
        last={last}
      >
        {spec.kind === "bool" ? renderControl(k) : <div className={OVERRIDE_CONTROL_W}>{renderControl(k)}</div>}
      </OverrideHeader>
    );
  };

  const rows = (keys: DecodeKey[]) => keys.map((k, i) => row(k, i === keys.length - 1));

  return (
    <div>
      {blocked ? (
        <div className="mb-1 mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12px] text-dim">
          <Info className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <div>
            Custom transcription parameters are <span className="text-text">disabled</span> for this
            connection by the server admin. Values below are read-only.
          </div>
        </div>
      ) : standard ? (
        <div className="mb-1 mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12px] text-dim">
          <Info className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <div>
            This looks like a standard Whisper server — only <span className="text-text">TEMPERATURE</span> is
            honoured. The rest are faster-whisper-specific and are disabled here.
          </div>
        </div>
      ) : null}

      <div className="mb-3">{rows(sectionKeys("primary"))}</div>

      <div className="flex flex-col gap-2.5 pb-3">
        {DECODE_SECTIONS.map((s) => {
          const keys = sectionKeys(s.id);
          const open = !!openSection[s.id];
          return (
            <DisclosureCard
              key={s.id}
              nested
              open={open}
              onToggle={() => setOpenSection((o) => ({ ...o, [s.id]: !open }))}
              title={s.title}
              summary={
                keys.some((k) => value[k] !== undefined) ? (
                  <SetSummary count={keys.filter((k) => value[k] !== undefined).length} inherit="" />
                ) : undefined
              }
              hint={s.id === "langdetect" && languagePinned ? LANG_PINNED_REASON : undefined}
            >
              {/* Guarded: `children` are built before DisclosureCard runs, so a closed block's
                  rows would otherwise be created on every keystroke elsewhere. */}
              {open && rows(keys)}
            </DisclosureCard>
          );
        })}
      </div>
    </div>
  );
}
