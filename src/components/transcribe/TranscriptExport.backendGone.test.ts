// A Save's address is frozen at the click, and its requests can leave many minutes later (the save
// dialog, the export queue, busy retries). Keys resolve by backend id when sent and a sync pull keeps
// a removed backend's key, so every export request checks that its backend still exists first.
import { describe, expect, it } from "vitest";
// Raw source (vite `?raw`): there is no DOM environment to render the panel in.
import src from "./TranscriptExport.tsx?raw";

/** The source between the last `check` before `sender` and the sender itself. */
const before = (sender: string, check: string) => {
  const at = src.indexOf(sender);
  expect(at).toBeGreaterThanOrEqual(0);
  const from = src.lastIndexOf(check, at);
  expect(from).toBeGreaterThanOrEqual(0);
  return src.slice(from, at);
};

describe("export requests send nothing once the Save's backend is gone", () => {
  it("the gone rule matches the jobs ledger's: config loaded and the id no longer listed", () => {
    expect(src).toMatch(
      /return st\.configLoaded && !st\.configLoadFailed && !st\.backends\.some\(\(b\) => b\.id === id\);/,
    );
  });

  it("each sender checks it first", () => {
    // Every queued attempt (the busy retries too), before the package request.
    expect(before("const out = await packageMedia(", "if (backendGone(issuer))")).toMatch(
      /^if \(backendGone\(issuer\)\) \{\s*return \{ kind: "error", detail: BACKEND_GONE_SAVE,/,
    );
    expect(before("fetchUrlVideoOnDemand({", "if (backendGone(issuer))")).toMatch(
      /^if \(backendGone\(issuer\)\) return fail\("error", BACKEND_GONE_SAVE\);/,
    );
    expect(before("void fetchUrlVideo({", "if (")).toMatch(/^if \(!backendGone\(issuer\)\) \{\s*$/);
    expect(before("fetchUrlMedia({", "if (backendGone(")).toMatch(
      /^if \(backendGone\(trBackend\.id\)\) throw new Error\(BACKEND_GONE_SAVE\);/,
    );
    expect(before("getMediaStreams({", "if (")).toMatch(/\|\| backendGone\(trBackend\.id\)\) return;/);
  });
});
