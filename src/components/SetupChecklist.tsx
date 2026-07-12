// Home's "Finish setting up" card — the permanent foundation under the
// first-run gate (design v4, "B standing on C"). Shows whenever the app lacks
// a backend or any profile: after "Skip for now", after a partial onboarding,
// or after deleting the last backend months in. Steps deep-link to the REAL
// screens so setup teaches the app's geography; quick add is an explicitly
// optional third row that never blocks the done state (the counter reads n/2
// on purpose). Completing both required steps retires the card entirely.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card } from "@/components/ui";
import { importSettingsFile, pickImportFile } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ImportResult } from "@/lib/syncTypes";
import { ImportPreview } from "@/screens/SettingsSync";

function StepBullet({ state, n }: { state: "done" | "now" | "off"; n: number }) {
  return (
    <span
      className={
        "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border font-mono text-[10.5px] " +
        (state === "done"
          ? "border-transparent bg-live/15 text-live"
          : state === "now"
            ? "border-accent text-accent"
            : "border-line-strong text-faint")
      }
    >
      {state === "done" ? "✓" : n}
    </span>
  );
}

export function SetupChecklist() {
  const navigate = useNavigate();
  const backends = useApp((s) => s.backends.length);
  const profiles = useApp((s) => s.profiles.length);
  const quickAdd = useApp((s) => s.settings.quickAddList != null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  if (backends > 0 && profiles > 0) return null;
  const doneCount = (backends > 0 ? 1 : 0) + (profiles > 0 ? 1 : 0);

  const doImport = async () => {
    setImportError(null);
    try {
      const path = await pickImportFile();
      if (!path) return;
      setImportResult(await importSettingsFile(path));
    } catch (e) {
      setImportError(String(e));
    }
  };

  return (
    <Card className="mt-8 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[15px] font-[650]">Finish setting up</h2>
        <span className="font-mono text-[10px] uppercase tracking-label text-faint">{doneCount} / 2</span>
      </div>

      <div className="mt-1 divide-y divide-line">
        <div className="flex items-start gap-3 py-3">
          <StepBullet state={backends > 0 ? "done" : "now"} n={1} />
          <div className="min-w-0 flex-1">
            <div className={"text-[13px] font-semibold " + (backends > 0 ? "text-dim" : "text-text")}>
              Connect a backend
            </div>
            <div className="mt-0.5 text-[12px] text-dim">
              Point the app at your faster-whisper server and test the connection.
            </div>
          </div>
          {backends === 0 && (
            <Button variant="accent" size="sm" onClick={() => navigate("/backends")}>
              Add backend
            </Button>
          )}
        </div>

        <div className="flex items-start gap-3 py-3">
          <StepBullet state={profiles > 0 ? "done" : backends > 0 ? "now" : "off"} n={2} />
          <div className="min-w-0 flex-1">
            <div className={"text-[13px] font-semibold " + (backends > 0 && profiles === 0 ? "text-text" : "text-dim")}>
              Confirm your hotkeys
            </div>
            <div className="mt-0.5 text-[12px] text-dim">
              Two starter profiles are ready — confirm or change their key combos.
            </div>
          </div>
          {profiles === 0 && (
            <Button variant={backends > 0 ? "accent" : "ghost"} size="sm" onClick={() => navigate("/profiles")} disabled={backends === 0}>
              Review
            </Button>
          )}
        </div>

        <div className="flex items-start gap-3 py-3">
          <StepBullet state={quickAdd ? "done" : "off"} n={3} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-dim">
              Set up quick add
              <span className="rounded-pill border border-dashed border-line-strong px-2 py-px font-mono text-[9px] uppercase tracking-label text-faint">
                optional
              </span>
            </div>
            <div className="mt-0.5 text-[12px] text-dim">
              Fix misheard words from anywhere with a hotkey — needs a full faster-whisper-backend.
            </div>
          </div>
          {!quickAdd && (
            <Button variant="ghost" size="sm" onClick={() => navigate("/dictionary")} disabled={backends === 0}>
              Set up
            </Button>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-dim">
        Moving from another computer?
        <button
          className="ring-signal rounded text-accent underline decoration-line underline-offset-2"
          onClick={() => void doImport()}
        >
          Import a settings file
        </button>
        <button
          className="ring-signal rounded text-accent underline decoration-line underline-offset-2"
          onClick={() => navigate("/settings")}
        >
          Restore via settings sync
        </button>
        {importError && <span className="text-warn">{importError}</span>}
      </div>

      {importResult && <ImportPreview result={importResult} onClose={() => setImportResult(null)} />}
    </Card>
  );
}
