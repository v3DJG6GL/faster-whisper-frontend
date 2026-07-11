// P30: settings export/import to a file. Reuses the sync engine's extract +
// apply core so a file round-trip and a server sync agree on exactly what
// travels (same categories, same machine-local exclusions).

import { useApp } from "./store";
import { appVersion, exportSettingsFile, syncDeviceInfo } from "./api";
import { ALL_CATEGORIES, applyBlob, composeBlob } from "./sync";
import type { SyncCategory } from "./types";
import type { ExportEnvelope, ImportResult, SyncBlob } from "./syncTypes";

/** Compose the export envelope from the CURRENT store state. All categories
 *  are always included (an export is a backup — the choosing happens on
 *  import); `includeSecrets` gates the plaintext API keys (default off). */
export async function buildEnvelope(includeSecrets: boolean): Promise<ExportEnvelope> {
  const s = useApp.getState();
  const allOn = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true])) as Record<
    SyncCategory,
    boolean
  >;
  const blob = await composeBlob(
    { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
    allOn,
    undefined,
    { includeSecrets },
  );
  const device = await syncDeviceInfo();
  return {
    formatVersion: 1,
    configVersion: 2,
    appVersion: await appVersion(),
    createdAt: new Date().toISOString(),
    hostname: device?.hostname ?? "",
    platform: device?.platform ?? "",
    categories: blob,
  };
}

/** Build + write the export to `path` (picked via the save dialog). */
export async function exportToFile(path: string, includeSecrets: boolean): Promise<void> {
  const envelope = await buildEnvelope(includeSecrets);
  await exportSettingsFile(path, envelope);
}

/** Apply the user's per-category selection from a parsed import. Secrets ride
 *  inside the blob (applyBlob writes them to the keyring and re-derives
 *  hasApiKey from keyring truth). Throws "dictating" if a session is live —
 *  the preview dialog blocks on that instead of silently deferring. */
export async function applyImport(
  selection: Record<SyncCategory, boolean>,
  result: ImportResult,
): Promise<void> {
  if (useApp.getState().status !== "idle") throw new Error("dictating");
  const blob: SyncBlob = { ...result.categories };
  if (selection.backends && blob.backends && Object.keys(result.secrets).length > 0) {
    blob.backends = { ...blob.backends, secrets: result.secrets };
  }
  await applyBlob(blob, selection);
}
