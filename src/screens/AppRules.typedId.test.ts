// On Windows the focus detector reports an app as its lowercased exe basename without ".exe"
// (focus/exe_name.rs), so a rule typed the way Task Manager or Explorer shows the app must be
// saved under that same key, or the editor arms a rule that never matches.
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRuleKey } from "@/lib/sanitize";

const load = async (windows: boolean) => {
  vi.resetModules();
  vi.doMock("@/lib/platform", () => ({ IS_LINUX: !windows, IS_WINDOWS: windows }));
  return (await import("./AppRules")).typedAppId;
};

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
