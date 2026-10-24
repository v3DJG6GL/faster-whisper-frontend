import { backendDisplayName, safeDisplayText } from "./sanitize";
import { fmtBytes } from "./format";
// Truthful error doorways: one template mapping the Rust transport's classified
// error strings (friendly_err's "Could not connect…" / "Timed out…" + the
// "HTTP nnn: detail" form) onto cause + backend name + one fix, instead of every
// call site guessing its own prose.

export type TransportErrorKind = "translate" | "transcribe" | "dictation";

export interface TransportErrorInfo {
  /** What happened, naming the backend — never speculation. */
  title: string;
  /** One actionable fix ("" when the title already says it all). */
  hint: string;
  /** Whether the log actually carries MORE than the title — drives the
   *  doorway's "View logs" affordance (a fully-explained connect refusal
   *  has nothing more to show). */
  showLogs: boolean;
}

const NOUN: Record<TransportErrorKind, string> = {
  translate: "Translation",
  transcribe: "Transcription",
  dictation: "Dictation",
};
const GERUND: Record<TransportErrorKind, string> = {
  translate: "translating",
  transcribe: "transcribing",
  dictation: "dictating",
};

/** An error as text for a sentence or a row: its message without the "Error: " prefix
 *  String(e) adds, bounded to `max` characters. */
export function errorText(e: unknown, max = Infinity): string {
  return String(e).replace(/^Error:\s*/, "").slice(0, max);
}

/** The transport error's cause in a few words — for call sites that keep
 *  their own sentence and just want the reason appended. */
export function shortCause(e: unknown): string {
  const msg = String(e ?? "");
  if (msg.includes("Could not connect")) return "could not connect";
  // HTTP first: a server refusal whose body mentions a timeout (a 503 "timed out waiting for
  // a peer worker") is an answer, not lost contact. Rust's own timeouts never carry "HTTP nnn".
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) return `HTTP ${http[1]}`;
  if (/timed out/i.test(msg)) return "timed out";
  return "see the log";
}

/** Did the server answer the request this Rust error comes from? A status it answered (Rust's
 *  "HTTP <code>"), an over-large or unreadable body, a serde parse failure and a malformed
 *  job id all say so; only a request that got no answer (connect, timeout, a dropped
 *  connection) does not. Rust carries no kind on the error, so this reads its fixed message
 *  shapes (transport/jobs.rs, transport/mod.rs body_capped_to / json_capped_to); anything
 *  unrecognised counts as no answer. */
export function isAnsweredError(message: string): boolean {
  return (
    /^HTTP \d/.test(message) ||
    message === "malformed job id" ||
    message.startsWith("The server sent an unreasonably large response") ||
    message.startsWith("The server sent a response that wasn't valid text") ||
    / at line \d+ column \d+$/.test(message) ||
    /^(invalid (type|value|length)|unknown (variant|field)|missing field|duplicate field|expected |EOF while parsing|trailing (characters|comma)|control character|number out of range|key must be|lone leading surrogate|recursion limit exceeded)/.test(message)
  );
}

/** Rust's refusal of a file over the server's upload limit (`batch::UploadTooLarge`), read back
 *  from its fixed `upload_too_large:<bytes>:<limit>` shape; null for any other error. */
export function uploadTooLarge(e: unknown): { size: number; limit: number } | null {
  const m = /upload_too_large:(\d+):(\d+)/.exec(String(e ?? ""));
  return m ? { size: Number(m[1]), limit: Number(m[2]) } : null;
}

/** The sentence for an over-limit file, naming both sizes in decimal units (fmtBytes) — the
 *  queue row's error. null for any other error. */
export function uploadTooLargeText(e: unknown): string | null {
  const t = uploadTooLarge(e);
  return t ? `The file is ${fmtBytes(t.size)}, over the server's upload limit of ${fmtBytes(t.limit)} — nothing was uploaded.` : null;
}

/** A backend as the doorway names it: the same rendering every list and picker uses
 *  (`backendDisplayName` — invisible head dropped, identity-folded, capped), so a blank or
 *  invisible-only synced name reads "Untitled backend" here too, never an empty gap. Only a
 *  missing/empty label keeps the sentence's own "the backend" (a caller passing that literal gets
 *  it back verbatim). Callers pass the picker's label (`backendLabels`), whose collision suffix
 *  (` · host`, ` · #id`) can carry an 80-codepoint name past 80: the cap is the name's plus room
 *  for that suffix, so the re-fold (idempotent on an already-folded label) never cuts it off. */
export const doorwayBackendLabel = (name: unknown): string =>
  typeof name === "string" && name !== "" ? backendDisplayName(name, 160) : "the backend";

/** Classify a transport-layer failure into the app-global error template. */
export function describeTransportError(
  kind: TransportErrorKind,
  e: unknown,
  backendLabel: string,
): TransportErrorInfo {
  // Defang once at the template boundary: the label is a peer-authored backend name shown on
  // the fixed doorway banner, the one surface above every screen.
  const label = doorwayBackendLabel(backendLabel);

  const msg = String(e ?? "");
  const big = uploadTooLarge(e);
  if (big) {
    return {
      title: `The file is ${fmtBytes(big.size)}, over ${label}'s upload limit of ${fmtBytes(big.limit)} — nothing was uploaded.`,
      hint: "",
      showLogs: false,
    };
  }
  if (msg.includes("Could not connect")) {
    return {
      title: `Could not reach ${label} — nothing was started.`,
      // friendly_err names a rejected certificate: "is the server running?" would send a user whose
      // LAN backend has a self-signed or expired certificate after the wrong problem.
      hint: msg.includes("TLS certificate")
        ? "The server's TLS certificate isn't trusted — expired, self-signed or issued for another name."
        : "Is the server running and the URL correct?",
      showLogs: false,
    };
  }
  // HTTP before the timeout test: a server refusal whose body says "timed out" (a 503 from a
  // peer-convert wait) is an answer from the server, not lost contact.
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) {
    const code = Number(http[1]);
    // Only a 403 whose body SAYS so is "turned off": a bare 403 on a translate job is the
    // server refusing the key (missing, wrong, or without translate permission), and
    // "enable translation" would send that user after the wrong problem. Any other status is a
    // failure of an enabled feature — a 400 naming LOCAL_FILES_ONLY "disabled" (an uncached
    // model on an offline server) is not the switch.
    const off = /\b(disabled|not enabled)\b/i.test(msg);
    if (kind === "translate" && code === 403 && off) {
      return {
        title: `Translation is turned off on ${label}.`,
        hint: "Enable it there, or pick another backend.",
        showLogs: true,
      };
    }
    // The templates that OPEN with the label: the fallback is capitalized here, a backend's own
    // name keeps the casing its author gave it.
    const subject = label === "the backend" ? "The backend" : label;
    // The other feature switches (URL download, video download) answer 403 "<feature> is not
    // enabled on this server": the key is fine, so the server's own sentence names the switch.
    if (code === 403 && off) {
      const said = safeDisplayText(/HTTP \d{3}:\s*(.*)/.exec(msg)?.[1] ?? "", 200).replace(/[\s.]+$/, "");
      return {
        title: `${subject} has this feature turned off.`,
        hint: `${said ? `${said[0].toUpperCase()}${said.slice(1)}. ` : ""}Enable it there, or pick another backend.`,
        showLogs: true,
      };
    }
    if (code === 401 || code === 403) {
      return {
        title: `${subject} rejected the request (HTTP ${code}).`,
        hint:
          kind === "translate"
            ? "Check the backend's API key — a key without translate access is refused the same way."
            : "Check the backend's API key.",
        showLogs: true,
      };
    }
    return {
      title: `${NOUN[kind]} failed on ${label} (HTTP ${code}).`,
      hint: "",
      showLogs: true,
    };
  }
  if (/timed out/i.test(msg)) {
    return {
      title: `Lost contact with ${label} while ${GERUND[kind]}.`,
      hint: "The server may still be working — check it, then try again.",
      showLogs: true,
    };
  }
  return { title: `${NOUN[kind]} failed on ${label}.`, hint: "", showLogs: true };
}

/** The dictation per-phrase translate fallback doorway. The client-side causes (our own
 *  budget, our own cancel, an empty answer) are named as such and offer no "View logs":
 *  the Logs buffer is fed by Rust tracing only, so they write nothing there. */
export function translateFailureDoorway(
  cause: "timeout" | "cancelled" | "empty" | "error" | null,
  e: unknown,
): { msg: string; showLogs: boolean } {
  const tail = " — inserted the original text.";
  if (cause === "timeout") return { msg: `Translation took too long${tail}`, showLogs: false };
  if (cause === "cancelled") return { msg: `Translation was cancelled${tail}`, showLogs: false };
  if (cause === "empty") return { msg: `Translation came back empty${tail}`, showLogs: false };
  return { msg: `Translation failed (${shortCause(e)})${tail}`, showLogs: true };
}

/** The doorway for a run whose request lost contact and was handed to its headless watcher:
 *  never "nothing was started" (a dropped connection may have reached the server) and never
 *  "try again" (a retry stops the watcher and deletes the job that would land in History). */
export function handedOffDoorway(
  kind: TransportErrorKind,
  backendLabel: string,
): { msg: string; showLogs: boolean } {
  const label = doorwayBackendLabel(backendLabel);
  return {
    msg: `Lost contact with ${label} while ${GERUND[kind]}. The server may still finish it — the transcript then appears in History on its own.`,
    showLogs: true,
  };
}

/** The failure-doorway payload for setLogsDoorway: title + fix in one line,
 *  "View logs" offered only when the log holds more than the line says. */
export function transportErrorDoorway(
  kind: TransportErrorKind,
  e: unknown,
  backendLabel: string,
): { msg: string; showLogs: boolean } {
  const d = describeTransportError(kind, e, backendLabel);
  return { msg: d.hint ? `${d.title} ${d.hint}` : d.title, showLogs: d.showLogs };
}
