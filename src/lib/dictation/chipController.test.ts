// The chip's translation-route resolution. Pure, so it can be exercised without the
// store or the cross-window payload it normally rides in.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import { hideOverlay } from "../api";
import type { Backend, Profile } from "../types";
import {
  initOverlayController,
  chipRoute,
  chipRouteMore,
  chipRoutePending,
  chipStatsLine,
  chipRouteTargets,
  configuredRouteTargets,
  tailUnits,
  trayRoute,
  trayStatus,
} from "./chipController";
import { homeTargetProfile, pickerOffHint, startOffHint } from "./dictation";

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
  it("previews only the codes the session sends", () => {
    // A synced code the wire refuses is never sent, so no readout may promise it.
    expect(configuredRouteTargets({ translationOverrides: { translateTo: ["de_CH", " fr "] } }, backend)).toEqual(["fr"]);
    expect(configuredRouteTargets({ translationOverrides: { translateTo: ["de_CH"] } }, backend)).toEqual([]);
  });
  it("previews no more targets than the session sends per request", () => {
    // The session caps at the server's TRANSLATION_MAX_TARGETS (else the app's 8): a longer
    // synced list must not promise languages dictation never types.
    const ten = ["de", "fr", "it", "es", "pt", "nl", "pl", "sv", "da", "fi"];
    const b = { id: "b1", translationOverrides: { translateTo: ten } };
    const caps = useApp.getState().caps;
    try {
      expect(configuredRouteTargets({}, b)).toEqual(ten.slice(0, 8));
      useApp.setState({
        caps: { b1: { server_info: { limits: { translation_max_targets: 3 } } } } as unknown as typeof caps,
      });
      expect(configuredRouteTargets({}, b)).toEqual(["de", "fr", "it"]);
      // No id: no server to ask, the app's ceiling.
      expect(configuredRouteTargets({}, { translationOverrides: { translateTo: ten } })).toEqual(ten.slice(0, 8));
    } finally {
      useApp.setState({ caps });
    }
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

  it("reads ?? for a language of only format characters, which is still sent", () => {
    const p = { ...profile, language: "\u200b" };
    expect(trayRoute(state({ profiles: [p], sessionTargets: ["fr", "it"] }))).toBe("?? → FR IT");
  });

  it("reads AUTO only for an unset or auto language", () => {
    for (const language of ["", "auto"]) {
      const p = { ...profile, language };
      const backends = [{ id: "b", language }];
      expect(trayRoute(state({ profiles: [p], backends, sessionTargets: ["fr", "it"] }))).toBe("AUTO → FR IT");
    }
  });

  it("caps a long synced language so the targets stay in the route", () => {
    const p = { ...profile, language: "x".repeat(100) };
    const route = trayRoute(state({ profiles: [p], sessionTargets: ["fr", "it"] }));
    expect(route.endsWith("→ FR IT")).toBe(true);
    expect(route.split(" → ")[0]).toHaveLength(12);
  });
});

describe("chipStatsLine", () => {
  type Usage = Parameters<typeof chipStatsLine>[0];
  const usage = (words: number) => ({ today: { all: { words, audio_s: 0 } } }) as unknown as Usage;

  it("says 'word' for exactly one word and 'words' otherwise", () => {
    expect(chipStatsLine(usage(1), "words")).toBe("1 word");
    expect(chipStatsLine(usage(0), "words")).toBe("0 words");
    expect(chipStatsLine(usage(1200), "words")).toBe("1.2k words");
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

describe("initOverlayController — canStart tells the chip whether its start buttons can start", () => {
  it("is false with every profile off, says why, and re-emits true once one is enabled", async () => {
    const s = useApp.getState();
    const profile = { id: "p1", name: "p1", activation: "handsfree", enabled: false, hotkey: [], backendId: "b1" } as unknown as Profile;
    const backend = { id: "b1", name: "b1" } as unknown as Backend;
    try {
      useApp.setState({
        status: "idle",
        profiles: [],
        backends: [backend],
        settings: { ...s.settings, recording: { ...s.settings.recording, indicatorPosition: "top" } },
      });
      await initOverlayController();
      const last = () => {
        const u = emit.mock.calls.filter((c) => c[0] === "dictation://update");
        return u[u.length - 1]?.[1] as { canStart?: boolean; startHint?: string };
      };
      expect(last()).toMatchObject({ canStart: false, startHint: "Add a profile to begin" });
      useApp.setState({ profiles: [profile] });
      expect(last()).toMatchObject({ canStart: false, startHint: "Enable a profile to begin" });
      useApp.setState({ profiles: [{ ...profile, enabled: true }] });
      expect(last()).toMatchObject({ canStart: true, startHint: "" });
    } finally {
      useApp.setState({ profiles: s.profiles, backends: s.backends });
    }
  });

  it("keeps the cycle button on with no Backend: cycling persists a home pick, it starts nothing", async () => {
    const s = useApp.getState();
    const p1 = { id: "p1", name: "p1", activation: "handsfree", enabled: true, hotkey: [], backendId: null } as unknown as Profile;
    const p2 = { ...p1, id: "p2", name: "p2" } as unknown as Profile;
    try {
      useApp.setState({
        status: "idle",
        profiles: [p1, p2],
        backends: [],
        settings: { ...s.settings, recording: { ...s.settings.recording, indicatorPosition: "top" } },
      });
      await initOverlayController();
      const last = () => {
        const u = emit.mock.calls.filter((c) => c[0] === "dictation://update");
        return u[u.length - 1]?.[1] as { canStart?: boolean; startHint?: string; canCycle?: boolean; cycleHint?: string };
      };
      useApp.setState({ backends: [] }); // force an emit from this state
      expect(last()).toMatchObject({ canStart: false, startHint: "Add a backend to begin", canCycle: true, cycleHint: "" });
      // Every profile off: now the cycle has nothing to cycle, and it says so — never "backend".
      useApp.setState({ profiles: [{ ...p1, enabled: false }, { ...p2, enabled: false }] });
      expect(last()).toMatchObject({ canCycle: false, cycleHint: "Enable a profile to begin" });
      useApp.setState({ profiles: [] });
      expect(last()).toMatchObject({ canCycle: false, cycleHint: "Add a profile to begin" });
    } finally {
      useApp.setState({ profiles: s.profiles, backends: s.backends });
    }
  });

  it("turns both buttons off while the target picker is open: start and cycle both bail on it", async () => {
    const s = useApp.getState();
    const profile = { id: "p1", name: "p1", activation: "handsfree", enabled: true, hotkey: [], backendId: "b1" } as unknown as Profile;
    const backend = { id: "b1", name: "b1" } as unknown as Backend;
    try {
      useApp.setState({
        status: "idle",
        profiles: [profile],
        backends: [backend],
        routePending: null,
        settings: { ...s.settings, recording: { ...s.settings.recording, indicatorPosition: "top" } },
      });
      await initOverlayController();
      const last = () => {
        const u = emit.mock.calls.filter((c) => c[0] === "dictation://update");
        return u[u.length - 1]?.[1] as { canStart?: boolean; startHint?: string; canCycle?: boolean; cycleHint?: string };
      };
      // The picker's stamp: status stays "idle", only routePending says it is open.
      useApp.setState({ routePending: "choosing" });
      const picker = "Answer the target picker first";
      expect(last()).toMatchObject({ canStart: false, startHint: picker, canCycle: false, cycleHint: picker });
      useApp.setState({ routePending: null });
      expect(last()).toMatchObject({ canStart: true, startHint: "", canCycle: true, cycleHint: "" });
    } finally {
      useApp.setState({ profiles: s.profiles, backends: s.backends, routePending: s.routePending });
    }
  });
});

describe("startOffHint", () => {
  // The Home button and the chip's dictate button share this one gate + wording: "" means a
  // click starts, anything else is the reason it will not — so Home can never say "Press to
  // dictate" over a click that toggle() then refuses (the last Backend deleted).
  const p = { id: "p1", name: "p1", activation: "handsfree", enabled: true, hotkey: [], backendId: "b1" } as unknown as Profile;
  const b = { id: "b1", name: "b1" } as unknown as Backend;
  const hint = (profiles: Profile[], backends: Backend[]) =>
    startOffHint(profiles, homeTargetProfile(profiles, null), backends);

  it("names each reason a start is refused, and is empty only when a start can run", () => {
    expect(hint([], [b])).toBe("Add a profile to begin");
    expect(hint([{ ...p, enabled: false }], [b])).toBe("Enable a profile to begin");
    expect(hint([p], [])).toBe("Add a backend to begin");
    expect(hint([p], [b])).toBe("");
  });

  it("never asks for a backend without a target: the cycle hint reuses it that way", () => {
    expect(startOffHint([p], undefined, [])).toBe("Enable a profile to begin");
    expect(startOffHint([], undefined, [])).toBe("Add a profile to begin");
  });
});

describe("pickerOffHint", () => {
  // Home reads it ahead of startOffHint like the chip does: an open target picker leaves
  // status "idle" while startHandsFree bails, so both surfaces must say why.
  it("is set only while the picker is open on an idle session", () => {
    expect(pickerOffHint("choosing", "idle")).toBe("Answer the target picker first");
    expect(pickerOffHint("choosing", "listening")).toBe("");
    expect(pickerOffHint("undecided", "idle")).toBe("");
    expect(pickerOffHint(null, "idle")).toBe("");
  });
});

describe("tailUnits", () => {
  it("never starts the cut on a lone low surrogate", () => {
    // 1000 units of emoji + "x": unit -800 is the low half of a pair. A lone surrogate in the
    // emitted JSON makes serde_json reject the whole dictation://update on the IPC hop.
    const t = tailUnits("\u{1F600}".repeat(500) + "x", 800);
    expect(t.charCodeAt(0) >= 0xdc00 && t.charCodeAt(0) <= 0xdfff).toBe(false);
    expect(t.endsWith("x")).toBe(true);
    expect(t.length).toBe(799);
  });
  it("keeps exactly the last n units of a BMP string", () => {
    const s = "abcdefghij".repeat(100);
    expect(tailUnits(s, 800)).toBe(s.slice(-800));
    expect(tailUnits(s, 800).length).toBe(800);
  });
  it("leaves a shorter string unchanged", () => {
    expect(tailUnits("short \u{1F600}", 800)).toBe("short \u{1F600}");
  });
});

describe("initOverlayController — the hide linger outlasts the chip's session note", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  // Dock off: the chip shows only for the session, then lingers. A note ("incomplete") or a
  // translate failure lands on the idle write and the chip holds it for 2600 ms.
  const settle = async (extra: Partial<ReturnType<typeof useApp.getState>>) => {
    const s = useApp.getState().settings;
    useApp.setState({
      status: "idle",
      sessionNote: null,
      translateFailure: null,
      sessionOutcome: null,
      settings: { ...s, recording: { ...s.recording, indicatorPosition: "top", persistentDock: false } },
    });
    await initOverlayController();
    vi.useFakeTimers();
    vi.mocked(hideOverlay).mockClear();
    useApp.setState({ status: "listening" });
    useApp.setState({ status: "idle", ...extra });
  };

  it("keeps the window up past 1800 ms while a session note shows", async () => {
    await settle({ sessionNote: "incomplete" });
    vi.advanceTimersByTime(2000);
    expect(hideOverlay).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(hideOverlay).toHaveBeenCalledTimes(1);
  });

  it("holds an untranslated typed outcome as long as the incomplete note", async () => {
    await settle({ sessionOutcome: "typed", translateFailure: "timeout" });
    vi.advanceTimersByTime(2700);
    expect(hideOverlay).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(hideOverlay).toHaveBeenCalledTimes(1);
  });

  it("holds a plain 'not inserted' note for its shorter hold", async () => {
    await settle({ sessionOutcome: "none", sessionNote: "not-inserted" });
    vi.advanceTimersByTime(2100);
    expect(hideOverlay).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(hideOverlay).toHaveBeenCalledTimes(1);
  });

  it("does not hold a translate failure that left nothing on screen", async () => {
    await settle({ sessionOutcome: "none", translateFailure: "cancelled" });
    vi.advanceTimersByTime(1800);
    expect(hideOverlay).toHaveBeenCalledTimes(1);
  });

  it("still hides a plain idle settle at 1800 ms", async () => {
    await settle({});
    vi.advanceTimersByTime(1799);
    expect(hideOverlay).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hideOverlay).toHaveBeenCalledTimes(1);
  });
});
