// Classify a Backend as the full faster-whisper-backend vs a conventional
// OpenAI-compatible Whisper server, so the override editor can disable knobs a
// standard server would silently ignore. Signal: the full backend emits a
// non-standard `boot_id` on GET /v1/models (see transport/discovery.rs); a
// conventional server never does.

import type { Backend, ConnectionInfo } from "./types";

export type ServerKind = "full" | "standard" | "unknown";

/** Classify purely from a connection-test result. Untested / failed ⇒ "unknown". */
export function classifyConnection(info?: ConnectionInfo | null): ServerKind {
  if (!info?.ok) return "unknown";
  return info.bootId != null ? "full" : "standard";
}

/**
 * Effective kind for a Backend: a manual `kind` override wins; otherwise infer
 * from the latest connection test. Callers MUST treat "unknown" as NOT-gated
 * (assume full) — never disable a knob we can't prove is unsupported.
 */
export function effectiveServerKind(backend: Backend, info?: ConnectionInfo | null): ServerKind {
  if (backend.kind === "full" || backend.kind === "standard") return backend.kind;
  return classifyConnection(info);
}
