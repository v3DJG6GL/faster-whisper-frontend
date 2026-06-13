import { Mic, Radio, Hand, Square, Pencil } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/lib/store";
import { Button, Card, SectionLabel, Select, StatusDot, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import { HotkeyChips } from "@/components/HotkeyChips";
import { startLive, stopLive } from "@/lib/streaming";
import type { Backend, Profile } from "@/lib/types";

const GLYPH = { hold: Mic, latch: Hand } as const;

function ProfileCard({ p }: { p: Profile }) {
  const backends = useApp((s) => s.backends);
  const updateProfile = useApp((s) => s.updateProfile);
  const navigate = useNavigate();
  const backend = backends.find((b) => b.id === p.backendId);
  const Glyph = GLYPH[p.activation];
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">
            <Glyph className="size-[18px]" />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-text">{p.name}</div>
            <div className="text-[12px] text-dim">
              {p.activation === "hold" ? "Hold the hotkey while you speak" : "Tap once to start, tap again to stop"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            title="Edit profile"
            onClick={() => navigate(`/profiles?edit=${p.id}`)}
          >
            <Pencil className="size-4" />
          </Button>
          <Toggle checked={p.enabled} onChange={(v) => updateProfile(p.id, { enabled: v })} />
        </div>
      </div>
      <div className="mt-5 flex items-center justify-between">
        <HotkeyChips codes={p.hotkey} />
        <div className="text-right">
          <div className="font-mono text-[11px] uppercase tracking-label text-faint">{backend?.endpoint ?? "—"}</div>
          <div className="text-[12.5px] text-dim">{backend?.name ?? "No backend"}</div>
        </div>
      </div>
    </Card>
  );
}

export default function Home() {
  const profiles = useApp((s) => s.profiles);
  const backends = useApp((s) => s.backends);
  const level = useApp((s) => s.level);
  const status = useApp((s) => s.status);
  const partial = useApp((s) => s.partial);
  const dictationError = useApp((s) => s.dictationError);
  const micId = useApp((s) => s.settings.microphoneId);
  const homeProfileId = useApp((s) => s.settings.homeProfileId);
  const updateSettings = useApp((s) => s.updateSettings);
  const setDictation = useApp((s) => s.setDictation);

  const enabled = profiles.filter((p) => p.enabled);
  // The hero button has no held chord (you click it), so it always dictates in latch
  // style. It targets the profile picked below — falling back to the first enabled
  // latch profile, then any enabled — and uses that profile's backend + overrides.
  const target =
    enabled.find((p) => p.id === homeProfileId) ??
    enabled.find((p) => p.activation === "latch") ??
    enabled[0];
  const headerBackend: Backend | undefined =
    backends.find((b) => b.id === target?.backendId) ?? backends[0];

  const dictating = status === "listening" || status === "transcribing";
  const toggle = () => {
    if (dictating) {
      void stopLive();
      return;
    }
    if (!headerBackend) return;
    // Tell the overlay chip which Profile is dictating (the hotkey path does this in
    // dictate(); the button bypasses it). null when only a backend is targeted.
    setDictation({ activeProfile: target?.id ?? null });
    // startLive resolves effective language / prompt / decode (target over backend);
    // target may be undefined → the backend's own defaults are used.
    void startLive(headerBackend, micId, "latch", target);
  };

  return (
    <div className="mx-auto max-w-[900px] px-10 py-12">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">faster-whisper · dictation</div>
          <h1 className="mt-2 font-display text-[40px] font-bold leading-none tracking-tight text-text">
            Speak into any field.
          </h1>
          <p className="mt-3 max-w-md text-[14px] text-dim">
            Push-to-talk or latch it on. Audio streams to your own faster-whisper backend and the text appears wherever your cursor is.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-pill border border-line bg-surface/70 px-3 py-1.5">
          <StatusDot tone="ok" />
          <span className="font-mono text-[11px] text-dim">
            {headerBackend?.serverUrl.replace(/^https?:\/\//, "") ?? "no backend"}
          </span>
        </div>
      </div>

      {/* Hero instrument */}
      <Card className="mt-8 overflow-hidden p-0">
        <div className="flex items-center gap-6 px-8 py-7">
          <button
            type="button"
            onClick={(e) => {
              // Blur immediately. With "Press Enter after" enabled, stopping via
              // this button leaves it focused; the autoEnter Return injected on
              // stop would then land on the focused button (Enter = activate) and
              // restart dictation. Dropping focus sends that Return to <body> (a
              // no-op) instead. The hotkey path is unaffected (the target app, not
              // our window, has focus there).
              e.currentTarget.blur();
              toggle();
            }}
            className={
              "ring-signal grid size-16 shrink-0 place-items-center rounded-full transition-transform hover:scale-105 " +
              (dictating ? "bg-rec text-white" : "bg-accent text-accent-ink")
            }
            title={dictating ? "Stop dictation" : "Start a live dictation"}
          >
            {dictating ? <Square className="size-6" /> : <Mic className="size-7" />}
          </button>
          <div className="min-w-0 flex-1 space-y-1">
            {enabled.length > 0 ? (
              enabled.slice(0, 4).map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-[15px] text-text">
                  <span className="text-dim">{p.activation === "hold" ? "Hold" : "Tap"}</span>
                  <HotkeyChips codes={p.hotkey} />
                  <span className="text-dim">{p.activation === "hold" ? "to talk" : "to latch"}</span>
                  <span className="truncate text-[12.5px] text-faint">· {p.name}</span>
                </div>
              ))
            ) : (
              <div className="text-[15px] text-dim">Enable a profile below to begin.</div>
            )}
            {enabled.length > 0 && (
              <div className="flex items-center gap-2 pt-1 text-[12.5px] text-dim">
                <span className="shrink-0">The button dictates with</span>
                <Select
                  value={target?.id ?? ""}
                  onChange={(v) => updateSettings({ homeProfileId: v })}
                  options={enabled.map((p) => ({ value: p.id, label: p.name }))}
                  className="w-40"
                />
              </div>
            )}
            <div className="pt-0.5 text-[12.5px] text-faint">
              The transcript appears wherever your cursor is.
            </div>
          </div>
          <Waveform level={level} active={status !== "idle"} bars={28} variant="bars" className="h-12 w-48" />
        </div>
        <div className="grid grid-cols-3 border-t border-line font-mono text-[12px]">
          <Readout label="model" value={headerBackend?.model ?? "—"} />
          <Readout label="endpoint" value={headerBackend?.endpoint ?? "—"} accent />
          <Readout label="language" value={headerBackend?.language ?? "auto"} last />
        </div>
      </Card>

      {(dictating || partial || status === "error") && (
        <Card className="mt-4 p-5">
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-label text-faint">
            <Waveform
              level={level}
              active={dictating}
              bars={5}
              variant="dots"
              tone={status === "transcribing" ? "accent" : status === "error" ? "dim" : "rec"}
              className="h-4 w-10"
            />
            {status === "transcribing" ? "finalizing…" : status === "error" ? "error" : "listening"}
          </div>
          {status === "error" && dictationError ? (
            <div className="select-text text-[13.5px] leading-relaxed text-rec">{dictationError}</div>
          ) : (
            <div className="min-h-6 select-text whitespace-pre-wrap text-[15px] leading-relaxed text-text">
              {partial || <span className="text-faint">…</span>}
            </div>
          )}
        </Card>
      )}

      <SectionLabel className="mb-3 mt-10">Profiles</SectionLabel>
      {profiles.length === 0 ? (
        <Card className="p-6 text-[13.5px] text-dim">
          No profiles yet — add one on the Profiles screen.
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {profiles.map((p) => (
            <ProfileCard key={p.id} p={p} />
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 px-1 text-[12px] text-faint">
        <Radio className="size-3.5" />
        Streaming backends show a live transcript in the chip while you speak.
      </div>
    </div>
  );
}

function Readout({ label, value, accent, last }: { label: string; value: string; accent?: boolean; last?: boolean }) {
  return (
    <div className={"px-8 py-4 " + (!last ? "border-r border-line" : "")}>
      <div className="text-[10px] uppercase tracking-label text-faint">{label}</div>
      <div className={"mt-1 truncate text-[13px] " + (accent ? "text-accent" : "text-text")}>{value}</div>
    </div>
  );
}
