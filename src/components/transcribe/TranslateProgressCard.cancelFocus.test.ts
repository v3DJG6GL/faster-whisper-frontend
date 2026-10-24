// The translate runs' Cancel buttons must not drop keyboard focus to <body>: a native `disabled`
// set on the FOCUSED button by the very press that cancels would, until the run's card unmounts.
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the cards in.
import cardSrc from "./TranslateProgressCard.tsx?raw";
import otherSrc from "./OtherTranslateRuns.tsx?raw";

const cancelButton = (src: string, open: string) => {
  const end = src.indexOf('{cancelling ? "Cancelling…" : "Cancel"}');
  const at = src.lastIndexOf(open, end);
  expect(at).toBeGreaterThanOrEqual(0);
  return src.slice(at, end);
};

describe("translate Cancel keeps keyboard focus while it cancels", () => {
  it("the viewer card's Cancel is aria-disabled, never disabled, and a second press is a no-op", () => {
    const btn = cancelButton(cardSrc, "<button");
    expect(btn).not.toMatch(/\sdisabled=\{/);
    expect(btn).toContain("aria-disabled={cancelling || undefined}");
    expect(btn).toMatch(/if \(!cancelling\) onCancel\(\)/);
    expect(btn).not.toContain("onClick={onCancel}");
  });

  it("the other-runs strip's Cancel is never disabled, and a second press is a no-op", () => {
    const btn = cancelButton(otherSrc, "<Button");
    expect(btn).not.toMatch(/\sdisabled=\{/);
    expect(btn).toContain("!cancelling && cancelTranslateRun(");
  });
});
