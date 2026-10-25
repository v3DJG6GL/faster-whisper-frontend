// The "Suggested starters" card names the chords "Keep these" commits. A starter whose chord the
// quick-add chord took is committed unbound (startersClearOf), so the card must not promise it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { startersClearOf } from "@/lib/starters";
import { StarterChord } from "./Profiles";

const card = (quickAdd: string[]) => {
  const kept = startersClearOf("b1", quickAdd, true);
  return {
    hold: renderToStaticMarkup(<StarterChord kept={kept} id="hold" verb="hold" />),
    handsfree: renderToStaticMarkup(
      <StarterChord kept={kept} id="handsfree" verb="tap" tail=" to start and stop" />,
    ),
  };
};

describe("suggested starters card chord text", () => {
  it("does not promise the push-to-talk chord the quick-add chord took", () => {
    const { hold, handsfree } = card(["ControlLeft", "ShiftLeft"]);
    expect(hold).not.toContain("Shift");
    expect(hold).toContain("no shortcut yet");
    expect(handsfree).toMatch(/^tap .*Ctrl.* to start and stop$/);
  });

  it("names both suggested chords when quick-add collides with neither", () => {
    const { hold, handsfree } = card(["AltLeft", "MetaLeft"]);
    expect(hold).toMatch(/^hold .*Ctrl.*Shift/);
    expect(handsfree).toMatch(/^tap .*Ctrl.* to start and stop$/);
    expect(hold + handsfree).not.toContain("no shortcut yet");
  });
});
