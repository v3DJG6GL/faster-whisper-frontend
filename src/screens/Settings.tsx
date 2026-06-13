import { useState, useEffect, useCallback } from "react";
import { Mic, Check, RefreshCw, Square } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Segmented, Select, SettingRow, StatusDot, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import {
  listAudioDevices,
  startMicTest,
  stopMicTest,
  onAudioLevel,
  evdevStatus,
  evdevSetup,
  type EvdevStatus,
} from "@/lib/api";
import type { AudioDevice } from "@/lib/types";

const TABS = ["General", "Audio", "Recording", "Permissions"] as const;
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
              desc="Show words appear in the chip as you speak (streaming backends only)."
              last
            >
              <Toggle checked={s.recording.realtimePreview} onChange={(v) => updateRecording({ realtimePreview: v })} />
            </SettingRow>
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
