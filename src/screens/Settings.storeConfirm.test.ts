// The Recording & history "Delete…" confirms name the exact count they remove. Saving a dictation
// or finishing a run sends no event the tab listens to, so arming must re-read the store stats or
// the confirm promises the count from the last read ("Delete 5 dictations" for a wipe of 50).
import { describe, expect, it, vi } from "vitest";
import settingsSrc from "./Settings.tsx?raw";
import { reportStoreError, takeParkedStoreError } from "./Settings";

const KINDS = ["dict", "files", "links", "video", "clear"] as const;

describe("store delete confirms re-read their counts on arm", () => {
  it("the arm helper re-reads the store stats before showing the confirm", () => {
    const body = settingsSrc.match(/const armStoreAction = \(kind: StoreKind\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
    expect(body).toMatch(/refreshStoreStats\(\);[\s\S]*setConfirming\(kind\)/);
  });

  // The re-read is an async folder walk: until it settles the confirm still shows the old count,
  // so a quick second click ran the wipe under it. The arm records its read's seq and the confirm
  // waits ("Counting…", disabled) until a read at or after it has settled.
  it("the arm records its read, and only a settled read at or after it ends the wait", () => {
    const body = settingsSrc.match(/const armStoreAction = \(kind: StoreKind\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
    expect(body).toMatch(/refreshStoreStats\(\);\s*setArmSeq\(statsSeq\.current\);/);
    expect(settingsSrc).toContain("const storeCounting = statsSettled < armSeq;");
    const refresh = settingsSrc.match(/const refreshStoreStats = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[basePref\]\);/)?.[1] ?? "";
    // Landed (latest only) and failed (latest only, the old counts stay up) both settle it.
    expect(refresh).toMatch(/if \(my !== statsSeq\.current\) return;[\s\S]*setStoreStats\(st\);\s*setStatsSettled\(my\);/);
    expect(refresh).toMatch(/\.catch\(\(\) => \{\s*if \(my === statsSeq\.current\) setStatsSettled\(my\);/);
  });

  // Every row renders its Delete… / confirm pair through one helper.
  const control =
    settingsSrc.match(/const storeDeleteControl = \(kind: StoreKind, confirmLabel: string\) =>([\s\S]*?)\n {4}\);\n/)?.[1] ?? "";
  const rendersVia = (kind: string) => new RegExp(`storeDeleteControl\\(\\s*"${kind}",`);

  it.each(KINDS)("the %s confirm waits for the arm's count", (kind) => {
    expect(settingsSrc).toMatch(rendersVia(kind));
    const i = control.indexOf("onClick={() => runStoreAction(kind)}");
    expect(i).toBeGreaterThan(-1);
    const btn = control.slice(i, i + 260);
    expect(btn).toMatch(/^onClick=\{\(\) => runStoreAction\(kind\)\} disabled=\{storeLocked \|\| storeCounting\}>/);
    expect(btn).toMatch(/"Deleting…"\s*:\s*storeCounting\s*\?\s*"Counting…"/);
  });

  it.each(KINDS)("the %s row arms through the helper, never setConfirming directly", (kind) => {
    expect(settingsSrc).toMatch(rendersVia(kind));
    expect(control).toContain("onClick={() => armStoreAction(kind)}");
    expect(settingsSrc).not.toContain(`setConfirming("${kind}")`);
  });
});

// A wipe outlives the screen: when it fails after the route unmounted, the dead mount's tab ref
// still reads Recording & history and its setState is dropped, so the failure must be parked for
// the live mount (and logged) rather than "shown" on the dead one.
describe("a store wipe failure reaches the live screen", () => {
  it("parks a failure that settles after the starting screen unmounted, and logs it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      takeParkedStoreError();
      const err = new Error("video/: permission denied");
      expect(reportStoreError(err, false, "Recording & history")).toBeNull();
      expect(log).toHaveBeenCalledWith("store action failed:", err);
      expect(takeParkedStoreError()).toContain("video/: permission denied");
      expect(takeParkedStoreError()).toBeNull(); // shown once
      // The live mount on the tab shows it itself, and parks nothing.
      expect(reportStoreError(err, true, "Recording & history")).toContain("permission denied");
      expect(takeParkedStoreError()).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});
