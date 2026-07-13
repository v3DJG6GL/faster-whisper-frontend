// Settings → Sync: file backup (export/import with per-category preview) and
// cross-device sync through a faster-whisper-backend (enable + server picker +
// per-device category toggles + status/manual controls + conflict dialog).
// The engine lives in lib/sync.ts; this screen only drives it.

import { useState, type ReactNode } from "react";
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
import { importSettingsFile, pickImportFile, pickSavePath, syncDelete } from "@/lib/api";
import { applyImport, exportToFile } from "@/lib/exportImport";
import {
  applyBlob,
  dismissSyncConflict,
  getPendingConflict,
  pullNow,
  pushNow,
  resetSyncState,
  resolveSyncConflicts,
} from "@/lib/sync";
import { effectiveServerUrl } from "@/lib/backends";
import { conflicts as chordConflicts, quickAddPeer } from "@/lib/conflicts";
import { IS_WINDOWS } from "@/lib/platform";
import type { SyncCategory } from "@/lib/types";
import type { ImportResult, SyncRemoteState } from "@/lib/syncTypes";

const MY_BUCKET = IS_WINDOWS ? ("windows" as const) : ("linux" as const);
const OTHER_BUCKET = IS_WINDOWS ? ("linux" as const) : ("windows" as const);

const CATEGORY_META: { key: SyncCategory; title: string; desc: string }[] = [
  { key: "general", title: "General", desc: "Theme, insertion, sounds, quick-add shortcut." },
  { key: "recording", title: "Recording & Chip", desc: "Chip styling, visibility and timing settings." },
  { key: "backends", title: "Backends", desc: "Server connections incl. API keys (stored on your own server)." },
  { key: "profiles", title: "Profiles", desc: "Dictation profiles incl. their hotkeys." },
  { key: "appRules", title: "App rules", desc: `Per-app rules for this OS (${MY_BUCKET}); other-OS rules pass through untouched.` },
];

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
  const dictating = useApp((st) => st.status !== "idle");
  const present = (c: SyncCategory) => result.categories[c] !== undefined;
  const [sel, setSel] = useState<Record<SyncCategory, boolean>>({
    general: present("general"),
    recording: present("recording"),
    backends: present("backends"),
    profiles: present("profiles"),
    appRules: present("appRules"),
  });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts: Partial<Record<SyncCategory, string>> = {
    backends: result.categories.backends ? `${result.categories.backends.list.length}` : undefined,
    profiles: result.categories.profiles ? `${result.categories.profiles.list.length}` : undefined,
    appRules: result.categories.appRules
      ? `${(result.categories.appRules[MY_BUCKET] ?? []).length} this OS · ${(result.categories.appRules[OTHER_BUCKET] ?? []).length} other OS`
      : undefined,
  };

  // Predict hotkey conflicts in the WOULD-BE state (imported profiles and/or
  // quick-add chord over the current ones) so the user isn't surprised by the
  // save-freeze banner after applying. Conservative L/R collapse off-Windows —
  // mirrors the persistence save-gate's no-low-level-backend assumption.
  const st = useApp.getState();
  const wouldProfiles =
    sel.profiles && result.categories.profiles ? result.categories.profiles.list : st.profiles;
  const wouldQa =
    sel.general && result.categories.general
      ? result.categories.general.quickAddHotkey
      : st.settings.general.quickAddHotkey;
  const peers = wouldQa.length > 0 ? [...wouldProfiles, quickAddPeer(wouldQa)] : wouldProfiles;
  const predictedConflicts =
    chordConflicts(peers, !IS_WINDOWS && !evdevEnabled).length > 0;

  const missingKeys =
    sel.backends && result.categories.backends
      ? result.categories.backends.list.filter((b) => b.hasApiKey && !result.secrets[b.id])
      : [];

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
        From {result.hostname || "unknown device"} · {result.platform || "?"} · v
        {result.appVersion || "?"} · {result.createdAt ? new Date(result.createdAt).toLocaleString() : "?"}
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
          Machine-specific settings (microphone, recordings folder, open at login, evdev) are never
          imported.
        </Notice>
        {result.hasSecrets && sel.backends && (
          <Notice tone="warn">This file contains API keys — they'll be stored in the system keyring.</Notice>
        )}
        {missingKeys.length > 0 && (
          <Notice tone="warn">
            {missingKeys.map((b) => `“${b.name}”`).join(", ")} need{missingKeys.length === 1 ? "s" : ""} an
            API key re-entered after importing (not included in the file).
          </Notice>
        )}
        {result.warnings.map((w) => (
          <Notice key={w} tone="warn">
            {w}
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
  const dictating = useApp((st) => st.status !== "idle");
  const blob = state.blob ?? {};
  const present = (c: SyncCategory) => blob[c] !== undefined;
  const [sel, setSel] = useState<Record<SyncCategory, boolean>>({
    general: present("general"),
    recording: present("recording"),
    backends: present("backends"),
    profiles: present("profiles"),
    appRules: present("appRules"),
  });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts: Partial<Record<SyncCategory, string>> = {
    backends: blob.backends ? `${blob.backends.list.length}` : undefined,
    profiles: blob.profiles ? `${blob.profiles.list.length}` : undefined,
    appRules: blob.appRules
      ? `${(blob.appRules[MY_BUCKET] ?? []).length} this OS · ${(blob.appRules[OTHER_BUCKET] ?? []).length} other OS`
      : undefined,
  };

  // Same would-be-state hazard previews as ImportPreview: predicted hotkey
  // collisions, and (new here) whether a selected category overwrites data the
  // device already has — on an empty app the restore is warning-free.
  const st = useApp.getState();
  const wouldProfiles = sel.profiles && blob.profiles ? blob.profiles.list : st.profiles;
  const wouldQa =
    sel.general && blob.general ? blob.general.quickAddHotkey : st.settings.general.quickAddHotkey;
  const peers = wouldQa.length > 0 ? [...wouldProfiles, quickAddPeer(wouldQa)] : wouldProfiles;
  const predictedConflicts = chordConflicts(peers, !IS_WINDOWS && !evdevEnabled).length > 0;
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
      await applyBlob(blob, sel);
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
        Last synced{state.device ? ` from ${state.device}` : ""}
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

/** Keep Local / Keep Remote per genuinely-conflicting category. */
function ConflictDialog() {
  const pending = getPendingConflict();
  const [picks, setPicks] = useState<Record<string, "local" | "remote">>({});
  if (!pending) return null;
  return (
    <Modal onClose={dismissSyncConflict}>
      <div className="text-[15px] font-semibold text-text">Sync conflict</div>
      <div className="mt-1 text-[12.5px] leading-snug text-dim">
        These settings changed both here and on {pending.remoteDevice || "another device"}. Pick which
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
                  { value: "local", label: "This device" },
                  { value: "remote", label: pending.remoteDevice || "Other device" },
                ]}
              />
            </SettingRow>
          );
        })}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={dismissSyncConflict}>
          Later
        </Button>
        <Button
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
      setImportError(String(e));
    }
  };

  const doDeleteServerCopy = async () => {
    if (!syncBackend) return;
    setDeleteArmed(false);
    await syncDelete({
      serverUrl: effectiveServerUrl(syncBackend, useApp.getState().settings),
      backendId: syncBackend.id,
    });
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
            options={backends.map((b) => ({
              value: b.id,
              label: b.hasApiKey ? b.name : `${b.name} (no API key)`,
            }))}
          />
        </SettingRow>
        {sync.enabled && syncBackend && !syncBackend.hasApiKey && (
          <div className="pb-3">
            <Notice tone="warn">
              “{syncBackend.name}” has no API key. On an open-mode server every keyless device shares one
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
        {CATEGORY_META.map(({ key, title, desc }) => (
          <SettingRow key={key} title={title} desc={desc} disabled={!sync.enabled}>
            <Toggle
              checked={sync.categories[key]}
              disabled={!sync.enabled}
              onChange={(v) => updateSync({ categories: { ...sync.categories, [key]: v } })}
              ariaLabel={`Sync ${title}`}
            />
          </SettingRow>
        ))}

        <div className="flex items-center gap-3 py-4">
          <StatusDot
            tone={syncStatus === "error" ? "warn" : syncStatus === "ok" ? "ok" : busy ? "accent" : "idle"}
            pulse={busy}
          />
          <div className="min-w-0 flex-1 text-[12.5px] text-dim">
            {busy
              ? "Syncing…"
              : lastSyncedAt
                ? `Last synced ${relTime(lastSyncedAt)}${lastSyncDevice ? ` · from ${lastSyncDevice}` : ""}`
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
      <ConflictDialog />
    </>
  );
}
