// The Recording & history "Delete…" confirms name the exact count they remove. Saving a dictation
// or finishing a run sends no event the tab listens to, so arming must re-read the store stats or
// the confirm promises the count from the last read ("Delete 5 dictations" for a wipe of 50).
import { describe, expect, it } from "vitest";
import settingsSrc from "./Settings.tsx?raw";

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

  it.each(KINDS)("the %s confirm waits for the arm's count", (kind) => {
    const i = settingsSrc.indexOf(`onClick={() => runStoreAction("${kind}")}`);
    expect(i).toBeGreaterThan(-1);
    const btn = settingsSrc.slice(i, i + 260);
    expect(btn).toMatch(/^onClick=\{\(\) => runStoreAction\("\w+"\)\} disabled=\{storeLocked \|\| storeCounting\}>/);
    expect(btn).toMatch(/"Deleting…"\s*:\s*storeCounting\s*\?\s*"Counting…"/);
  });

  it.each(KINDS)("the %s row arms through the helper, never setConfirming directly", (kind) => {
    expect(settingsSrc).toContain(`onClick={() => armStoreAction("${kind}")}`);
    expect(settingsSrc).not.toContain(`setConfirming("${kind}")`);
  });
});
