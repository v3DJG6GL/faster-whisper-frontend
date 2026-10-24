// The live-dictation knobs (the stream handshake's `streaming_*` decode keys), built like
// DecodeFields over the one key table: Profiles ("Live dictation overrides", with the "What
// you'd get" preview) and Backends ("Live dictation defaults"). The values ride the profile's /
// backend's `decodeOverrides`; every batch request drops them (Rust batch.rs post()).
//
// The server applies them and keeps the pair rules (inner < outer, hard break 0 or > outer);
// the steppers keep the inner pause below the outer one (a server-locked partner is clamped
// against, never moved), and the preview runs the values through serverTimings(), so it never
// shows a pair the server would rewrite.
// Nothing here acts on the values — the preview just draws them.
import { useId, type CSSProperties } from "react";
import { RangeField, Stepper } from "@/components/ui";
import { OverrideHeader, OverrideText } from "@/components/OverrideField";
import { OVERRIDE_CONTROL_W } from "@/components/styles";
import type { DecodeOverrides, InheritedValues } from "@/lib/types";
import { keySpec, sectionKeys, type DecodeKey } from "@/lib/decodeKeys";
import { LOCKED_REASON, NOT_ON_SERVER_REASON, type ServerInherited } from "@/lib/inherit";
import { envDesc } from "@/lib/envDesc";
import {
  keepInnerBelowOuter,
  LIVE_FALLBACK,
  livePreview,
  previewRule,
  secText,
  separatorGlyphs,
  serverTimings,
  type LiveTimings,
  type PairFacts,
  type PauseKind,
} from "@/lib/livePreview";

/** The preview's colour per pause kind; the related rows carry the same dot. */
const PAUSE_COLOR: Record<PauseKind, string> = {
  go: "var(--c-faint)",
  ref: "var(--c-warn)",
  end: "var(--c-ok)",
  par: "var(--c-para)",
};

/** How each live key is edited. The ranges are the editor's, inside the server's bounds in
 *  DECODE_KEYS, which the sync sanitizer and the server enforce. */
const CONTROL: Partial<Record<DecodeKey, { min: number; max: number; step: number; dot?: PauseKind }>> = {
  streaming_vad_inner_silence_ms: { min: 200, max: 3900, step: 100, dot: "ref" },
  streaming_vad_outer_silence_ms: { min: 400, max: 4000, step: 100, dot: "end" },
  // Edited in whole seconds ("never" at 0), stored in ms.
  streaming_hard_break_silence_ms: { min: 0, max: 20, step: 1, dot: "par" },
  streaming_hard_break_separator: { min: 0, max: 0, step: 0, dot: "par" },
  streaming_vad_threshold: { min: 0.1, max: 0.9, step: 0.05 },
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function LiveDictationFields({
  value,
  onChange,
  inherited,
  sources,
  serverValues,
  locked,
  known,
  disabledReason,
  preview,
}: {
  /** The whole decodeOverrides object; only the live keys are edited here. */
  value: DecodeOverrides;
  onChange: (v: DecodeOverrides) => void;
  /** What an unset key inherits (serverInherited().values: the server's, a backend's over it). */
  inherited?: InheritedValues;
  /** Where each inherited value comes from: "Backend default" reads "· backend", else "· server". */
  sources?: ServerInherited["sources"];
  /** The server's own values (no backend layer under them), when `inherited` mixes a backend's
   *  in: what runs when the server drops a client value. Absent = `inherited` is the server's. */
  serverValues?: InheritedValues;
  locked?: ReadonlySet<DecodeKey>;
  known?: ReadonlySet<DecodeKey> | null;
  /** The whole block does nothing here (e.g. the profile uses the Batch endpoint): the tooltip. */
  disabledReason?: string;
  /** Show the "What you'd get" sample (Profiles). */
  preview?: boolean;
}) {
  const uid = useId();
  const keys = sectionKeys("live");

  const patch = (p: Partial<Record<DecodeKey, number | string | undefined>>) => {
    const next: Record<string, unknown> = { ...value };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    onChange(next as DecodeOverrides);
  };
  const own = (k: DecodeKey) => value[k];
  // What the server applies: a locked key's own value is ignored ("Ignored · locked by the
  // server"), and its inherited value is already the server's.
  const eff = (k: DecodeKey) => (locked?.has(k) ? undefined : value[k]);
  const inh = (k: DecodeKey) => inherited?.[k];
  const noteOf = (k: DecodeKey) => (sources?.[k] === "Backend default" ? "backend" : "server");

  // The four knobs as the preview reads them: own value (unless locked), else inherited, else the
  // server's documented default (a server that hasn't answered yet).
  const t: LiveTimings = {
    innerMs: num(eff("streaming_vad_inner_silence_ms")) ?? num(inh("streaming_vad_inner_silence_ms")) ?? LIVE_FALLBACK.innerMs,
    outerMs: num(eff("streaming_vad_outer_silence_ms")) ?? num(inh("streaming_vad_outer_silence_ms")) ?? LIVE_FALLBACK.outerMs,
    hardMs: num(eff("streaming_hard_break_silence_ms")) ?? num(inh("streaming_hard_break_silence_ms")) ?? LIVE_FALLBACK.hardMs,
    separator: str(eff("streaming_hard_break_separator")) ?? str(inh("streaming_hard_break_separator")) ?? LIVE_FALLBACK.separator,
  };

  // Which pauses the server rewrites as a pair (serverTimings): only client-sent ones — this
  // row's own value or the backend's under it — and never a locked one.
  const sent = (k: DecodeKey) =>
    !disabledReason && !locked?.has(k) && (value[k] !== undefined || sources?.[k] === "Backend default");
  const outerKey: DecodeKey = "streaming_vad_outer_silence_ms";
  const pairFacts: PairFacts = {
    client: {
      inner: sent("streaming_vad_inner_silence_ms"),
      outer: sent(outerKey),
      hard: sent("streaming_hard_break_silence_ms"),
    },
    innerLocked: !!locked?.has("streaming_vad_inner_silence_ms"),
    hardLocked: !!locked?.has("streaming_hard_break_silence_ms"),
    serverOuterMs:
      num(serverValues?.[outerKey]) ??
      (sources?.[outerKey] !== "Backend default" ? num(inh(outerKey)) : undefined) ??
      LIVE_FALLBACK.outerMs,
  };

  /** Inner/outer: write the moved one, and the other only when it had to move along. A partner
   *  the server locked never moves (its write would be ignored): the moved one is clamped against
   *  it instead. */
  const setPause = (changed: "inner" | "outer", ms: number) => {
    const partner: DecodeKey = changed === "inner" ? "streaming_vad_outer_silence_ms" : "streaming_vad_inner_silence_ms";
    if (locked?.has(partner)) {
      // Roles swapped: the locked partner is the fixed one, so keepInnerBelowOuter moves `changed`.
      const pair =
        changed === "inner"
          ? keepInnerBelowOuter("outer", ms, t.outerMs)
          : keepInnerBelowOuter("inner", t.innerMs, ms);
      patch(
        changed === "inner"
          ? { streaming_vad_inner_silence_ms: pair.innerMs }
          : { streaming_vad_outer_silence_ms: pair.outerMs },
      );
      return;
    }
    const pair = keepInnerBelowOuter(
      changed,
      changed === "inner" ? ms : t.innerMs,
      changed === "outer" ? ms : t.outerMs,
    );
    patch({
      streaming_vad_inner_silence_ms: changed === "inner" || pair.innerMs !== t.innerMs ? pair.innerMs : own("streaming_vad_inner_silence_ms") as number | undefined,
      streaming_vad_outer_silence_ms: changed === "outer" || pair.outerMs !== t.outerMs ? pair.outerMs : own("streaming_vad_outer_silence_ms") as number | undefined,
    });
  };

  /** Inner/outer ↺: the reset one inherits again, and the other moves along when the inherited
   *  value would break inner < outer (an own inner 400 / outer 500, inner reset to 700). */
  const resetPause = (which: "inner" | "outer") => {
    const k: DecodeKey = which === "inner" ? "streaming_vad_inner_silence_ms" : "streaming_vad_outer_silence_ms";
    const inheritedMs = num(inh(k)) ?? (which === "inner" ? LIVE_FALLBACK.innerMs : LIVE_FALLBACK.outerMs);
    const pair = keepInnerBelowOuter(
      which,
      which === "inner" ? inheritedMs : t.innerMs,
      which === "outer" ? inheritedMs : t.outerMs,
    );
    // A locked partner is not written (the server ignores it); its value is what the reset meets.
    const partnerLocked = !!locked?.has(which === "inner" ? "streaming_vad_outer_silence_ms" : "streaming_vad_inner_silence_ms");
    patch({
      [k]: undefined,
      ...(!partnerLocked && which === "inner" && pair.outerMs !== t.outerMs ? { streaming_vad_outer_silence_ms: pair.outerMs } : {}),
      ...(!partnerLocked && which === "outer" && pair.innerMs !== t.innerMs ? { streaming_vad_inner_silence_ms: pair.innerMs } : {}),
    });
  };
  /** One key's ↺, shared by its control and its row: a pause moves its partner along, any other
   *  key just inherits again. */
  const resetOf = (k: DecodeKey) =>
    k === "streaming_vad_inner_silence_ms"
      ? resetPause("inner")
      : k === "streaming_vad_outer_silence_ms"
        ? resetPause("outer")
        : patch({ [k]: undefined });

  // A disabled control shows the value the server applies (eff): a locked key's ignored own value
  // is not what runs, so it would read as the setting in force.
  const control = (k: DecodeKey, off: boolean) => {
    const spec = keySpec(k);
    const c = CONTROL[k]!;
    const label = spec.env;
    switch (k) {
      case "streaming_vad_inner_silence_ms":
      case "streaming_vad_outer_silence_ms":
        return (
          <Stepper
            value={num(eff(k))}
            inherited={num(inh(k)) ?? (k === "streaming_vad_inner_silence_ms" ? LIVE_FALLBACK.innerMs : LIVE_FALLBACK.outerMs)}
            inheritNote={noteOf(k)}
            onReset={() => resetOf(k)}
            onChange={(n) => setPause(k === "streaming_vad_inner_silence_ms" ? "inner" : "outer", n)}
            min={c.min}
            max={c.max}
            step={c.step}
            unit="ms"
            ariaLabel={label}
            disabled={off}
          />
        );
      case "streaming_hard_break_silence_ms": {
        const ms = num(eff(k));
        return (
          <Stepper
            value={ms === undefined ? undefined : ms / 1000}
            inherited={(num(inh(k)) ?? LIVE_FALLBACK.hardMs) / 1000}
            inheritNote={noteOf(k)}
            onReset={() => resetOf(k)}
            onChange={(s) => patch({ [k]: Math.round(s * 1000) })}
            min={c.min}
            max={c.max}
            step={c.step}
            decimals={1}
            unit="s"
            zeroLabel="never"
            ariaLabel={label}
            disabled={off}
          />
        );
      }
      case "streaming_hard_break_separator": {
        const i = inh(k);
        return (
          <div className={OVERRIDE_CONTROL_W}>
            <OverrideText
              ariaLabel={label}
              escape
              maxLength={spec.maxLen}
              value={str(eff(k))}
              onChange={(s) => patch({ [k]: s })}
              // The server's "" is a real value: nothing is typed at a hard break.
              inherited={i === "" ? "nothing" : str(i) ?? (known ? "nothing" : undefined)}
              title="\n = a line break, \t = a tab"
              disabled={off}
            />
          </div>
        );
      }
      default: {
        // STREAMING_VAD_THRESHOLD: a slider, ↺ back to the inherited value.
        const v = num(eff(k));
        const base = num(inh(k)) ?? 0.5;
        return (
          <RangeField
            label={label}
            hideLabel
            value={v ?? base}
            inherited={v === undefined}
            min={c.min}
            max={c.max}
            step={c.step}
            defaultValue={base}
            onChange={(n) => patch({ [k]: Math.round(n * 100) / 100 })}
            onReset={() => resetOf(k)}
            disabled={off}
          />
        );
      }
    }
  };

  return (
    <div>
      {keys.map((k, i) => {
        const spec = keySpec(k);
        const isLocked = !!locked?.has(k);
        const why = disabledReason ?? (known && !known.has(k) ? NOT_ON_SERVER_REASON : undefined);
        const dot = preview ? CONTROL[k]?.dot : undefined;
        const hasOwn = value[k] !== undefined;
        // The control is disabled (locked, or `why`) and its own ↺ with it, so the row's reset takes
        // over while the key still holds a value: the stored value is ignored, and clearing it is the
        // only thing left to do with it (DecodeFields does the same). The text field always takes
        // the row's reset; an enabled stepper or slider carries its own.
        const onReset =
          k === "streaming_hard_break_separator" || isLocked
            ? () => patch({ [k]: undefined })
            : why
              ? () => resetOf(k)
              : undefined;
        return (
          <OverrideHeader
            key={k}
            title={spec.env}
            desc={envDesc(spec.env)}
            overridden={hasOwn && !isLocked}
            resettable={hasOwn}
            lockReason={isLocked ? LOCKED_REASON : undefined}
            describedById={isLocked ? `${uid}-${k}` : undefined}
            onClear={k === "streaming_hard_break_separator" && !isLocked && !why ? () => patch({ [k]: "" }) : undefined}
            canClear={value[k] !== ""}
            clearTitle="Override with empty (type nothing at a hard break)"
            onReset={onReset}
            disabled={!!why && !hasOwn}
            disabledTitle={why}
            dot={dot ? PAUSE_COLOR[dot] : undefined}
            dotTitle={dot ? "Its colour in the preview" : undefined}
            // A row kept live for its reset loses the disabled tooltip: say why its value does nothing.
            note={isLocked && hasOwn ? "Ignored · locked by the server" : why && hasOwn ? "Ignored here" : undefined}
            last={i === keys.length - 1 && !preview}
          >
            {control(k, !!why || isLocked)}
          </OverrideHeader>
        );
      })}
      {preview && <LivePreview t={t} facts={pairFacts} />}
    </div>
  );
}

const chip = (color: string): CSSProperties => ({
  color,
  background: color === PAUSE_COLOR.go ? "var(--c-surface-2)" : `color-mix(in srgb, ${color} 14%, transparent)`,
});

const PAUSE_TIP: Record<PauseKind, string> = {
  go: "Too short to do anything",
  ref: "The live preview refreshes; no period",
  end: "Sentence ends",
  par: "New paragraph",
};

/** "What you'd get": the sample dictation typed into a little app window, each pause shown
 *  where it happens, in the colour of the setting that decides it. */
function LivePreview({ t, facts }: { t: LiveTimings; facts: PairFacts }) {
  const st = serverTimings(t, facts);
  const rule = previewRule(st);
  const tokens = livePreview(st);
  return (
    <div className="mb-3 mt-2 flex flex-col gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="text-[12.5px] font-semibold text-dim">What you&apos;d get</div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[12px] text-faint">
        {(Object.keys(rule) as PauseKind[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-[7px] rounded-full" style={{ background: PAUSE_COLOR[k] }} aria-hidden />
            {rule[k]}
          </span>
        ))}
      </div>
      <div className="overflow-hidden rounded-[10px] border border-line-strong bg-bg">
        <div className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-2.5 py-1.5 text-[11.5px] text-faint">
          {[0, 1, 2].map((i) => (
            <span key={i} className="inline-block size-2 rounded-full bg-line-strong" aria-hidden />
          ))}
          <span className="ml-1.5">Sample · typed into your app</span>
        </div>
        <div className="px-3.5 pb-3.5 pt-3 font-typewriter text-[15px] leading-[1.95] tracking-[0.01em] text-text">
          {tokens.map((tk, i) => {
            switch (tk.kind) {
              case "words": {
                if (!tk.glued) return <span key={i}>{tk.text}</span>;
                const [first, ...rest] = tk.text.split(" ");
                return (
                  <span key={i}>
                    <mark
                      title="Glued to the sentence before: no separator"
                      className="bg-transparent text-inherit underline decoration-rec decoration-wavy underline-offset-4"
                    >
                      {first}
                    </mark>
                    {rest.length ? ` ${rest.join(" ")}` : ""}
                  </span>
                );
              }
              case "period":
                return <span key={i}>.</span>;
              case "space":
                return <span key={i}> </span>;
              case "pause":
                return (
                  <span
                    key={i}
                    title={PAUSE_TIP[tk.pause]}
                    className="mx-0.5 inline-block rounded-md px-1.5 align-[1px] font-mono text-[10.5px] leading-[18px]"
                    style={chip(PAUSE_COLOR[tk.pause])}
                  >
                    {secText(tk.seconds)}
                    {tk.pause === "par" ? " ¶" : tk.pause === "ref" ? " ↻ preview" : ""}
                  </span>
                );
              case "separator":
                return (
                  <span key={i}>
                    <span
                      title="Your separator"
                      className="inline-block min-w-[0.55em] whitespace-pre rounded px-px"
                      style={{
                        color: "var(--c-para)",
                        background: "color-mix(in srgb, var(--c-para) 22%, transparent)",
                        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--c-para) 45%, transparent)",
                      }}
                    >
                      {separatorGlyphs(tk.text)}
                    </span>
                    {tk.text.includes("\n") && <br />}
                  </span>
                );
            }
          })}
          <span className="preview-caret ml-0.5 inline-block h-[1.1em] w-0.5 bg-accent align-[-3px]" aria-hidden />
        </div>
      </div>
    </div>
  );
}
