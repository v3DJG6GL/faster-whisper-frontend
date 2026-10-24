import { describe, expect, it } from "vitest";
import { fatesAfterSuppliedKey } from "./backends";
import { backendKeyFates } from "./sync/sync";
import { DEFAULT_SETTINGS } from "./defaults";
import { backend } from "./sync/syncTestFixtures";

// The connect-first restore writes the key the user just typed over the stored key of the
// backend for the server it connected to, so the dialog must not say that backend keeps this
// device's key and sends it to the new address.
describe("fatesAfterSuppliedKey — the restore dialog's moved-key notice", () => {
  const local = [backend({ id: "A", name: "Home", hasApiKey: true, serverUrl: "http://old:8000" })];
  const incoming = [backend({ id: "A", name: "Home", hasApiKey: true, serverUrl: "http://new:8000" })];
  const fates = backendKeyFates(incoming, undefined, local, DEFAULT_SETTINGS);

  it("without a typed key the server copy's new address takes this device's key", () => {
    expect(fates.moved.map((m) => [m.backend.id, m.to])).toEqual([["A", "http://new:8000"]]);
    expect(fatesAfterSuppliedKey(fates, incoming, undefined).moved.map((m) => m.backend.id)).toEqual(["A"]);
  });

  it("a key typed for the new address replaces the old one: neither moved nor missing", () => {
    const after = fatesAfterSuppliedKey(fates, incoming, "new:8000");
    expect(after.moved).toEqual([]);
    expect(after.missing).toEqual([]);
  });

  it("a key typed for another address leaves the warning", () => {
    expect(fatesAfterSuppliedKey(fates, incoming, "http://elsewhere:8000").moved.map((m) => m.backend.id)).toEqual(["A"]);
  });
});
