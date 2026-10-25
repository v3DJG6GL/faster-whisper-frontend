// Settings → Sync: file backup (export/import with per-category preview) and
// cross-device sync through a faster-whisper-backend (enable + server picker +
// per-setting sync switches + status/manual controls + conflict dialog).
// The engine lives in lib/sync/sync.ts; this screen only drives it.

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { pickAndImportSettings, pickSavePath, syncDelete } from "@/lib/api";
import { evdevPermittedNow } from "@/lib/persistence";
import { applyImport, exportToFile, stripMachineFolders } from "@/lib/sync/settingsFile";
import { SyncSettingsList } from "@/components/sync/SyncSettingsList";
import { syncServerOptions } from "@/components/sync/syncServerOptions";
import { SETTING } from "@/lib/settingsManifest";
import {
  ALL_CATEGORIES,
  applyBlob,
  approvePendingReview,
  backendKeyFates,
  consentDetailCap,
  deleteAnswerRuntime,
  dismissSyncConflict,
  disableConflictingProfiles,
  getPendingConflict,
  getPendingReview,
  isCodeList,
  isPlainObject,
  migrateBlob,
  pullNow,
  pushNow,
  rejectPendingReview,
  resetSyncState,
  resolveSyncConflicts,
  restorableCategories,
  sanitizeAppRules,
  sanitizeBackends,
  sanitizeProfiles,
  type SecurityChange,
} from "@/lib/sync/sync";
import { authorityOf, backendLabel, effectiveServerUrl, insecureUrlWarning, fatesAfterSuppliedKey } from "@/lib/backends";
import { plural, relTime } from "@/lib/format";
import { canonicalizeCodes, sameCodes } from "@/lib/keys";
import { IS_WINDOWS } from "@/lib/platform";
import { everyWhileVisible } from "@/lib/windowVisibility";
import { backendDisplayName, peerDeviceName, profileDisplayName, safeDisplayText, safeIdentityText } from "@/lib/sanitize";
import type { Profile, SyncCategory } from "@/lib/types";
import type { ImportResult, SyncBlob, SyncRemoteState } from "@/lib/sync/syncTypes";

const MY_BUCKET = IS_WINDOWS ? ("windows" as const) : ("linux" as const);
const OTHER_BUCKET = IS_WINDOWS ? ("linux" as const) : ("windows" as const);

/** Coerce an opaque payload field to an array before the previews count it. Both preview
 *  components render categories that are only compile-time typed: the Rust importer lets an app-rules
 *  bucket be null or absent, and the sync-pull path passes the blob through as raw JSON. An
 *  `{"appRules": {}}` payload otherwise throws in the render body, and with no error boundary in
 *  the app that unmounts the whole window. */
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Category descriptions for the import preview and the restore dialog (the Sync
 *  list itself renders per-setting switches from the manifest). */
const CATEGORY_META: { key: SyncCategory; title: string; desc: string }[] = [
  { key: "general", title: "General", desc: "Theme, insertion, sounds, launch at login." },
  {
    key: "recording",
    title: "Dictation",
    desc: "Save dictation audio, silence trim, the dictation history & retention clock, reporting the app you dictate into, system-audio mute, hands-free auto-stop.",
  },
  {
    key: "fileTranscriptions",
    title: "File transcriptions",
    desc: "History retention, audio copies, and video downloads for links.",
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

/** A category's display name ("recording" → "Dictation"), as every sync surface spells it. */
export function categoryTitle(c: SyncCategory): string {
  return CATEGORY_META.find((m) => m.key === c)?.title ?? c;
}


/** What a selection would overwrite on this device, for the two preview dialogs' replace
 *  warning: a selected category the blob carries AND the device already has data for. "Carries"
 *  is applyBlob's own arm test (a plain object), so the warning never names a category the
 *  apply would skip. */
function replacedNames(
  sel: Record<SyncCategory, boolean>,
  blob: SyncBlob,
  st: ReturnType<typeof useApp.getState>,
): string[] {
  return [
    sel.backends && isPlainObject(blob.backends) && st.backends.length > 0 && "backends",
    sel.profiles && isPlainObject(blob.profiles) && st.profiles.length > 0 && "profiles",
    sel.appRules && isPlainObject(blob.appRules) && st.appRules.length > 0 && "app rules for this OS",
  ].filter((n): n is string => typeof n === "string");
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The import header's date. `createdAt` is copied verbatim from the file, so a
 *  hand-edited non-date falls back to "?" like its sibling fields, not "Invalid Date". */
function createdLabel(createdAt: string | undefined): string {
  const created = new Date(createdAt ?? "");
  return Number.isNaN(created.getTime()) ? "?" : created.toLocaleString();
}

/** Initial per-category selection for the two preview dialogs: every category
 *  present in the blob starts checked. "Present" is applyBlob's own arm test (a plain
 *  object), so a `null` section the file loader accepts never reads as importable. */
function presentSel(blob: SyncBlob): Record<SyncCategory, boolean> {
  return Object.fromEntries(
    ALL_CATEGORIES.map((c) => [c, isPlainObject(blob[c])]),
  ) as Record<SyncCategory, boolean>;
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

/** Cap on a backend or profile name quoted in a preview notice, so one entry reads the same in every line. */
const NOTICE_NAME_CAP = 60;

/** Cap on a server host shown where dictation or a key would go, so one host reads the same in every line. */
const HOST_CAP = 80;

/** The API-key half of the import / restore disclosure (`backendKeyFates`): keys the apply
 *  stores, keys nobody supplies, and a key this device keeps that now goes to another server. */
function KeyFateNotices({ fates, source }: { fates: ReturnType<typeof backendKeyFates>; source: "file" | "backup" }) {
  const what = source === "file" ? "This file" : "The server copy";
  return (
    <>
      {fates.carried && (
        <Notice tone="warn">{what} contains API keys — they&apos;ll be stored in the system keyring.</Notice>
      )}
      {fates.missing.length > 0 && (
        <Notice tone="warn">
          {fates.missing.map((b) => `“${backendDisplayName(b.name, NOTICE_NAME_CAP)}”`).join(", ")} need
          {fates.missing.length === 1 ? "s" : ""} an API key re-entered after{" "}
          {source === "file" ? "importing (not included in the file)" : "restoring (not in the server copy)"}.
        </Notice>
      )}
      {fates.moved.map(({ backend: b, to }) => {
        // An empty address (the sanitizer blanks a scheme this app does not speak) is the
        // "not configured" state: nothing is sent, so say that rather than "sent to an empty
        // address".
        if (!to) {
          return (
            <Notice key={`moved-${b.id}`} tone="warn">
              &ldquo;{backendDisplayName(b.name, NOTICE_NAME_CAP)}&rdquo; is left without a usable server address — its
              API key stays on this device and nothing is sent until you set one.
            </Notice>
          );
        }
        // The host through the IDENTITY helper, like `IncomingAddresses`: `serverUrl` is uncapped
        // on the import path, and the markerless display cut let a padded host show a
        // trusted-looking prefix of itself on the line that says where the key goes.
        const auth = authorityOf(to);
        return (
          <Notice key={`moved-${b.id}`} tone="warn">
            &ldquo;{backendDisplayName(b.name, NOTICE_NAME_CAP)}&rdquo; keeps this device&apos;s API key, which is then sent to{" "}
            <span className="font-mono font-semibold">
              {auth ? safeIdentityText(auth.host, HOST_CAP) : "an unreadable address"}
            </span>
            {auth?.hasUserinfo ? " (the address hides the real host behind a username)" : ""}.
          </Notice>
        );
      })}
    </>
  );
}

/** Per-category selection + hazard preview for a parsed import file. */
export function ImportPreview({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const dictating = useApp((st) => st.status !== "idle");
  // Normalize a pre-split file once for everything this dialog previews —
  // `applyImport` migrates again on apply (idempotent), so preview and apply
  // read the same shape.
  const categories = useMemo(() => migrateBlob(result.categories), [result.categories]);
  const present = (c: SyncCategory) => isPlainObject(categories[c]);
  const [sel, setSel] = useState<Record<SyncCategory, boolean>>(() => presentSel(categories));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What `applyBlob` would install, not the raw file list: `sanitizeBackends` dedupes ids, drops
  // reserved ones, blanks unusable addresses and caps the count, so the row count and the address
  // list below disclose the same entries the key notices are judged on.
  const installBackends = useMemo(
    () => (categories.backends ? sanitizeBackends(categories.backends.list) : []),
    [categories],
  );
  // Likewise the profiles: `sanitizeProfiles` dedupes ids and drops malformed entries, so the raw
  // file length would over-count what replaces this device's profiles.
  const installProfiles = useMemo(
    () => (categories.profiles ? sanitizeProfiles(categories.profiles.list) : []),
    [categories],
  );
  // And this OS's app rules: `sanitizeAppRules` drops malformed entries and duplicate app ids. A
  // file's other-OS bucket never lands: the apply installs only this OS's rules, and a later push
  // takes the other bucket from the sync snapshot, not from the file.
  const installAppRules = useMemo(
    () => (isPlainObject(categories.appRules) ? sanitizeAppRules(categories.appRules[MY_BUCKET]) : []),
    [categories],
  );

  const otherOs = isPlainObject(categories.appRules) ? arr(categories.appRules[OTHER_BUCKET]).length : 0;
  const counts: Partial<Record<SyncCategory, string>> = {
    backends: categories.backends ? `${installBackends.length}` : undefined,
    profiles: categories.profiles ? `${installProfiles.length}` : undefined,
    appRules: categories.appRules
      ? `${installAppRules.length} this OS${otherOs ? ` · ${otherOs} other OS (not imported)` : ""}`
      : undefined,
  };

  // Predict the apply's hotkey-collision fix in the WOULD-BE state (imported profiles and/or
  // quick-add chord over the current ones). It walks the SANITIZED profiles: this consent dialog
  // renders before `applyBlob` sanitizes, with no error boundary, and `arr()` coerces only the
  // container, so a raw element (a profile missing `hotkey`, a numeric code) would throw and
  // unmount the very dialog that lets the user reject the blob. The sanitizer also bounds chord
  // length (`isCodeList`), which keeps `isStrictSubset`'s O(k·m) scan from freezing the webview on
  // a hand-authored file.
  const st = useApp.getState();
  const wouldProfiles = sel.profiles && categories.profiles ? installProfiles : st.profiles;
  // Post-migration the chord lives in the dictionary category (see `predictChordFix` for how an
  // absent or malformed one resolves).
  const chordFix = predictChordFix(
    wouldProfiles,
    sel.dictionary ? categories.dictionary?.quickAddHotkey : undefined,
    st.settings.general.quickAddHotkey,
    sel.profiles && isPlainObject(categories.profiles),
  );

  // Judged on what the apply installs (sanitized, as above). Import never deletes a stored key
  // and the apply re-derives `hasApiKey` from the keyring by id, so a same-id backend this
  // device holds a key for keeps it: nothing to re-enter — but if the file moves it to another
  // server, that key goes there, whatever the file's own `hasApiKey` says (`backendKeyFates`).
  const keyFates = backendKeyFates(sel.backends ? installBackends : [], result.secrets, st.backends, st.settings);

  const replaced = replacedNames(sel, categories, st);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const applied = await applyImport(sel, result);
      if (!applied) {
        setError("Settings could not be applied right now — try again in a moment.");
        return;
      }
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
    <Modal onClose={applying ? () => {} : onClose}>
      <div className="text-[15px] font-semibold text-text">Import settings</div>
      <div className="mt-1 text-[12.5px] text-dim">
        From {peerName(result.hostname) || "unknown device"} · {safeText(result.platform, 40) || "?"} · v
        {safeText(result.appVersion, 30) || "?"} · {createdLabel(result.createdAt)}
      </div>

      <div className="mt-4">
        {CATEGORY_META.map(({ key, title, desc: metaDesc }, i) => {
          // The shared appRules line ("other-OS rules pass through untouched") holds for a
          // server restore, where the server copy keeps the other bucket — but an import installs
          // only this OS's bucket, which the "(N other OS (not imported))" count says next to it.
          const desc =
            key === "appRules"
              ? `Per-app rules for this OS (${MY_BUCKET}); a file's other-OS rules are not imported.`
              : metaDesc;
          return (
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
          );
        })}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <Notice>
          Never imported: the microphone, &ldquo;{SETTING.pressEnterAfter.label}&rdquo;, this
          device&apos;s audio and log folders, and the Linux input backend. Other machine-specific
          settings in the file (chip position, paste shortcuts, server addresses) come in with their
          category.
        </Notice>
        {/* Every present category starts checked and `applyBlob` REPLACES rather than merges: a file
            carrying `"backends": {"list": []}` shows a pre-checked "(0)" row with no address block and
            no missing-key warning, yet deletes every configured backend, nulls every profile's
            backendId and drops the keyring association. Only this notice says the selection
            replaces rather than adds. */}
        {replaced.length > 0 && (
          <Notice tone="warn">
            Selected categories replace what&apos;s on this device — your current{" "}
            {joinNames(replaced)} are overwritten.
          </Notice>
        )}
        {sel.backends && categories.backends && (
          <IncomingAddresses list={categories.backends.list} />
        )}
        <KeyFateNotices fates={keyFates} source="file" />
        {/* These interpolate a backend name straight out of the imported file: sanitized so a bidi
            override cannot rewrite the sentence the user reads to decide whether to import. */}
        {result.warnings.slice(0, 20).map((w) => (
          <Notice key={w} tone="warn">
            {safeDisplayText(w, 300)}
          </Notice>
        ))}
        <ChordFixNotices fix={chordFix} source="file" />
        {dictating && <Notice tone="warn">Stop dictation before importing.</Notice>}
        {error && <Notice tone="warn">{error}</Notice>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={applying}>
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
  keyFor,
}: {
  state: SyncRemoteState;
  onCancel: () => void;
  onApplied: () => void | Promise<void>;
  /** The server address `onApplied` writes a just-typed API key for (the Backends connect-first
   *  flow): the restored backend it lands on is not one that "needs an API key re-entered". */
  keyFor?: string;
}) {
  const dictating = useApp((st) => st.status !== "idle");
  // Normalize a pre-split server blob for the preview AND the apply below.
  const blob = useMemo(() => migrateBlob((state.blob ?? {}) as SyncBlob), [state.blob]);
  const present = (c: SyncCategory) => isPlainObject(blob[c]);
  const [sel, setSel] = useState<Record<SyncCategory, boolean>>(() => presentSel(blob));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The list applyBlob installs, as ImportPreview counts and lists it.
  const installBackends = useMemo(
    () => (blob.backends ? sanitizeBackends(blob.backends.list) : []),
    [blob],
  );
  const installProfiles = useMemo(
    () => (blob.profiles ? sanitizeProfiles(blob.profiles.list) : []),
    [blob],
  );
  const installAppRules = useMemo(
    () => (isPlainObject(blob.appRules) ? sanitizeAppRules(blob.appRules[MY_BUCKET]) : []),
    [blob],
  );
  const counts: Partial<Record<SyncCategory, string>> = {
    backends: blob.backends ? `${installBackends.length}` : undefined,
    profiles: blob.profiles ? `${installProfiles.length}` : undefined,
    appRules: blob.appRules
      ? `${installAppRules.length} this OS · ${arr(blob.appRules[OTHER_BUCKET]).length} other OS`
      : undefined,
  };

  // Same would-be-state hazard previews as ImportPreview (hotkey collisions, replaced data — so on
  // an empty app the restore is warning-free), on the sanitized lists for the same reason: this
  // dialog renders before `applyBlob` sanitizes and `conflicts()` walks the elements in a render body.
  const st = useApp.getState();
  const wouldProfiles = sel.profiles && blob.profiles ? installProfiles : st.profiles;
  // Post-migration the chord lives in the dictionary category, as in ImportPreview.
  const chordFix = predictChordFix(
    wouldProfiles,
    sel.dictionary ? blob.dictionary?.quickAddHotkey : undefined,
    st.settings.general.quickAddHotkey,
    sel.profiles && isPlainObject(blob.profiles),
  );
  const replaced = replacedNames(sel, blob, st);
  // No security review stands in front of this direct `applyBlob`, so this is the only place a
  // moved key or the account's stored keys replacing this device's is disclosed.
  const fates = backendKeyFates(sel.backends ? installBackends : [], blob.backends?.secrets, st.backends, st.settings);
  const keyFates = fatesAfterSuppliedKey(fates, sel.backends ? installBackends : [], keyFor);

  const apply = async () => {
    // Re-check right before applying: applyBlob refuses while dictating, and
    // saying why up front beats the generic "nothing was restored" below. The
    // disabled button covers the steady state; this covers a session starting
    // between render and click.
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
      // The gate bypass opens the folder gates — keep this machine's folders.
      const ok = await applyBlob(stripMachineFolders(blob), sel, 2, { ignoreGates: true });
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

  const from = peerName(state.device);
  return (
    <Modal onClose={applying ? () => {} : onCancel}>
      <div className="text-[15px] font-semibold text-text">Restore from server</div>
      <div className="mt-1 text-[12.5px] text-dim">
        Last synced{from ? ` from ${from}` : ""}
        {state.updated_ts ? ` · ${relTime(state.updated_ts * 1000)}` : ""}
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
        <Notice>
          Never restored: the microphone, &ldquo;{SETTING.pressEnterAfter.label}&rdquo;, this
          device&apos;s audio and log folders, and the Linux input backend. Other machine-specific
          settings in the server copy (chip position, paste shortcuts, server addresses) come in
          with their category.
        </Notice>
        {replaced.length > 0 && (
          <Notice tone="warn">
            Selected categories replace what&apos;s on this device — your current{" "}
            {joinNames(replaced)} are overwritten.
          </Notice>
        )}
        {sel.backends && blob.backends && <IncomingAddresses list={blob.backends.list} />}
        <KeyFateNotices fates={keyFates} source="backup" />
        <Notice tone="ok">
          After restoring, settings sync turns on for this device against this server.
        </Notice>
        <ChordFixNotices fix={chordFix} source="backup" />
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

/** Maximum change rows shown in the SecurityReviewDialog. */
const MAX_REVIEW_ROWS = 50;
/** Alias for `safeDisplayText` — every string this screen renders through it came from an untrusted blob or file. */
const safeText = safeDisplayText;

/** A peer device's name as this screen shows it, or "" when it would read as this device's own
 *  arm label (the caller then renders its neutral fallback) — `peerDeviceName`, which holds the
 *  fold and the reasoning, against this screen's arm label. */
const peerName = (device: string | null | undefined): string => peerDeviceName(device, LOCAL_ARM_LABEL);

/** The label for the "adopt the other device's value" arm of a conflict choice: the peer's name
 *  (`peerName` — never one that collides with "This device", invisible and joiner characters
 *  included), else the neutral wording. */
const remoteArmLabel = (device: string | null): string => peerName(device) || "Other device";

const LOCAL_ARM_LABEL = "This device";


/** The addresses an incoming blob would install, shown BEFORE it is applied by Restore from
 *  server, Import preview and Onboarding's restore — they apply the same attacker-authored
 *  `backends.list` through `applyBlob` with no `securityChanges` review in front. A URL's real
 *  authority is whatever follows the last `@`, so `http://localhost:8000@evil.tld/v1` reads as
 *  loopback until it is parsed. */
export function IncomingAddresses({ list }: { list: unknown }) {
  // Takes the RAW inbound list and derives the rows itself, so every caller lists the same thing:
  // what `applyBlob` would install (`sanitizeBackends` — run here BEFORE consent, since a `[null]`
  // element or a non-string address would throw in this render body and unmount the dialog that
  // lets the user refuse the blob), at the address this device would CONNECT to (a surviving id's
  // "Address on this device" override wins over the canonical one).
  const settings = useApp.getState().settings;
  const all = sanitizeBackends(list).map((b) => ({ ...b, serverUrl: effectiveServerUrl(b, settings) }));
  const backends = all.slice(0, MAX_SHOWN_ADDRESSES);
  if (backends.length === 0) return null;
  return (
    <Notice>
      <div className="font-medium">Dictation would be sent to:</div>
      <ul className="mt-1 space-y-0.5">
        {backends.map((b, i) => {
          const url = b.serverUrl;
          // An empty address is the sanitizer's "not configured" state (it blanks a scheme this
          // app does not speak): nothing is sent, as the moved-key notice says for the same entry.
          // "unreadable address" stays for a non-empty string `authorityOf` rejects.
          if (url.trim() === "") {
            return (
              <li key={`${b.id}-${i}`} className="font-mono text-[12px]">
                {backendDisplayName(b.name, NOTICE_NAME_CAP)} →{" "}
                <span className="text-dim">no usable address — nothing is sent until one is set</span>
              </li>
            );
          }
          const auth = authorityOf(url);
          const warn = insecureUrlWarning(url);
          return (
            <li key={`${b.id}-${i}`} className="font-mono text-[12px]" title={safeText(url, 300)}>
              {backendDisplayName(b.name, NOTICE_NAME_CAP)} →{" "}
              {/* The host through the IDENTITY helper, which marks a truncation: `serverUrl` has no
                  length cap on the sync/import path, and the plain filter's markerless 80-code-point
                  cut would show a padded hostname (`sync.internal.corp.example.com.<padding>.evil.tld`)
                  as a trusted-looking PREFIX of itself on the dialog that discloses where dictation goes. */}
              <span className="font-semibold">{auth ? safeIdentityText(auth.host, HOST_CAP) : "unreadable address"}</span>
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

/** The restore offers' disclosure chips (Onboarding and the Backends restore offer): the
 *  categories a pulled blob carries, by display name. Same predicate as the offers' gates
 *  (`restorableCategories`), so the chips never name a category the restore skips. */
export function SyncedCategoryChips({ blob }: { blob: SyncBlob | null | undefined }) {
  const present = useMemo(() => restorableCategories(blob), [blob]);
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {present.map((c) => (
        <span key={c} className="rounded-pill border border-line-strong px-2.5 py-0.5 font-mono text-[10px] text-dim">
          {categoryTitle(c)}
        </span>
      ))}
    </div>
  );
}

const MAX_SHOWN_ADDRESSES = 20;
/** Bound on the list fed to the hazard PREVIEWS. `conflicts()` is an O(n²) pair scan that also
 *  pushes O(n²) result objects, and it runs in the render body — before the user has consented to
 *  anything. Truncating a predictive warning drops no data; the applied list is untouched. */
const MAX_PREVIEW_PEERS = 500;

/** What `applyBlob`'s collision pass would do to the would-be bindings: which profiles it
 *  switches off (by name), and whether it drops an INCOMING quick-add chord that differs from this
 *  device's (`qaKept`).
 *
 *  `incomingQa` is the blob's `dictionary.quickAddHotkey` when that category is applied, else
 *  `undefined`. An absent or malformed chord keeps this device's chord, as `applyBlob` does.
 *  `qaKept` needs a chord that actually arrives and differs: the collision pass also "rejects"
 *  this device's OWN chord when it is the fallback, and the apply then just re-pins it. */
export function predictChordFix(
  wouldProfiles: Profile[],
  incomingQa: unknown,
  localQa: string[],
  profilesAreInbound: boolean,
): { switchedOff: string[]; qaKept: boolean } {
  const inbound = isCodeList(incomingQa);
  const wouldQa = inbound ? incomingQa : localQa;
  const qaDiffers = inbound && !sameCodes(canonicalizeCodes(incomingQa), canonicalizeCodes(localQa));
  const before = wouldProfiles.slice(0, MAX_PREVIEW_PEERS);
  // evdevEnabled is machine-local (never synced), so the apply decides side-collapse on this.
  const evdevLive = useApp.getState().settings.general.evdevEnabled === true && evdevPermittedNow();
  const resolved = disableConflictingProfiles(before, wouldQa, profilesAreInbound, evdevLive, undefined, localQa);
  return {
    switchedOff: resolved.profiles
      .filter((p, i) => p.enabled === false && before[i]?.enabled !== false)
      .map((p) => p.name),
    qaKept: qaDiffers && resolved.rejectQuickAddHotkey,
  };
}

const MAX_SHOWN_SWITCHED_OFF = 3;
export function ChordFixNotices({ fix, source }: { fix: ReturnType<typeof predictChordFix>; source: "file" | "backup" }) {
  const names = fix.switchedOff.slice(0, MAX_SHOWN_SWITCHED_OFF).map((n) => `“${profileDisplayName(n, NOTICE_NAME_CAP)}”`);
  const more = fix.switchedOff.length - names.length;
  if (more > 0) names.push(`${more} more`);
  return (
    <>
      {fix.switchedOff.length > 0 && (
        <Notice tone="warn">
          Some shortcuts collide — {joinNames(names)} will be switched off. Give{" "}
          {fix.switchedOff.length === 1 ? "it" : "each"} a free shortcut and re-enable it in Profiles.
        </Notice>
      )}
      {fix.qaKept && (
        <Notice tone="warn">
          The {source}&apos;s quick-add shortcut collides with a profile on this device — this device
          keeps its own quick-add shortcut.
        </Notice>
      )}
    </>
  );
}

/** A pulled update that would repoint a backend or replace a stored key, held for approval. */
function SecurityReviewDialog() {
  // The getter is not reactive: re-read it on every prompt change (see `syncPromptSeq`).
  useApp((st) => st.syncPromptSeq);
  const pending = getPendingReview();
  const dictating = useApp((st) => st.status !== "idle");
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  const LABELS: Record<SecurityChange["kind"], string> = {
    "new-backend": "New server added",
    "server-url": "Server address changed",
    "api-key": "API key changed",
    "save-recordings": "Saving every dictation would be turned on",
    "history-retention": "File transcriptions would start being deleted",
    "dictation-retention": "Dictations would start being deleted",
    "dictation-history": "Dictation history would be turned off and wiped",
    "report-target-app": "Reporting the app you dictate into would be turned on",
    "typed-text": "Text typed into your apps would change",
  };
  const label = (c: SecurityChange) => LABELS[c.kind];
  const shown = pending.changes.slice(0, MAX_REVIEW_ROWS);
  const hidden = pending.changes.length - shown.length;
  // Only a new server or a moved address carries a `url`: a retention, history or key row
  // sends nothing anywhere new, so the footer must not warn about "the new address" for it.
  const repoints = pending.changes.some((c) => !!c.url);
  return (
    <Modal onClose={busy ? () => {} : rejectPendingReview}>
      <div className="text-[15px] font-semibold text-text">Review this update</div>
      <div className="mt-1 text-[12.5px] leading-snug text-dim">
        {peerName(pending.device) || "Another device"} sent changes that affect where your
        dictation is sent, which key is used, what it types, or what is kept on this device.{" "}
        {/* The raise's held-back apply is refused while dictating: then nothing landed. */}
        {pending.restApplied
          ? "Everything else was applied already — only these are waiting."
          : "Nothing from this update has been applied yet — all of it waits for your decision."}
      </div>
      {pending.relisted && (
        <Notice tone="warn" className="mt-3">
          This device or your sync switches changed since this was listed — review the updated
          list before applying.
        </Notice>
      )}
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
                  Would connect to <span className="font-mono font-semibold">{safeIdentityText(auth.host, HOST_CAP)}</span>
                </div>
              )}
              <div className="mt-0.5 font-mono text-[11px] break-all text-dim">
                {/* `safeIdentityText`: an `api-key` row has no `url`, so this NAME is its only
                    identity while it decides whether a plaintext key reaches the OS keyring — and
                    names are uncapped (a rename raises no review), so a markerless cut could hide
                    a padded suffix. `consentDetailCap`: a typed-text row shows the whole value. */}
                {c.backend ? `${safeIdentityText(c.backend, 80)} · ` : ""}
                {safeIdentityText(c.detail, consentDetailCap(c.kind))}
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
          <div className="text-[12px] text-faint">…and {plural(hidden, "more change", "more changes")} not shown.</div>
        )}
      </div>
      <Notice className="mt-3">
        If you did not change this yourself on another device, reject it
        {repoints ? " — your microphone audio and everything you dictate would go to the new address." : "."}
      </Notice>
      {dictating && (
        <Notice className="mt-3">Stop dictation before applying — nothing is queued while a session runs.</Notice>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={rejectPendingReview}>
          Reject
        </Button>
        {/* Before approve takes the review (and this modal) down, it waits for the engine lock and
            composes this device, so `busy` locks both buttons for that wait. */}
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
  // Same as SecurityReviewDialog: re-read on every prompt change, so a closed or widened
  // conflict never leaves the old body (and its categories) on screen.
  useApp((st) => st.syncPromptSeq);
  // The picks live here, not in the body: resolve nulls the pending conflict before it awaits
  // the apply, so the body unmounts; a refused apply restores the SAME conflict (same id) and a
  // fresh body would show every row back on "local" — the next Apply then keeps this device's
  // settings without asking. Tagged with the conflict id and its remote key: a NEW remote still
  // starts empty (a retained "remote" pick would silently hand the peer content the user never
  // chose), while a re-raise of the same remote over a changed category list (the resolve's
  // widening re-merge) keeps the picks for the categories it still shows.
  const [picks, setPicks] = useState<{ id: number; remoteKey: number; p: Record<string, "local" | "remote"> }>({
    id: -1,
    remoteKey: -1,
    p: {},
  });
  const pending = getPendingConflict();
  if (!pending) return null;
  const carried = (s: typeof picks): Record<string, "local" | "remote"> =>
    s.id === pending.id
      ? s.p
      : s.remoteKey === pending.remoteKey
        ? Object.fromEntries(Object.entries(s.p).filter(([c]) => (pending.categories as string[]).includes(c)))
        : {};
  // Keyed on the conflict's identity so a new conflict remounts the body with busy cleared (a
  // restored one shares the id but remounts anyway: the body unmounted while it was nulled).
  return (
    <ConflictDialogBody
      key={pending.id}
      pending={pending}
      picks={carried(picks)}
      onPick={(c, v) =>
        setPicks((s) => ({ id: pending.id, remoteKey: pending.remoteKey, p: { ...carried(s), [c]: v } }))
      }
    />
  );
}

function ConflictDialogBody({
  pending,
  picks,
  onPick,
}: {
  pending: NonNullable<ReturnType<typeof getPendingConflict>>;
  picks: Record<string, "local" | "remote">;
  onPick: (category: string, value: "local" | "remote") => void;
}) {
  // resolveSyncConflicts returns silently while a session runs (same rule as the review's
  // approve) — the button says so instead of doing nothing.
  const dictating = useApp((st) => st.status !== "idle");
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={busy ? () => {} : dismissSyncConflict}>
      <div className="text-[15px] font-semibold text-text">Sync conflict</div>
      <div className="mt-1 text-[12.5px] leading-snug text-dim">
        These settings changed both here and on {peerName(pending.remoteDevice) || "another device"}. Pick which
        version to keep — the rest of this update is applied together with your picks.
      </div>
      <div className="mt-4">
        {pending.categories.map((c, i) => {
          const title = categoryTitle(c);
          return (
            <SettingRow key={c} title={title} last={i === pending.categories.length - 1}>
              <Segmented
                ariaLabel={`Resolve ${title}`}
                value={picks[c] ?? "local"}
                onChange={(v) => onPick(c, v)}
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
        <Button variant="ghost" disabled={busy} onClick={dismissSyncConflict}>
          Later
        </Button>
        {/* Resolve nulls the pending conflict before its await, so no Later/backdrop click can
            land in this dialog meanwhile. */}
        <Button
          disabled={busy || dictating}
          onClick={() => {
            const chosen = Object.fromEntries(pending.categories.map((c) => [c, picks[c] ?? "local"]));
            setBusy(true);
            // Bound to the conflict shown: picks never apply to one re-raised over other categories.
            void resolveSyncConflicts(chosen, pending.id).finally(() => setBusy(false));
          }}
        >
          {busy ? "Applying…" : "Apply"}
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
  const lastSyncFrom = peerName(lastSyncDevice);
  // "Last synced …" is relative to now and nothing else re-renders this tab between syncs (no
  // periodic pull). Hidden (closed to the tray): skip the redraw, and catch up at once on show.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastSyncedAt) return;
    return everyWhileVisible(30_000, () => setTick((n) => n + 1));
  }, [lastSyncedAt]);

  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "busy" | "done" | "nokeys" | "error">("idle");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const syncBackend = backends.find((b) => b.id === sync.backendId) ?? null;
  const busy = syncStatus === "syncing";
  // "Really delete" deletes the copy on the CURRENT sync server: an arm made for another server,
  // or before sync was switched off, must not survive to delete this one (or reset sync state
  // under a row that reads disabled).
  const canDelete = sync.enabled && !!syncBackend;
  useEffect(() => setDeleteArmed(false), [sync.backendId, sync.enabled]);

  const doExport = async () => {
    try {
      // Local date: toISOString() is UTC, so near midnight it would name yesterday's or tomorrow's file.
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const path = await pickSavePath(`faster-whisper-settings-${stamp}.json`);
      if (!path) return;
      setExportState("busy");
      const { keysMissing } = await exportToFile(path, includeSecrets);
      // A keyless backup the user asked to carry keys stays flagged (no auto-reset):
      // the gap otherwise surfaces only when restoring.
      if (keysMissing) {
        setExportState("nokeys");
        return;
      }
      setExportState("done");
      // Only clear our own "done": a later export's "nokeys" must outlive this timer.
      setTimeout(() => setExportState((st) => (st === "done" ? "idle" : st)), 2500);
    } catch (e) {
      console.error("export failed", e);
      setExportState("error");
    }
  };

  const doImport = async () => {
    setImportError(null);
    const r = await pickAndImportSettings();
    if (!r) return;
    if ("error" in r) setImportError(r.error);
    else setImportResult(r.result);
  };

  const doDeleteServerCopy = async () => {
    if (!canDelete || !syncBackend) return;
    setDeleteArmed(false);
    try {
      const r = await syncDelete({
        serverUrl: effectiveServerUrl(syncBackend, useApp.getState().settings),
        backendId: syncBackend.id,
      });
      useApp.getState().setSyncRuntime(deleteAnswerRuntime(r));
      if (!r.ok) return;
      await resetSyncState();
    } catch (e) {
      console.error("delete server copy failed", e);
      useApp.getState().setSyncRuntime({ syncStatus: "error", syncError: safeDisplayText(String(e), 200) });
    }
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
        {exportState === "nokeys" && (
          <div className="pb-4">
            <Notice tone="warn">
              Exported — but the API keys could not be read from the system keyring and are not in
              the file.
            </Notice>
          </div>
        )}
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
            options={syncServerOptions(backends, sync.backendId, sync.enabled)}
          />
        </SettingRow>
        {sync.enabled && !syncBackend && backends.length > 0 && (
          <div className="pb-3">
            <Notice tone="warn">No sync server chosen — pick one above.</Notice>
          </div>
        )}
        {sync.enabled && syncBackend && !syncBackend.hasApiKey && (
          <div className="pb-3">
            <Notice tone="warn">
              “{backendLabel(backends, syncBackend)}” has no API key. On an open-mode server every keyless device shares one
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
          <span className="font-semibold text-dim">Never synced:</span> microphone,{" "}
          &ldquo;{SETTING.pressEnterAfter.label}&rdquo;, this device's audio and log folders (unless
          enabled above), the Linux input backend, and these sync settings themselves.
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
                ? `Last synced ${relTime(lastSyncedAt)}${lastSyncFrom ? ` · from ${lastSyncFrom}` : ""}`
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
          disabled={!canDelete}
          last
        >
          {deleteArmed && canDelete ? (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setDeleteArmed(false)}>
                Keep
              </Button>
              <Button variant="danger" onClick={() => void doDeleteServerCopy()}>
                Really delete
              </Button>
            </div>
          ) : (
            <Button variant="ghost" disabled={!canDelete} onClick={() => setDeleteArmed(true)}>
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
