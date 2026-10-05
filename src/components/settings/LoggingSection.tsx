import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/lib/store";
import { Button, Segmented, SectionLabel, Select, SettingRow, Toggle } from "@/components/ui";
import { safeDisplayText } from "@/lib/sanitize";
import { pickRecordingsDir, logFolderPath, openLogFolder } from "@/lib/api";
import { SETTING } from "@/lib/settingsManifest";
import { LOG_RETENTION_OPTIONS, withCurrentDay } from "@/lib/retentionOptions";

/** Settings → General → Logging: the in-app log viewer's knobs. Level changes
 *  apply live (the Rust filter reloads on config save); `RUST_LOG` overrides
 *  the level control when set at launch. */
export function LoggingSection() {
  const logging = useApp((s) => s.settings.logging);
  const updateLogging = useApp((s) => s.updateLogging);
  const navigate = useNavigate();
  const [folder, setFolder] = useState<string | null>(null);
  const logDir = logging?.logDir ?? null;
  useEffect(() => {
    // Change… then Reset race two lookups; only the latest may land.
    let live = true;
    void logFolderPath(logDir).then((p) => {
      if (live) setFolder(p);
    });
    return () => {
      live = false;
    };
  }, [logDir]);

  return (
    <>
      <SectionLabel className="mb-1 mt-4">Logging</SectionLabel>
      <SettingRow
        title={SETTING.logLevel.label}
        desc="How much detail is captured — lower levels aren’t recorded at all. Debug helps when reporting a problem; Info is right for every day. A RUST_LOG environment variable overrides this."
      >
        <Segmented
          value={logging?.logLevel ?? "info"}
          onChange={(v) => updateLogging({ logLevel: v })}
          ariaLabel="Log level"
          options={[
            { value: "error", label: "Errors" },
            { value: "warn", label: "Warnings" },
            { value: "info", label: "Info" },
            { value: "debug", label: "Debug" },
          ]}
        />
      </SettingRow>
      <SettingRow
        title={SETTING.logRetention.label}
        desc="Log files older than this are deleted on startup. The current session is always kept."
      >
        <Select
          value={String(logging?.keepDays ?? 30)}
          onChange={(v) => updateLogging({ keepDays: Number(v) })}
          ariaLabel="Keep log files"
          options={withCurrentDay(LOG_RETENTION_OPTIONS, logging?.keepDays ?? 30)}
        />
      </SettingRow>
      <SettingRow
        title={SETTING.logsInSidebar.label}
        desc="Hidden, the page stays reachable from the button below — and from failure notices, which still appear."
      >
        <Toggle
          checked={logging?.showInSidebar ?? true}
          onChange={(v) => updateLogging({ showInSidebar: v })}
        />
      </SettingRow>
      <SettingRow title="Logs page" desc="Opens the console — works whether or not the sidebar entry is shown.">
        <Button size="sm" variant="accent" onClick={() => navigate("/logs")}>
          Open logs
        </Button>
      </SettingRow>
      <SettingRow
        title={SETTING.logFolder.label}
        desc={folder ? safeDisplayText(folder, 120) : "One file per app session."}
        last
      >
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void openLogFolder(logDir).catch(() => {})}>
            Open folder
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void pickRecordingsDir().then((picked) => {
                if (picked) updateLogging({ logDir: picked });
              }).catch(() => {})
            }
          >
            Change…
          </Button>
          {logDir && (
            <Button size="sm" variant="ghost" onClick={() => updateLogging({ logDir: null })}>
              Reset
            </Button>
          )}
        </div>
      </SettingRow>
    </>
  );
}
