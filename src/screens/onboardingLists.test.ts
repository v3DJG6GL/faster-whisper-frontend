import { describe, expect, it } from "vitest";
import { quickAddListsOf } from "./onboardingLists";
import type { PipelineFetch, PipelineRule } from "@/lib/types";

const map = (name: string, extra: Partial<PipelineRule> = {}): PipelineRule => ({
  name,
  label: name,
  type: "callback:map",
  enabled: true,
  ...extra,
});

const fetchOf = (rules: PipelineRule[], role: "admin" | "user" = "user", editable: Record<string, string[]> = { "callback:map": ["map"] }): PipelineFetch => ({
  ok: true,
  status: 200,
  state: { rules, role, editable_fields: editable },
});

describe("quickAddListsOf", () => {
  it("does not offer (or lead with) a list locked for this role", () => {
    const lists = quickAddListsOf(fetchOf([map("locked", { locked: true }), map("open")]));
    expect(lists.map((r) => r.name)).toEqual(["open"]);
  });

  it("offers nothing when every list is locked, so the no-editable-list notice shows", () => {
    expect(quickAddListsOf(fetchOf([map("a", { locked: true }), map("b", { locked: true })]))).toEqual([]);
  });

  it("offers nothing when the server's editable_fields omit `map` for this account", () => {
    expect(quickAddListsOf(fetchOf([map("a")], "user", { "callback:map": ["enabled"] }))).toEqual([]);
  });

  it("still offers a locked list to an admin, and skips non-map rules", () => {
    const rules = [map("locked", { locked: true }), { ...map("other"), type: "callback:dedup" as const }];
    expect(quickAddListsOf(fetchOf(rules, "admin")).map((r) => r.name)).toEqual(["locked"]);
  });
});
