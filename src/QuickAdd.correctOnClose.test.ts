// Quick-Add's correct-on-close puts the corrected word over the selection after the window has
// hidden. Whenever that insert ends on the clipboard instead, the word stays uncorrected and the
// user's clipboard is replaced, so the chip must say it. Rust flags only a DIVERT (clipboard
// against the method asked for); when the method itself resolves to "clipboard" — a read-only
// field under deep field detection, the app's rule, the global method — it answers a plain
// landing, and only this window knows where the word went.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitCorrectionCopied, getFocusedApp, getFocusedSelection, injectText } from "@/lib/api";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import type { AppRule, FocusedApp, GeneralSettings } from "@/lib/types";
import { replaceSelectionAfterClose } from "./QuickAdd";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getFocusedSelection: vi.fn(),
  getFocusedApp: vi.fn(),
  injectText: vi.fn(),
  emitCorrectionCopied: vi.fn(),
}));

const APP_ID = "org.example.reader";
const GENERAL: GeneralSettings = { ...DEFAULT_SETTINGS.general, insertMethod: "paste", deepFieldDetection: false };
const LANDED = { landed: true, diverted: false };

/** Close Quick-Add over a still-selected "teh" that the list corrects to "the". */
async function correctOnClose(a: {
  app?: Partial<FocusedApp>;
  general?: Partial<GeneralSettings>;
  rules?: AppRule[];
  out?: { landed: boolean; diverted: boolean };
}) {
  vi.mocked(getFocusedSelection).mockResolvedValue("teh");
  vi.mocked(getFocusedApp).mockResolvedValue({ appId: APP_ID, title: "Notes", ...a.app });
  vi.mocked(injectText).mockResolvedValue(a.out ?? LANDED);
  vi.mocked(emitCorrectionCopied).mockResolvedValue(undefined);
  const done = replaceSelectionAfterClose("teh", "the", { ...GENERAL, ...a.general }, a.rules ?? []);
  await vi.advanceTimersByTimeAsync(1000); // the wait for focus to return to the source app
  await done;
  return vi.mocked(injectText).mock.calls[0]?.[0];
}

describe("Quick-Add correct-on-close that ends on the clipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tells the chip when a read-only field coerced the correction to clipboard-only", async () => {
    const sent = await correctOnClose({ app: { editable: false }, general: { deepFieldDetection: true } });
    expect(sent?.method).toBe("clipboard");
    expect(sent?.text).toBe("the");
    expect(emitCorrectionCopied).toHaveBeenCalledTimes(1);
  });

  it("tells the chip when the app's rule inserts by clipboard", async () => {
    const rule: AppRule = { id: "r1", appId: APP_ID, block: false, insertMethod: "clipboard" };
    const sent = await correctOnClose({ rules: [rule] });
    expect(sent?.method).toBe("clipboard");
    expect(emitCorrectionCopied).toHaveBeenCalledTimes(1);
  });

  it("tells the chip when the global insert method is clipboard", async () => {
    const sent = await correctOnClose({ general: { insertMethod: "clipboard" } });
    expect(sent?.method).toBe("clipboard");
    expect(emitCorrectionCopied).toHaveBeenCalledTimes(1);
  });

  it("tells the chip when Rust diverted a paste to the clipboard", async () => {
    const sent = await correctOnClose({ out: { landed: true, diverted: true } });
    expect(sent?.method).toBe("paste");
    expect(emitCorrectionCopied).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the correction replaced the selection", async () => {
    const sent = await correctOnClose({});
    expect(sent?.method).toBe("paste");
    expect(emitCorrectionCopied).not.toHaveBeenCalled();
  });

  it("says nothing when a clipboard-only correction wrote nothing", async () => {
    await correctOnClose({ general: { insertMethod: "clipboard" }, out: { landed: false, diverted: false } });
    expect(injectText).toHaveBeenCalledTimes(1);
    expect(emitCorrectionCopied).not.toHaveBeenCalled();
  });

  it("still copies nothing into an app marked never-type-into", async () => {
    const rule: AppRule = { id: "r1", appId: APP_ID, block: true };
    await correctOnClose({ rules: [rule] });
    expect(injectText).not.toHaveBeenCalled();
    expect(emitCorrectionCopied).not.toHaveBeenCalled();
  });
});
