import { useState, useEffect, useCallback, useRef } from "react";
import { Mic, Play, RefreshCw, Square } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Notice, SettingRow } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import {
  listAudioDevices, startMicTest, stopMicTest, playMicTest, stopMicTestPlayback, onMicTestPlayEnded,
  onAudioLevel,
} from "@/lib/api";
import type { MicInventory } from "@/lib/types";
import { MicPicker } from "@/components/settings/MicPicker";
import { buildMicView, isAlsaPin, labelForPick } from "@/lib/micOptions";

// Smoothed level above the digital-silence floor ⇒ the mic is actually capturing (a
// cold/Bluetooth mic can be open but silent for ~1–2s first). A live mic has a faint
// noise floor (~0.0002) even in silence; a warming one is exact zero. Mirrors streaming.ts.
const MIC_LIVE_LEVEL = 0.0001;
// Cap a mic test so it can't hold the mic open indefinitely (a Bluetooth headset would
// stay stuck in low-quality mic mode the whole time). Plenty for a "does it work?" check.
const MIC_TEST_MAX_MS = 15000;

export function AudioTab() {
  const microphoneId = useApp((s) => s.settings.microphoneId);
  const microphoneLabel = useApp((s) => s.settings.microphoneLabel);
  const updateSettings = useApp((s) => s.updateSettings);
  const [inv, setInv] = useState<MicInventory | null>(null);
  // "Show all audio paths": view state only, open from the start when the pin IS a raw path
  // (those rows only exist with the paths listed).
  const [advanced, setAdvanced] = useState(() => isAlsaPin(microphoneId));
  const withPaths = advanced || isAlsaPin(microphoneId);

  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  // Mic is open but not yet delivering real audio (cold/Bluetooth warm-up) → show "warming up…".
  const [micWarming, setMicWarming] = useState(false);
  // True once a stopped test captured something worth replaying (enables Replay).
  const [hasClip, setHasClip] = useState(false);
  // Whether a replay is currently sounding — drives the button label and guards
  // against starting a second, overlapping playback.
  const [playing, setPlaying] = useState(false);
  const clipSecsRef = useRef(0);
  const playTimerRef = useRef<number | null>(null);
  // False once the tab unmounted, so a stop that resolves afterwards doesn't start a replay.
  const mountedRef = useRef(true);
  // Latest "stop + offer replay" handler, so the auto-stop timer (armed in an effect defined
  // above the handler) can call it without a declaration-order / stale-closure problem.
  const stopAndReplayRef = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    try {
      setInv(await listAudioDevices(withPaths));
    } catch (e) {
      console.error("listing audio devices failed:", e); // keep prior list; don't float the rejection
    }
  }, [withPaths]);

  // Keep the list current while this tab is on screen: plugging a mic in or out, or changing the
  // system default, shows up within a few seconds. Listing never opens a mic (a Bluetooth headset
  // would switch profile). Paused while the window is hidden; gone with the tab.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Mic test: subscribe to levels and open the device while `testing` is on.
  useEffect(() => {
    if (!testing) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    // Show "warming up…" until real audio flows (a cold/Bluetooth mic is silent for
    // ~1–2s first), with a safety timeout so it never hangs on a silent device.
    setMicWarming(true);
    const warmTimer = window.setTimeout(() => setMicWarming(false), 5000);
    // Auto-stop so the test can't run (and hold the mic) forever.
    const maxTimer = window.setTimeout(() => {
      // Auto-stop: take the SAME path as pressing Stop, so the captured clip is offered for replay
      // too (the bare setTesting(false) skipped the capture, leaving no Replay button after timeout).
      if (active) void stopAndReplayRef.current();
    }, MIC_TEST_MAX_MS);
    void (async () => {
      const un = await onAudioLevel((l) => {
        if (!active) return;
        setLevel(l);
        if (l > MIC_LIVE_LEVEL) setMicWarming(false);
      });
      // Torn down mid-await (test toggled off / device switched) → don't leave the
      // level listener registered for the rest of the session.
      if (!active) {
        un();
        return;
      }
      unlisten = un;
      try {
        await startMicTest(microphoneId);
      } catch (e) {
        // The mic failed to open (busy / unplugged / denied). Don't leave a silent dead meter
        // with the button stuck on Stop — end the test (cleanup stops + unlistens).
        console.error("mic test failed to start:", e);
        if (active) {
          setMicWarming(false);
          setTesting(false);
        }
      }
    })();
    return () => {
      active = false;
      clearTimeout(warmTimer);
      clearTimeout(maxTimer);
      unlisten?.();
      void stopMicTest().catch(() => {});
      setLevel(0);
      setMicWarming(false);
    };
  }, [testing, microphoneId]);

  // Clear "playing" when the replay finishes — Rust emits this once the current
  // playback drains (and wasn't superseded). The duration-based timer in replay()
  // is just a safety net in case the event is missed.
  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    let un: (() => void) | undefined;
    void onMicTestPlayEnded(() => {
      if (active) setPlaying(false);
    })
      .then((u) => {
        if (active) un = u;
        else u();
      })
      .catch(() => {}); // a rejected dynamic import / listen() must not surface as an unhandled rejection
    return () => {
      mountedRef.current = false;
      active = false;
      un?.();
      if (playTimerRef.current != null) clearTimeout(playTimerRef.current);
      // Silence an in-flight replay on unmount: AudioTab unmounts on a Settings tab switch or a
      // route navigation, but the mic-test playback is a detached Rust thread (up to ~15s) that
      // only stopMicTestPlayback() halts — the test-effect cleanup's stopMicTest() doesn't touch
      // playback. Without this the clip keeps sounding with no UI to stop it. No-op when idle.
      void stopMicTestPlayback().catch(() => {});
    };
  }, []);

  // Replay the last capture. Rust guarantees a single playback at a time (a new
  // play stops the previous), so we just reflect "playing" and let the play-ended
  // event clear it, with a duration-based fallback.
  const replay = useCallback(() => {
    if (clipSecsRef.current <= 0) return;
    setPlaying(true);
    void playMicTest().catch(() => {});
    if (playTimerRef.current != null) clearTimeout(playTimerRef.current);
    playTimerRef.current = window.setTimeout(() => {
      setPlaying(false);
      playTimerRef.current = null;
    }, clipSecsRef.current * 1000 + 1000);
  }, []);

  // Stop an in-flight replay — the Replay button doubles as a Stop while it's playing.
  const stopPlayback = useCallback(() => {
    void stopMicTestPlayback().catch(() => {});
    setPlaying(false);
    if (playTimerRef.current != null) {
      clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
  }, []);

  // Stop the test and, if it captured something, enable + play the replay. Shared by the manual
  // Stop button AND the 15s auto-stop, so both offer replay. try/finally: always flip testing off
  // even if the stop invoke rejects, so the button can't stick on "Stop".
  const stopAndReplay = useCallback(async () => {
    let secs = 0;
    try {
      secs = await stopMicTest();
    } catch (e) {
      console.error("stop mic test failed:", e); // secs stays 0 → the replay below is correctly skipped
    } finally {
      setTesting(false);
    }
    // Unmounted during the await: the cleanup already silenced playback, and a replay started
    // now would have no button left to stop it.
    if (!mountedRef.current) return;
    if (secs > 0.2) {
      setHasClip(true);
      clipSecsRef.current = secs;
      replay();
    }
  }, [replay]);
  stopAndReplayRef.current = stopAndReplay;

  // Test/Stop: pressing Stop replays what was just captured (a quick "did my mic
  // work?" check). The capture effect's cleanup also calls stopMicTest — harmless;
  // here we stop first so the recorded clip is final, then play it back.
  const onToggle = useCallback(async () => {
    if (!testing) {
      // Starting a test silences any lingering replay (Rust bumps the generation).
      setPlaying(false);
      if (playTimerRef.current != null) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
      setHasClip(false);
      setTesting(true);
      return;
    }
    await stopAndReplay();
  }, [testing, stopAndReplay]);

  const view = buildMicView(inv, microphoneId, microphoneLabel, advanced);

  return (
    <Card className="px-6">
      <SettingRow
        title="Microphone"
        desc="Audio input device used for dictation."
        expand={
          view.missing ? (
            <Notice className="mb-3">
              {view.pinnedLabel} is not connected. Dictation uses System default
              {inv?.defaultLabel ? ` (${inv.defaultLabel})` : ""} until it is plugged back in.
            </Notice>
          ) : undefined
        }
      >
        <div className="flex items-center gap-2">
          <MicPicker
            inv={inv}
            value={microphoneId}
            savedLabel={microphoneLabel}
            advanced={advanced}
            onAdvancedChange={setAdvanced}
            onPick={(id) =>
              updateSettings({ microphoneId: id, microphoneLabel: id ? labelForPick(inv, id) : null })
            }
            className="w-56"
            // Locked during a test: switching the device mid-test re-runs the capture effect,
            // racing the old fire-and-forget stop against the new start (the late stop could tear
            // down the freshly-opened device → dead meter). Stop the test to change the mic.
            disabled={testing}
          />
          <Button variant="ghost" size="sm" title="Refresh devices" onClick={() => void refresh()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </SettingRow>
      <SettingRow
        title="Test microphone"
        desc="Open the mic and watch the input level; pressing Stop replays what it just heard."
        last
      >
        <div className="flex items-center gap-3">
          <Waveform
            level={level}
            active={testing}
            bars={16}
            tone={testing && !micWarming ? "armed" : "dim"}
            className="h-7 w-28"
          />
          {testing && micWarming && (
            <span className="animate-pulse font-mono text-[11px] text-faint">warming up…</span>
          )}

          <div className="flex items-center gap-2">
            <Button variant={testing ? "danger" : "default"} size="sm" onClick={() => void onToggle()}>
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
            {hasClip && !testing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (playing ? stopPlayback() : replay())}
                title={playing ? "Stop playback" : "Replay the last test recording"}
              >
                {playing ? <Square className="size-3.5" /> : <Play className="size-3.5" />}{" "}
                {playing ? "Stop" : "Replay"}
              </Button>
            )}
          </div>
        </div>
      </SettingRow>
    </Card>
  );
}
