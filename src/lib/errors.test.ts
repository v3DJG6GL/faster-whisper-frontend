// The truthful error template: classified transport strings in, cause +
// backend + one fix out. The exact friendly_err phrases come from
// src-tauri/src/transport/mod.rs — keep the two in step.
import { describe, expect, it } from "vitest";
import {
  describeTransportError,
  doorwayBackendLabel,
  errorText,
  handedOffDoorway,
  shortCause,
  transportErrorDoorway,
  translateFailureDoorway,
  uploadTooLarge,
  uploadTooLargeText,
} from "./errors";

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

  it("a server 503 whose body says 'timed out' is an HTTP refusal, not lost contact", () => {
    const d = describeTransportError(
      "transcribe",
      "HTTP 503: Auto-convert of 'x' timed out waiting for a peer worker",
      "B",
    );
    expect(d.title).toBe("Transcription failed on B (HTTP 503).");
  });

  it("a translate 403 is 'turned off' only when the body says so; a bare one is the key", () => {
    const off = describeTransportError("translate", new Error("HTTP 403: translation disabled"), "GPU box");
    expect(off.title).toBe("Translation is turned off on GPU box.");
    const key = describeTransportError("translate", new Error("HTTP 403: forbidden"), "GPU box");
    expect(key.title).toContain("rejected the request (HTTP 403)");
    expect(key.hint).toContain("API key");
  });

  it("strips bidi and bounds a peer-authored backend name", () => {
    const d = describeTransportError("transcribe", "HTTP 500", "\u202E" + "A".repeat(300));
    expect(d.title).not.toContain("\u202E");
    expect(d.title.length).toBeLessThan(200);
  });

  it("names a blank or invisible-only backend the way the lists do, and drops an invisible head", () => {
    expect(describeTransportError("transcribe", "Could not connect", "\u2800  ").title).toBe(
      "Could not reach Untitled backend — nothing was started.",
    );
    expect(handedOffDoorway("transcribe", "   ").msg.startsWith("Lost contact with Untitled backend")).toBe(true);
    for (const blank of ["\u2800", "\u200d"]) {
      expect(handedOffDoorway("transcribe", blank).msg.startsWith("Lost contact with Untitled backend ")).toBe(true);
      expect(transportErrorDoorway("transcribe", "HTTP 500: boom", blank).msg).toBe(
        "Transcription failed on Untitled backend (HTTP 500).",
      );
    }
    expect(describeTransportError("transcribe", "HTTP 500", "\u200dWork").title).toBe("Transcription failed on Work (HTTP 500).");
    expect(handedOffDoorway("transcribe", "\u2800My server").msg.startsWith("Lost contact with My server ")).toBe(true);
    // A missing name, and the callers' own literal, keep the sentence's wording.
    expect(doorwayBackendLabel(undefined)).toBe("the backend");
    expect(doorwayBackendLabel("")).toBe("the backend");
    expect(doorwayBackendLabel("the backend")).toBe("the backend");
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

  it("prefers the HTTP code over a 'timed out' in the server's body", () => {
    expect(shortCause("HTTP 503: Auto-convert of 'x' timed out waiting for a peer worker")).toBe("HTTP 503");
  });
});

describe("translateFailureDoorway", () => {
  it("names a client-side cause and offers no log that holds nothing", () => {
    expect(translateFailureDoorway("timeout", new Error("no answer within 20s"))).toEqual({
      msg: "Translation took too long — inserted the original text.",
      showLogs: false,
    });
    expect(translateFailureDoorway("cancelled", null).showLogs).toBe(false);
    expect(translateFailureDoorway("empty", null).msg).toContain("came back empty");
  });
  it("a server error keeps the cause and the log doorway", () => {
    const d = translateFailureDoorway("error", "HTTP 500: boom");
    expect(d.showLogs).toBe(true);
    expect(d.msg).toContain("HTTP 500");
  });
});

describe("errorText", () => {
  it("the message without String(e)'s Error: prefix, bounded", () => {
    expect(errorText(new Error("HTTP 500"))).toBe("HTTP 500");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(new Error("x".repeat(300)), 200)).toHaveLength(200);
  });
});

describe("a file over the server's upload limit", () => {
  // Rust refuses it before the upload in a fixed shape (batch::UploadTooLarge).
  const e = "upload_too_large:3210000000:2000000000";

  it("reads both sizes back and names them in decimal units", () => {
    expect(uploadTooLarge(e)).toEqual({ size: 3_210_000_000, limit: 2_000_000_000 });
    expect(uploadTooLargeText(e)).toBe(
      "The file is 3.21 GB, over the server's upload limit of 2.00 GB — nothing was uploaded.",
    );
    expect(uploadTooLarge("HTTP 413: too large")).toBeNull();
    expect(uploadTooLargeText("Could not connect")).toBeNull();
  });

  it("the doorway names the backend and offers no logs", () => {
    const d = describeTransportError("transcribe", e, "studio");
    expect(d.title).toBe("The file is 3.21 GB, over studio's upload limit of 2.00 GB — nothing was uploaded.");
    expect(d.showLogs).toBe(false);
  });
});
