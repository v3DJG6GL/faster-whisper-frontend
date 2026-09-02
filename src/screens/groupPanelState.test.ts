// The disclosure toggle must never claim a panel it does not drive: in
// "changed & default-off" mode the panel's contents follow the filter, not the
// toggle, and a collapsed group has no panel node to point `aria-controls` at.
import { describe, expect, it } from "vitest";
import { groupPanelState } from "./SyncSettingsList";
import type { SettingDef, SettingId } from "../lib/settingsManifest";

const DEFS = [{ id: "a" }, { id: "b" }] as unknown as SettingDef[];
const ALL_ON = { a: true, b: true } as unknown as Record<SettingId, boolean>;
const A_OFF = { a: false, b: true } as unknown as Record<SettingId, boolean>;
const NONE = new Set<SettingId>();
const SOME = new Set(["a"] as unknown as SettingId[]);

describe("groupPanelState", () => {
  it("filter off + expanded: every row shows and the toggle owns the panel", () => {
    const s = groupPanelState(DEFS, ALL_ON, NONE, true, false);
    expect(s.visible).toHaveLength(2);
    expect(s.panelOpen).toBe(true);
    expect(s.owns).toBe(true);
  });

  it("filter off + collapsed: no rows, no panel, no ownership", () => {
    const s = groupPanelState(DEFS, ALL_ON, NONE, false, false);
    expect(s.visible).toHaveLength(0);
    expect(s.panelOpen).toBe(false);
    expect(s.owns).toBe(false);
  });

  it("filter on with exceptions: the panel opens but the toggle owns nothing", () => {
    const s = groupPanelState(DEFS, ALL_ON, SOME, false, true);
    expect(s.visible.map((d) => d.id)).toEqual(["a"]);
    expect(s.panelOpen).toBe(true);
    expect(s.owns).toBe(false);
  });

  it("filter on with no exceptions: the group stays closed even when expanded", () => {
    const s = groupPanelState(DEFS, ALL_ON, NONE, true, true);
    expect(s.visible).toHaveLength(0);
    expect(s.panelOpen).toBe(false);
    expect(s.owns).toBe(false);
  });

  it("filter on: a disabled switch surfaces the row even when unchanged", () => {
    const s = groupPanelState(DEFS, A_OFF, NONE, false, true);
    expect(s.visible.map((d) => d.id)).toEqual(["a"]);
    expect(s.panelOpen).toBe(true);
  });
});
