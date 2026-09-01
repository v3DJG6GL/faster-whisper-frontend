// The insertion cascade — constraint > app rule > profile > global — plus the two
// coercion helpers that were each written out several times before being extracted.
//
// These are pure functions in streaming.ts (nothing here touches the store or Tauri),
// which is the point of extracting them: the precedence is the part that has to be right,
// and it was previously only observable by running a dictation.

import { describe, expect, it } from "vitest";
import { holdCoerced, liveAllowed, resolveInjectionTarget } from "./streaming";
import type { AppRule, FocusedApp, GeneralSettings } from "./types";

const G: GeneralSettings = {
  openAtLogin: false,
  startMinimized: false,
  insertTiming: "live",
  insertMethod: "paste",
  pasteShortcut: ["ControlLeft", "KeyV"],
  autoEnter: false,
  restoreClipboard: true,
  soundEffects: false,
  evdevEnabled: false,
  deepFieldDetection: false,
  quickAddHotkey: [],
};

const app = (over: Partial<FocusedApp> = {}): FocusedApp => ({ appId: "konsole", title: "Konsole", ...over });
const rule = (over: Partial<AppRule> = {}): AppRule => ({ id: "r1", appId: "konsole", block: false, ...over });

describe("holdCoerced", () => {
  it("coerces a hold session even when the resolved method would type", () => {
    // The PTT chord is physically held, so any injected key folds into the held modifier.
    expect(holdCoerced("hold", "paste")).toBe(true);
    expect(holdCoerced("hold", "direct")).toBe(true);
  });

  it("leaves hands-free alone unless the method is already clipboard", () => {
    expect(holdCoerced("handsfree", "paste")).toBe(false);
    expect(holdCoerced("handsfree", "clipboard")).toBe(true);
  });

  it("treats an unknown activation as not-hold", () => {
    // Callers pass `cfg?.activation`, which is undefined outside a session.
    expect(holdCoerced(undefined, "paste")).toBe(false);
  });
});

describe("liveAllowed", () => {
  const base = { wants: true, endpoint: "stream", activation: "handsfree", method: "paste" } as const;

  it("allows live typing only when all three preconditions hold", () => {
    expect(liveAllowed(base)).toBe(true);
  });

  it("refuses when the user didn't ask", () => {
    expect(liveAllowed({ ...base, wants: false })).toBe(false);
  });

  it("refuses on a batch endpoint — there are no live phrases to insert", () => {
    expect(liveAllowed({ ...base, endpoint: "batch" })).toBe(false);
  });

  it("refuses for a hold session that would TYPE, but allows clipboard-only", () => {
    // Clipboard-only types NOTHING, so it is safe under a held chord and may run live in
    // any activation. This is the case that distinguishes `liveAllowed` from `!holdCoerced`
    // — defining one from the other silently disabled every clipboard-live session.
    expect(liveAllowed({ ...base, activation: "hold" })).toBe(false);
    expect(liveAllowed({ ...base, activation: "hold", method: "clipboard" })).toBe(true);
  });

  it("allows hands-free + clipboard-only, the other case an inverted holdCoerced broke", () => {
    expect(liveAllowed({ ...base, activation: "handsfree", method: "clipboard" })).toBe(true);
  });
});

describe("resolveInjectionTarget precedence", () => {
  it("falls back to the global when nothing overrides", () => {
    const r = resolveInjectionTarget(app(), [], G);
    expect(r.method).toBe("paste");
    expect(r.autoEnter).toBe(false);
    expect(r.restoreClipboard).toBe(true);
  });

  it("lets the profile override the global", () => {
    const r = resolveInjectionTarget(app(), [], G, { insertMethod: "direct", autoEnter: true });
    expect(r.method).toBe("direct");
    expect(r.autoEnter).toBe(true);
    // Untouched fields still inherit.
    expect(r.restoreClipboard).toBe(true);
  });

  it("lets an app rule override the profile", () => {
    // The app rule expresses what the TARGET accepts; an unachievable preference is not
    // satisfiable, so it outranks the profile's intent.
    const r = resolveInjectionTarget(app(), [rule({ insertMethod: "clipboard", autoEnter: false })], G, {
      insertMethod: "direct",
      autoEnter: true,
    });
    expect(r.method).toBe("clipboard");
    expect(r.autoEnter).toBe(false);
  });

  it("treats a null app-rule field as inherit, not as an explicit value", () => {
    // AppRule uses `null` for inherit where Profile uses `undefined`; `??` must see through both.
    const r = resolveInjectionTarget(app(), [rule({ insertMethod: null, autoEnter: null })], G, {
      insertMethod: "direct",
      autoEnter: true,
    });
    expect(r.method).toBe("direct");
    expect(r.autoEnter).toBe(true);
  });

  it("lets a blocked app coerce the METHOD without touching the other preferences", () => {
    // The constraint is about where keystrokes may go, not about whether the user wanted
    // an Enter — and the downstream holdCoerced/clipboard guards suppress it anyway.
    const r = resolveInjectionTarget(app(), [rule({ block: true })], G, { autoEnter: true });
    expect(r.method).toBe("clipboard");
    expect(r.autoEnter).toBe(true);
  });

  it("coerces a non-editable target to clipboard when deep detection is on", () => {
    const r = resolveInjectionTarget(app({ editable: false }), [], { ...G, deepFieldDetection: true });
    expect(r.method).toBe("clipboard");
    expect(r.notEditable).toBe(true);
  });

  it("lets an explicit per-app method opt out of the non-editable coercion", () => {
    // "konsole → paste": a terminal isn't an editable AT-SPI field, yet the user said paste.
    const r = resolveInjectionTarget(
      app({ editable: false }),
      [rule({ insertMethod: "paste" })],
      { ...G, deepFieldDetection: true },
    );
    expect(r.method).toBe("paste");
    expect(r.notEditable).toBe(false);
  });

  it("short-circuits on our own window without matching a rule", () => {
    // Nothing is typed here, so no rule applies and nothing is coerced — but the profile
    // layer still resolves, which the two hand-copied call sites used to get wrong.
    const r = resolveInjectionTarget(app({ isSelf: true }), [rule({ insertMethod: "clipboard" })], G, {
      insertMethod: "direct",
    });
    expect(r.isSelf).toBe(true);
    expect(r.rule).toBeUndefined();
    expect(r.method).toBe("direct");
  });

  it("matches rules by normalized app id, not raw equality", () => {
    const r = resolveInjectionTarget(app({ appId: "KonSole" }), [rule({ insertMethod: "direct" })], G);
    expect(r.method).toBe("direct");
  });
});
