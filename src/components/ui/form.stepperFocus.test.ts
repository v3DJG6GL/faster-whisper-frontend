// The Stepper's buttons must not drop keyboard focus to <body>: a native `disabled` set on the
// FOCUSED −/+ when a keyboard step reaches a bound did, and so did the ↺ that unmounts itself.
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
      // The handlers refuse the step themselves now that the button stays enabled.
      expect(src).toContain(`!${bound}) press(`);
      expect(src).toContain(`if (!${bound}) stepBy(`);
    }
  });

  it("the reset returns focus to the field once it re-renders", () => {
    const reset = button("Reset");
    expect(reset).toContain("resetPressed.current = true");
    expect(stepper).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!resetPressed\.current\) return;[\s\S]*?inputRef\.current\?\.focus\(\)/);
    expect(stepper).toContain("ref={inputRef}");
  });
});
