// The truthful error template: classified transport strings in, cause +
// backend + one fix out. The exact friendly_err phrases come from
// src-tauri/src/transport/mod.rs — keep the two in step.
import { describe, expect, it } from "vitest";
import { describeTransportError, shortCause, transportErrorDoorway } from "./errors";

describe("describeTransportError", () => {
  it("connect refusal: names the backend, promises nothing started, no log detour", () => {
    const d = describeTransportError(
      "translate",
      "Could not connect — is the server running and the URL correct?",
      "GPU box",
    );
    expect(d.title).toBe("Could not reach GPU box — nothing was started.");
    expect(d.hint).toMatch(/server running/);
    expect(d.showLogs).toBe(false);
  });

  it("timeout: lost-contact copy per kind", () => {
    const d = describeTransportError("translate", "Timed out waiting for the server.", "GPU box");
    expect(d.title).toBe("Lost contact with GPU box while translating.");
    expect(d.showLogs).toBe(true);
    expect(
      describeTransportError("transcribe", "Timed out waiting for the server.", "X").title,
    ).toContain("while transcribing");
  });

  it("HTTP 403 on a translate job reads as translation-disabled", () => {
    const d = describeTransportError("translate", new Error("HTTP 403: forbidden"), "GPU box");
    expect(d.title).toBe("Translation is turned off on GPU box.");
  });

  it("HTTP 401 elsewhere points at the API key", () => {
    const d = describeTransportError("transcribe", "HTTP 401: unauthorized", "GPU box");
    expect(d.title).toContain("rejected the request (HTTP 401)");
    expect(d.hint).toMatch(/API key/);
  });

  it("other HTTP codes and unknown errors fall back honestly", () => {
    expect(describeTransportError("transcribe", "HTTP 500: boom", "X").title).toBe(
      "Transcription failed on X (HTTP 500).",
    );
    expect(describeTransportError("dictation", "weird", "X").title).toBe(
      "Dictation failed on X.",
    );
  });
});

describe("transportErrorDoorway", () => {
  it("joins title + hint into one doorway line and carries showLogs", () => {
    const d = transportErrorDoorway("translate", "Could not connect — nope", "X");
    expect(d.msg).toBe("Could not reach X — nothing was started. Is the server running and the URL correct?");
    expect(d.showLogs).toBe(false);
  });
  it("skips the joiner when there is no hint", () => {
    expect(transportErrorDoorway("translate", "HTTP 500: boom", "X").msg).toBe(
      "Translation failed on X (HTTP 500).",
    );
  });
});

describe("shortCause", () => {
  it("condenses the known causes", () => {
    expect(shortCause("Could not connect — x")).toBe("could not connect");
    expect(shortCause(new Error("translation timed out"))).toBe("timed out");
    expect(shortCause("HTTP 404: not found")).toBe("HTTP 404");
    expect(shortCause("???")).toBe("see the log");
  });
});
