// At launch the persisted backlog posts once the config is in. The queue file is usually read
// before the config (the smaller file), and a flush before the config posts nothing — which must
// not leave the backlog waiting for the next poll pass (30 s, or 5 min started hidden in the tray).
import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let ready!: () => void;
  return {
    configReady: new Promise<void>((r) => (ready = r)),
    resolveConfigReady: () => ready(),
    calls: [] as { serverUrl: string; backendId: string }[],
    // The boot store: config still loading, no backends yet.
    state: {
      configLoaded: false,
      configLoadFailed: false,
      backends: [] as { id: string; serverUrl: string }[],
      settings: { sync: { urlOverrides: {} as Record<string, string> } },
    },
  };
});
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  isTauri: true,
  // Last run's unposted outcome.
  loadUsageOutcomes: () =>
    Promise.resolve({
      version: 1,
      items: [
        {
          backendId: "b",
          serverUrl: "u",
          outcome: { job_id: "c".repeat(32), activation: "hold", delivery: "typed", translation: "not_asked" },
          queuedAt: Date.now(),
          attempts: 0,
          nextAt: 0,
        },
      ],
    }),
  saveUsageOutcomes: () => Promise.resolve(),
  postUsageOutcomes: (args: { serverUrl: string; backendId: string }) => {
    h.calls.push({ serverUrl: args.serverUrl, backendId: args.backendId });
    return Promise.resolve({ ok: true, status: 200 });
  },
}));
vi.mock("./store", () => ({ useApp: { getState: () => h.state } }));
vi.mock("./persistence", () => ({ configReady: h.configReady }));

import { initOutcomeQueue } from "./usageOutcome";

it("posts last run's backlog once the config is in, though the queue file was read first", async () => {
  const launched = initOutcomeQueue();
  for (let i = 0; i < 10; i++) await Promise.resolve(); // the queue file is read; the config is still loading
  expect(h.calls).toEqual([]);
  // initConfig: hydrate, setConfigLoaded, then configReady.
  h.state.backends = [{ id: "b", serverUrl: "u" }];
  h.state.configLoaded = true;
  h.resolveConfigReady();
  await launched;
  expect(h.calls).toEqual([{ serverUrl: "u", backendId: "b" }]);
});
