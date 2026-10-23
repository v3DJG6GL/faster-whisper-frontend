import { afterEach, describe, expect, it, vi } from "vitest";

// Shift+Insert pastes the PRIMARY selection in many Linux terminals (xterm, VTE, Konsole), while
// the app fills only the CLIPBOARD: the Linux label warns about it, the stored chord stays put.
describe("Shift + Insert preset label", () => {
  afterEach(() => {
    vi.doUnmock("./platform");
    vi.resetModules();
  });
  const load = async (linux: boolean) => {
    vi.resetModules();
    vi.doMock("./platform", () => ({ IS_LINUX: linux, IS_WINDOWS: !linux }));
    return import("./paste");
  };

  it("warns off terminals on Linux, in the picker and the read-only label alike", async () => {
    const paste = await load(true);
    const preset = paste.PASTE_PRESETS.find((p) => p.value === "shift-insert");
    expect(preset?.label).toBe("Shift + Insert (not in terminals)");
    expect(paste.pasteLabel(["ShiftLeft", "Insert"])).toBe("Shift + Insert (not in terminals)");
  });

  it("keeps the stored chord, so a saved Shift+Insert setting still resolves to the preset", async () => {
    const paste = await load(true);
    expect(paste.pasteCodes("shift-insert")).toEqual(["ShiftLeft", "Insert"]);
    expect(paste.pasteKey(["ShiftLeft", "Insert"])).toBe("shift-insert");
  });

  it("stays a plain Shift + Insert off Linux", async () => {
    const paste = await load(false);
    expect(paste.pasteLabel(["ShiftLeft", "Insert"])).toBe("Shift + Insert");
  });
});
