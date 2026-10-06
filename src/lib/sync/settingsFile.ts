// P30: settings export/import to a file. Reuses the sync engine's extract +
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
 *  chord-less profiles), the machine-specific recordings folder never does. */
export async function buildEnvelope(includeSecrets: boolean): Promise<ExportEnvelope> {
  const s = useApp.getState();
  const allOn = categorySelection(true);
  const blob = await composeBlob(
    { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
    allOn,
    undefined,
    // The Transcribe picks are portable (the backends list travels in the same
    // envelope); only the machine-specific recordings folder stays behind.
    { includeSecrets, sub: { recordingsDir: false, profileHotkeys: true, quickAddHotkey: true, transcribePicks: true } },
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
 *  `keysMissing`: the user asked for the API keys, this device has some, yet
 *  the file has none — composeBlob degrades a locked or partial keyring read to
 *  the keyless list (all or nothing), so the caller must say so instead of
 *  reporting a plain success for a backup that silently lacks its keys. */
export async function exportToFile(
  path: string,
  includeSecrets: boolean,
): Promise<{ keysMissing: boolean }> {
  const envelope = await buildEnvelope(includeSecrets);
  await exportSettingsFile(path, envelope);
  const keysMissing =
    includeSecrets &&
    useApp.getState().backends.some((b) => b.hasApiKey) &&
    !envelope.categories.backends?.secrets;
  return { keysMissing };
}

/** Apply the user's per-category selection from a parsed import. Secrets ride
 *  inside the blob (applyBlob writes them to the keyring and re-derives
 *  hasApiKey from keyring truth). Throws "dictating" if a session is live —
 *  the preview dialog blocks on that instead of silently deferring. Returns
 *  false when applyBlob deferred or its retries exhausted (nothing was applied). */
export async function applyImport(
  selection: Record<SyncCategory, boolean>,
  result: ImportResult,
): Promise<boolean> {
  if (useApp.getState().status !== "idle") throw new Error("dictating");
  // Normalize a file written before the category split (chip fields inside
  // recording, the quick-add chord/pin under general/backends).
  const blob: SyncBlob = migrateBlob({ ...result.categories });
  // ignoreGates turns the folder gates on, so a file naming folder paths would
  // move this device's recordings and logs — which the dialog promises never
  // happens. Our own exports never carry these keys; strip them so a
  // hand-edited file cannot either (absent keys keep the local values).
  if (isPlainObject(blob.recording)) {
    const { recordingsDir: _r, audioBaseDir: _a, ...rec } = blob.recording;
    blob.recording = rec as SyncBlob["recording"];
  }
  if (isPlainObject(blob.logging)) {
    const { logDir: _l, ...lg } = blob.logging;
    blob.logging = lg as SyncBlob["logging"];
  }
  if (selection.backends && blob.backends && Object.keys(result.secrets).length > 0) {
    blob.backends = { ...blob.backends, secrets: result.secrets };
  }
  return applyBlob(blob, selection, 2, { ignoreGates: true });
}

function isPlainObject<T>(v: T | undefined): v is T {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
