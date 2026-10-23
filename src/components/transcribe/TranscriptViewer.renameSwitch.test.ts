// A speaker name half-typed into the rename field is stored when the batch run's follow switches
// the viewer to its next finished file. That switch is no click, so no blur commits the draft:
// the record-switch reset closed the editor and cleared the draft unsaved.
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the viewer in.
import viewerSrc from "./TranscriptViewer.tsx?raw";

const resetEffect = () => {
  const at = viewerSrc.indexOf("const renameRecordRef");
  expect(at, "the rename switch reset moved — update TranscriptViewer.renameSwitch.test.ts").toBeGreaterThanOrEqual(0);
  return viewerSrc.slice(at, viewerSrc.indexOf("}, [path, okey]);", at));
};

describe("a speaker rename being typed survives a record switch without a blur", () => {
  it("the switch commits the open draft under the PREVIOUS record before closing the editor", () => {
    const effect = resetEffect();
    expect(effect).toContain("const prev = renameRecordRef.current;");
    expect(effect).toContain("useTranscribeRun.getState().renames[prev.okey]");
    expect(effect).toContain("setRename(prev.okey, editingSpeaker, name);");
    // Committed before the close: the close clears the draft the commit reads.
    expect(effect.indexOf("setRename(prev.okey")).toBeLessThan(effect.indexOf("setEditingSpeaker(null);"));
    expect(effect).toContain('setRenameDraft("");');
    // Never under the record now on screen: that is the A-draft-onto-B's-speaker bug.
    expect(effect).not.toContain("setRename(okey,");
  });

  it("okey moving path → id at run finish is no switch: the editor stays open", () => {
    const effect = resetEffect();
    const skip = effect.indexOf("if (prev.path === path && prev.okey === path && okey !== path) return;");
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(skip).toBeLessThan(effect.indexOf("setEditingSpeaker(null);"));
    expect(skip).toBeLessThan(effect.indexOf("setRename(prev.okey"));
  });
});
