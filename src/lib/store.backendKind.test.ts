// Saving a backend with a different Server type on the same target: the cached caps were probed
// (or pinned null) under the old kind, so they go; the connection and usage stay. Same for a
// sync pull or import that changes the kind through `hydrate`.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import { backend } from "./sync/syncTestFixtures";

const base = backend({ name: "B", serverUrl: "http://a" });

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

describe("hydrate on a Server type change", () => {
  it("drops the backend's caps but keeps its connection and usage", () => {
    const conn = { ok: true } as never;
    const usage = { today: {} } as never;
    useApp.setState({
      backends: [{ ...base, kind: "standard" }],
      connections: { b1: conn },
      usage: { b1: usage },
      caps: { b1: null },
    });
    useApp.getState().hydrate({
      settings: useApp.getState().settings,
      backends: [{ ...base, kind: "auto" }],
      profiles: [],
      appRules: [],
      version: CONFIG_VERSION,
    });
    const s = useApp.getState();
    expect("b1" in s.caps).toBe(false);
    expect(s.connections.b1).toBe(conn);
    expect(s.usage.b1).toBe(usage);
  });

  it("keeps the caps when the kind is unchanged", () => {
    useApp.setState({ backends: [{ ...base, kind: "full" }], caps: { b1: null } });
    useApp.getState().hydrate({
      settings: useApp.getState().settings,
      backends: [{ ...base, kind: "full" }],
      profiles: [],
      appRules: [],
      version: CONFIG_VERSION,
    });
    expect("b1" in useApp.getState().caps).toBe(true);
  });
});
