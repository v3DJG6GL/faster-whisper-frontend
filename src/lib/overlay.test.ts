// The chip's translation-route resolution. Pure, so it can be exercised without the
// store or the cross-window payload it normally rides in.

import { describe, expect, it } from "vitest";
import { chipRouteMore, chipRouteTargets, configuredRouteTargets } from "./overlay";

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
