import { useState, useEffect, useCallback, useRef } from "react";
import { Mic, Play, RefreshCw, Square } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Notice, SettingRow } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import {
  listAudioDevices, startMicTest, stopMicTest, playMicTest, stopMicTestPlayback, onMicTestPlayEnded,
  onMicTestEnded, onAudioLevel,
} from "@/lib/api";
import type { MicInventory } from "@/lib/types";
import { MicPicker } from "@/components/settings/MicPicker";
import { buildMicView, isAlsaPin, labelForPick } from "@/lib/micOptions";
import { safeDisplayText } from "@/lib/sanitize";
import { isWindowHidden, onWindowHiddenChange } from "@/lib/windowVisibility";

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
  // "Show all audio paths": view state only. Until the user flips it, it is open when the pin
  // IS a raw path (those rows only exist with the paths listed) — an ALSA id the listing shows
  // as an ordinary mic row (no sound server: every mic row's id is its sysdefault path) is not.
  const [advancedChoice, setAdvanced] = useState<boolean | null>(null);
  const pinIsPath = isAlsaPin(microphoneId) && !inv?.mics.some((m) => m.id === microphoneId);
  const advanced = advancedChoice ?? pinIsPath;
  const withPaths = advanced || isAlsaPin(microphoneId);
  // Whether the listing on screen was fetched WITH the paths: the flip sets `advanced` at once,
  // but until the paths reply lands every path list is empty and the picker said "No other
  // audio paths found." — the path rows show only once the listing carries them.
  const [invHasPaths, setInvHasPaths] = useState(false);
  const showPaths = advanced && invHasPaths;

  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  // Mic is open but not yet delivering real audio (cold/Bluetooth warm-up) → show "warming up…".
  const [micWarming, setMicWarming] = useState(false);
  // True once a stopped test captured something worth replaying (enables Replay).
  const [hasClip, setHasClip] = useState(false);
  // Whether a replay is currently sounding — drives the button label and guards
  // against starting a second, overlapping playback.
  const [playing, setPlaying] = useState(false);
  // Why the last test ended on its own (the mic vanished mid-test); cleared by the next start.
  const [testNote, setTestNote] = useState<string | null>(null);
  const clipSecsRef = useRef(0);
  const playTimerRef = useRef<number | null>(null);
  // False once the tab unmounted, so a stop that resolves afterwards doesn't start a replay.
  const mountedRef = useRef(true);
  // Latest "stop + offer replay" handler, so the auto-stop timer (armed in an effect defined
  // above the handler) can call it without a declaration-order / stale-closure problem.
  const stopAndReplayRef = useRef<() => void>(() => {});
  // A stop in flight: a double-clicked Stop, or Stop racing the auto-stop, must not stop and
  // replay twice (the second replay would restart the playback).
  const stoppingRef = useRef(false);
  // Bumped per listing and by the poll's cleanup, so a reply issued before a "Show all audio
  // paths" flip (or unmount) can't land after the newer one and overwrite it.
  const invSeq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++invSeq.current;
    try {
      const next = await listAudioDevices(withPaths);
      if (my === invSeq.current) {
        setInv(next);
        setInvHasPaths(withPaths);
      }
    } catch (e) {
      console.error("listing audio devices failed:", e); // keep prior list; don't float the rejection
    }
  }, [withPaths]);

  // Keep the list current while this tab is on screen: plugging a mic in or out, or changing the
  // system default, shows up within a few seconds. Listing never opens a mic (a Bluetooth headset
  // would switch profile). Paused while the window is hidden — closed to the tray (Rust's
  // show/hide; WebView2 never fires visibilitychange for a hidden window) or minimized/unmapped
  // (the document signal); gone with the tab.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!isWindowHidden()) void refresh();
    }, 3000);
    const off = onWindowHiddenChange((hidden) => {
      if (!hidden) void refresh();
    });
    return () => {
      clearInterval(timer);
      off();
      invSeq.current++;
    };
  }, [refresh]);

  // Mic test: subscribe to levels and open the device while `testing` is on.
  useEffect(() => {
    if (!testing) return;
    let active = true;
    // `issued`: our start went out, after the replaced capture's stop settled (that join is where
    // its last event was sent), so a test-ended before this belongs to the replaced capture.
    // `started`: the open resolved. An event between the two is ours but early: latch it and act
    // once the start resolves (a start that fails takes its own path instead).
    let issued = false;
    let started = false;
    let endedEarly = false;
    let unlisten: (() => void) | undefined;
    let unlistenEnded: (() => void) | undefined;
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
      // The capture ends itself when the device is lost or a slow open failed late; leave
      // "testing" the way Stop does (the clip heard so far stays replayable) and say why.
      let endReason = "device-lost";
      const endTest = () => {
        setTestNote(
          endReason === "open-failed"
            ? "The microphone could not be opened, so the test ended."
            : "The microphone stopped delivering audio, so the test ended.",
        );
        void stopAndReplayRef.current();
      };
      const unEnded = await onMicTestEnded((reason) => {
        if (!active || !issued) return;
        endReason = reason;
        if (!started) {
          endedEarly = true;
          return;
        }
        endTest();
      }).catch(() => undefined);
      if (!active) {
        unEnded?.();
        return;
      }
      unlistenEnded = unEnded;
      try {
        await startMicTest(microphoneId, () => {
          issued = true;
        });
        started = true;
        if (endedEarly && active) endTest();
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
      unlistenEnded?.();
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
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    let secs = 0;
    try {
      secs = await stopMicTest();
    } catch (e) {
      console.error("stop mic test failed:", e); // secs stays 0 → the replay below is correctly skipped
    } finally {
      setTesting(false);
      stoppingRef.current = false;
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
      setTestNote(null);
      setTesting(true);
      return;
    }
    await stopAndReplay();
  }, [testing, stopAndReplay]);

  const view = buildMicView(inv, microphoneId, microphoneLabel, showPaths);

  return (
    <Card className="px-6">
      <SettingRow
        title="Microphone"
        desc="Audio input device used for dictation."
        expand={
          view.missing && view.legacy ? (
            <Notice className="mb-3">
              {safeDisplayText(view.pinnedLabel ?? "", 80)} isn't offered by{" "}
              {inv?.server ? safeDisplayText(inv.server, 40) : "the sound server"}. Dictation opens it through its
              sound card while it is plugged in, otherwise it uses System default
              {inv?.defaultLabel ? ` (${safeDisplayText(inv.defaultLabel, 80)})` : ""}.
            </Notice>
          ) : view.missing ? (
            <Notice className="mb-3">
              {safeDisplayText(view.pinnedLabel ?? "", 80)} is not connected. Dictation uses System default
              {inv?.defaultLabel ? ` (${safeDisplayText(inv.defaultLabel, 80)})` : ""} until it is plugged back in.
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
            pathsListed={invHasPaths}
            onAdvancedChange={setAdvanced}
            onPick={(id) =>
              updateSettings({
                microphoneId: id,
                // Re-picking the unplugged pin finds no live device to name it — keep its saved label.
                microphoneLabel: id ? (labelForPick(inv, id) ?? (id === microphoneId ? microphoneLabel : null)) : null,
              })
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
          {!testing && testNote && <span className="text-[11px] text-faint">{testNote}</span>}

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
