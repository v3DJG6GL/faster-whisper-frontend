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
  const msg = String(e ?? "");
  if (msg.includes("Could not connect")) {
    return {
      title: `Could not reach ${backendLabel} — nothing was started.`,
      hint: "Is the server running and the URL correct?",
      showLogs: false,
    };
  }
  if (/timed out/i.test(msg)) {
    return {
      title: `Lost contact with ${backendLabel} while ${GERUND[kind]}.`,
      hint: "The server may still be working — check it, then try again.",
      showLogs: true,
    };
  }
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) {
    const code = Number(http[1]);
    if (kind === "translate" && (code === 403 || /\bdisabled\b/i.test(msg))) {
      return {
        title: `Translation is turned off on ${backendLabel}.`,
        hint: "Enable it there, or pick another backend.",
        showLogs: true,
      };
    }
    if (code === 401 || code === 403) {
      return {
        title: `${backendLabel} rejected the request (HTTP ${code}).`,
        hint: "Check the backend's API key.",
        showLogs: true,
      };
    }
    return {
      title: `${NOUN[kind]} failed on ${backendLabel} (HTTP ${code}).`,
      hint: "",
      showLogs: true,
    };
  }
  return { title: `${NOUN[kind]} failed on ${backendLabel}.`, hint: "", showLogs: true };
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
