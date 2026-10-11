// First-run onboarding — "connect first, branch after" (design v4).
//
// Mounted by App INSTEAD of the shell when a loaded config has no backends AND
// no profiles (fresh install; seeds are gone). One gate screen asks the only
// day-one question — where is your server? — then branches on what the server
// knows: synced settings found → restore offer; nothing → editable starter
// profiles → optional quick-add step (full backends only). "Skip for now" and
// every completion set settings.setupDismissed so the gate never re-opens; any
// later half-configured state is the Home checklist's job (SetupChecklist).

import { useEffect, useMemo, useRef, useState } from "react";
import { BrandMark, Wordmark } from "@/components/Sidebar";
import { TriggerTile } from "@/components/TriggerTile";
import { QuickAddShortcutField } from "@/components/QuickAddShortcutField";
import { Button, Labeled, Notice, Select, TextInput } from "@/components/ui";
import {
  deleteBackendKey, evdevStatus, getPipelineRules, pickAndImportSettings,
  setBackendKey, syncPull, testConnection,
} from "@/lib/api";
import { insecureUrlWarning, newBackendDraft, normalizeUrl, storedTypedUrl, stripUrlNoise, typedServerUrl } from "@/lib/backends";
import { QUICK_ADD_PEER_ID, withQuickAddPeer } from "@/lib/hotkeyConflicts";
import {
  applyBlob, carriesQuickAddPin, categorySelection, isPlainObject, migrateBlob, restorableCategories,
  sanitizeProfiles,
} from "@/lib/sync/sync";
import { startersClearOf } from "@/lib/starters";
import { ruleListOf } from "@/lib/pipelineMap";
import { useApp } from "@/lib/store";
import { useHotkeyCapture } from "@/lib/useHotkeyCapture";
import { IS_WINDOWS } from "@/lib/platform";
import { safeDisplayText } from "@/lib/sanitize";
import {
  ChordFixNotices, ImportPreview, IncomingAddresses, SyncedCategoryChips, predictChordFix,
} from "@/components/sync/SettingsSync";
import { stripMachineFolders } from "@/lib/sync/settingsFile";
import { relTime } from "@/lib/format";
import type { ImportResult, SyncPullResult } from "@/lib/sync/syncTypes";
import type { Backend, ConnectionInfo, PipelineRule, Profile } from "@/lib/types";


type Step = "gate" | "restore" | "starters" | "quickadd";

const ALL_ON = categorySelection(true);

export function Onboarding({ onDone }: { onDone: () => void }) {
  const st = useApp;
  const [step, setStep] = useState<Step>("gate");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const urlRef = useRef(url);
  const keyRef = useRef(key);
  urlRef.current = url;
  keyRef.current = key;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [backendId, setBackendId] = useState<string | null>(null);
  const [pull, setPull] = useState<SyncPullResult | null>(null);
  // Why the starters step shows: the user declined a restore, the account has nothing
  // synced, or neither is known (standard server, failed pull) — its copy must not lie.
  const [startersIntro, setStartersIntro] = useState<StartersIntro>("none");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  // Every exit marks setup handled so the gate never re-opens; later gaps
  // (deleted backends, skipped steps) fall to the Home checklist instead.
  const finish = () => {
    // The component unmounts, but an in-flight testAndContinue keeps running —
    // without this latch it would pull sync and offer a restore against a server
    // the user explicitly walked away from.
    abandoned.current = true;
    st.getState().updateSettings({ setupDismissed: true });
    onDone();
  };
  const abandoned = useRef(false);

  // The backend created at the connect gate, kept so the restore can put it back if the applied
  // blob's list does not contain it (see restoreEverything).
  const gateBackend = useRef<Backend | null>(null);
  // Set when a restore landed but carried no profiles, so the starters step follows it (and the
  // quick-add step only when the restore did not already pin a list).
  const restored = useRef(false);

  const testAndContinue = async () => {
    // Re-entrancy guard, matching the Backends screen's twin. The submit Button is disabled while
    // busy, but both text inputs still fire this on Enter and stay editable — and a second run
    // mints a fresh id, writes the API key to a SECOND keyring account, and upserts a duplicate
    // backend, leaving one of the two keys orphaned in the OS wallet.
    if (busy) return;
    const serverUrl = typedServerUrl(url);
    // Snapshotted alongside the url so the post-await check below compares BOTH terms the test
    // was run with — a corrected key matters as much as a corrected host.
    const keyAtTest = key;
    // Still the target on screen? Every await below re-asks — the inputs stay editable
    // throughout (the test, the keyring write parked on a wallet prompt, the pull).
    const stillLive = () =>
      !abandoned.current && typedServerUrl(urlRef.current) === serverUrl && keyRef.current === keyAtTest;
    if (!serverUrl.replace(/^https?:\/\//i, "")) {
      // A lone `http://` has a supported scheme and no host: name the missing host, as the
      // Backends connect step does — and, as it does, a bad port (`host:80o0`, `host:`) is not
      // blamed on the scheme.
      const typed = stripUrlNoise(url.trim());
      setError(
        !typed
          ? "Enter the server’s address, like http://host:8000."
          : /^https?:/i.test(storedTypedUrl(url))
          ? "Enter the server’s host too, like http://host:8000."
          : /^[a-z][a-z0-9+.-]*:[\\/]/i.test(typed)
            ? "Enter an address like http://host:8000 — that scheme isn’t supported."
            : "Enter an address like http://host:8000 — the port after “:” must be a number.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await testConnection({ serverUrl, apiKey: key || undefined });
      // Live-target guard, the twin of the one `Backends.ConnectStep.testAndContinue` already has
      // for exactly this reason. Both inputs stay editable for the whole (unbounded,
      // network-timeout-length) test while `busy` blocks a re-run, so a user who mistypes a host,
      // presses Enter and corrects the field is FORCED to wait — and the stale result then won
      // unconditionally: a backend for the ABANDONED url was minted, the typed API key written to
      // the keyring under it, `syncPull` run against it, and its restore offer presented while the
      // on-screen field showed the corrected host. Accepting that restore runs
      // `applyBlob(blob, ALL_ON)` and binds sync to that server.
      if (!stillLive()) return;
      if (!res.ok) {
        setError(res.error || "Couldn’t reach the server.");
        return;
      }
      // The tested server becomes Backend #1 no matter which branch follows —
      // via the shared factory, so the model rule (a full server's default, a
      // standard server's loaded model) and the standard-server batch endpoint
      // are picked up here too.
      // Key goes to the OS keyring FIRST (mirrors the Backends editor).
      const backend: Backend = newBackendDraft({ serverUrl, hasApiKey: key.length > 0, info: res });
      if (key) {
        await setBackendKey(backend.id, key);
        // The keyring write can park behind a locked-wallet prompt while the user retypes the
        // target (or leaves): nothing references this entry yet, so drop it and mint nothing.
        if (!stillLive()) {
          void deleteBackendKey(backend.id).catch(() => {});
          return;
        }
      }
      st.getState().upsertBackend(backend);
      gateBackend.current = backend;
      st.getState().setConnection(backend.id, res);
      setInfo(res);
      setBackendId(backend.id);
      // Full backend → this account may have synced settings; discover, don't ask.
      if (res.bootId) {
        const p = await syncPull({ serverUrl, apiKey: key || null });
        if (abandoned.current) return;
        if (!stillLive()) {
          // Retyped during the pull: the backend minted above (and its keyring entry) is for
          // the abandoned target — roll it back, or the corrected attempt mints a duplicate
          // beside it. (After `finish()` the minted backend is kept: the user left with it.)
          st.getState().removeBackend(backend.id);
          if (key) void deleteBackendKey(backend.id).catch(() => {});
          gateBackend.current = null;
          setInfo(null);
          setBackendId(null);
          return;
        }
        // Gate on what the blob can RESTORE, not on its truthiness: a `{}` (a peer syncing with
        // every category off) or a blob of unknown future keys opened an empty offer whose
        // "Restore everything" applied nothing and still turned sync on.
        if (p.ok && p.state?.blob && restorableCategories(p.state.blob).length > 0) {
          setPull(p);
          setStep("restore");
          return;
        }
        // "Nothing synced yet" only when there is no copy at all: one this version cannot
        // restore from (`{}`, or only newer categories) is still a synced copy.
        setStartersIntro(p.ok && !p.state?.blob ? "empty" : "none");
      } else {
        setStartersIntro("none");
      }
      setStep("starters");
    } catch (e) {
      // Same live-target guard as the resolved branches: a keyring or invoke failure for the
      // abandoned target must not show under the corrected one.
      if (stillLive()) setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const restoreEverything = async () => {
    const blob = pull?.state?.blob;
    if (!blob) return;
    setBusy(true);
    try {
      // Normalize a pre-split server blob first — the apply arms filter fields to their new
      // categories, so an unmigrated old blob would silently drop the chip settings, the
      // quick-add chord, and the pin (they'd sit in locations the arms no longer read).
      // `false` = nothing landed (dictation started meanwhile, or the apply was dropped stale
      // after its retries). Binding sync to a state that never hydrated would push this
      // device's pre-restore config over the server copy — same guard as the Sync tab's restore.
      // The peer's folder paths are stripped: the gate bypass would otherwise apply them here.
      const ok = await applyBlob(stripMachineFolders(migrateBlob(blob)), ALL_ON, 2, { ignoreGates: true });
      if (!ok) {
        setError("Nothing was restored — stop dictation or avoid changing settings while restoring, then try again.");
        return;
      }
      // Turn sync on for this device, against the restored backend that matches
      // the gate's URL (the restore may have replaced Backend #1's entry).
      const s = st.getState();
      const gateUrl = typedServerUrl(url);
      // Re-add the gate's own backend when the restore replaced the list without it, exactly as
      // the Backends screen's restore does. `?? s.backends[0]` bound sync — and therefore every
      // future push of every backend's plaintext key — to the FIRST entry of a list the server
      // wrote, chosen by position, with nothing on screen saying so. It also orphaned the keyring
      // entry written at the gate, since no backend referenced that id any more.
      let match = s.backends.find((b) => normalizeUrl(b.serverUrl) === gateUrl);
      if (!match && gateBackend.current) {
        s.upsertBackend(gateBackend.current);
        match = gateBackend.current;
      }
      // Write the API key the user proved at the gate to the matched backend's keyring
      // entry — `applyBlob` may have replaced the backends list, orphaning the key that
      // was written under `gateBackend.id`. Mirrors Backends.RestoreOffer.finishRestore.
      if (match && key) await setBackendKey(match.id, key);
      // Once the key sits under the bound backend, drop the gate's own entry if the restore left
      // no backend referencing it — otherwise a second copy of the key lingers in the keyring.
      const gate = gateBackend.current;
      if (key && gate && match && match.id !== gate.id && !st.getState().backends.some((b) => b.id === gate.id)) {
        void deleteBackendKey(gate.id).catch(() => {});
      }
      s.updateSync({ enabled: true, backendId: match?.id ?? null });
      // A copy with no profiles (a peer syncing only general or recording, or an empty list) would
      // leave setup with no dictation profile and no hotkey: offer the starters, bound to the
      // backend sync now uses (the restore may have replaced the gate's entry).
      if (st.getState().profiles.length === 0) {
        restored.current = true;
        if (match) setBackendId(match.id);
        setStartersIntro("none");
        setStep("starters");
        return;
      }
      finish();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Whether "Restore everything" brings profiles (and with them the dictation hotkeys): the
  // restore step promises them only then — a profiles category whose list holds no entry
  // applyBlob would keep (empty, or only malformed ones) promises nothing. (The starters
  // fallback still checks the store after the apply.)
  const pulledBlob = pull?.state?.blob;
  const carriesProfiles =
    !!pulledBlob &&
    restorableCategories(pulledBlob).includes("profiles") &&
    sanitizeProfiles(migrateBlob(pulledBlob).profiles?.list).length > 0;
  // Quick add arrives only with a pinned list the restore keeps: the chord alone is inert, and
  // a peer that never pinned one would otherwise be promised quick add while setup skips it.
  const bringsQuickAdd = !!pulledBlob && carriesQuickAddPin(migrateBlob(pulledBlob));
  // How the restore's collision pass resolves hotkeys (all categories on), predicted as the Sync
  // tab's restore preview does: `applyBlob` switches off an incoming profile that collides with
  // this device's quick-add chord (the default one, when the copy brings none) or with another
  // profile, and `finish()` then skips Profiles — so say so here.
  const chordFix = useMemo(() => {
    if (!pulledBlob) return null;
    const m = migrateBlob(pulledBlob);
    const s = st.getState();
    const inbound = isPlainObject(m.profiles);
    return predictChordFix(
      inbound ? sanitizeProfiles(m.profiles?.list) : s.profiles,
      m.dictionary?.quickAddHotkey,
      s.settings.general.quickAddHotkey,
      inbound,
    );
  }, [pulledBlob, st]);
  const switchesOff = (chordFix?.switchedOff.length ?? 0) > 0;
  // The copy's quick-add chord collides with one of its profiles: this device keeps its own.
  const qaKept = !!chordFix?.qaKept;
  // The restore sentence: what arrives, then what is left to do here.
  const arrives = [
    "profiles",
    ...(!switchesOff && !qaKept ? ["hotkeys"] : []),
    ...(bringsQuickAdd && !qaKept ? ["quick add"] : []),
  ];
  const restoreTails = [
    ...(switchesOff ? ["re-enable the switched-off profiles in Profiles"] : []),
    ...(qaKept ? ["this device keeps its own quick-add shortcut"] : []),
    ...(!bringsQuickAdd ? ["pin a quick-add list later in the Dictionary"] : []),
  ];
  const arrivesText =
    arrives.length > 2
      ? `${arrives.slice(0, -1).join(", ")} and ${arrives[arrives.length - 1]} all arrive`
      : `${arrives.join(" and ")} arrive`;

  const doImport = async () => {
    setError(null);
    const r = await pickAndImportSettings();
    if (!r) return;
    if ("error" in r) setError(r.error);
    else setImportResult(r.result);
  };

  return (
    // m-auto (not items-center on the parent): centered flex children taller than
    // the viewport get their top clipped past scroll reach; auto margins don't.
    <div className="relative z-10 flex h-screen overflow-y-auto">
      <div className="m-auto flex w-full max-w-[560px] flex-col items-center px-8 py-10 text-center">
        <div className="flex items-center gap-3">
          <BrandMark />
          <div className="text-left leading-none">
            <Wordmark />
          </div>
        </div>

        {step === "gate" && (
          <>
            <h1 className="mt-6 font-display text-[21px] font-[680]">Connect your server</h1>
            <p className="mt-1.5 max-w-[46ch] text-[13px] text-dim">
              Everything starts with your faster-whisper server — dictation, settings, sync. Enter its
              address to begin.
            </p>
            <div className="mt-6 flex w-full max-w-[430px] flex-col gap-4 text-left">
              <Labeled label="Server URL">
                <TextInput
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://host:8000"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void testAndContinue();
                  }}
                />
              </Labeled>
              <Labeled label="API key · if your server requires one">
                <TextInput
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="wk_…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void testAndContinue();
                  }}
                />
              </Labeled>
              <div className="flex items-center gap-3">
                <Button variant="accent" onClick={() => void testAndContinue()} disabled={busy || !url.trim()}>
                  {busy ? "Testing…" : "Test & continue"}
                </Button>
                <span className="text-[12px] text-faint">defaults: streaming · the server’s language</span>
              </div>
              {error && <Notice>{error}</Notice>}
              {url.trim() && insecureUrlWarning(url) && <Notice>{insecureUrlWarning(url)}</Notice>}
            </div>
            <div className="mt-7 flex w-full max-w-[430px] items-center justify-between">
              <button
                className="ring-signal rounded text-[12px] text-dim underline decoration-line underline-offset-2 hover:text-text disabled:opacity-50"
                onClick={() => void doImport()}
                disabled={busy}
              >
                Have a settings file? Import it instead
              </button>
              <Button variant="ghost" onClick={finish} disabled={busy}>
                Skip for now
              </Button>
            </div>
          </>
        )}

        {step === "restore" && pull?.state && (
          <>
            <div className="mt-6 font-mono text-[11px] text-dim">
              connected ·{" "}
              {info?.serverVersion
                ? `faster-whisper-backend ${safeDisplayText(info.serverVersion, 30)}`
                : "faster-whisper-backend"}
            </div>
            <div className="mt-4 w-full max-w-[480px] rounded-card border border-accent/40 bg-accent-soft p-4 text-left">
              <div className="text-[13.5px] font-semibold">This account has synced settings</div>
              <div className="mt-1 font-mono text-[11px] text-dim">
                last synced{pull.state.device ? ` from ${safeDisplayText(pull.state.device, 60)}` : ""}
                {pull.state.updated_ts ? ` · ${relTime(pull.state.updated_ts * 1000)}` : ""}
              </div>
              <SyncedCategoryChips blob={pull.state.blob} />
              {pull.state.blob?.backends ? (
                <div className="mt-2.5">
                  {/* What the restore installs, at the address this device uses — as Settings'
                      import and restore previews list it. */}
                  <IncomingAddresses list={pull.state.blob.backends.list} />
                </div>
              ) : null}
              {chordFix && (chordFix.switchedOff.length > 0 || chordFix.qaKept) && (
                <div className="mt-2.5 flex flex-col gap-2">
                  <ChordFixNotices fix={chordFix} source="backup" />
                </div>
              )}
              <div className="mt-3.5 flex items-center gap-2.5">
                <Button variant="accent" onClick={() => void restoreEverything()} disabled={busy}>
                  {busy ? "Restoring…" : "Restore everything"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStartersIntro("fresh");
                    setStep("starters");
                  }}
                  disabled={busy}
                >
                  Start fresh instead
                </Button>
              </div>
            </div>
            <p className="mt-4 max-w-[46ch] text-[12px] text-dim">
              {carriesProfiles
                ? `Restoring turns sync on for this device and skips the remaining steps — ${arrivesText} with your settings${
                    restoreTails.length ? `; ${restoreTails.join("; ")}` : ""
                  }.`
                : "Restoring turns sync on for this device. This copy carries no profiles — you’ll pick starters next."}
            </p>
            {error && <Notice className="mt-3">{error}</Notice>}
          </>
        )}

        {step === "starters" && (
          <StartersStep
            backendId={backendId}
            intro={startersIntro}
            onConfirm={(drafts) => {
              const s = st.getState();
              // Stored as the Profiles editor's save() stores it: a cleared name is "Untitled profile".
              for (const p of drafts) s.upsertProfile({ ...p, name: p.name.trim() || "Untitled profile" });
              // After a restore that pinned a quick-add list, finish: the step would re-ask (and
              // could overwrite) what just arrived. Read from the store, not the blob's
              // categories: the apply lands a pin only when its backend came along.
              if (restored.current && s.settings.quickAddList) finish();
              // Quick add needs a full faster-whisper-backend (pipeline rules).
              else if (info?.bootId) setStep("quickadd");
              else finish();
            }}
          />
        )}

        {step === "quickadd" && backendId && (
          <QuickAddStep serverUrl={typedServerUrl(url)} backendId={backendId} onFinish={finish} />
        )}

        {importResult && (
          <ImportPreview
            result={importResult}
            onClose={() => {
              setImportResult(null);
              // An applied import leaves a configured app behind — done. A
              // cancelled one leaves the store empty → stay on the gate.
              const s = st.getState();
              if (s.backends.length > 0 || s.profiles.length > 0) finish();
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Step 2b: editable starter profiles ─────────────────────────────────────

type StartersIntro = "fresh" | "empty" | "none";

const STARTERS_INTRO: Record<StartersIntro, string> = {
  fresh: "Starting fresh — here are two starters.",
  empty: "Nothing synced on this account yet — here are two starters.",
  none: "Here are two starters.",
};

function StartersStep({
  backendId,
  intro,
  onConfirm,
}: {
  backendId: string | null;
  intro: StartersIntro;
  onConfirm: (drafts: Profile[]) => void;
}) {
  const quickAddHotkey = useApp((s) => s.settings.general.quickAddHotkey);
  const evdevEnabled = useApp((s) => s.settings.general.evdevEnabled);
  const updateGeneral = useApp((s) => s.updateGeneral);
  // A starter whose fixed chord is the quick-add chord starts unbound (its card asks for one), as
  // the Profiles screen's "Keep these" commits it: Confirm has no conflict check of its own, and a
  // colliding pair would hold every later save. Sides collapsed until evdevStatus answers — the
  // conservative reading.
  const [drafts, setDrafts] = useState<Profile[]>(() => startersClearOf(backendId, quickAddHotkey, !IS_WINDOWS));
  const [lowLevel, setLowLevel] = useState(IS_WINDOWS);
  useEffect(() => {
    if (IS_WINDOWS) return;
    void evdevStatus()
      .then((s) => setLowLevel(!!(s.permitted && evdevEnabled)))
      .catch(() => {});
  }, [evdevEnabled]);

  const patch = (id: string, p: Partial<Profile>) =>
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, ...p } : x)));

  return (
    <>
      <h1 className="mt-6 font-display text-[21px] font-[680]">Your hotkeys</h1>
      <p className="mt-1.5 max-w-[52ch] text-[13px] text-dim">
        {STARTERS_INTRO[intro]} Everything is editable; they’re only created when you confirm.
      </p>
      <div className="mt-5 grid w-full max-w-[540px] grid-cols-1 gap-3 text-left sm:grid-cols-2">
        {drafts.map((p) => (
          <StarterCard
            key={p.id}
            profile={p}
            others={withQuickAddPeer(drafts.filter((x) => x.id !== p.id), quickAddHotkey)}
            lowLevelActive={lowLevel}
            onPatch={(patchP) => patch(p.id, patchP)}
            onTakeOver={(id) =>
              id === QUICK_ADD_PEER_ID ? updateGeneral({ quickAddHotkey: [] }) : patch(id, { hotkey: [] })
            }
          />
        ))}
      </div>
      <div className="mt-6 flex w-full max-w-[540px] justify-end">
        <Button variant="accent" onClick={() => onConfirm(drafts.filter((d) => d.hotkey.length > 0))}>
          Confirm & continue
        </Button>
      </div>
    </>
  );
}

function StarterCard({
  profile: p,
  others,
  lowLevelActive,
  onPatch,
  onTakeOver,
}: {
  profile: Profile;
  others: Profile[];
  lowLevelActive: boolean;
  onPatch: (p: Partial<Profile>) => void;
  /** "Use it here": the starter (or quick add) that had these keys loses its shortcut. */
  onTakeOver: (otherId: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const capture = useHotkeyCapture({
    capturing,
    lowLevelActive,
    others,
    selfKind: p.activation === "handsfree" ? "handsfree" : "hold",
    onCommit: (codes) => {
      onPatch({ hotkey: codes });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
    onTakeOver,
  });
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <TextInput
        value={p.name}
        onChange={(e) => onPatch({ name: e.target.value })}
        aria-label="Profile name"
        className="mb-3"
      />
      {/* No ×: a starter is only created with a shortcut. */}
      <TriggerTile
        purpose="dictation"
        codes={p.hotkey}
        capturing={capturing}
        capture={capture}
        activation={p.activation}
        onActivationChange={(v) => onPatch({ activation: v })}
        onToggle={() => setCapturing((c) => !c)}
        onRetry={() => {
          capture.dismissPending();
          setCapturing(true);
        }}
      />
      <div className="mt-2.5 text-[11px] text-faint">
        {/* Confirm drops a starter without keys (its shortcut may have been handed to the other
            card via "Use it here") — say so on the card instead of dropping it silently. */}
        {p.hotkey.length === 0
          ? "Not created without a shortcut — record one, or it is skipped."
          : "Language, vocabulary and more: Profiles screen, any time."}
      </div>
    </div>
  );
}

// ── Step 3: quick add & word mappings (full backends only) ─────────────────

function QuickAddStep({
  serverUrl,
  backendId,
  onFinish,
}: {
  serverUrl: string;
  backendId: string;
  onFinish: () => void;
}) {
  const updateSettings = useApp((s) => s.updateSettings);
  const quickAddHotkey = useApp((s) => s.settings.general.quickAddHotkey);
  const [rules, setRules] = useState<PipelineRule[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  // `ruleListOf` yields [] for a failed/gated fetch too (status 0/401/403/404/500), which the
  // empty-list notice below would otherwise report as "no editable list on this server".
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    // A re-run for a new target starts clean, and only the latest request may set state.
    let live = true;
    setLoadFailed(false);
    setRules(null);
    void getPipelineRules({ serverUrl, backendId })
      .then((res) => {
        if (!live) return;
        if (!res.ok) setLoadFailed(true);
        const maps = ruleListOf(res).filter((r) => r.type === "callback:map");
        setRules(maps);
        setSlug(maps[0]?.name ?? null);
      })
      .catch(() => {
        if (!live) return;
        setLoadFailed(true);
        setRules([]);
      });
    return () => { live = false; };
  }, [serverUrl, backendId]);

  const options = useMemo(
    // First-run screen, fired from a mount effect against a server the user has just met.
    // `ruleListOf` coerces these to strings but bounds no length and strips no bidi marks.
    // `value` stays RAW on purpose: it is the slug PATCHed back and stored in
    // `quickAddList.slug`, so defanging it would pin quick-add to a list that does not exist.
    () =>
      (rules ?? []).map((r) => ({
        value: r.name,
        label: safeDisplayText(r.label, 80) || safeDisplayText(r.name, 80),
      })),
    [rules],
  );

  return (
    <>
      <h1 className="mt-6 font-display text-[21px] font-[680]">Fix words from anywhere</h1>
      <p className="mt-1.5 max-w-[52ch] text-[13px] text-dim">
        When dictation mishears a name or a term, press the quick-add hotkey, type the correction,
        done. Mappings live in your server’s Dictionary — every device shares them.
      </p>
      <div className="mt-6 flex w-full max-w-[430px] flex-col gap-4 text-left">
        {loadFailed ? (
          <Notice>
            Couldn’t load this server’s word-mapping lists right now — you can pick one on the
            Dictionary screen later.
          </Notice>
        ) : rules !== null && rules.length === 0 ? (
          <Notice>
            This server doesn’t share an editable word-mapping list yet — an admin can add one
            (Dictionary explains how). You can set this up there later.
          </Notice>
        ) : (
          <Labeled label="Word-mapping list · on your server">
            <Select
              value={slug ?? ""}
              onChange={(v) => setSlug(v)}
              options={options.length ? options : [{ value: "", label: "Loading…" }]}
            />
          </Labeled>
        )}
        <QuickAddShortcutField title="Quick-add hotkey" />
      </div>
      <div className="mt-7 flex w-full max-w-[430px] items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-label text-faint">
          Optional — Dictionary offers this any time
        </span>
        <div className="flex items-center gap-2.5">
          <Button variant="ghost" onClick={onFinish}>
            Skip
          </Button>
          <Button
            variant="accent"
            disabled={!slug}
            onClick={() => {
              if (slug) updateSettings({ quickAddList: { backendId, slug } });
              onFinish();
            }}
          >
            Finish setup
          </Button>
        </div>
      </div>
      {quickAddHotkey.length === 0 && (
        <p className="mt-3 text-[11px] text-faint">No quick-add hotkey set — record one above, or later on the Dictionary screen.</p>
      )}
    </>
  );
}
