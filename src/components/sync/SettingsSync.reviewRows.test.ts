// The security review dialog caps its rows, and a peer's blob picks their order: a repoint of a
// server this device already uses must stay in view behind a wall of decoy rows.
import { describe, expect, it } from "vitest";
import type { SecurityChange } from "@/lib/sync/sync";
import { reviewRows } from "./SettingsSync";

const row = (kind: SecurityChange["kind"], backend: string): SecurityChange => ({ kind, backend, detail: backend });

describe("reviewRows", () => {
  it("keeps a server-url row past 50 decoys in view, with the same hidden count", () => {
    const changes = [
      ...Array.from({ length: 50 }, (_, i) => row("new-backend", `decoy${i}`)),
      ...Array.from({ length: 3 }, (_, i) => row("typed-text", `profile${i}`)),
      row("server-url", "home"),
    ];
    const { shown, hidden } = reviewRows(changes);
    expect(shown).toHaveLength(50);
    expect(hidden).toBe(4);
    expect(shown[0]).toMatchObject({ kind: "server-url", backend: "home" });
    expect(shown.slice(1, 4).map((c) => c.backend)).toEqual(["profile0", "profile1", "profile2"]);
    // New servers keep their own order behind them.
    expect(shown.slice(4).map((c) => c.backend)).toEqual(Array.from({ length: 46 }, (_, i) => `decoy${i}`));
  });

  it("keeps the listed order within the cap", () => {
    const changes = [row("new-backend", "a"), row("typed-text", "b"), row("api-key", "c"), row("server-url", "d")];
    expect(reviewRows(changes)).toEqual({ shown: changes, hidden: 0 });
  });
});
