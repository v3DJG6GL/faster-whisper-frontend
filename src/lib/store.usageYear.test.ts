// The store's Statistics documents. On a failed fetch the year document follows the page
// document's rule: the last good year from the same backend + target stays up, marked failed,
// never another's. Forgetting, removing or re-keying a backend drops the documents that name it.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import { backend as backendFixture } from "./sync/syncTestFixtures";
import type { Backend } from "./types";

const sig = (backendId: string, target: string, w: string) => JSON.stringify([backendId, target, { range: "365", with: w }]);
/** A good (fetched) usage document; its contents do not matter to these tests. */
const good = { today: {}, total: {}, series: [] } as never;

describe("the Statistics year document on a failed fetch", () => {
  it("keeps the last good year up and marks the new query failed", () => {
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
  const backend = (id: string, hasApiKey: boolean) => backendFixture({ id, name: id, serverUrl: `http://${id}`, hasApiKey });
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
