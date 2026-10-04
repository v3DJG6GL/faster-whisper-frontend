// The quick-add chord capture, shared by the Dictionary screen (its home) and
// the onboarding quick-add step. Self-contained: it reads/writes the store,
// resolves the low-level-backend gate itself (evdev permitted + enabled on
// Linux; the hook backend is always on on Windows), and runs the same
// conflict check against the Profile chords as the Profiles editor — the two
// rebind surfaces must compute the gate identically (see Profiles.tsx).

import { useEffect, useState } from "react";
import { evdevStatus } from "@/lib/api";
import { useApp } from "@/lib/store";
import { useHotkeyCapture } from "@/lib/useHotkeyCapture";
import { IS_WINDOWS } from "@/lib/platform";
import { TriggerTile } from "@/components/TriggerTile";

export function QuickAddShortcutField({
  allowClear = false,
  title = "Shortcut",
}: {
  allowClear?: boolean;
  title?: string;
}) {
  const codes = useApp((s) => s.settings.general.quickAddHotkey);
  const profiles = useApp((s) => s.profiles);
  const evdevEnabled = useApp((s) => s.settings.general.evdevEnabled);
  const updateGeneral = useApp((s) => s.updateGeneral);
  const updateProfile = useApp((s) => s.updateProfile);
  const [capturing, setCapturing] = useState(false);
  const [lowLevel, setLowLevel] = useState(IS_WINDOWS);
  useEffect(() => {
    if (IS_WINDOWS) return;
    void evdevStatus()
      .then((s) => setLowLevel(!!(s.permitted && evdevEnabled)))
      .catch(() => {});
  }, [evdevEnabled]);
  const capture = useHotkeyCapture({
    capturing,
    lowLevelActive: lowLevel,
    others: profiles,
    selfKind: "quickadd",
    onCommit: (c) => {
      updateGeneral({ quickAddHotkey: c });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
    // "Use it here": the profile that had these keys loses its shortcut (applied at once, like
    // every quick-add change).
    onTakeOver: (id) => updateProfile(id, { hotkey: [] }),
  });
  return (
    <TriggerTile
      title={title}
      purpose="quickadd"
      codes={codes}
      capturing={capturing}
      capture={capture}
      onToggle={() => setCapturing((c) => !c)}
      onRetry={() => {
        capture.dismissPending();
        setCapturing(true);
      }}
      onClear={allowClear ? () => updateGeneral({ quickAddHotkey: [] }) : undefined}
    />
  );
}
