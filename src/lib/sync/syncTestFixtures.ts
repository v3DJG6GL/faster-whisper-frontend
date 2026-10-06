// Shared fixtures for the sync engine's tests.

import type { Backend } from "../types";

/** A minimal full-server Backend ("b1" on a LAN address, no API key), with `over` on top. */
export function backend(over: Partial<Backend> = {}): Backend {
  const b: Backend = {
    id: "b1",
    name: "local",
    serverUrl: "http://10.0.0.2:8000",
    hasApiKey: false,
    model: "large-v3",
    endpoint: "batch",
    language: "auto",
    prompt: "",
    responseFormat: "verbose_json",
    kind: "full",
  };
  return { ...b, ...over };
}
