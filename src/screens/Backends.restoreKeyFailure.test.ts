// The connect-first restore writes the key the user typed over the backend for the server it
// connected to. When that keyring write fails after the restore applied, what happens to the
// backend depends on where the key held under its id came from: a key the blob carried is the one
// the apply has just written for this very backend, and must survive the failure.
import { describe, expect, it } from "vitest";
import { restoreKeyFailure } from "./Backends";
import type { RestorePreApply } from "@/components/sync/SettingsSync";
import { backendKeyFates, carriedKeyIds } from "@/lib/sync/sync";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { backend } from "@/lib/sync/syncTestFixtures";
import type { Backend } from "@/lib/types";

const TYPED = "http://typed.lan:8000";

// As RestoreFromServer builds it: `installed` is the list the apply installs, `secrets` its keys.
const pre = (local: Backend[], installed: Backend[], secrets: unknown): RestorePreApply => ({
  backends: new Map(local.map((b) => [b.id, b])),
  keyMoved: new Set(
    backendKeyFates(installed, secrets, local, DEFAULT_SETTINGS).moved.map((m) => m.backend.id),
  ),
  carried: carriedKeyIds(installed, secrets),
});

describe("restoreKeyFailure: the typed key's write failed after the restore applied", () => {
  const added = backend({ id: "x", serverUrl: TYPED, hasApiKey: true });

  it("keeps the key of a backend the blob added together with its key", () => {
    expect(restoreKeyFailure("x", true, pre([], [added], { x: "peer-key" }))).toEqual({ kind: "keep" });
  });

  it("drops what the keyring holds for a blob-added id whose key was not carried", () => {
    expect(restoreKeyFailure("x", true, pre([], [added], undefined))).toEqual({ kind: "dropHeld" });
    // A key the apply would not write (empty, another id's) is not carried either.
    expect(restoreKeyFailure("x", true, pre([], [added], { x: "", y: "peer-key" }))).toEqual({ kind: "dropHeld" });
    // Backends left out of the restore: nothing was installed, so nothing was carried.
    expect(restoreKeyFailure("x", true, pre([], [], { x: "peer-key" }))).toEqual({ kind: "dropHeld" });
  });

  it("adds this flow's own backend keyless when the restore brought none for the server", () => {
    expect(restoreKeyFailure("draft", false, pre([], [added], { x: "peer-key" }))).toEqual({ kind: "addKeyless" });
  });

  it("moves a backend this device had back when the blob moved it here with no key", () => {
    const here = backend({ id: "x", serverUrl: "http://old.lan:8000", hasApiKey: true });
    expect(restoreKeyFailure("x", true, pre([here], [added], undefined))).toEqual({
      kind: "moveBack",
      serverUrl: "http://old.lan:8000",
    });
    // Moved WITH its key: the carried key replaced this device's, and belongs to this address.
    expect(restoreKeyFailure("x", true, pre([here], [added], { x: "peer-key" }))).toEqual({ kind: "keep" });
  });

  it("leaves a backend this device had at this address as it is", () => {
    const here = backend({ id: "x", serverUrl: TYPED, hasApiKey: true });
    expect(restoreKeyFailure("x", true, pre([here], [added], undefined))).toEqual({ kind: "keep" });
    expect(restoreKeyFailure("x", true, pre([here], [added], { x: "peer-key" }))).toEqual({ kind: "keep" });
  });
});
