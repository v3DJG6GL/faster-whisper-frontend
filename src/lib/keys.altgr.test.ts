import { describe, expect, it, vi } from "vitest";
import { dropAltGrPhantom } from "./keys";

// Windows/WebView2 emits a phantom ControlLeft keydown right before AltRight on
// AltGr layouts; the Rust backend drops it in both feeds, so a chord captured
// WITH it could never fire. The helper must strip it exactly when AltGr is the
// modifier in play — and leave a genuine Ctrl + right-Alt chord alone.
describe("dropAltGrPhantom", () => {
  it("strips the phantom ControlLeft when AltGraph is active", () => {
    expect(dropAltGrPhantom(["ControlLeft", "AltRight"], true)).toEqual(["AltRight"]);
  });
  it("keeps a real Ctrl + right-Alt chord on a non-AltGr layout", () => {
    expect(dropAltGrPhantom(["ControlLeft", "AltRight"], false)).toEqual(["ControlLeft", "AltRight"]);
  });
  it("does nothing when AltRight is not part of the chord", () => {
    expect(dropAltGrPhantom(["ControlLeft", "KeyA"], true)).toEqual(["ControlLeft", "KeyA"]);
  });
});

// The strip is a Windows/WebView2 artefact: on Linux the evdev backend binds ControlLeft
// and AltRight independently, so a Ctrl+AltGr+X capture must keep its Ctrl.
describe("altGrPhantomActive", () => {
  const altGraphDown = { getModifierState: (k: string) => k === "AltGraph" };
  it("is armed only on Windows", async () => {
    vi.resetModules();
    vi.doMock("./platform", () => ({ IS_LINUX: false, IS_WINDOWS: true }));
    const win = await import("./keys");
    expect(win.altGrPhantomActive(altGraphDown)).toBe(true);
    vi.doMock("./platform", () => ({ IS_LINUX: true, IS_WINDOWS: false }));
    vi.resetModules();
    const linux = await import("./keys");
    expect(linux.altGrPhantomActive(altGraphDown)).toBe(false);
    vi.doUnmock("./platform");
  });
});
