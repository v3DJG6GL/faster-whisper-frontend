import { describe, expect, it, vi } from "vitest";

const { getCapabilities } = vi.hoisted(() => ({
  getCapabilities: vi.fn<(args: { serverUrl: string; backendId: string }) => Promise<unknown>>(),
}));
vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), getCapabilities }));

import { targetCap } from "./languages";
import { useApp } from "./store";
import { newBackendDraft } from "./backends";
import {
  credentialGeneration,
  forgetCaps,
  maxTranslationTargets,
  refreshCaps,
  requestCredentialGen,
  sendableTargets,
  translationLanguages,
  translationTargetInfo,
  translationWarm,
} from "./capabilities";
import type { Capabilities } from "./types";

function caps(patch: Partial<Capabilities>): Capabilities {
  return {
    can_request_override_profile: false,
    can_request_decode_overrides: false,
    ...patch,
  };
}

describe("translationWarm", () => {
  it("is null when there are no caps at all", () => {
    expect(translationWarm(null)).toBe(null);
  });

  it("is null on a backend that sends no translation_models field", () => {
    // An older server: absent is UNKNOWN, never "cold" — callers must not gate on it.
    expect(translationWarm(caps({ translation_enabled: true }))).toBe(null);
  });

  it("is false when nothing is loaded", () => {
    expect(
      translationWarm(caps({ translation_models: [{ id: "a", loaded: false }] })),
    ).toBe(false);
  });

  it("is true when any model is loaded and no model is named", () => {
    expect(
      translationWarm(
        caps({
          translation_models: [
            { id: "a", loaded: false },
            { id: "b", loaded: true },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("answers for the named model, not the set", () => {
    const c = caps({
      translation_models: [
        { id: "a", loaded: false },
        { id: "b", loaded: true },
      ],
    });
    expect(translationWarm(c, "b")).toBe(true);
    expect(translationWarm(c, "a")).toBe(false);
  });

  it("is false for a model the server does not list", () => {
    expect(
      translationWarm(caps({ translation_models: [{ id: "a", loaded: true }] }), "gone"),
    ).toBe(false);
  });

  it("falls back to the any-loaded answer for a blank model name", () => {
    expect(
      translationWarm(caps({ translation_models: [{ id: "a", loaded: true }] }), "  "),
    ).toBe(true);
  });

  it("is empty-list false, not null", () => {
    expect(translationWarm(caps({ translation_models: [] }))).toBe(false);
  });
});

describe("translationLanguages", () => {
  const models = [
    { id: "hy-mt", loaded: true, languages: ["de", "fr"] },
    { id: "custom", loaded: false, languages: null },
  ];
  it("reads the named model's list, and the default (first) model's when none is named", () => {
    expect(translationLanguages(caps({ translation_models: models }), "hy-mt")).toEqual(["de", "fr"]);
    expect(translationLanguages(caps({ translation_models: models }), "")).toEqual(["de", "fr"]);
  });
  it("is null (unknown) for a model without a list, an unlisted model, or no caps", () => {
    expect(translationLanguages(caps({ translation_models: models }), "custom")).toBe(null);
    expect(translationLanguages(caps({ translation_models: models }), "other")).toBe(null);
    expect(translationLanguages(caps({}))).toBe(null);
    expect(translationLanguages(null)).toBe(null);
  });
});

describe("translationTargetInfo", () => {
  const models = [
    { id: "org/hy-mt", loaded: true, languages: ["de", "fr"] },
    { id: "custom", loaded: false, languages: null },
  ];
  it("the named model's languages and short name; the server default's without one", () => {
    expect(translationTargetInfo(caps({ translation_models: models }), "custom")).toEqual({ supported: null, modelName: "custom" });
    expect(translationTargetInfo(caps({ translation_models: models }))).toEqual({ supported: ["de", "fr"], modelName: "hy-mt" });
    expect(translationTargetInfo(null, "")).toEqual({ supported: null, modelName: undefined });
  });
});

describe("targetCap", () => {
  it("bounds a seeded cap like the caps one", () => {
    expect(targetCap(3)).toBe(3);
    expect(targetCap(99)).toBe(8);
    expect(targetCap("3")).toBe(8);
    expect(targetCap(undefined)).toBe(8);
  });
});

describe("maxTranslationTargets", () => {
  it("is the app ceiling when the server says nothing usable", () => {
    expect(maxTranslationTargets(null)).toBe(8);
    expect(maxTranslationTargets(caps({}))).toBe(8);
    expect(maxTranslationTargets(caps({ server_info: { limits: {} } }))).toBe(8);
    expect(maxTranslationTargets(caps({ server_info: { limits: { translation_max_targets: 0 } } }))).toBe(8);
  });

  it("takes the lower of the server cap and the app ceiling", () => {
    const at = (n: number) => maxTranslationTargets(caps({ server_info: { limits: { translation_max_targets: n } } }));
    expect(at(3)).toBe(3);
    expect(at(10)).toBe(8);
    expect(at(3.7)).toBe(3);
  });
});

describe("sendableTargets", () => {
  it("drops the codes the wire refuses before it caps, so they take no slot", () => {
    useApp.setState({ caps: {} });
    expect(sendableTargets(["de_CH", "fr", 7, "it", "fr"], "b1")).toEqual(["fr", "it"]);
    expect(sendableTargets(undefined, null)).toEqual([]);
  });

  it("caps at this Backend's translation_max_targets, keeping the first in order", () => {
    useApp.setState({ caps: { b1: caps({ server_info: { limits: { translation_max_targets: 2 } } }) } });
    expect(sendableTargets(["de_CH", "fr", "it", "es"], "b1")).toEqual(["fr", "it"]);
    // Another Backend, or none, is held only to the app's ceiling.
    const ten = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh", "ii", "jj"];
    expect(sendableTargets(ten, "b2")).toHaveLength(8);
    expect(sendableTargets(ten, undefined)).toHaveLength(8);
  });
});

describe("forgetCaps", () => {
  it("drops an in-flight fetch made with a rotated key and lets the next reader re-probe", async () => {
    const b = { ...newBackendDraft(), hasApiKey: true };
    useApp.setState({ backends: [b], connections: {}, caps: {} });
    let resolveOld!: (c: unknown) => void;
    getCapabilities.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
    const old = refreshCaps(b);
    // Key rotated: same address, same key presence — only the generation tells them apart.
    forgetCaps(b.id);
    const fresh = { server_info: { version: "new" } };
    getCapabilities.mockImplementationOnce(async () => fresh);
    // Not coalesced onto the old request, not swallowed by the min-interval floor.
    await refreshCaps(b);
    expect(getCapabilities).toHaveBeenCalledTimes(2);
    expect(useApp.getState().caps[b.id]).toBe(fresh);
    resolveOld({ server_info: { version: "old" } });
    await old;
    expect(useApp.getState().caps[b.id]).toBe(fresh);
  });

  it("bumps the credential generation a connection test snapshots", () => {
    const id = newBackendDraft().id;
    const before = credentialGeneration(id);
    forgetCaps(id);
    expect(credentialGeneration(id)).toBe(before + 1);
    // Per Backend: another id's generation does not move.
    const other = newBackendDraft().id;
    expect(credentialGeneration(other)).toBe(0);
  });

  it("names the stored key's generation only for a request that uses the stored key", () => {
    const id = newBackendDraft().id;
    forgetCaps(id);
    forgetCaps(id);
    expect(requestCredentialGen(id, null)).toBe(2);
    expect(requestCredentialGen(id, "")).toBe(2);
    // A typed key is the request's own credential: no stored generation applies.
    expect(requestCredentialGen(id, "sk-typed")).toBe(0);
    expect(requestCredentialGen(null, null)).toBe(0);
  });
});

describe("refreshCaps after an address change", () => {
  it("does not join a fetch still hanging on the old address", async () => {
    getCapabilities.mockClear();
    const a = { ...newBackendDraft(), serverUrl: "http://10.0.0.1:8000" };
    useApp.setState({ backends: [a], connections: {}, caps: {} });
    // The old host never answers (an unreachable address hangs to the client timeout).
    getCapabilities.mockImplementationOnce(() => new Promise(() => {}));
    void refreshCaps(a);
    const b = { ...a, serverUrl: "http://10.0.0.2:8000" };
    useApp.setState({ backends: [b] });
    const fresh = { server_info: { version: "fixed" } };
    getCapabilities.mockImplementationOnce(async () => fresh);
    await refreshCaps(b, { force: true });
    expect(getCapabilities).toHaveBeenCalledTimes(2);
    expect(getCapabilities.mock.calls[1][0].serverUrl).toBe("http://10.0.0.2:8000");
    expect(useApp.getState().caps[b.id]).toBe(fresh);
  });
});
