import { describe, expect, it } from "vitest";
import { newBackendDraft } from "../../lib/backends";
import type { Backend } from "../../lib/types";
import { NO_SYNC_SERVER_LABEL, syncServerOptions } from "./syncServerOptions";

const be = (id: string, name: string): Backend =>
  ({ ...newBackendDraft(), id, name, serverUrl: `http://${id}.lan`, hasApiKey: true });

describe("syncServerOptions", () => {
  const work = be("work1234", "Work");

  it("sync on with no server id: the picker shows a placeholder, not the first backend", () => {
    // Sync was switched on while no backend existed, then "Work" was added.
    const opts = syncServerOptions([work], null, true);
    expect(opts[0]).toEqual({ value: "", label: NO_SYNC_SERVER_LABEL });
    expect(opts.map((o) => o.value)).toEqual(["", "work1234"]);
  });

  it("a server id naming a deleted backend gets the placeholder too", () => {
    expect(syncServerOptions([work], "gone5678", true)[0].label).toBe(NO_SYNC_SERVER_LABEL);
  });

  it("a resolved server, sync off, or no backends at all: no placeholder", () => {
    expect(syncServerOptions([work], "work1234", true).map((o) => o.value)).toEqual(["work1234"]);
    expect(syncServerOptions([work], null, false).map((o) => o.value)).toEqual(["work1234"]);
    expect(syncServerOptions([], null, true)).toEqual([]);
  });

  it("a keyless backend is marked in its label", () => {
    expect(syncServerOptions([{ ...work, hasApiKey: false }], "work1234", true)[0].label).toBe("Work (no API key)");
  });
});
