import { useState, useEffect, useCallback } from "react";
import { Mic, Check, Info, Keyboard, RefreshCw, Square } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Kbd, Segmented, Select, SettingRow, StatusDot, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import { HotkeyChips } from "@/components/HotkeyChips";
import {
  listAudioDevices,
  startMicTest,
  stopMicTest,
  onAudioLevel,
  validateCodes,
  suspendShortcuts,
  reregisterShortcuts,
  evdevStatus,
  evdevSetup,
  type EvdevStatus,
} from "@/lib/api";
import { codeToToken, MODIFIER_CODES, canonicalizeCodes, sameCodes, codesToLabels } from "@/lib/keys";
import type { AudioDevice, DictationModeId } from "@/lib/types";

const TABS = ["General", "Audio", "Recording", "Shortcuts", "Permissions"] as const;
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
      unlisten = await onAudioLevel((l) => {
        if (active) setLevel(l);
      });
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

export default function Settings() {
  const [tab, setTab] = useState<Tab>("General");
  const s = useApp((st) => st.settings);
  const updateGeneral = useApp((st) => st.updateGeneral);
  const updateRecording = useApp((st) => st.updateRecording);
  const modes = useApp((st) => st.modes);
  const profiles = useApp((st) => st.profiles);
  const updateMode = useApp((st) => st.updateMode);
  const [capturing, setCapturing] = useState<DictationModeId | null>(null);
  const [heldCodes, setHeldCodes] = useState<string[]>([]); // live chord preview
  const [captureWarn, setCaptureWarn] = useState<string | null>(null);
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  const [evdevMsg, setEvdevMsg] = useState<string | null>(null);
  const [evdevBusy, setEvdevBusy] = useState(false);

  useEffect(() => {
    void evdevStatus().then(setEvdev);
  }, [tab]);

  // When the evdev backend owns the modes, it can bind modifier-only / AltGr /
  // left-right chords the plugin can't — so capture validates differently.
  const evdevActive = !!(s.general.evdevEnabled && evdev?.permitted);

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

  // Key-capture for rebinding: track held modifier codes (per side) live, then
  // finalize on the first real key — validate it, warn (don't silently drop) on
  // reject. Bindings are stored as event.code lists (carrying side + AltGr).
  useEffect(() => {
    if (!capturing) {
      setHeldCodes([]);
      setCaptureWarn(null);
      return;
    }
    // Suspend global hotkeys during capture so pressing the current binding only
    // rebinds — it must not also fire dictation (that race left a stuck session).
    void suspendShortcuts();
    const pressed = new Set<string>();
    let peak: string[] = []; // largest modifier-only set held (for evdev chords)
    let done = false;
    const finalize = (codes: string[]) => {
      const mode = capturing;
      if (useApp.getState().modes.some((m) => m.mode !== mode && sameCodes(m.hotkey, codes))) {
        setCaptureWarn("Already bound to the other mode");
        done = false;
        return;
      }
      if (evdevActive) {
        // evdev owns the modes — it can bind modifier-only / AltGr / left-right.
        updateMode(mode, { hotkey: codes });
        setCapturing(null);
      } else {
        void validateCodes(codes).then((ok) => {
          if (ok) {
            updateMode(mode, { hotkey: codes });
            setCapturing(null);
          } else {
            setCaptureWarn("Can't register that — add a letter/digit, or enable the evdev backend (Permissions) for modifier-only / AltGr");
            done = false;
          }
        });
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (MODIFIER_CODES.has(e.code)) {
        pressed.add(e.code);
        const cur = canonicalizeCodes([...pressed]);
        if (cur.length > peak.length) peak = cur;
        setHeldCodes(cur);
        return; // still building the chord
      }
      if (!codeToToken(e.code) && !evdevActive) {
        setCaptureWarn("That key can't be a global shortcut — try another");
        return; // keep listening
      }
      done = true;
      finalize(canonicalizeCodes([...pressed, e.code]));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      pressed.delete(e.code);
      setHeldCodes(canonicalizeCodes([...pressed]));
      // Modifier-only chord (e.g. Ctrl+Shift): no real key was pressed and every
      // key has been released — finalize the peak set. Only the evdev backend can
      // honour these; on the plugin path, nudge the user instead.
      if (!done && pressed.size === 0 && peak.length > 0) {
        if (evdevActive) {
          done = true;
          finalize(peak);
        } else {
          setCaptureWarn("Modifier-only chords need the evdev backend (Permissions)");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      void reregisterShortcuts(); // restore hotkeys when capture ends
    };
  }, [capturing, updateMode, evdevActive]);

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
              desc="When to place the transcription into the focused field. “Live” inserts each finished phrase as you speak (streaming profiles; batch inserts on stop)."
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
                  : "Clipboard paste is the most reliable. Direct typing never touches the clipboard, but can struggle with some keyboard layouts."
              }
            >
              <Select
                value={s.general.insertMethod}
                onChange={(v) => updateGeneral({ insertMethod: v })}
                options={[
                  { value: "paste", label: "Clipboard paste" },
                  { value: "direct", label: "Direct typing" },
                ]}
                className="w-52"
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
            <SettingRow title="Overlay position" desc="Where the dictation chip sits on screen while you talk.">
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
            <SettingRow title="Keep audio recordings" desc="Save a .wav of each dictation locally.">
              <Toggle checked={s.recording.saveRecordings} onChange={(v) => updateRecording({ saveRecordings: v })} />
            </SettingRow>
            <SettingRow title="Silence other apps while recording" desc="Mute system audio for the duration of a dictation.">
              <Toggle checked={s.recording.muteSystemAudio} onChange={(v) => updateRecording({ muteSystemAudio: v })} />
            </SettingRow>
            <SettingRow
              title="Live transcript in overlay"
              desc="Show words appear in the chip as you speak (streaming profiles only)."
              last
            >
              <Toggle checked={s.recording.realtimePreview} onChange={(v) => updateRecording({ realtimePreview: v })} />
            </SettingRow>
          </Card>
        )}

        {tab === "Shortcuts" && (
          <div className="flex flex-col gap-4">
            {modes.map((m) => (
              <Card key={m.mode} className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[14px] font-semibold text-text">
                      {m.mode === "hold" ? "Push-to-talk" : "Latch"}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-dim">
                      {m.mode === "hold"
                        ? "Hold the hotkey while you speak; release to stop."
                        : "Tap once to start, tap again to stop."}
                    </div>
                  </div>
                  <Toggle checked={m.enabled} onChange={(v) => updateMode(m.mode, { enabled: v })} />
                </div>
                <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
                  <div className="flex items-center gap-3">
                    {capturing === m.mode ? (
                      <div className="flex items-center gap-2 rounded-lg border border-accent/60 bg-accent-soft/40 px-3 py-1.5 ring-2 ring-accent/25">
                        <span className="size-2 animate-pulse rounded-full bg-accent" />
                        <span className="inline-flex items-center gap-1">
                          {codesToLabels(heldCodes).map((k, i) => (
                            <span key={i} className="inline-flex items-center gap-1">
                              {i > 0 && <span className="text-faint">+</span>}
                              <Kbd>{k}</Kbd>
                            </span>
                          ))}
                          {heldCodes.length > 0 && <span className="text-faint">+</span>}
                          <Kbd>…</Kbd>
                        </span>
                        <span className={"text-[12px] " + (captureWarn ? "text-rec" : "text-dim")}>
                          {captureWarn ?? "Press your shortcut · Esc to cancel"}
                        </span>
                      </div>
                    ) : (
                      <HotkeyChips codes={m.hotkey} />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCapturing(capturing === m.mode ? null : m.mode)}
                    >
                      <Keyboard className="size-4" /> {capturing === m.mode ? "Cancel" : "Rebind"}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-faint">Profile</span>
                    <Select
                      value={m.profileId ?? ""}
                      onChange={(v) => updateMode(m.mode, { profileId: v || null })}
                      options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                      className="w-44"
                    />
                  </div>
                </div>
              </Card>
            ))}
            <div className="flex items-start gap-2 px-1 text-[12px] text-faint">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              On Wayland, press-&-hold needs the optional evdev backend (Permissions). Toggle works everywhere; you can
              also bind these in your desktop’s shortcut settings.
            </div>
          </div>
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
                Bindings using AltGr or a specific left/right modifier only fire while this is on.
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
