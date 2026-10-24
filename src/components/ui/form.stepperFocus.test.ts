// The Stepper's and RangeField's buttons must not drop keyboard focus to <body>, which a native
// `disabled` set on the FOCUSED −/+ when a keyboard step reaches a bound would do, and so would a
// ↺ unmounting itself.
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the Stepper in.
import formSrc from "./form.tsx?raw";

const stepper = formSrc.slice(formSrc.indexOf("export function Stepper("));
const button = (label: string) => {
  const at = stepper.indexOf(`aria-label={\`${label}`);
  expect(at).toBeGreaterThanOrEqual(0);
  return stepper.slice(at, stepper.indexOf("</button>", at));
};

describe("Stepper keeps keyboard focus", () => {
  it("−/+ mark a bound with aria-disabled and keep native disabled for a disabled Stepper only", () => {
    for (const [label, bound] of [["Decrease", "atMin"], ["Increase", "atMax"]] as const) {
      const src = button(label);
      expect(src).toContain("disabled={disabled}");
      expect(src).toContain(`aria-disabled={${bound} || undefined}`);
      expect(src).not.toMatch(/disabled=\{disabled \|\| cur/);
      // The button stays enabled at a bound, so the handlers refuse the step themselves.
      expect(src).toContain(`!${bound}) press(`);
      expect(src).toContain(`e.detail === 0 && !${bound}) stepBy(`);
    }
  });

  it("the reset returns focus to the field once it re-renders, after a keyboard press only", () => {
    const reset = button("Reset");
    // detail 0 is a keyboard activation (Enter/Space); a mouse click leaves focus alone, or the
    // field would show its focused look instead of the inherited one it was just reset to.
    expect(reset).toContain("resetPressed.current = e.detail === 0");
    expect(reset).not.toContain("resetPressed.current = true");
    expect(stepper).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!resetPressed\.current\) return;[\s\S]*?inputRef\.current\?\.focus\(\)/);
    expect(stepper).toContain("ref={inputRef}");
  });
});

describe("RangeField keeps keyboard focus", () => {
  const range = formSrc.slice(formSrc.indexOf("export function RangeField("), formSrc.indexOf("export function Stepper("));

  it("the reset returns focus to the slider after a keyboard press only", () => {
    const at = range.indexOf("aria-label={`Reset ");
    expect(at).toBeGreaterThanOrEqual(0);
    const reset = range.slice(at, range.indexOf("</button>", at));
    expect(reset).toContain("resetPressed.current = e.detail === 0");
    expect(range).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!resetPressed\.current\) return;[\s\S]*?inputRef\.current\?\.focus\(\)/);
    expect(range).toMatch(/<input\s+ref=\{inputRef\}[\s\S]*?type="range"/);
  });
});
