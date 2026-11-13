// First-run "Restore everything" writes the key proved at the gate over the backend the restored
// copy keeps at the gate's address. When that keyring write fails, only an entry nothing in this
// restore accounts for is dropped: a key the copy carried was written by the apply moments
// earlier, for this very backend, and must survive the failure.
import { describe, expect, it } from "vitest";
import { staleHeldBackend } from "./Onboarding";
import { backend } from "@/lib/sync/syncTestFixtures";

describe("staleHeldBackend: whose keyring entry a failed gate-key write drops", () => {
  const match = backend({ id: "x", hasApiKey: true });
  const other = backend({ id: "y" });
  // The ids this device had before the restore: only the gate's own backend.
  const before: ReadonlySet<string> = new Set(["gate"]);

  it("is none when the restored copy carried the backend's key", () => {
    expect(staleHeldBackend(match, before, { list: [match, other], secrets: { x: "peer-key" } })).toBeNull();
  });

  it("is the backend when its id is new here and the copy carried no key for it", () => {
    expect(staleHeldBackend(match, before, { list: [match, other], secrets: undefined })).toBe(match);
    // A key the apply would not write (empty), or another backend's, is not carried for it.
    expect(staleHeldBackend(match, before, { list: [match, other], secrets: { x: "", y: "peer-key" } })).toBe(match);
  });

  it("is none for an id this device already had", () => {
    expect(staleHeldBackend(match, new Set(["gate", "x"]), { list: [match], secrets: undefined })).toBeNull();
  });
});
