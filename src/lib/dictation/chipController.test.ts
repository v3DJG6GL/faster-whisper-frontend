// The chip's translation-route resolution. Pure, so it can be exercised without the
// store or the cross-window payload it normally rides in.

import { describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import {
  initOverlayController,
  chipRoute,
  chipRouteMore,
  chipRoutePending,
  chipRouteTargets,
  configuredRouteTargets,
  trayRoute,
  trayStatus,
} from "./chipController";

// Only initOverlayController touches these: the rest of this file is pure.
const emit = vi.hoisted(() => vi.fn((_event: string, _payload?: unknown) => Promise.resolve()));
vi.mock("@tauri-apps/api/event", () => ({ emit, listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  isTauri: true,
  showOverlay: vi.fn(() => Promise.resolve()),
  setOverlayScale: vi.fn(() => Promise.resolve()),
  hideOverlay: vi.fn(() => Promise.resolve()),
  setTrayState: vi.fn(() => Promise.resolve()),
  playCue: vi.fn(() => Promise.resolve()),
}));

describe("configuredRouteTargets", () => {
  // The Backend's translation defaults under the Profile's overrides — the session's merge.
  // Home and the Profiles row once read the Profile alone, so an inheriting profile read as
  // "no translation" while the chip and the dictation translated.
  const backend = { translationOverrides: { translateTo: ["fr", "it"] } };
  it("inherits the backend's targets when the profile sets none", () => {
    expect(configuredRouteTargets({}, backend)).toEqual(["fr", "it"]);
    expect(configuredRouteTargets({ translationOverrides: {} }, backend)).toEqual(["fr", "it"]);
  });
  it("lets the profile override them", () => {
    expect(configuredRouteTargets({ translationOverrides: { translateTo: ["de"] } }, backend)).toEqual(["de"]);
  });
  it("is undefined when neither layer translates", () => {
    expect(configuredRouteTargets({}, {})).toBeUndefined();
    expect(configuredRouteTargets(null, undefined)).toBeUndefined();
  });
});

describe("chipRouteTargets", () => {
  it("prefers the running session's resolved targets over the Profile's config", () => {
    // The two diverge the moment something can change the targets for one session. The
    // session is the authority — the Profile is only what the NEXT one would do.
    expect(chipRouteTargets(["fr"], ["it", "es"])).toEqual(["fr"]);
  });

  it("falls back to the Profile's targets when no session is running", () => {
    // This is the standby dock's preview: "what happens if I press the chord".
    expect(chipRouteTargets(null, ["it", "es"])).toEqual(["it", "es"]);
  });

  it("distinguishes 'no session' from 'a session that does not translate'", () => {
    // `[]` is a real answer — this session translates nothing — and must NOT fall through
    // to the Profile, or a per-session "insert the original only" would still show a route.
    expect(chipRouteTargets([], ["it"])).toEqual([]);
    expect(chipRouteTargets(null, ["it"])).toEqual(["it"]);
  });

  it("shows nothing when neither layer has targets", () => {
    expect(chipRouteTargets(null, undefined)).toEqual([]);
    expect(chipRouteTargets(null, [])).toEqual([]);
  });

  it("drops non-strings and blanks rather than rendering them", () => {
    // `sanitizeProfiles` type-checks `translateTo` as a whole but not its elements, and an
    // object leaf reaching the chip would render as "Objects are not valid as a React child".
    const dirty = ["fr", "", "  ", null, 42, { x: 1 }] as unknown as string[];
    expect(chipRouteTargets(null, dirty)).toEqual(["fr"]);
  });

  it("caps how many targets are shown", () => {
    // The row shares one line with the live transcript — the surface the user actually
    // reads to supervise what is about to be typed.
    expect(chipRouteTargets(null, ["fr", "it", "es", "pt"], 2)).toEqual(["fr", "it"]);
  });

  it("reports how many targets the cap left out, so the chip can say +N", () => {
    expect(chipRouteMore(null, ["fr", "it", "es", "pt"], 2)).toBe(2);
    expect(chipRouteMore(["fr", "it"], ["es", "pt", "de"], 2)).toBe(0);
    expect(chipRouteMore(null, ["fr", "", "it", "es"], 2)).toBe(1); // blanks don't count
    expect(chipRouteMore(null, undefined, 2)).toBe(0);
  });

  it("caps the length of a single code", () => {
    // No sanitizer bounds a per-element length, and this lands in a `shrink-0` cell.
    const long = "x".repeat(400);
    expect(chipRouteTargets(null, [long])).toEqual(["x".repeat(12)]);
  });

  it("trims surrounding whitespace, matching how streaming.ts resolves the same list", () => {
    expect(chipRouteTargets(null, [" fr ", "it "])).toEqual(["fr", "it"]);
  });
});

describe("chipRoutePending", () => {
  // The stand-in for the route when there is none to promise. Paired with chipRouteTargets
  // the way chipPayload pairs them: an "ask" preview hides the configured targets.
  it("is empty for a running session that resolved its targets", () => {
    expect(chipRoutePending(null, "listening", true)).toBe("");
    expect(chipRouteTargets(["fr"], ["it"])).toEqual(["fr"]);
  });

  it("says 'ask' on the standby dock for a Profile that asks, and hides the preview", () => {
    // The configured targets are only the picker's preselection; previewing them as the
    // route promised what the next chord press would first ask about.
    expect(chipRoute(null, ["it", "es"], null, "idle", true)).toEqual({
      routePending: "ask",
      translateTo: [],
      translateMore: 0,
    });
  });

  it("sends the configured route and its overflow when the Profile does not ask", () => {
    expect(chipRoute(null, ["it", "es", "fr"], null, "idle", false)).toEqual({
      routePending: "",
      translateTo: ["it", "es"],
      translateMore: 1,
    });
  });

  it("previews nothing beside a failed start's error, where there is no session", () => {
    // flashError leaves status "error" with sessionTargets null; the configured targets are
    // the idle standby preview only (the tray shows no route there either).
    for (const asks of [true, false]) {
      expect(chipRoute(null, ["fr", "it"], null, "error", asks)).toEqual({
        routePending: "",
        translateTo: [],
        translateMore: 0,
      });
    }
    // A running session's own targets still show under a non-idle status.
    expect(chipRoute(["de"], ["fr", "it"], null, "listening", false).translateTo).toEqual(["de"]);
  });

  it("previews the configured route for a Profile that does not ask", () => {
    expect(chipRoutePending(null, "idle", false)).toBe("");
    expect(chipRoutePending(null, "idle", undefined)).toBe("");
    expect(chipRouteTargets(null, ["it", "es"])).toEqual(["it", "es"]);
  });

  it("does not say 'ask' while a session runs, even under an asking Profile", () => {
    // Push-to-talk under an ask-Profile publishes "undecided" itself; a session that has
    // already resolved its targets must show them, not the standby glyph.
    expect(chipRoutePending(null, "translating", true)).toBe("");
  });

  it("forwards the session's own pending value ahead of everything", () => {
    expect(chipRoutePending("undecided", "listening", true)).toBe("undecided");
    expect(chipRoutePending("choosing", "idle", true)).toBe("choosing");
    expect(chipRoutePending("original", "listening", false)).toBe("original");
  });
});

describe("trayStatus", () => {
  // The tray tooltip is the only status surface on a chip-less desktop (GNOME, non-KDE Wayland).
  it("names the server's work behind a listening status", () => {
    expect(trayStatus("listening", false, null)).toBe("listening");
    expect(trayStatus("listening", false, "loading")).toBe("loading");
    expect(trayStatus("listening", false, "decoding")).toBe("transcribing");
  });

  it("does not call a held utterance `transcribing`: the tray cannot see whether you are speaking", () => {
    expect(trayStatus("listening", false, "open")).toBe("listening");
  });

  it("keeps warm-up on top, and never repaints a status that speaks for itself", () => {
    expect(trayStatus("listening", true, "loading")).toBe("warming");
    expect(trayStatus("transcribing", true, "decoding")).toBe("transcribing");
    expect(trayStatus("idle", false, "loading")).toBe("idle");
    expect(trayStatus("error", false, "decoding")).toBe("error");
  });
});

describe("trayRoute", () => {
  type TrayState = Parameters<typeof trayRoute>[0];
  const profile = { id: "p", backendId: "b", language: "de", translationOverrides: { translateTo: ["fr", "it"] } };
  const state = (over: Partial<Record<string, unknown>>) =>
    ({
      activeProfile: "p",
      profiles: [profile],
      backends: [{ id: "b" }],
      sessionTargets: null,
      routePending: null,
      ...over,
    }) as unknown as TrayState;

  it("shows the running session's resolved route", () => {
    expect(trayRoute(state({ sessionTargets: [" fr ", "it"] }))).toBe("DE → FR IT");
  });

  it("advertises no route without a session, even when the Profile would translate", () => {
    // A failed start's error linger keeps activeProfile but nulls sessionTargets: nothing
    // runs, so the Profile's configured targets must not read as a live route.
    expect(trayRoute(state({ sessionTargets: null }))).toBe("");
  });
});

describe("initOverlayController — configLoaded reaches the chip", () => {
  it("sends configLoaded and re-emits when the config finishes loading", async () => {
    const s = useApp.getState().settings;
    useApp.setState({ configLoaded: false, settings: { ...s, recording: { ...s.recording, indicatorPosition: "top" } } });
    await initOverlayController();
    const updates = () =>
      emit.mock.calls.filter((c) => c[0] === "dictation://update").map((c) => c[1] as { configLoaded?: boolean });
    const last = () => updates()[updates().length - 1];
    // The startup push carries the not-yet-loaded flag, so the chip keeps re-seeding its sizes.
    expect(last()?.configLoaded).toBe(false);
    const before = updates().length;
    // setConfigLoaded alone (same settings object) must still reach the chip, or it never latches.
    useApp.getState().setConfigLoaded();
    expect(updates().length).toBe(before + 1);
    expect(last()?.configLoaded).toBe(true);
  });
});
