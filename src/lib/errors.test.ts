// The truthful error template: classified transport strings in, cause +
// backend + one fix out. The exact friendly_err phrases come from
// src-tauri/src/transport/mod.rs — keep the two in step.
import { describe, expect, it } from "vitest";
import {
  describeTransportError,
  doorwayBackendLabel,
  errorText,
  handedOffDoorway,
  isAnsweredError,
  shortCause,
  transportErrorDoorway,
  translateFailureDoorway,
  uploadTooLarge,
  uploadTooLargeText,
} from "./errors";
import { backendLabels, newBackendDraft } from "./backends";

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

  it("a rejected TLS certificate keeps the connect title but names the certificate as the fix", () => {
    const cert = describeTransportError(
      "transcribe",
      "Could not connect — the server's TLS certificate isn't trusted (expired, self-signed or for another name).",
      "GPU box",
    );
    expect(cert.title).toBe("Could not reach GPU box — nothing was started.");
    expect(cert.hint).toBe(
      "The server's TLS certificate isn't trusted — expired, self-signed or issued for another name.",
    );
    expect(cert.hint).not.toMatch(/server running/);
    expect(cert.showLogs).toBe(false);
    const plain = describeTransportError(
      "transcribe",
      "Could not connect — is the server running and the URL correct?",
      "GPU box",
    );
    expect(plain.hint).toBe("Is the server running and the URL correct?");
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

  it("a refusal from a missing backend opens its sentence capitalized; a real name keeps its casing", () => {
    expect(describeTransportError("transcribe", "HTTP 401: unauthorized", "").title).toBe(
      "The backend rejected the request (HTTP 401).",
    );
    expect(describeTransportError("transcribe", "HTTP 403: forbidden", "the backend").title).toBe(
      "The backend rejected the request (HTTP 403).",
    );
    expect(describeTransportError("transcribe", "HTTP 401: unauthorized", "gpu box").title).toBe(
      "gpu box rejected the request (HTTP 401).",
    );
  });

  it("keeps the picker's collision suffix, even on a full-length name", () => {
    expect(doorwayBackendLabel("Local \u00b7 10.0.0.5:8000")).toBe("Local \u00b7 10.0.0.5:8000");
    // Two same-named backends at the 80-codepoint name cap: the doorway must still tell them apart.
    const name = "W".repeat(80);
    const all = ["http://10.0.0.5:8000", "http://10.0.0.6:8000"].map((serverUrl, i) => ({
      ...newBackendDraft(), id: `id${i}`, name, serverUrl,
    }));
    const [a, b] = all.map((x) => backendLabels(all).get(x.id));
    expect(doorwayBackendLabel(a)).toBe(`${name} \u00b7 10.0.0.5:8000`);
    expect(transportErrorDoorway("transcribe", "HTTP 500", a ?? "").msg).not.toBe(
      transportErrorDoorway("transcribe", "HTTP 500", b ?? "").msg,
    );
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

describe("isAnsweredError", () => {
  it("a status or an unreadable body was an answer; no answer is a transport failure", () => {
    // Rust's progress()/getJob shapes: "HTTP <status>", json_capped_to's body and serde errors.
    for (const m of [
      "HTTP 404", "HTTP 503", "malformed job id",
      "The server sent an unreasonably large response — ignoring it.",
      "The server sent a response that wasn't valid text.",
      "expected value at line 1 column 1", "invalid type: string \"x\", expected f64",
      "missing field `stage`",
    ]) expect(isAnsweredError(m)).toBe(true);
    // friendly_err: connect, timeout, and reqwest's own text for a dropped connection.
    for (const m of [
      "Could not connect — is the server running and the URL correct?",
      "Timed out waiting for the server.", "error sending request", "error decoding response body",
      "Error: Not running in the desktop app.",
    ]) expect(isAnsweredError(m)).toBe(false);
  });
});
