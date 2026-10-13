// A PATCH the server refuses for this caller (403 — the list was locked after quick-add loaded)
// must not be a retryable "error": quick-add would re-PATCH the refused list on every summon and
// never re-run the refresh write gate that shows "List locked".
import { describe, expect, it } from "vitest";
import { quickAddSaveOutcome } from "./quickAddSave";
import type { PipelineSaveResult } from "./types";

function reply(over: Partial<PipelineSaveResult>): PipelineSaveResult {
  return { ok: false, status: 0, saved: [], conflicts: [], requires_restart: false, ...over };
}

describe("quickAddSaveOutcome", () => {
  it("treats a 403 (list locked) as refused, not a retryable error", () => {
    expect(quickAddSaveOutcome(reply({ status: 403, detail: "locked" }))).toBe("refused");
  });

  it("keeps transient failures retryable, including a 401 (a fixable key must not drop the addition)", () => {
    expect(quickAddSaveOutcome(reply({ status: 401 }))).toBe("error");
    expect(quickAddSaveOutcome(reply({ status: 500 }))).toBe("error");
    expect(quickAddSaveOutcome(reply({ status: 0 }))).toBe("error");
    expect(quickAddSaveOutcome(reply({ status: 422 }))).toBe("error");
  });

  it("reports a landed save, including a 2xx whose reply could not be read", () => {
    expect(quickAddSaveOutcome(reply({ ok: true, status: 200 }))).toBe("saved");
    expect(quickAddSaveOutcome(reply({ ok: false, status: 200 }))).toBe("saved");
  });

  it("reports an env-pinned rule list as pinned, only on a readable reply", () => {
    expect(quickAddSaveOutcome(reply({ ok: true, status: 200, env_pinned_ignored: ["PIPELINE_RULES"] }))).toBe("pinned");
    expect(quickAddSaveOutcome(reply({ ok: true, status: 200, env_pinned_ignored: ["OTHER"] }))).toBe("saved");
  });
});
