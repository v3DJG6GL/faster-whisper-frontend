// The chip's translation-route resolution. Pure, so it can be exercised without the
// store or the cross-window payload it normally rides in.

import { describe, expect, it } from "vitest";
import { chipRouteTargets } from "./overlay";

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

  it("caps the length of a single code", () => {
    // No sanitizer bounds a per-element length, and this lands in a `shrink-0` cell.
    const long = "x".repeat(400);
    expect(chipRouteTargets(null, [long])).toEqual(["x".repeat(12)]);
  });

  it("trims surrounding whitespace, matching how streaming.ts resolves the same list", () => {
    expect(chipRouteTargets(null, [" fr ", "it "])).toEqual(["fr", "it"]);
  });
});
