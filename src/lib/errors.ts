import { safeDisplayText } from "./sanitize";
// Truthful error toasts ("Job Signals"): one template mapping the Rust
// transport's classified error strings (friendly_err's "Could not connect…" /
// "Timed out…" + the "HTTP nnn: detail" form) onto cause + backend name + one
// fix, instead of every call site guessing its own prose. Kept generic across
// job kinds; the translate paths are wired now, other call sites migrate as
// they're touched.

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

/** The transport error's cause in a few words — for call sites that keep
 *  their own sentence and just want the reason appended. */
export function shortCause(e: unknown): string {
  const msg = String(e ?? "");
  if (msg.includes("Could not connect")) return "could not connect";
  if (/timed out/i.test(msg)) return "timed out";
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) return `HTTP ${http[1]}`;
  return "see the log";
}

/** Classify a transport-layer failure into the app-global error template. */
export function describeTransportError(
  kind: TransportErrorKind,
  e: unknown,
  backendLabel: string,
): TransportErrorInfo {
  // Defang once at the template boundary: the label is a peer-authored backend name that
  // otherwise reached the fixed doorway banner — the one surface above every screen — uncapped.
  const label = safeDisplayText(backendLabel, 80) || "the backend";

  const msg = String(e ?? "");
  if (msg.includes("Could not connect")) {
    return {
      title: `Could not reach ${label} — nothing was started.`,
      hint: "Is the server running and the URL correct?",
      showLogs: false,
    };
  }
  if (/timed out/i.test(msg)) {
    return {
      title: `Lost contact with ${label} while ${GERUND[kind]}.`,
      hint: "The server may still be working — check it, then try again.",
      showLogs: true,
    };
  }
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) {
    const code = Number(http[1]);
    // Only a body that SAYS so is "turned off": a bare 403 on a translate job is the
    // server refusing the key (missing, wrong, or without translate permission), and
    // telling that user to "enable translation" sent them after the wrong problem.
    if (kind === "translate" && /\bdisabled\b/i.test(msg)) {
      return {
        title: `Translation is turned off on ${label}.`,
        hint: "Enable it there, or pick another backend.",
        showLogs: true,
      };
    }
    if (code === 401 || code === 403) {
      return {
        title: `${label} rejected the request (HTTP ${code}).`,
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
  return { title: `${NOUN[kind]} failed on ${label}.`, hint: "", showLogs: true };
}

/** The dictation per-phrase translate fallback doorway. The client-side causes (our own
 *  budget, our own cancel, an empty answer) are named as such and offer no "View logs":
 *  the Logs buffer is fed by Rust tracing only, and a client-side budget expiry writes
 *  nothing there — the old text rendered every one of them as "see the log" with a
 *  button that led to nothing. */
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
