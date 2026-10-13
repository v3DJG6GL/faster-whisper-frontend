// A store's saves must reach Rust in the order they were made: Rust's per-store lock does not
// order invokes (each one's args are deserialised in its own task first), so api.ts sends one
// invoke per store at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Pending {
  cmd: string;
  args: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
const sent: Pending[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    new Promise((resolve, reject) => {
      sent.push({ cmd, args, resolve, reject });
    }),
}));

vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
const api = await import("./api");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sent.length = 0;
});

describe("per-store invoke order", () => {
  it("sends a jobs-ledger save only after the previous one settled, in call order", async () => {
    expect(api.isTauri).toBe(true);
    const a = api.saveJobsLedger({ rows: ["A"] });
    const b = api.saveJobsLedger({ rows: ["B"] });
    await flush();
    expect(sent.map((p) => p.args)).toEqual([{ ledger: { rows: ["A"] } }]);

    sent[0].resolve(undefined);
    await a;
    await flush();
    expect(sent.map((p) => p.args)).toEqual([{ ledger: { rows: ["A"] } }, { ledger: { rows: ["B"] } }]);
    sent[1].resolve(undefined);
    await b;
  });

  it("a failed jobs-ledger save still lets the next one through, and its caller sees the error", async () => {
    const a = api.saveJobsLedger({ rows: ["A"] });
    const b = api.saveJobsLedger({ rows: ["B"] });
    await flush();
    expect(sent).toHaveLength(1);
    sent[0].reject("locked");
    await expect(a).rejects.toBe("locked");
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1].args).toEqual({ ledger: { rows: ["B"] } });
    sent[1].resolve(undefined);
    await b;
  });

  it("a load waits for the jobs-ledger save sent before it", async () => {
    const s = api.saveJobsLedger({ rows: ["A"] });
    const l = api.loadJobsLedger();
    await flush();
    expect(sent.map((p) => p.cmd)).toEqual(["save_jobs_ledger"]);
    sent[0].resolve(undefined);
    await s;
    await flush();
    expect(sent.map((p) => p.cmd)).toEqual(["save_jobs_ledger", "load_jobs_ledger"]);
    sent[1].resolve({ rows: ["A"] });
    await expect(l).resolves.toEqual({ rows: ["A"] });
  });

  it("sync-state saves (and the device-id call that writes the same file) go one at a time", async () => {
    const a = api.saveSyncState({ v: "A" } as never);
    const d = api.syncDeviceInfo();
    const b = api.saveSyncState({ v: "B" } as never);
    await flush();
    expect(sent.map((p) => p.cmd)).toEqual(["save_sync_state"]);
    sent[0].reject("io");
    await expect(a).rejects.toBe("io");
    await flush();
    expect(sent.map((p) => p.cmd)).toEqual(["save_sync_state", "sync_device_info"]);
    sent[1].resolve({ id: "x" });
    await d;
    await flush();
    expect(sent.map((p) => p.args)).toEqual([{ state: { v: "A" } }, undefined, { state: { v: "B" } }]);
    sent[2].resolve(undefined);
    await b;
  });

  it("different stores don't wait on each other", async () => {
    const j = api.saveJobsLedger({ rows: [] });
    const u = api.saveUsageOutcomes([]);
    await flush();
    expect(sent.map((p) => p.cmd)).toEqual(["save_jobs_ledger", "save_usage_outcomes"]);
    sent.forEach((p) => p.resolve(undefined));
    await Promise.all([j, u]);
  });
});
