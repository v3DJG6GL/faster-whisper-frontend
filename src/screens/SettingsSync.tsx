// Settings → Sync: file backup (export/import with per-category preview) and
// cross-device sync through a faster-whisper-backend (enable + server picker +
// per-device category toggles + status/manual controls + conflict dialog).
// The engine lives in lib/sync.ts; this screen only drives it.

import { useMemo, useState, type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { DownloadCloud, UploadCloud, RefreshCw, Loader2 } from "lucide-react";
import { useApp, DEFAULT_SYNC } from "@/lib/store";
import {
  Button,
  Card,
  Notice,
  SectionLabel,
  Segmented,
  Select,
  SettingRow,
  StatusDot,
  Toggle,
} from "@/components/ui";
import { evdevStatus, importSettingsFile, pickImportFile, pickSavePath, syncDelete, type EvdevStatus } from "@/lib/api";
import { applyImport, exportToFile } from "@/lib/exportImport";
import { SyncSettingsList } from "@/screens/SyncSettingsList";
import {
  ALL_CATEGORIES,
  applyBlob,
  approvePendingReview,
  dismissSyncConflict,
  deleteFailureMessage,
  getPendingConflict,
  getPendingReview,
  isCodeList,
  migrateBlob,
  pullNow,
  pushNow,
  rejectPendingReview,
  resetSyncState,
  resolveSyncConflicts,
  sanitizeProfiles,
  type SecurityChange,
} from "@/lib/sync";
import { authorityOf, backendOptions, effectiveServerUrl, insecureUrlWarning } from "@/lib/backends";
import { ownProp } from "@/lib/own";
import { conflicts as chordConflicts, quickAddPeer } from "@/lib/conflicts";
import { IS_WINDOWS } from "@/lib/platform";
import { safeDisplayText, safeIdentityText } from "@/lib/sanitize";
import type { Backend, SyncCategory } from "@/lib/types";
import type { ImportResult, SyncBlob, SyncRemoteState } from "@/lib/syncTypes";

const MY_BUCKET = IS_WINDOWS ? ("windows" as const) : ("linux" as const);
const OTHER_BUCKET = IS_WINDOWS ? ("linux" as const) : ("windows" as const);

/** Coerce an opaque payload field to an array before the previews walk it. Both preview
 *  components render categories that are only compile-time typed: the Rust importer validates a
 *  category's `list` only when the key is present, and the sync-pull path passes the blob through
 *  as raw JSON. A `{"backends": {}}` payload otherwise throws in the render body, and with no
 *  error boundary in the app that unmounts the whole window. */
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** The renderable rows of an inbound backend list: an array whose elements are objects.
 *  Everything else is dropped before the render body dereferences it. */
export function displayableBackends(list: unknown): Backend[] {
  return arr<unknown>(list).filter((b): b is Backend => !!b && typeof b === "object");
}

/** Category descriptions for the import preview and the restore dialog (the Sync
 *  list itself renders per-setting switches from the manifest). */
const CATEGORY_META: { key: SyncCategory; title: string; desc: string }[] = [
  { key: "general", title: "General", desc: "Theme, insertion, sounds, launch at login." },
  {
    key: "recording",
    title: "Dictation",
    desc: "Save dictation audio, silence trim, the dictation history & retention clock, system-audio mute, hands-free auto-stop.",
  },
  {
    key: "fileTranscriptions",
    title: "File transcriptions",
    desc: "History retention and audio copies.",
  },
  {
    key: "transcription",
    title: "Transcribe defaults",
    desc: "The Transcribe screen's option, display and export defaults — diarization, translation targets and model, music separation, timestamps, colors, format.",
  },
  { key: "chip", title: "Chip", desc: "Styling, visibility, timing, quick-launch buttons." },
  { key: "backends", title: "Backends", desc: "Server connections incl. API keys (stored on your own server)." },
  { key: "profiles", title: "Profiles", desc: "Dictation profiles: name, backend, activation, chip tag." },
  { key: "dictionary", title: "Dictionary", desc: "Quick-add shortcut and pinned list. The word list itself lives on your server and always follows your account." },
  { key: "appRules", title: "App rules", desc: `Per-app rules for this OS (${MY_BUCKET}); other-OS rules pass through untouched.` },
  { key: "logging", title: "Logging", desc: "Log level, file retention, sidebar visibility. Log files themselves never sync." },
];


/** Initial per-category selection for the two preview dialogs: every category
 *  present in the blob starts checked. */
function presentSel(blob: SyncBlob): Record<SyncCategory, boolean> {
  return Object.fromEntries(
    ALL_CATEGORIES.map((c) => [c, blob[c] !== undefined]),
  ) as Record<SyncCategory, boolean>;
}

/** "just now" / "4m ago" / "3h ago" / a date — for the last-synced line. */
export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  // Portaled to <body>: callers mount this from arbitrary depths (e.g. inside a
  // Card, whose backdrop-blur makes it a containing block for fixed-position
  // descendants) — without the portal the "fullscreen" backdrop would dim only
  // the ancestor's box and the panel would float over undimmed content.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-[600px]" onClick={(e) => e.stopPropagation()}>
        <Card className="max-h-[80vh] overflow-y-auto px-6 py-5">{children}</Card>
      </div>
    </div>,
    document.body,
  );
}

/** Per-category selection + hazard preview for a parsed import file. */
export function ImportPreview({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const evdevEnabled = useApp((st) => st.settings.general.evdevEnabled);
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  useEffect(() => {
    void evdevStatus().then(setEvdev).catch(() => {}); // match Profiles/Settings; ignore an IPC reject
  }, []);
  // Same predicate as the persistence save gate (persistence.ts): a low-level backend
  // owns the chords only on Windows, or when evdev is enabled AND permitted. While the
  // status is still loading, collapse — over-warn rather than under-warn.
  const lowLevelActive = IS_WINDOWS || (evdevEnabled && !!evdev?.permitted);
  const dictating = useApp((st) => st.status !== "idle");
  // Normalize a pre-split file once for everything this dialog previews —
  // `applyImport` migrates again on apply (idempotent), so preview and apply
  // read the same shape.
  const categories = useMemo(() => migrateBlob(result.categories), [result.categories]);
  const present = (c: SyncCategory) => categories[c] !== undefined;
  const [sel, setSel] = useState<Record<SyncCategory, boolean>>(() => presentSel(categories));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts: Partial<Record<SyncCategory, string>> = {
    backends: categories.backends ? `${arr(categories.backends.list).length}` : undefined,
    profiles: categories.profiles ? `${arr(categories.profiles.list).length}` : undefined,
    appRules: categories.appRules
      ? `${arr(categories.appRules[MY_BUCKET]).length} this OS · ${arr(categories.appRules[OTHER_BUCKET]).length} other OS`
      : undefined,
  };

  // Predict hotkey conflicts in the WOULD-BE state (imported profiles and/or
  // quick-add chord over the current ones) so the user isn't surprised by the
  // save-freeze banner after applying. Conservative L/R collapse off-Windows —
  // mirrors the persistence save-gate's no-low-level-backend assumption.
  // Run the SAME sanitizers `applyBlob` runs. This dialog is the consent step, so it renders
  // strictly BEFORE them — and `arr()` coerces only the CONTAINER, so every element was
  // attacker-shaped at the point `chordConflicts` walked it, in a render body, with no error
  // boundary anywhere in the tree. A profile missing `hotkey` threw on `p.hotkey.length` and a
  // numeric code threw in `canonicalizeCodes`' `localeCompare` tie-break — unmounting the very
  // window whose job is to let the user REJECT this blob. The same call also bounds chord LENGTH
  // (`isCodeList`), which is what keeps `isStrictSubset`'s O(k·m) scan from freezing the webview
  // on a hand-authored file. Bonus: the preview now predicts exactly what apply would install.
  const st = useApp.getState();
  const wouldProfiles =
    sel.profiles && categories.profiles
      ? sanitizeProfiles(categories.profiles.list)
      : st.profiles;
  // Post-migration the chord lives in the dictionary category.
  const rawQa = categories.dictionary?.quickAddHotkey;
  const wouldQa =
    sel.dictionary && rawQa !== undefined
      ? (isCodeList(rawQa) ? rawQa : [])
      : st.settings.general.quickAddHotkey;
  const peers = (wouldQa.length > 0 ? [...wouldProfiles, quickAddPeer(wouldQa)] : wouldProfiles).slice(
    0,
    MAX_PREVIEW_PEERS,
  );
  const predictedConflicts =
    chordConflicts(peers, !lowLevelActive).length > 0;

  const missingKeys =
    sel.backends && categories.backends
      ? arr<Backend>(categories.backends.list).filter(
          (b) => b.hasApiKey && !ownProp(result.secrets, b.id),
        )
      : [];

  // Same condition `RestoreFromServer` computes for its own replace warning — see the notice below.
  const replaces =
    (sel.backends && categories.backends && st.backends.length > 0) ||
    (sel.profiles && categories.profiles && st.profiles.length > 0) ||
    (sel.appRules && categories.appRules && st.appRules.length > 0);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      await applyImport(sel, result);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error && e.message === "dictating"
          ? "Stop dictation before importing."
          : String(e),
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="text-[15px] font-semibold text-text">Import settings</div>
      <div className="mt-1 text-[12.5px] text-dim">
        From {safeText(result.hostname, 60) || "unknown device"} · {safeText(result.platform, 40) || "?"} · v
        {safeText(result.appVersion, 30) || "?"} · {result.createdAt ? new Date(result.createdAt).toLocaleString() : "?"}
      </div>

      <div className="mt-4">
        {CATEGORY_META.map(({ key, title, desc }, i) => (
          <SettingRow
            key={key}
            title={title}
            desc={present(key) ? (counts[key] ? `${desc} (${counts[key]})` : desc) : "Not in this file."}
            disabled={!present(key)}
            last={i === CATEGORY_META.length - 1}
          >
            <Toggle
              checked={sel[key]}
              disabled={!present(key)}
              onChange={(v) => setSel((s) => ({ ...s, [key]: v }))}
              ariaLabel={`Import ${title}`}
            />
          </SettingRow>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <Notice>
          Machine-specific settings (microphone, audio folder, evdev) are never imported.
        </Notice>
        {/* The hazard notice `RestoreFromServer` has and this dialog did not, though both default
            every present category to ON and both apply through `applyBlob` — which REPLACES rather
            than merges. A file carrying `"backends": {"list": []}` renders as a pre-checked row
            reading "Backends · Server connections incl. API keys (0)", with no incoming-addresses
            block (it returns null on an empty list) and no missing-key warning, and on Import
            deletes every configured backend, nulls every profile's backendId and takes the keyring
            association with it. Nothing in the dialog said the selection replaces rather than adds. */}
        {replaces && (
          <Notice tone="warn">
            Selected categories replace what&apos;s on this device — your current backends and
            profiles are overwritten.
          </Notice>
        )}
        {result.hasSecrets && sel.backends && (
          <Notice tone="warn">This file contains API keys — they'll be stored in the system keyring.</Notice>
        )}
        {sel.backends && categories.backends && (
          <IncomingAddresses list={categories.backends.list} />
        )}
        {missingKeys.length > 0 && (
          <Notice tone="warn">
            {missingKeys.map((b) => `“${safeText(b.name, 60)}”`).join(", ")} need{missingKeys.length === 1 ? "s" : ""} an
            API key re-entered after importing (not included in the file).
          </Notice>
        )}
        {/* These interpolate a backend name straight out of the imported file. The missing-keys
            line above renders the same field through safeText; this one did not, so a bidi
            override could rewrite the sentence the user reads to decide whether to import. */}
        {result.warnings.slice(0, 20).map((w) => (
          <Notice key={w} tone="warn">
            {safeDisplayText(w, 300)}
          </Notice>
        ))}
        {predictedConflicts && (
          <Notice tone="warn">
            Some imported shortcuts collide — saving stays paused after import until you resolve them
            in Profiles.
          </Notice>
        )}
        {dictating && <Notice tone="warn">Stop dictation before importing.</Notice>}
        {error && <Notice tone="warn">{error}</Notice>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => void apply()}
          disabled={applying || dictating || !Object.values(sel).some(Boolean)}
        >
          {applying ? "Importing…" : "Import selected"}
        </Button>
      </div>
    </Modal>
  );
}

/** Per-category selection + hazard preview for a server-side settings blob —
 *  ImportPreview's sibling for the Backends connect-first add flow, where the
 *  just-connected account turns out to have synced settings. Applies via the
 *  same `applyBlob` path sync uses; the CALLER runs `onApplied` afterwards
 *  (bind sync to the new backend, close the flow). */
export function RestoreFromServer({
  state,
  onCancel,
  onApplied,
}: {
  state: SyncRemoteState;
  onCancel: () => void;
  onApplied: () => void | Promise<void>;
}) {
  const evdevEnabled = useApp((st) => st.settings.general.evdevEnabled);
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  useEffect(() => {
    void evdevStatus().then(setEvdev).catch(() => {}); // match Profiles/Settings; ignore an IPC reject
  }, []);
  // Same predicate as the persistence save gate (persistence.ts): a low-level backend
  // owns the chords only on Windows, or when evdev is enabled AND permitted. While the
  // status is still loading, collapse — over-warn rather than under-warn.
  const lowLevelActive = IS_WINDOWS || (evdevEnabled && !!evdev?.permitted);
  const dictating = useApp((st) => st.status !== "idle");
  // Normalize a pre-split server blob for the preview AND the apply below.
  const blob = useMemo(() => migrateBlob((state.blob ?? {}) as SyncBlob), [state.blob]);
  const present = (c: SyncCategory) => blob[c] !== undefined;
  const [sel, setSel] = useState<Record<SyncCategory, boolean>>(() => presentSel(blob));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts: Partial<Record<SyncCategory, string>> = {
    backends: blob.backends ? `${arr(blob.backends.list).length}` : undefined,
    profiles: blob.profiles ? `${arr(blob.profiles.list).length}` : undefined,
    appRules: blob.appRules
      ? `${arr(blob.appRules[MY_BUCKET]).length} this OS · ${arr(blob.appRules[OTHER_BUCKET]).length} other OS`
      : undefined,
  };

  // Same would-be-state hazard previews as ImportPreview: predicted hotkey
  // collisions, and (new here) whether a selected category overwrites data the
  // device already has — on an empty app the restore is warning-free.
  // Same reasoning as ImportPreview above: sanitize with `applyBlob`'s own helpers, because this
  // dialog renders before them and `chordConflicts` walks the elements in a render body.
  const st = useApp.getState();
  const wouldProfiles = sel.profiles && blob.profiles ? sanitizeProfiles(blob.profiles.list) : st.profiles;
  // Post-migration the chord lives in the dictionary category.
  const rawQa = blob.dictionary?.quickAddHotkey;
  const wouldQa =
    sel.dictionary && rawQa !== undefined
      ? (isCodeList(rawQa) ? rawQa : [])
      : st.settings.general.quickAddHotkey;
  const peers = (wouldQa.length > 0 ? [...wouldProfiles, quickAddPeer(wouldQa)] : wouldProfiles).slice(
    0,
    MAX_PREVIEW_PEERS,
  );
  const predictedConflicts = chordConflicts(peers, !lowLevelActive).length > 0;
  const replaces =
    (sel.backends && blob.backends && st.backends.length > 0) ||
    (sel.profiles && blob.profiles && st.profiles.length > 0) ||
    (sel.appRules && blob.appRules && st.appRules.length > 0);

  const apply = async () => {
    // Re-check right before applying: applyBlob silently DEFERS while dictating
    // (fine for background sync, wrong here — onApplied would bind sync against
    // the pre-restore state). The disabled button covers the steady state; this
    // covers a session starting between render and click.
    if (useApp.getState().status !== "idle") {
      setError("Stop dictation before restoring.");
      return;
    }
    setApplying(true);
    setError(null);
    try {
      // The boolean matters: false = nothing was applied (a session started between the
      // check above and applyBlob's own, or the apply was dropped stale after its retries).
      // Binding sync to the new backend on a state that never landed would then push this
      // device's pre-restore config over the server copy.
      const ok = await applyBlob(blob, sel, 2, { ignoreGates: true });
      if (!ok) {
        setError("Nothing was restored — stop dictation or avoid changing settings while restoring, then try again.");
        setApplying(false);
        return;
      }
      await onApplied();
    } catch (e) {
      setError(String(e));
      setApplying(false);
    }
  };

  return (
    <Modal onClose={onCancel}>
      <div className="text-[15px] font-semibold text-text">Restore from server</div>
      <div className="mt-1 text-[12.5px] text-dim">
        Last synced{state.device ? ` from ${safeText(state.device, 60)}` : ""}
        {state.updated_at ? ` · ${relTime(state.updated_at * 1000)}` : ""}
      </div>

      <div className="mt-4">
        {CATEGORY_META.map(({ key, title, desc }, i) => (
          <SettingRow
            key={key}
            title={title}
            desc={present(key) ? (counts[key] ? `${desc} (${counts[key]})` : desc) : "Nothing synced."}
            disabled={!present(key)}
            last={i === CATEGORY_META.length - 1}
          >
            <Toggle
              checked={sel[key]}
              disabled={!present(key)}
              onChange={(v) => setSel((s) => ({ ...s, [key]: v }))}
              ariaLabel={`Restore ${title}`}
            />
          </SettingRow>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {replaces && (
          <Notice tone="warn">
            Selected categories replace what&apos;s on this device — your current backends and
            profiles are overwritten.
          </Notice>
        )}
        {sel.backends && blob.backends && <IncomingAddresses list={blob.backends.list} />}
        <Notice tone="ok">
          After restoring, settings sync turns on for this device against this server.
        </Notice>
        {predictedConflicts && (
          <Notice tone="warn">
            Some restored shortcuts collide — saving stays paused after restoring until you resolve
            them in Profiles.
          </Notice>
        )}
        {dictating && <Notice tone="warn">Stop dictation before restoring.</Notice>}
        {error && <Notice tone="warn">{error}</Notice>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={applying}>
          Cancel
        </Button>
        <Button
          onClick={() => void apply()}
          disabled={applying || dictating || !Object.values(sel).some(Boolean)}
        >
          {applying ? "Restoring…" : "Restore selected"}
        </Button>
      </div>
    </Modal>
  );
}

/** Every string in this dialog came from the untrusted blob, and it is the ONE surface where the
 *  user decides whether to trust an address. Strip the characters that let a sender make text
 *  read as something other than what it is — C0/C1 controls, the bidi overrides and isolates
 *  (U+202A–U+202E, U+2066–U+2069) and the invisible marks — and bound the length so a long value
 *  cannot push the buttons off screen. */
const MAX_REVIEW_ROWS = 50;
/** Moved to lib/sanitize.ts (`safeDisplayText`) so the sibling dialogs and cards that render
 *  remote-authored identity share one implementation — and one Cf denylist — with this one. */
const safeText = safeDisplayText;

/** The label for the "adopt the other device's value" arm of a conflict choice. The name is
 *  server-supplied, so it must never be able to read as the arm beside it: a device calling
 *  itself "This device" would produce two identical buttons on the control that decides whose
 *  settings win. Fall back to the neutral wording on a collision (compared case- and
 *  whitespace-insensitively, since the buttons are read, not parsed). */
function remoteArmLabel(device: string | null): string {
  const name = safeText(device, 60);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return name && norm(name) !== norm(LOCAL_ARM_LABEL) ? name : "Other device";
}

const LOCAL_ARM_LABEL = "This device";


/** The addresses an incoming blob would install, shown BEFORE it is applied.
 *
 *  SecurityReviewDialog gets this because it is where the user decides whether to trust an
 *  address. Its siblings — Restore from server, Import preview, Onboarding's restore — apply the
 *  same attacker-authored `backends.list` through the same `applyBlob`, with no `securityChanges`
 *  gate in front of them, and disclosed only a COUNT. A URL's real authority is whatever follows
 *  the last `@`, so `http://localhost:8000@evil.tld/v1` reads as loopback until it is parsed. */
export function IncomingAddresses({ list }: { list: unknown }) {
  // ELEMENTS too, not only the container: the pull path hands this the raw server list, and
  // `sanitizeBackends` runs only inside applyBlob — AFTER consent. A `[null]` element threw
  // in this render body and unmounted the very dialog that lets the user refuse the blob.
  const all = displayableBackends(list);
  const backends = all.slice(0, MAX_SHOWN_ADDRESSES);
  if (backends.length === 0) return null;
  return (
    <Notice>
      <div className="font-medium">Dictation would be sent to:</div>
      <ul className="mt-1 space-y-0.5">
        {backends.map((b, i) => {
          const auth = authorityOf(String(b.serverUrl ?? ""));
          const warn = insecureUrlWarning(String(b.serverUrl ?? ""));
          return (
            <li key={`${b.id}-${i}`} className="font-mono text-[12px]" title={safeText(String(b.serverUrl ?? ""), 300)}>
              {safeText(b.name || b.id, 60)} →{" "}
              {/* The host through the IDENTITY helper, which marks a truncation. The plain display
                  filter cuts at 80 code points with no ellipsis, and `serverUrl` has no length cap
                  on the sync/import path — so a padded, fully resolvable hostname
                  (`sync.internal.corp.example.com.<padding>.evil.tld`) rendered as a
                  trusted-looking PREFIX of itself with the real suffix invisible, on the dialog
                  whose whole job is to disclose where dictation would go. Its sibling in the
                  security-review dialog below gets the same treatment: that one's detail line
                  carries the full address, but at the same markerless 200-code-point cap — and for
                  a repoint the detail is TWO addresses sharing that budget. */}
              <span className="font-semibold">{auth ? safeIdentityText(auth.host, 80) : "unreadable address"}</span>
              {auth?.hasUserinfo ? " · address hides the real host behind a username" : ""}
              {warn ? ` · ${warn}` : ""}
            </li>
          );
        })}
      </ul>
      {all.length > backends.length ? (
        <div className="mt-1">…and {all.length - backends.length} more.</div>
      ) : null}
    </Notice>
  );
}

const MAX_SHOWN_ADDRESSES = 20;
/** Bound on the list fed to the hazard PREVIEWS. `conflicts()` is an O(n²) pair scan that also
 *  pushes O(n²) result objects, and it runs in the render body — before the user has consented to
 *  anything. Truncating a predictive warning drops no data; the applied list is untouched. */
const MAX_PREVIEW_PEERS = 500;

/** A pulled update that would repoint a backend or replace a stored key, held for approval. */
function SecurityReviewDialog() {
  const pending = getPendingReview();
  const dictating = useApp((st) => st.status !== "idle");
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  const LABELS: Record<SecurityChange["kind"], string> = {
    "new-backend": "New server added",
    "server-url": "Server address changed",
    "api-key": "API key changed",
    "recording-retention": "Saved recordings would be deleted",
    "save-recordings": "Saving every dictation would be turned on",
    "history-retention": "File transcriptions would start being deleted",
    "dictation-retention": "Dictations would start being deleted",
    "dictation-history": "Dictation history would be turned off and wiped",
  };
  const label = (c: SecurityChange) => LABELS[c.kind];
  const shown = pending.changes.slice(0, MAX_REVIEW_ROWS);
  const hidden = pending.changes.length - shown.length;
  return (
    <Modal onClose={busy ? () => {} : rejectPendingReview}>
      <div className="text-[15px] font-semibold text-text">Review this update</div>
      <div className="mt-1 text-[12.5px] leading-snug text-dim">
        {safeText(pending.device || "Another device", 60)} sent changes that affect where your
        dictation is sent, which key is used, or what is kept on this device. Everything else was
        applied already — only these are waiting.
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {shown.map((c, i) => {
          const auth = c.url ? authorityOf(c.url) : null;
          const insecure = c.url ? insecureUrlWarning(c.url) : null;
          return (
            <div
              key={`${c.kind}-${c.backend}-${i}`}
              className="rounded-card border border-line bg-surface-2 px-3.5 py-2.5"
            >
              <div className="text-[13.5px] font-semibold text-text">{label(c)}</div>
              {auth && (
                <div className="mt-1 text-[12.5px] text-text">
                  Would connect to <span className="font-mono font-semibold">{safeIdentityText(auth.host, 80)}</span>
                </div>
              )}
              <div className="mt-0.5 font-mono text-[11px] break-all text-dim">
                {/* `safeIdentityText`: on the `api-key` arm `securityChanges` pushes no `url`,
                    so the "Would connect to" line above does not render and this NAME is the
                    row's only identity — while the row decides whether an incoming plaintext key
                    is written to the OS keyring. `sanitizeBackends` length-caps nothing and a
                    rename raises no security change, so a prior pull can set
                    `"Work" + 100 spaces + "EvilCorp"` and the markerless cut lands in the
                    padding. Its two neighbours in this same block were already converted. */}
                {c.backend ? `${safeIdentityText(c.backend, 80)} · ` : ""}
                {safeIdentityText(c.detail, 200)}
              </div>
              {auth?.hasUserinfo && (
                <div className="mt-1 text-[12px] font-semibold text-rec">
                  This address hides the real server behind a sign-in prefix — the part before the
                  “@” is not where it connects.
                </div>
              )}
              {insecure && <div className="mt-1 text-[12px] text-rec">{insecure}</div>}
            </div>
          );
        })}
        {hidden > 0 && (
          <div className="text-[12px] text-faint">…and {hidden} more change(s) not shown.</div>
        )}
      </div>
      <Notice className="mt-3">
        If you did not change this yourself on another device, reject it — your microphone audio and
        everything you dictate would go to the new address.
      </Notice>
      {dictating && (
        <Notice className="mt-3">Stop dictation before applying — nothing is queued while a session runs.</Notice>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={rejectPendingReview}>
          Reject
        </Button>
        {/* Both buttons stay live across the await otherwise: approve nulls the pending review and
            only then awaits applyBlob's keyring writes, so a click on Reject during that window
            closes the modal as "rejected" after the change has already been committed. */}
        <Button
          disabled={busy || dictating}
          onClick={() => {
            setBusy(true);
            void approvePendingReview().finally(() => setBusy(false));
          }}
        >
          {busy ? "Applying…" : "Apply"}
        </Button>
      </div>
    </Modal>
  );
}

/** Keep Local / Keep Remote per genuinely-conflicting category. */
function ConflictDialog() {
  const pending = getPendingConflict();
  if (!pending) return null;
  // Keyed on the conflict's identity so a NEW conflict remounts the body with
  // fresh picks — the instance never unmounts between conflicts, and a retained
  // "remote" pick would silently hand the peer a category with no second prompt.
  return <ConflictDialogBody key={pending.id} pending={pending} />;
}

function ConflictDialogBody({ pending }: { pending: NonNullable<ReturnType<typeof getPendingConflict>> }) {
  const [picks, setPicks] = useState<Record<string, "local" | "remote">>({});
  // resolveSyncConflicts returns silently while a session runs (same rule as the review's
  // approve) — the button says so instead of doing nothing.
  const dictating = useApp((st) => st.status !== "idle");
  return (
    <Modal onClose={dismissSyncConflict}>
      <div className="text-[15px] font-semibold text-text">Sync conflict</div>
      <div className="mt-1 text-[12.5px] leading-snug text-dim">
        These settings changed both here and on {safeText(pending.remoteDevice, 60) || "another device"}. Pick which
        version to keep — everything else was merged automatically.
      </div>
      <div className="mt-4">
        {pending.categories.map((c, i) => {
          const meta = CATEGORY_META.find((m) => m.key === c);
          return (
            <SettingRow key={c} title={meta?.title ?? c} last={i === pending.categories.length - 1}>
              <Segmented
                ariaLabel={`Resolve ${meta?.title ?? c}`}
                value={picks[c] ?? "local"}
                onChange={(v) => setPicks((p) => ({ ...p, [c]: v }))}
                options={[
                  { value: "local", label: LOCAL_ARM_LABEL },
                  // The server names this button. Defanging its characters does not stop it
                  // reporting the literal string "This device" and rendering two identical
                  // arms — on the one control that decides whose settings win, for categories
                  // (general, profiles, app rules) that then apply with no second prompt.
                  { value: "remote", label: remoteArmLabel(pending.remoteDevice) },
                ]}
              />
            </SettingRow>
          );
        })}
      </div>
      {dictating && (
        <Notice className="mt-3">Stop dictation before resolving — nothing is queued while a session runs.</Notice>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={dismissSyncConflict}>
          Later
        </Button>
        <Button
          disabled={dictating}
          onClick={() => {
            const chosen = Object.fromEntries(pending.categories.map((c) => [c, picks[c] ?? "local"]));
            void resolveSyncConflicts(chosen);
          }}
        >
          Apply
        </Button>
      </div>
    </Modal>
  );
}

export function SyncTab() {
  const backends = useApp((st) => st.backends);
  const sync = useApp((st) => st.settings.sync) ?? DEFAULT_SYNC;
  const updateSync = useApp((st) => st.updateSync);
  const syncStatus = useApp((st) => st.syncStatus);
  const syncError = useApp((st) => st.syncError);
  const syncUnsupported = useApp((st) => st.syncUnsupported);
  const lastSyncedAt = useApp((st) => st.lastSyncedAt);
  const lastSyncDevice = useApp((st) => st.lastSyncDevice);

  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const syncBackend = backends.find((b) => b.id === sync.backendId) ?? null;
  const busy = syncStatus === "syncing";

  const doExport = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await pickSavePath(`faster-whisper-settings-${stamp}.json`);
    if (!path) return;
    setExportState("busy");
    try {
      await exportToFile(path, includeSecrets);
      setExportState("done");
      setTimeout(() => setExportState("idle"), 2500);
    } catch (e) {
      console.error("export failed", e);
      setExportState("error");
    }
  };

  const doImport = async () => {
    setImportError(null);
    const path = await pickImportFile();
    if (!path) return;
    try {
      setImportResult(await importSettingsFile(path));
    } catch (e) {
      // `import_settings_file`'s serde errors echo the offending input VERBATIM and untruncated
      // (the config enums are plain unit variants, so `unknown_variant` quotes whatever the file
      // said). That is attacker-authored text from a file that never passed validation, i.e. with
      // no consent step in front of it. Defang it the way the `warnings` channel beside it is.
      setImportError(safeDisplayText(String(e), 300));
    }
  };

  const doDeleteServerCopy = async () => {
    if (!syncBackend) return;
    setDeleteArmed(false);
    const r = await syncDelete({
      serverUrl: effectiveServerUrl(syncBackend, useApp.getState().settings),
      backendId: syncBackend.id,
    });
    // 404 = already gone; treat as done. Anything else must not clear the local
    // base — with version 0 and no snapshot, the next push CASes against 0,
    // takes a 409 against the doc the user believes deleted, and merges it back.
    if (!r.ok && r.status !== 404) {
      useApp.getState().setSyncRuntime({ syncStatus: "error", syncError: deleteFailureMessage(r) });
      return;
    }
    await resetSyncState();
  };

  return (
    <>
      <Card className="px-6">
        <SectionLabel className="pt-5">Backup</SectionLabel>
        <SettingRow
          title="Export settings"
          desc="Save everything to a JSON file you can import on another computer."
        >
          <Button onClick={() => void doExport()} disabled={exportState === "busy"}>
            <DownloadCloud className="size-4" />
            {exportState === "done" ? "Exported ✓" : exportState === "error" ? "Failed — retry" : "Export…"}
          </Button>
        </SettingRow>
        <SettingRow
          title="Include API keys"
          desc="Write the stored keys into the file in plain text — only for backups you keep private."
        >
          <Toggle checked={includeSecrets} onChange={setIncludeSecrets} />
        </SettingRow>
        <SettingRow
          title="Import settings"
          desc="Load a settings file — you choose which parts to apply."
          last
        >
          <Button variant="ghost" onClick={() => void doImport()}>
            <UploadCloud className="size-4" />
            Import…
          </Button>
        </SettingRow>
        {importError && (
          <div className="pb-4">
            <Notice tone="warn">{importError}</Notice>
          </div>
        )}
      </Card>

      <Card className="mt-6 px-6">
        <SectionLabel className="pt-5">Sync across devices</SectionLabel>
        <SettingRow
          title="Sync settings with a server"
          desc="Store your settings on a faster-whisper-backend so every computer using the same account shares one configuration. Pulls on start and focus, pushes as you change things."
        >
          <Toggle
            checked={sync.enabled}
            onChange={(v) =>
              updateSync({
                enabled: v,
                // First enable with nothing picked: default to the first backend.
                backendId: sync.backendId ?? backends[0]?.id ?? null,
              })
            }
          />
        </SettingRow>
        <SettingRow
          title="Sync server"
          desc="Which backend stores the settings. All machines must reach this server."
          disabled={!sync.enabled}
        >
          <Select
            value={sync.backendId ?? ""}
            onChange={(v) => updateSync({ backendId: v || null })}
            disabled={!sync.enabled}
            // This control picks which server receives EVERY backend's plaintext key, and a
            // backend rename arrives with no prompt — so the labels get the same defanging as the
            // device name on the conflict dialog, plus a host suffix when two of them collide.
            options={backendOptions(backends).map((o, i) =>
              backends[i].hasApiKey ? o : { ...o, label: `${o.label} (no API key)` },
            )}
          />
        </SettingRow>
        {sync.enabled && syncBackend && !syncBackend.hasApiKey && (
          <div className="pb-3">
            <Notice tone="warn">
              “{safeText(syncBackend.name, 80)}” has no API key. On an open-mode server every keyless device shares one
              settings set; on a locked-down server sync won't work at all. Add a key to give this account
              its own set.
            </Notice>
          </div>
        )}
        {syncUnsupported && (
          <div className="pb-3">
            <Notice tone="warn">
              This server doesn't support settings sync yet — update faster-whisper-backend.
            </Notice>
          </div>
        )}

        <SectionLabel>What this device syncs</SectionLabel>
        <SyncSettingsList enabled={sync.enabled} />
        <div className="mt-3 rounded-[10px] border border-dashed border-line-strong px-4 py-2.5 text-[12px] leading-snug text-faint">
          <span className="font-semibold text-dim">Never synced:</span> microphone, this device's
          audio and log folders (unless enabled above), the Linux input backend, and these sync
          settings themselves.
        </div>

        <div className="flex items-center gap-3 py-4">
          <StatusDot
            tone={syncStatus === "error" ? "warn" : syncStatus === "ok" ? "ok" : busy ? "accent" : "idle"}
            pulse={busy}
          />
          <div className="min-w-0 flex-1 text-[12.5px] text-dim">
            {busy
              ? "Syncing…"
              : lastSyncedAt
                ? `Last synced ${relTime(lastSyncedAt)}${lastSyncDevice ? ` · from ${safeText(lastSyncDevice, 60)}` : ""}`
                : sync.enabled
                  ? "Not synced yet."
                  : "Sync is off."}
          </div>
          <Button variant="ghost" disabled={!sync.enabled || busy} onClick={() => void pullNow(true)}>
            <RefreshCw className="size-4" />
            Pull now
          </Button>
          <Button variant="ghost" disabled={!sync.enabled || busy} onClick={() => void pushNow(true)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
            Push now
          </Button>
        </div>
        {syncError && !syncUnsupported && (
          <div className="pb-4">
            <Notice tone="warn">{syncError}</Notice>
          </div>
        )}
        <SettingRow
          title="Delete server copy"
          desc="Remove the stored settings from the server. Devices keep their local settings."
          disabled={!sync.enabled || !syncBackend}
          last
        >
          {deleteArmed ? (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setDeleteArmed(false)}>
                Keep
              </Button>
              <Button variant="danger" onClick={() => void doDeleteServerCopy()}>
                Really delete
              </Button>
            </div>
          ) : (
            <Button variant="ghost" disabled={!sync.enabled || !syncBackend} onClick={() => setDeleteArmed(true)}>
              Delete…
            </Button>
          )}
        </SettingRow>
      </Card>

      {importResult && <ImportPreview result={importResult} onClose={() => setImportResult(null)} />}
      <SecurityReviewDialog />
      <ConflictDialog />
    </>
  );
}
