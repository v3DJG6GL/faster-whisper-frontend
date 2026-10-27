// On Windows the focus detector reports an app as its lowercased exe basename without ".exe"
// (focus/exe_name.rs), so a rule typed the way Task Manager or Explorer shows the app must be
// saved under that same key, or the editor arms a rule that never matches.
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRuleKey } from "@/lib/sanitize";

const loadModule = async (windows: boolean) => {
  vi.resetModules();
  vi.doMock("@/lib/platform", () => ({ IS_LINUX: !windows, IS_WINDOWS: windows }));
  return import("./AppRules");
};
const load = async (windows: boolean) => (await loadModule(windows)).typedAppId;

afterEach(() => {
  vi.doUnmock("@/lib/platform");
});

describe("typedAppId", () => {
  it("keys a hand-typed Windows exe name or path the way the detector reports it", async () => {
    const typedAppId = await load(true);
    expect(appRuleKey(typedAppId("Chrome.exe"))).toBe("chrome");
    expect(appRuleKey(typedAppId("C:\\Apps\\Code.EXE "))).toBe("code");
    expect(typedAppId("mstsc")).toBe("mstsc");
    expect(appRuleKey(typedAppId(".exe"))).toBe("");
  });

  it("keeps the exe name of a pasted Windows path longer than the id bound", async () => {
    const typedAppId = await load(true);
    expect(appRuleKey(typedAppId("C:\\" + "a".repeat(220) + "\\Code.exe"))).toBe("code");
  });

  it("strips the .exe of a Windows exe name just under the id bound before bounding it", async () => {
    const typedAppId = await load(true);
    expect(appRuleKey(typedAppId("C:\\x\\" + "a".repeat(198) + ".exe"))).toBe("a".repeat(198));
    expect(appRuleKey(typedAppId("Code.exe\u200b"))).toBe("code");
  });

  it("drops the quotes Explorer's Copy as path puts around a pasted Windows path", async () => {
    const typedAppId = await load(true);
    expect(appRuleKey(typedAppId('"C:\\Apps\\Chrome.exe"'))).toBe("chrome");
  });

  it("leaves a Linux app id as typed", async () => {
    const typedAppId = await load(false);
    expect(typedAppId(" org.kde.konsole ")).toBe("org.kde.konsole");
    expect(typedAppId("chrome.exe")).toBe("chrome.exe");
  });
});

describe("ruleAppId", () => {
  it("keeps a Windows id the detector reported instead of stripping a second .exe", async () => {
    const { ruleAppId } = await loadModule(true);
    // An image `Setup.exe.exe` reports `setup.exe`: captured or stored, it must save as that.
    expect(ruleAppId("setup.exe", "setup.exe")).toBe("setup.exe");
    // Text the user typed over it is still keyed as typed.
    expect(appRuleKey(ruleAppId("C:\\x\\Setup.exe.exe", "setup.exe"))).toBe("setup.exe");
    expect(appRuleKey(ruleAppId("Chrome.exe", "setup.exe"))).toBe("chrome");
  });

  it("re-keys a stored Windows id on save: only a \"Use current\" id is kept as is", async () => {
    const { ruleAppId } = await loadModule(true);
    // Older builds saved a typed path or exe name verbatim; re-saving must repair it.
    const path = "C:\\Apps\\Code.exe";
    expect(appRuleKey(ruleAppId(path, null))).toBe("code");
    expect(appRuleKey(ruleAppId(`"${path}"`, null))).toBe("code");
    expect(appRuleKey(ruleAppId("Chrome.exe", null))).toBe("chrome");
    expect(ruleAppId("mstsc.exe", null)).toBe("mstsc");
  });
});
