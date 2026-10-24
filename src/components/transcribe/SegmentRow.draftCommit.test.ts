// A correction half-typed into a row must be stored when the batch run's follow switches the viewer
// to its next finished file. That switch is no click, so no blur commits the draft: without this,
// the span's text is overwritten with the new file's line, or the edit-mode reset unmounts it unsaved.
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the row in.
import rowSrc from "./SegmentRow.tsx?raw";
import viewerSrc from "./TranscriptViewer.tsx?raw";

const editable = () => {
  const at = rowSrc.indexOf("contentEditable");
  expect(at, "the editable span moved — update SegmentRow.draftCommit.test.ts").toBeGreaterThanOrEqual(0);
  return rowSrc.slice(at, rowSrc.indexOf("onKeyDown=", at));
};

describe("a correction being typed survives a record switch without a blur", () => {
  it("the editable span is keyed on the record, so a switch unmounts it instead of rewriting its text", () => {
    expect(editable()).toContain("key={`${recordKey}:${editRev}`}");
    // path, not okey: okey moves path → id at run finish with the same transcript on screen.
    const row = viewerSrc.slice(viewerSrc.indexOf("<SegmentRow"), viewerSrc.indexOf("onCommitEdit={onCommitEdit}"));
    expect(row).toContain("recordKey={path}");
  });

  it("a dirty span's unmount commits its text through the previous render's onCommitEdit", () => {
    const span = editable();
    expect(span).toContain("ref={editableRef}");
    expect(span).toMatch(/onInput=\{\(\) => \{\s*dirtyRef\.current = true;/);
    // The blur commit clears it, so a remount after a blur commit never commits twice.
    expect(span).toMatch(/onBlur=\{\(e\) => \{\s*dirtyRef\.current = false;/);
    const ref = rowSrc.slice(rowSrc.indexOf("const editableRef"), rowSrc.indexOf("}, []);", rowSrc.indexOf("const editableRef")));
    expect(ref).toContain("if (!dirtyRef.current) return;");
    expect(ref).toContain("commitRef.current.onCommitEdit(commitRef.current.i,");
    // Updated after commit, never during render: the switching render must not hand the deleted
    // span the NEW record's onCommitEdit, which would compare against the other file's line.
    expect(rowSrc).toMatch(/useLayoutEffect\(\(\) => \{\s*commitRef\.current = \{ i, onCommitEdit \};\s*\}\);/);
    expect(rowSrc.match(/commitRef\.current = /g)).toHaveLength(1);
  });
});
