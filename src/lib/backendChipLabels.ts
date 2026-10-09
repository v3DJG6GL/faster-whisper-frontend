// The small chips that say which server build a backend runs and where its model runs:
// "v0.1.153" (connections[id].serverVersion, from /v1/models) and "CUDA" / "CPU" (the backend's
// model's `device` in /v1/models — a loaded model's real device, so a CPU fallback shows).
// Shown in the backend pickers, the Backends list row and the editor header; ModelPicker shows
// each model's device chip. Both values come from the server, so both are bounded here.

import { ownProp } from "./own";
import type { Backend, ConnectionInfo, ServerModel } from "./types";

/** A version as its chip: "v0.1.153"; undefined when there is none or it isn't version-shaped. */
export function versionChip(v: string | undefined | null): string | undefined {
  const t = typeof v === "string" ? v.trim().replace(/^v/i, "") : "";
  return /^[0-9][0-9A-Za-z.+-]{0,23}$/.test(t) ? `v${t}` : undefined;
}

/** A model device as its chip: "CUDA", "CPU"; undefined for anything not a short token. */
export function deviceChip(device: string | undefined | null): string | undefined {
  return typeof device === "string" && /^[a-z0-9_:-]{1,16}$/i.test(device) ? device.toUpperCase() : undefined;
}

const tail = (id: string) => id.split("/").pop() ?? id;

/** The OpenAI model alias the server maps to its default model (and does not list). */
export const WHISPER_ALIAS = "whisper-1";

/** Where the backend's default model runs: the model it names (by id, else by the same last path
 *  part, "org/large-v3" ~ "large-v3"), else — a backend that leaves the model to the server, or
 *  names the OpenAI alias "whisper-1" the server maps to its default (and does not list) — the
 *  device every listed model shares (or its only model's). /v1/models does not say which model is
 *  the default, but always lists it, loaded or not: a device all listed models agree on is the
 *  default's too. Any split (a per-model device override, or a model on another device still
 *  loaded beside an unloaded default) gives no chip rather than a guess — callers that know the
 *  resolved default name pass it instead. */
export function modelDevice(models: readonly ServerModel[] | undefined, model: string): string | undefined {
  if (!models?.length) return undefined;
  const m = model.trim();
  const byName = m ? (models.find((x) => x.id === m) ?? models.find((x) => tail(x.id) === tail(m))) : undefined;
  if (byName) return deviceChip(byName.device);
  if (m && m !== WHISPER_ALIAS) return undefined;
  const first = deviceChip(models[0].device);
  return first && models.every((x) => deviceChip(x.device) === first) ? first : undefined;
}

/** The chips of one backend, from its last connection result: [version, device], each only when
 *  known. */
export function backendChips(b: Pick<Backend, "model">, conn: ConnectionInfo | undefined): string[] {
  if (!conn?.ok) return [];
  return [versionChip(conn.serverVersion), modelDevice(conn.models, b.model)].filter((c): c is string => !!c);
}

/** Backend picker options (value = backend id) with each backend's chips attached. */
export function withBackendChips<O extends { value: string }>(
  options: O[],
  backends: readonly Pick<Backend, "id" | "model">[],
  connections: Record<string, ConnectionInfo | undefined> | undefined,
): (O & { chips?: string[] })[] {
  return options.map((o) => {
    const b = backends.find((x) => x.id === o.value);
    const chips = b ? backendChips(b, ownProp(connections, b.id)) : [];
    return chips.length ? { ...o, chips } : o;
  });
}
