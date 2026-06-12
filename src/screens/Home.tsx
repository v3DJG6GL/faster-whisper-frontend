import { Mic, Radio, Hand } from "lucide-react";
import { useApp } from "@/lib/store";
import { Card, Kbd, SectionLabel, StatusDot, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import type { ModeBinding } from "@/lib/types";

function HotkeyChips({ hotkey }: { hotkey: string }) {
  const keys = hotkey.split("+");
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-faint">+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}

function ModeCard({ mode, icon: Icon, title, hint }: { mode: ModeBinding; icon: typeof Mic; title: string; hint: string }) {
  const profiles = useApp((s) => s.profiles);
  const updateMode = useApp((s) => s.updateMode);
  const profile = profiles.find((p) => p.id === mode.profileId);
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">
            <Icon className="size-[18px]" />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-text">{title}</div>
            <div className="text-[12px] text-dim">{hint}</div>
          </div>
        </div>
        <Toggle checked={mode.enabled} onChange={(v) => updateMode(mode.mode, { enabled: v })} />
      </div>
      <div className="mt-5 flex items-center justify-between">
        <HotkeyChips hotkey={mode.hotkey} />
        <div className="text-right">
          <div className="font-mono text-[11px] uppercase tracking-label text-faint">{profile?.endpoint ?? "—"}</div>
          <div className="text-[12.5px] text-dim">{profile?.name ?? "No profile"}</div>
        </div>
      </div>
    </Card>
  );
}

export default function Home() {
  const modes = useApp((s) => s.modes);
  const profiles = useApp((s) => s.profiles);
  const level = useApp((s) => s.level);
  const status = useApp((s) => s.status);
  const hold = modes.find((m) => m.mode === "hold")!;
  const handsfree = modes.find((m) => m.mode === "handsfree")!;
  const active = profiles.find((p) => p.id === hold.profileId) ?? profiles[0];

  return (
    <div className="mx-auto max-w-[900px] px-10 py-12">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">faster-whisper · dictation</div>
          <h1 className="mt-2 font-display text-[40px] font-bold leading-none tracking-tight text-text">
            Speak into any field.
          </h1>
          <p className="mt-3 max-w-md text-[14px] text-dim">
            Push-to-talk or latch it on. Audio streams to your own faster-whisper server and the text appears wherever your cursor is.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-pill border border-line bg-surface/70 px-3 py-1.5">
          <StatusDot tone="ok" />
          <span className="font-mono text-[11px] text-dim">{active?.serverUrl.replace(/^https?:\/\//, "") ?? "no server"}</span>
        </div>
      </div>

      {/* Hero instrument */}
      <Card className="mt-8 overflow-hidden p-0">
        <div className="flex items-center gap-6 px-8 py-7">
          <button
            type="button"
            className="ring-signal group grid size-16 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition-transform hover:scale-105"
            title="Press your hotkey to dictate"
          >
            <Mic className="size-7" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] text-text">
              Hold <HotkeyChips hotkey={hold.hotkey} /> and speak.
            </div>
            <div className="mt-1.5 text-[12.5px] text-dim">
              Release to transcribe · {handsfree.hotkey} latches it on
            </div>
          </div>
          <Waveform level={level} active={status !== "idle"} bars={28} variant="bars" className="h-12 w-48" />
        </div>
        <div className="grid grid-cols-3 border-t border-line font-mono text-[12px]">
          <Readout label="model" value={active?.model ?? "—"} />
          <Readout label="endpoint" value={active?.endpoint ?? "—"} accent />
          <Readout label="language" value={active?.language ?? "auto"} last />
        </div>
      </Card>

      <SectionLabel className="mb-3 mt-10">Dictation modes</SectionLabel>
      <div className="grid grid-cols-2 gap-4">
        <ModeCard mode={hold} icon={Mic} title="Push-to-talk" hint="Hold the hotkey while you speak" />
        <ModeCard mode={handsfree} icon={Hand} title="Latch" hint="Tap once to start, tap again to stop" />
      </div>

      <div className="mt-4 flex items-center gap-2 px-1 text-[12px] text-faint">
        <Radio className="size-3.5" />
        Streaming profiles show a live transcript in the chip while you speak.
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
