// An audio-folder move (Change… / Reset) ends in a forced History reload, which replaces the
// mirror with the disk copy. A coalesced record write dropped before the move is then gone
// from both — a retro-translate chunk parked at that moment stayed untranslated for good — so
// both handlers land the parked writes first. Rust re-points every save that names a moved
// path (MOVED, save_transcript_record), so a flushed write cannot put a pre-move path back.
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`).
import settingsSrc from "./Settings.tsx?raw";

// From one handler's declaration to the next declaration in the component.
const body = (name: string, next: string) => {
  const from = settingsSrc.indexOf(`const ${name} = () =>`);
  return from < 0 ? "" : settingsSrc.slice(from, settingsSrc.indexOf(`const ${next} = `, from));
};

describe("an audio-folder move lands the parked record writes, never drops them", () => {
  it("Change… awaits the flush before moving and drops nothing", () => {
    const src = body("changeRecDir", "resetRecDir");
    expect(src).toMatch(/await flushRecordWrites\(\);[\s\S]*await moveAudioBase\(from, picked\);/);
    expect(src).not.toContain("dropPendingWrites(");
  });

  it("Reset moves only after the flush settled and drops nothing", () => {
    const src = body("resetRecDir", "runEvdevSetup");
    expect(src).toMatch(/flushRecordWrites\(\)\s*\.then\(\(\) => moveAudioBase\(basePref, null\)\)/);
    expect(src).not.toContain("dropPendingWrites(");
  });
});
