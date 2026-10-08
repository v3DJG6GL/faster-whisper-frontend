// Saving a backend with a different Server type on the same target: the cached caps were probed
// (or pinned null) under the old kind, so they go; the connection and usage stay.

import { describe, expect, it } from "vitest";
import { useApp } from "./store";
import type { Backend } from "./types";

const base = {
  id: "b1",
  name: "B",
  serverUrl: "http://a",
  hasApiKey: false,
  model: "large-v3",
  endpoint: "batch",
  language: "auto",
  prompt: "",
} as unknown as Backend;

describe("upsertBackend on a Server type change", () => {
  it("drops the backend's caps but keeps its connection and usage", () => {
    const conn = { ok: true } as never;
    const usage = { today: {} } as never;
    useApp.setState({
      backends: [{ ...base, kind: "standard" }],
      connections: { b1: conn },
      usage: { b1: usage },
      caps: { b1: null, b2: null },
    });
    useApp.getState().upsertBackend({ ...base, kind: "auto" });
    const s = useApp.getState();
    expect("b1" in s.caps).toBe(false);
    expect("b2" in s.caps).toBe(true);
    expect(s.connections.b1).toBe(conn);
    expect(s.usage.b1).toBe(usage);
  });

  it("leaves the caps alone when the kind is unchanged", () => {
    const caps = { b1: null };
    useApp.setState({ backends: [{ ...base, kind: "full" }], caps });
    useApp.getState().upsertBackend({ ...base, kind: "full", name: "renamed" });
    expect(useApp.getState().caps).toBe(caps);
  });
});
