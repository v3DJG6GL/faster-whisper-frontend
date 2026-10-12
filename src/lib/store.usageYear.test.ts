// The Statistics calendar's year document on a failed fetch: same rule as the page document —
// the last good year from the same backend + target stays up, marked failed, never another's.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import type { Backend } from "./types";

const sig = (backendId: string, target: string, w: string) => JSON.stringify([backendId, target, { range: "365", with: w }]);

describe("the Statistics year document on a failed fetch", () => {
  it("keeps the last good year up and marks the new query failed", () => {
    const good = { today: {}, total: {}, series: [] } as never;
    useApp.setState({ usageYear: null });
    useApp.getState().setUsageYear(sig("a", "http://a", "all"), good);
    useApp.getState().setUsageYear(sig("a", "http://a", "dictate"), null);
    expect(useApp.getState().usageYear).toEqual({ sig: sig("a", "http://a", "dictate"), stats: good, failed: true });
    // A repeat failure for the same query is a no-op (same reference).
    const before = useApp.getState().usageYear;
    useApp.getState().setUsageYear(sig("a", "http://a", "dictate"), null);
    expect(useApp.getState().usageYear).toBe(before);
    // A later success for that query clears the failure, even when it equals the carried year.
    useApp.getState().setUsageYear(sig("a", "http://a", "dictate"), good);
    expect(useApp.getState().usageYear).toEqual({ sig: sig("a", "http://a", "dictate"), stats: good });
  });

  it("never carries another backend's or target's year over a failure", () => {
    const good = { today: {}, total: {}, series: [] } as never;
    for (const next of [sig("b", "http://a", "all"), sig("a", "http://other", "all")]) {
      useApp.setState({ usageYear: null });
      useApp.getState().setUsageYear(sig("a", "http://a", "all"), good);
      useApp.getState().setUsageYear(next, null);
      expect(useApp.getState().usageYear).toEqual({ sig: next, stats: null, failed: true });
    }
  });
});

describe("forgetting a backend's caches", () => {
  it("drops the Statistics documents that name it and keeps every other backend's", () => {
    const good = { today: {}, total: {}, series: [] } as never;
    const viewA = { sig: sig("a", "http://a", "all"), stats: good };
    const yearB = { sig: sig("b", "http://b", "all"), stats: good };
    useApp.setState({ usageView: viewA, usageYear: yearB });
    useApp.getState().forgetBackendCaches("b");
    expect(useApp.getState().usageYear).toBeNull();
    expect(useApp.getState().usageView).toBe(viewA);
    const viewB = { sig: sig("b", "http://b", "dictate"), stats: good };
    const yearA = { sig: sig("a", "http://a", "dictate"), stats: good };
    useApp.setState({ usageView: viewB, usageYear: yearA });
    useApp.getState().forgetBackendCaches("b");
    expect(useApp.getState().usageView).toBeNull();
    expect(useApp.getState().usageYear).toBe(yearA);
  });
});

describe("hydrate replacing the backend list", () => {
  const good = { today: {}, total: {}, series: [] } as never;
  const backend = (id: string, hasApiKey: boolean) =>
    ({ id, name: id, serverUrl: `http://${id}`, hasApiKey, model: "large-v3", endpoint: "batch", language: "auto", prompt: "" }) as unknown as Backend;
  const hydrate = (backends: Backend[]) =>
    useApp.getState().hydrate({ settings: useApp.getState().settings, backends, profiles: [], appRules: [], version: CONFIG_VERSION });

  it("drops the Statistics documents of a backend whose key changed and keeps another's", () => {
    const viewA = { sig: sig("a", "http://a", "all"), stats: good };
    const yearA = { sig: sig("a", "http://a", "dictate"), stats: good };
    useApp.setState({ backends: [backend("a", false), backend("b", false)], usage: { a: good, b: good }, usageView: viewA, usageYear: yearA });
    hydrate([backend("a", true), backend("b", false)]); // a key added on another device, pulled
    expect(useApp.getState().usageView).toBeNull();
    expect(useApp.getState().usageYear).toBeNull();
    const viewB = { sig: sig("b", "http://b", "all"), stats: good };
    useApp.setState({ usageView: viewB });
    hydrate([backend("a", false), backend("b", false)]);
    expect(useApp.getState().usageView).toBe(viewB);
  });

  it("drops a document naming a removed backend even with no cache entry for it", () => {
    const viewA = { sig: sig("a", "http://a", "all"), stats: good };
    useApp.setState({ backends: [backend("a", false)], connections: {}, usage: {}, caps: {}, usageView: viewA, usageYear: null });
    hydrate([]);
    expect(useApp.getState().usageView).toBeNull();
  });

  it("keeps the documents by reference when the backends are unchanged", () => {
    const viewA = { sig: sig("a", "http://a", "all"), stats: good };
    const yearA = { sig: sig("a", "http://a", "dictate"), stats: good };
    useApp.setState({ backends: [backend("a", false)], usage: { a: good }, usageView: viewA, usageYear: yearA });
    hydrate([backend("a", false)]);
    expect(useApp.getState().usageView).toBe(viewA);
    expect(useApp.getState().usageYear).toBe(yearA);
  });
});
