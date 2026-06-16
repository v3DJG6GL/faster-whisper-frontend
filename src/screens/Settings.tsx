import { useState, useEffect, useCallback } from "react";
import { Mic, Check, RefreshCw, Square, ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Segmented, SectionLabel, Select, SettingRow, Stepper, StatusDot, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import { SCREENS, OVERLAY_ACTIONS, quickLaunchMeta } from "@/lib/screens";
import {
  listAudioDevices,
  startMicTest,
  stopMicTest,
  onAudioLevel,
  evdevStatus,
  evdevSetup,
  setDeepFieldDetection,
  type EvdevStatus,
} from "@/lib/api";
import type { AudioDevice, OverlayQuickAction } from "@/lib/types";
import { PASTE_PRESETS, pasteKey, pasteCodes } from "@/lib/paste";

const TABS = ["General", "Audio", "Recording", "Chip", "Permissions"] as const;
type Tab = (typeof TABS)[number];

function AudioTab() {
  const microphoneId = useApp((s) => s.settings.microphoneId);
  const updateSettings = useApp((s) => s.updateSettings);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);

  const refresh = useCallback(async () => {
    setDevices(await listAudioDevices());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Mic test: subscribe to levels and open the device while `testing` is on.
  useEffect(() => {
    if (!testing) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const un = await onAudioLevel((l) => {
        if (active) setLevel(l);
      });
      // Torn down mid-await (test toggled off / device switched) → don't leave the
      // level listener registered for the rest of the session.
      if (!active) {
        un();
        return;
      }
      unlisten = un;
      await startMicTest(microphoneId);
    })();
    return () => {
      active = false;
      unlisten?.();
      void stopMicTest();
      setLevel(0);
    };
  }, [testing, microphoneId]);

  const options = [
    { value: "default", label: "System default" },
    ...devices.map((d) => ({ value: d.id, label: d.label })),
  ];

  return (
    <Card className="px-6">
      <SettingRow title="Microphone" desc="Audio input device used for dictation.">
        <div className="flex items-center gap-2">
          <Select
            value={microphoneId ?? "default"}
            onChange={(v) => updateSettings({ microphoneId: v === "default" ? null : v })}
            options={options}
            className="w-56"
          />
          <Button variant="ghost" size="sm" title="Refresh devices" onClick={() => void refresh()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </SettingRow>
      <SettingRow title="Test microphone" desc="Open the mic and watch the input level." last>
        <div className="flex items-center gap-3">
          <Waveform level={level} active={testing} bars={16} tone={testing ? "accent" : "dim"} className="h-7 w-28" />
          <Button variant={testing ? "danger" : "default"} size="sm" onClick={() => setTesting((t) => !t)}>
            {testing ? (
              <>
                <Square className="size-3.5" /> Stop
              </>
            ) : (
              <>
                <Mic className="size-4" /> Test
              </>
            )}
          </Button>
        </div>
      </SettingRow>
    </Card>
  );
}

const QUICK_LAUNCH_MAX = 6;

/** Editor for the overlay chip's quick-launch buttons: an ordered list of screens +
 *  dictation actions the user can add/reorder/remove (capped to fit the chip). */
function QuickLaunchEditor({
  items,
  onChange,
}: {
  items: OverlayQuickAction[];
  onChange: (v: OverlayQuickAction[]) => void;
}) {
  const [pick, setPick] = useState("");
  const used = new Set(items.map((e) => `${e.kind}:${e.target}`));
  const addable = [
    ...SCREENS.map((s) => ({ value: `screen:${s.id}`, label: `Screen · ${s.label}` })),
    ...OVERLAY_ACTIONS.map((a) => ({ value: `action:${a.id}`, label: `Action · ${a.label}` })),
  ].filter((o) => !used.has(o.value));

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => {
    if (!pick) return;
    const [kind, target] = pick.split(":");
    onChange([
      ...items,
      {
        id: crypto.randomUUID(),
        kind: kind as "screen" | "action",
        target: target as OverlayQuickAction["target"],
      },
    ]);
    setPick("");
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {items.length === 0 && (
        <div className="text-[12.5px] text-faint">No buttons yet — add screens or dictation actions below.</div>
      )}
      {items.map((e, i) => {
        const { label, icon: Icon } = quickLaunchMeta(e);
        return (
          <div
            key={e.id}
            className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2/40 px-3 py-2"
          >
            <Icon className="size-4 shrink-0 text-faint" />
            <span className="text-[13px] text-text">{label}</span>
            <span className="font-mono text-[10px] uppercase tracking-label text-faint">{e.kind}</span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Move down"
                onClick={() => move(i, 1)}
                disabled={i === items.length - 1}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Remove"
                onClick={() => onChange(items.filter((x) => x.id !== e.id))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
      {items.length < QUICK_LAUNCH_MAX && addable.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            className="flex-1"
            value={pick}
            onChange={setPick}
            options={[{ value: "", label: "Add a button…" }, ...addable]}
          />
          <Button size="sm" onClick={add} disabled={!pick}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>("General");
  const s = useApp((st) => st.settings);
  const updateGeneral = useApp((st) => st.updateGeneral);
  const updateRecording = useApp((st) => st.updateRecording);
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  const [evdevMsg, setEvdevMsg] = useState<string | null>(null);
  const [evdevBusy, setEvdevBusy] = useState(false);

  useEffect(() => {
    void evdevStatus().then(setEvdev);
  }, [tab]);

  const runEvdevSetup = () => {
    setEvdevBusy(true);
    setEvdevMsg(null);
    void evdevSetup()
      .then((m) => {
        setEvdevMsg(m);
        return evdevStatus().then(setEvdev);
      })
      .catch((e) => setEvdevMsg(String(e)))
      .finally(() => setEvdevBusy(false));
  };

  return (
    <div className="mx-auto flex max-w-[880px] gap-8 px-10 py-12">
      <div className="w-[150px] shrink-0">
        <h1 className="mb-5 font-display text-[22px] font-bold tracking-tight text-text">Settings</h1>
        <div className="flex flex-col gap-0.5">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "ring-signal rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors " +
                (tab === t ? "bg-surface-2 text-text" : "text-dim hover:text-text")
              }
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {tab === "General" && (
          <Card className="px-6">
            <SettingRow title="Open at login" desc="Launch automatically when you sign in.">
              <Toggle checked={s.general.openAtLogin} onChange={(v) => updateGeneral({ openAtLogin: v })} />
            </SettingRow>
            <SettingRow title="Start minimized to tray" desc="Start hidden; reach it from the system tray.">
              <Toggle checked={s.general.startMinimized} onChange={(v) => updateGeneral({ startMinimized: v })} />
            </SettingRow>
            <SettingRow
              title="Auto-insert"
              desc="When to place the transcription into the focused field. “Live” inserts each finished phrase as you speak (streaming backends; batch inserts on stop)."
            >
              <Segmented
                value={s.general.insertTiming}
                onChange={(v) => updateGeneral({ insertTiming: v })}
                options={[
                  { value: "off", label: "Off" },
                  { value: "stop", label: "When I stop" },
                  { value: "live", label: "Live" },
                ]}
              />
            </SettingRow>
            <SettingRow
              title="Insertion method"
              desc={
                s.general.insertTiming === "live"
                  ? "Applies to “When I stop”. Live always types (keystrokes) — it has to backspace-correct revised words, which the clipboard can’t do."
                  : "Clipboard paste is the most reliable. Direct typing never touches the clipboard but can struggle with some layouts. Clipboard only copies the text without typing — you paste it yourself."
              }
            >
              <Segmented
                value={s.general.insertMethod}
                onChange={(v) => updateGeneral({ insertMethod: v })}
                options={[
                  { value: "paste", label: "Clipboard paste" },
                  { value: "direct", label: "Direct typing" },
                  { value: "clipboard", label: "Clipboard only" },
                ]}
              />
            </SettingRow>
            <SettingRow
              title="Paste shortcut"
              desc="The keys sent for “Clipboard paste”. Terminals (Konsole, kitty…) need Ctrl + Shift + V."
              disabled={s.general.insertMethod !== "paste"}
            >
              <Select
                value={pasteKey(s.general.pasteShortcut)}
                onChange={(v) => updateGeneral({ pasteShortcut: pasteCodes(v) })}
                options={PASTE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              />
            </SettingRow>
            <SettingRow
              title="Deep field detection"
              desc="Skip typing when the focused element isn’t a text field — the transcript goes to the clipboard instead. Uses accessibility to cover most apps including browsers and Electron (may raise their memory use); games and the desktop are never blocked."
            >
              <Toggle
                checked={s.general.deepFieldDetection}
                onChange={(v) => {
                  updateGeneral({ deepFieldDetection: v });
                  void setDeepFieldDetection(v);
                }}
              />
            </SettingRow>
            <SettingRow title="Press Enter after" desc="Send a Return key once the text is inserted.">
              <Toggle checked={s.general.autoEnter} onChange={(v) => updateGeneral({ autoEnter: v })} />
            </SettingRow>
            <SettingRow
              title="Restore clipboard afterward"
              desc="Put your previous clipboard contents back once the paste is done."
            >
              <Toggle checked={s.general.restoreClipboard} onChange={(v) => updateGeneral({ restoreClipboard: v })} />
            </SettingRow>
            <SettingRow title="Sound cues" desc="A short tone when dictation starts and stops." last>
              <Toggle checked={s.general.soundEffects} onChange={(v) => updateGeneral({ soundEffects: v })} />
            </SettingRow>
          </Card>
        )}

        {tab === "Audio" && <AudioTab />}

        {tab === "Recording" && (
          <Card className="px-6">
            <SettingRow title="Keep audio recordings" desc="Save a .wav of each dictation locally.">
              <Toggle checked={s.recording.saveRecordings} onChange={(v) => updateRecording({ saveRecordings: v })} />
            </SettingRow>
            <SettingRow
              title="Silence other apps while recording"
              desc="Mute system audio for the duration of a dictation."
              last
            >
              <Toggle checked={s.recording.muteSystemAudio} onChange={(v) => updateRecording({ muteSystemAudio: v })} />
            </SettingRow>
          </Card>
        )}

        {tab === "Chip" && (
          <Card className="px-6">
            <SectionLabel className="mb-1 mt-4">Placement</SectionLabel>
            <SettingRow title="Position" desc="Where the dictation chip sits on screen while you talk.">
              <Segmented
                value={s.recording.indicatorPosition}
                onChange={(v) => updateRecording({ indicatorPosition: v })}
                options={[
                  { value: "top", label: "Top" },
                  { value: "bottom", label: "Bottom" },
                  { value: "off", label: "Off" },
                ]}
              />
            </SettingRow>
            <SettingRow
              title="Keep chip docked"
              desc="Keep the chip on screen as a small standby dot when you're not dictating, instead of hiding it."
              disabled={s.recording.indicatorPosition === "off"}
            >
              <Toggle
                checked={s.recording.persistentDock}
                disabled={s.recording.indicatorPosition === "off"}
                onChange={(v) => updateRecording({ persistentDock: v })}
              />
            </SettingRow>

            <SectionLabel className="mb-1 mt-7">Auto-hide</SectionLabel>
            <SettingRow
              title="Auto-hide to edge"
              desc="After sitting idle, hide the chip against the screen edge so it stops covering things — hover the edge dot to bring it back."
              disabled={s.recording.indicatorPosition === "off"}
            >
              <Toggle
                checked={s.recording.overlayPeek}
                disabled={s.recording.indicatorPosition === "off"}
                onChange={(v) => updateRecording({ overlayPeek: v })}
              />
            </SettingRow>
            <SettingRow
              title="Hide after"
              desc="How long the chip sits idle before it hides against the edge."
              disabled={!s.recording.overlayPeek || s.recording.indicatorPosition === "off"}
            >
              <Stepper
                ariaLabel="hide after"
                value={s.recording.peekTimeoutSec}
                onChange={(v) => updateRecording({ peekTimeoutSec: v })}
                min={1}
                max={600}
                step={0.5}
                decimals={1}
                unit="s"
                disabled={!s.recording.overlayPeek || s.recording.indicatorPosition === "off"}
              />
            </SettingRow>
            <SettingRow
              title="Stay hidden while dictating"
              desc="Keep the chip hidden against the edge as a small dot even while you dictate, instead of popping out — it just changes colour and gently pulses while you speak. Hover the edge dot to reveal the transcript."
              disabled={!s.recording.overlayPeek || s.recording.indicatorPosition === "off"}
            >
              <Toggle
                checked={s.recording.peekWhileActive}
                disabled={!s.recording.overlayPeek || s.recording.indicatorPosition === "off"}
                onChange={(v) => updateRecording({ peekWhileActive: v })}
              />
            </SettingRow>

            <SectionLabel className="mb-1 mt-7">Appearance</SectionLabel>
            <SettingRow
              title="Dim after"
              desc="How long the chip sits idle before it fades to a dim, unobtrusive opacity (a docked standby dot dims too). Set to Never to keep it full opacity."
              disabled={s.recording.indicatorPosition === "off"}
            >
              <Stepper
                ariaLabel="dim after"
                value={s.recording.dimAfterSec}
                onChange={(v) => updateRecording({ dimAfterSec: v })}
                min={0}
                max={600}
                step={0.5}
                decimals={1}
                unit="s"
                zeroLabel="Never"
                disabled={s.recording.indicatorPosition === "off"}
              />
            </SettingRow>
            <SettingRow
              title="Live transcript"
              desc="Show words appear in the chip as you speak (streaming backends only)."
            >
              <Toggle checked={s.recording.realtimePreview} onChange={(v) => updateRecording({ realtimePreview: v })} />
            </SettingRow>
            <SettingRow
              title="Show active profile"
              desc="Label the chip with the running profile's tag; hover it to reveal language and mode."
            >
              <Toggle
                checked={s.recording.showProfileOnOverlay}
                onChange={(v) => updateRecording({ showProfileOnOverlay: v })}
              />
            </SettingRow>
            <SettingRow
              title="Show injection target"
              desc="Show which app dictation is typing into (→ app) on the chip, and warn when it isn't a text field."
            >
              <Toggle
                checked={s.recording.showTargetOnOverlay}
                onChange={(v) => updateRecording({ showTargetOnOverlay: v })}
              />
            </SettingRow>
            <SettingRow
              title="Only while speaking"
              desc="Show the injection target only while you're actively dictating — hide it when armed but silent, so it doesn't flicker as you move between windows."
              disabled={!s.recording.showTargetOnOverlay}
            >
              <Toggle
                checked={s.recording.showTargetOnlySpeaking}
                onChange={(v) => updateRecording({ showTargetOnlySpeaking: v })}
                disabled={!s.recording.showTargetOnOverlay}
              />
            </SettingRow>

            <SectionLabel className="mb-1 mt-7">Interaction</SectionLabel>
            <SettingRow
              title="Hover reveal delay"
              desc="How long you hover the chip before it expands to show language / mode and the quick-launch buttons."
              disabled={s.recording.indicatorPosition === "off"}
            >
              <Stepper
                ariaLabel="hover reveal delay"
                value={s.recording.hoverRevealMs}
                onChange={(v) => updateRecording({ hoverRevealMs: v })}
                min={0}
                max={3000}
                step={50}
                unit="ms"
                zeroLabel="Instant"
                disabled={s.recording.indicatorPosition === "off"}
              />
            </SettingRow>
            <div className="py-4">
              <div className="text-[14px] font-medium text-text">Quick-launch buttons</div>
              <div className="mb-3 mt-0.5 text-[12.5px] leading-snug text-dim">
                Icon buttons shown on the idle chip when you hover it — jump to a screen or run a dictation action.
              </div>
              <QuickLaunchEditor
                items={s.recording.quickLaunch ?? []}
                onChange={(v) => updateRecording({ quickLaunch: v })}
              />
            </div>
          </Card>
        )}

        {tab === "Permissions" && (
          <Card className="px-6">
            <SettingRow title="Microphone access" desc="Required to capture your voice.">
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ok">
                <StatusDot tone="ok" /> Granted
              </span>
            </SettingRow>
            <SettingRow
              title="Hardware hotkeys (evdev)"
              desc="Reliable hold-to-talk + left/right modifiers + AltGr on Wayland by reading /dev/input. Reads all keyboard input — strictly opt-in, and needs the 'input' group."
              last
            >
              {evdev && !evdev.available ? (
                <span className="text-[12.5px] text-faint">Linux only</span>
              ) : evdev && evdev.permitted ? (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-dim">{s.general.evdevEnabled ? "On" : "Off"}</span>
                  <Toggle
                    checked={s.general.evdevEnabled}
                    onChange={(v) => updateGeneral({ evdevEnabled: v })}
                  />
                </div>
              ) : (
                <Button variant="default" size="sm" onClick={runEvdevSetup} disabled={evdevBusy}>
                  <Mic className="size-4" /> {evdevBusy ? "Authorizing…" : "Set up"}
                </Button>
              )}
            </SettingRow>
            {evdevMsg && <div className="px-1 pt-3 text-[12px] text-dim">{evdevMsg}</div>}
            {evdev && evdev.permitted && (
              <div className="px-1 pt-3 text-[12px] text-faint">
                Profiles using AltGr or a specific left/right modifier only fire while this is on.
              </div>
            )}
          </Card>
        )}

        <div className="mt-5 flex items-center gap-2 px-1 font-mono text-[11px] text-faint">
          <Check className="size-3.5 text-ok" /> changes apply immediately
        </div>
      </div>
    </div>
  );
}
