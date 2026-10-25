// Settings export/import to a file. Reuses the sync engine's extract +
// apply core so a file round-trip and a server sync agree on exactly what
// travels (same categories, same machine-local exclusions).

import { CONFIG_VERSION, useApp } from "../store";
import { appVersion, exportSettingsFile, syncDeviceInfo } from "../api";
import { applyBlob, categorySelection, composeBlob, migrateBlob } from "./sync";
import type { SyncCategory } from "../types";
import type { ExportEnvelope, ImportResult, SyncBlob } from "./syncTypes";

/** Compose the export envelope from the CURRENT store state. All categories
 *  are always included (an export is a backup — the choosing happens on
 *  import); `includeSecrets` gates the plaintext API keys (default off). The
 *  sub-toggle set is fixed to the export contract, independent of this
 *  device's sync sub-toggles: chords travel (a backup without them restores
 *  chord-less profiles), the machine-specific folders (recordings, audio base,
 *  logs) never do. */
export async function buildEnvelope(includeSecrets: boolean): Promise<ExportEnvelope> {
  const s = useApp.getState();
  const allOn = categorySelection(true);
  const blob = await composeBlob(
    { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
    allOn,
    undefined,
    // The Transcribe picks are portable: the backends list they name travels in
    // the same envelope. An unreadable keyring keeps the server list, keyless
    // (exportToFile reports it as keysMissing).
    {
      includeSecrets,
      sub: { recordingsDir: false, profileHotkeys: true, quickAddHotkey: true, transcribePicks: true },
      onUnreadKeys: "keyless",
    },
  );
  const device = await syncDeviceInfo();
  return {
    formatVersion: 1,
    configVersion: CONFIG_VERSION,
    appVersion: await appVersion(),
    createdAt: new Date().toISOString(),
    hostname: device?.hostname ?? "",
    platform: device?.platform ?? "",
    categories: blob,
  };
}

/** Build + write the export to `path` (picked via the save dialog).
 *  `keysMissing`: the user asked for the API keys, the exported list had keyed
 *  backends, yet the file has none — composeBlob degrades a locked or partial keyring
 *  read to the keyless list (all or nothing; the servers stay in the file), so the
 *  caller must say so instead of reporting a plain success for a backup that silently
 *  lacks its keys. */
export async function exportToFile(
  path: string,
  includeSecrets: boolean,
): Promise<{ keysMissing: boolean }> {
  const envelope = await buildEnvelope(includeSecrets);
  await exportSettingsFile(path, envelope);
  // Judged on the list the file holds, not the live store after the keyring read and the write (a
  // focus pull landing meanwhile can add or drop a key) nor the store's flags at the start:
  // composeBlob writes a flag whose key the keyring reports absent as keyless, and that file
  // lacks nothing.
  const list = envelope.categories.backends?.list;
  const hadKeys = Array.isArray(list) && list.some((b) => b.hasApiKey);
  const keysMissing = includeSecrets && hadKeys && !envelope.categories.backends?.secrets;
  return { keysMissing };
}

/** Drop this machine's folder paths (recordings, audio base, logs) from a blob
 *  about to be applied by a one-shot restore — file import, Restore from server,
 *  onboarding. Those apply with `ignoreGates`, which opens the folder gates, so a
 *  blob naming folders would move this device's recordings and logs to a path
 *  from another machine (a Windows path on Linux means nothing here). Absent keys
 *  keep the local values. Pure: returns a new blob, the input is untouched. */
export function stripMachineFolders(blob: SyncBlob): SyncBlob {
  const out: SyncBlob = { ...blob };
  if (isPlainObject(out.recording)) {
    const { recordingsDir: _r, audioBaseDir: _a, ...rec } = out.recording;
    out.recording = rec as SyncBlob["recording"];
  }
  if (isPlainObject(out.logging)) {
    const { logDir: _l, ...lg } = out.logging;
    out.logging = lg as SyncBlob["logging"];
  }
  return out;
}

/** Apply the user's per-category selection from a parsed import. Secrets ride
 *  inside the blob (applyBlob writes them to the keyring and re-derives
 *  hasApiKey from keyring truth). Throws "dictating" if a session is live —
 *  the preview dialog blocks on that instead of a bare refusal. Returns
 *  false when nothing was applied: applyBlob refused (dictation live), its
 *  retries ran out, or a supersede dropped it. */
export async function applyImport(
  selection: Record<SyncCategory, boolean>,
  result: ImportResult,
): Promise<boolean> {
  if (useApp.getState().status !== "idle") throw new Error("dictating");
  // Normalize a file written before the category split (chip fields inside
  // recording, the quick-add chord/pin under general/backends).
  // Our own exports never carry the folder keys; strip them so a hand-edited
  // file cannot either.
  const blob: SyncBlob = stripMachineFolders(migrateBlob({ ...result.categories }));
  if (selection.backends && blob.backends && Object.keys(result.secrets).length > 0) {
    blob.backends = { ...blob.backends, secrets: result.secrets };
  }
  return applyBlob(blob, selection, 2, { ignoreGates: true });
}

function isPlainObject<T>(v: T | undefined): v is T {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
