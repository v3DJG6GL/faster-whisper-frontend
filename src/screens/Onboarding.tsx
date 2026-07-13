// First-run onboarding — "connect first, branch after" (design v4).
//
// Mounted by App INSTEAD of the shell when a loaded config has no backends AND
// no profiles (fresh install; seeds are gone). One gate screen asks the only
// day-one question — where is your server? — then branches on what the server
// knows: synced settings found → restore offer; nothing → editable starter
// profiles → optional quick-add step (full backends only). "Skip for now" and
// every completion set settings.setupDismissed so the gate never re-opens; any
// later half-configured state is the Home checklist's job (SetupChecklist).

import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/Sidebar";
import { HotkeyCaptureControl } from "@/components/HotkeyCaptureControl";
import { Button, Labeled, Notice, Segmented, Select, TextInput } from "@/components/ui";
import {
  evdevStatus, getPipelineRules, importSettingsFile, pickImportFile, setBackendKey,
  syncPull, testConnection,
} from "@/lib/api";
import { normalizeUrl, nameFromUrl } from "@/lib/backends";
import { quickAddPeer } from "@/lib/conflicts";
import { ALL_CATEGORIES, applyBlob } from "@/lib/sync";
import { starterProfiles } from "@/lib/starters";
import { ruleListOf } from "@/lib/pipelineMap";
import { useApp } from "@/lib/store";
import { useHotkeyCapture } from "@/lib/useHotkeyCapture";
import { IS_WINDOWS } from "@/lib/platform";
import { ImportPreview, relTime } from "./SettingsSync";
import type { ImportResult, SyncPullResult } from "@/lib/syncTypes";
import type { Backend, ConnectionInfo, PipelineRule, Profile, SyncCategory } from "@/lib/types";


type Step = "gate" | "restore" | "starters" | "quickadd";

const ALL_ON = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true])) as Record<SyncCategory, boolean>;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const st = useApp;
  const [step, setStep] = useState<Step>("gate");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [backendId, setBackendId] = useState<string | null>(null);
  const [pull, setPull] = useState<SyncPullResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // Every exit marks setup handled so the gate never re-opens; later gaps
  // (deleted backends, skipped steps) fall to the Home checklist instead.
  const finish = () => {
    st.getState().updateSettings({ setupDismissed: true });
    onDone();
  };

  const testAndContinue = async () => {
    const serverUrl = normalizeUrl(url);
    if (!serverUrl.replace(/^https?:\/\//i, "")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await testConnection({ serverUrl, apiKey: key || undefined });
      if (!res.ok) {
        setError(res.error || "Couldn’t reach the server.");
        return;
      }
      // The tested server becomes Backend #1 no matter which branch follows.
      // Key goes to the OS keyring FIRST (mirrors the Backends editor).
      const id = crypto.randomUUID();
      if (key) await setBackendKey(id, key);
      const backend: Backend = {
        id,
        name: nameFromUrl(serverUrl),
        serverUrl,
        hasApiKey: key.length > 0,
        model: "whisper-1",
        endpoint: "stream",
        language: "auto",
        prompt: "",
        responseFormat: "verbose_json",
      };
      st.getState().upsertBackend(backend);
      st.getState().setConnection(id, res);
      setInfo(res);
      setBackendId(id);
      // Full backend → this account may have synced settings; discover, don't ask.
      if (res.bootId) {
        const p = await syncPull({ serverUrl, apiKey: key || null });
        if (p.ok && p.state?.blob) {
          setPull(p);
          setStep("restore");
          return;
        }
      }
      setStep("starters");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const restoreEverything = async () => {
    const blob = pull?.state?.blob;
    if (!blob) return;
    setBusy(true);
    try {
      await applyBlob(blob, ALL_ON);
      // Turn sync on for this device, against the restored backend that matches
      // the gate's URL (the restore may have replaced Backend #1's entry).
      const s = st.getState();
      const gateUrl = normalizeUrl(url);
      const match = s.backends.find((b) => normalizeUrl(b.serverUrl) === gateUrl) ?? s.backends[0];
      s.updateSync({ enabled: true, backendId: match?.id ?? null });
      finish();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setError(null);
    try {
      const path = await pickImportFile();
      if (!path) return;
      setImportResult(await importSettingsFile(path));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    // m-auto (not items-center on the parent): centered flex children taller than
    // the viewport get their top clipped past scroll reach; auto margins don't.
    <div className="relative z-10 flex h-screen overflow-y-auto">
      <div className="m-auto flex w-full max-w-[560px] flex-col items-center px-8 py-10 text-center">
        <div className="flex items-center gap-3">
          <BrandMark />
          <div className="text-left leading-none">
            <div className="font-display text-[20px] font-[430] tracking-tight text-text">
              faster<span className="font-[730] text-accent">whisper</span>
            </div>
            <div className="mt-1 font-mono text-[12px] uppercase tracking-label text-faint">
              <span className="font-bold text-accent">&gt;</span> frontend
            </div>
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
                <span className="text-[12px] text-faint">defaults: streaming · auto language</span>
              </div>
              {error && <Notice>{error}</Notice>}
            </div>
            <div className="mt-7 flex w-full max-w-[430px] items-center justify-between">
              <button
                className="ring-signal rounded text-[12px] text-dim underline decoration-line underline-offset-2 hover:text-text"
                onClick={() => void doImport()}
              >
                Have a settings file? Import it instead
              </button>
              <Button variant="ghost" onClick={finish}>
                Skip for now
              </Button>
            </div>
          </>
        )}

        {step === "restore" && pull?.state && (
          <>
            <div className="mt-6 font-mono text-[11px] text-dim">
              connected · {info?.serverVersion ? `faster-whisper-backend ${info.serverVersion}` : "faster-whisper-backend"}
            </div>
            <div className="mt-4 w-full max-w-[480px] rounded-card border border-accent/40 bg-accent-soft p-4 text-left">
              <div className="text-[13.5px] font-semibold">This account has synced settings</div>
              <div className="mt-1 font-mono text-[11px] text-dim">
                last synced{pull.state.device ? ` from ${pull.state.device}` : ""}
                {pull.state.updated_at ? ` · ${relTime(pull.state.updated_at * 1000)}` : ""}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {ALL_CATEGORIES.filter((c) => pull.state?.blob?.[c] !== undefined).map((c) => (
                  <span key={c} className="rounded-pill border border-line-strong px-2.5 py-0.5 font-mono text-[10px] text-dim">
                    {c === "appRules" ? "app rules" : c}
                  </span>
                ))}
              </div>
              <div className="mt-3.5 flex items-center gap-2.5">
                <Button variant="accent" onClick={() => void restoreEverything()} disabled={busy}>
                  {busy ? "Restoring…" : "Restore everything"}
                </Button>
                <Button variant="ghost" onClick={() => setStep("starters")} disabled={busy}>
                  Start fresh instead
                </Button>
              </div>
            </div>
            <p className="mt-4 max-w-[46ch] text-[12px] text-dim">
              Restoring turns sync on for this device and skips the remaining steps — profiles, hotkeys
              and quick add all arrive with your settings.
            </p>
            {error && <Notice className="mt-3">{error}</Notice>}
          </>
        )}

        {step === "starters" && (
          <StartersStep
            backendId={backendId}
            onConfirm={(drafts) => {
              const s = st.getState();
              for (const p of drafts) s.upsertProfile(p);
              // Quick add needs a full faster-whisper-backend (pipeline rules).
              if (info?.bootId) setStep("quickadd");
              else finish();
            }}
          />
        )}

        {step === "quickadd" && backendId && (
          <QuickAddStep serverUrl={normalizeUrl(url)} backendId={backendId} onFinish={finish} />
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

function StartersStep({
  backendId,
  onConfirm,
}: {
  backendId: string | null;
  onConfirm: (drafts: Profile[]) => void;
}) {
  const quickAddHotkey = useApp((s) => s.settings.general.quickAddHotkey);
  const evdevEnabled = useApp((s) => s.settings.general.evdevEnabled);
  const [drafts, setDrafts] = useState<Profile[]>(() => starterProfiles(backendId));
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
        Nothing synced on this account yet — here are two starters. Everything is editable; they’re
        only created when you confirm. Tip: Latch extends Push-to-talk — add Space while holding to go
        hands-free.
      </p>
      <div className="mt-5 grid w-full max-w-[540px] grid-cols-1 gap-3 text-left sm:grid-cols-2">
        {drafts.map((p) => (
          <StarterCard
            key={p.id}
            profile={p}
            others={[...drafts.filter((x) => x.id !== p.id), ...(quickAddHotkey.length ? [quickAddPeer(quickAddHotkey)] : [])]}
            lowLevelActive={lowLevel}
            onPatch={(patchP) => patch(p.id, patchP)}
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
}: {
  profile: Profile;
  others: Profile[];
  lowLevelActive: boolean;
  onPatch: (p: Partial<Profile>) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const { heldCodes, warn } = useHotkeyCapture({
    capturing,
    lowLevelActive,
    others,
    selfKind: p.activation === "latch" ? "latch" : "hold",
    onCommit: (codes) => {
      onPatch({ hotkey: codes });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
  });
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <TextInput
        value={p.name}
        onChange={(e) => onPatch({ name: e.target.value })}
        aria-label="Profile name"
        className="mb-2.5"
      />
      <Segmented
        value={p.activation}
        onChange={(v) => onPatch({ activation: v })}
        options={[
          { value: "hold", label: "Hold" },
          { value: "latch", label: "Toggle" },
        ]}
      />
      <div className="mt-3">
        <HotkeyCaptureControl
          codes={p.hotkey}
          capturing={capturing}
          heldCodes={heldCodes}
          warn={warn}
          onToggle={() => setCapturing((c) => !c)}
        />
      </div>
      <div className="mt-2.5 text-[11px] text-faint">
        {p.activation === "hold" ? "Hold to dictate, release to stop." : "Tap to start hands-free, tap to stop."}{" "}
        Language, vocabulary and more: Profiles screen, any time.
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
  useEffect(() => {
    void getPipelineRules({ serverUrl, backendId })
      .then((res) => {
        const maps = ruleListOf(res).filter((r) => r.type === "callback:map");
        setRules(maps);
        setSlug(maps[0]?.name ?? null);
      })
      .catch(() => setRules([]));
  }, [serverUrl, backendId]);

  const options = useMemo(
    () => (rules ?? []).map((r) => ({ value: r.name, label: r.label || r.name })),
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
        {rules !== null && rules.length === 0 ? (
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
        <Labeled label="Quick-add hotkey">
          <QuickAddHotkeyInline />
        </Labeled>
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
        <p className="mt-3 text-[11px] text-faint">No quick-add hotkey set — add one in Settings → General.</p>
      )}
    </>
  );
}

/** The quick-add chord with an inline re-capture — same recorder + conflict
 *  gate as Settings → General, scoped to the onboarding card. */
function QuickAddHotkeyInline() {
  const codes = useApp((s) => s.settings.general.quickAddHotkey);
  const profiles = useApp((s) => s.profiles);
  const evdevEnabled = useApp((s) => s.settings.general.evdevEnabled);
  const updateGeneral = useApp((s) => s.updateGeneral);
  const [capturing, setCapturing] = useState(false);
  const [lowLevel, setLowLevel] = useState(IS_WINDOWS);
  useEffect(() => {
    if (IS_WINDOWS) return;
    void evdevStatus()
      .then((s) => setLowLevel(!!(s.permitted && evdevEnabled)))
      .catch(() => {});
  }, [evdevEnabled]);
  const { heldCodes, warn } = useHotkeyCapture({
    capturing,
    lowLevelActive: lowLevel,
    others: profiles,
    selfKind: "quickadd",
    onCommit: (c) => {
      updateGeneral({ quickAddHotkey: c });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
  });
  return (
    <HotkeyCaptureControl
      codes={codes}
      capturing={capturing}
      heldCodes={heldCodes}
      warn={warn}
      onToggle={() => setCapturing((c) => !c)}
    />
  );
}
