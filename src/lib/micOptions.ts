// The microphone picker's rows (Settings → Audio), built from the Rust MicInventory.
//
// Design "Microphone Paths" (D74 A, D75 L1, D76 P1, D77 M1, D78 chip):
// - "System default — <what it resolves to now>" first, then one row per microphone.
// - A pinned mic that isn't connected stays selected and is shown as such; dictation uses the
//   default until it is back (Rust resolve_input). The pin is never overwritten.
// - Linux only: "Show all audio paths" adds each mic's ways in — the sound server path and the
//   raw ALSA paths — labelled by what they do, with the technical id beneath.
// Pure, so it is unit-tested apart from the component.

import type { MicInventory, MicPath, MicPathKind } from "./types";

/** cpal host names a saved pin starts with ("<host>:<device>"). Anything else is a display
 *  name saved before pins were device ids. */
const HOSTS = ["pulseaudio", "pipewire", "alsa", "jack", "wasapi", "asio", "coreaudio", "aaudio"];

export function pinHost(id: string | null | undefined): string | null {
  if (!id) return null;
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const host = id.slice(0, i);
  return HOSTS.includes(host) && id.length > i + 1 ? host : null;
}

/** A pre-ids pin: a device's display name rather than "<host>:<device>". */
export function isLegacyPin(id: string | null | undefined): id is string {
  return !!id && id !== "default" && pinHost(id) === null;
}

/** A raw ALSA path — only listed with the advanced paths, so the picker loads them for it. */
export function isAlsaPin(id: string | null | undefined): boolean {
  return pinHost(id) === "alsa";
}

/** The technical id beneath a path row: the device part of the pin. */
export function techId(id: string): string {
  return pinHost(id) ? id.slice(id.indexOf(":") + 1) : id;
}

const PATH_TEXT: Record<Exclude<MicPathKind, "server">, string> = {
  "alsa-shared": "Direct, shared, converts format",
  "alsa-exclusive": "Direct, exclusive, converts format",
  "alsa-raw": "Direct, exclusive, raw hardware",
  "alsa-dsnoop": "Direct, shared, no conversion",
};

export function pathText(kind: MicPathKind, server: MicInventory["server"]): string {
  return kind === "server" ? `Via ${server ?? "the sound server"} — shared, any format` : PATH_TEXT[kind];
}

export function pathBadge(kind: MicPathKind, server: MicInventory["server"]): string {
  return kind === "server" ? (server ?? "Server") : "ALSA";
}

export type MicRow =
  | { type: "default"; value: null; label: string; sub: string }
  | { type: "mic"; value: string; label: string; bluetooth: boolean; missing: boolean }
  | { type: "group"; label: string }
  | { type: "path"; value: string; label: string; techId: string; badge: string; server: boolean }
  | { type: "note"; label: string };

export type SelectableRow = Extract<MicRow, { value: string | null }>;

export function isSelectable(r: MicRow): r is SelectableRow {
  return r.type === "default" || r.type === "mic" || r.type === "path";
}

export interface MicView {
  rows: MicRow[];
  /** The pinned mic isn't in the list (only decided once a list has loaded). */
  missing: boolean;
  /** What the closed picker reads. */
  triggerLabel: string;
  /** What the pinned mic is called (for the "not connected" line). */
  pinnedLabel: string | null;
}

/** The pinned mic's name: the label saved with it, else a legacy pin's own name, else its id. */
export function pinnedName(id: string | null, savedLabel: string | null | undefined): string | null {
  if (!id) return null;
  if (savedLabel) return savedLabel;
  return isLegacyPin(id) ? id : techId(id);
}

export function buildMicView(
  inv: MicInventory | null,
  selectedId: string | null,
  savedLabel: string | null | undefined,
  advanced: boolean,
): MicView {
  const name = pinnedName(selectedId, savedLabel);
  const mics = inv?.mics ?? [];
  const paths: { mic: string; path: MicPath }[] = [
    ...mics.flatMap((m) => m.paths.map((path) => ({ mic: m.label, path }))),
    ...(inv?.otherPaths ?? []).flatMap((g) => g.paths.map((path) => ({ mic: g.label, path }))),
  ];
  const selMic = selectedId ? mics.find((m) => m.id === selectedId) : undefined;
  const selPath = selectedId && !selMic ? paths.find((p) => p.path.id === selectedId) : undefined;
  const missing = !!inv && !!selectedId && !selMic && !selPath;

  const rows: MicRow[] = [
    {
      type: "default",
      value: null,
      label: inv?.defaultLabel ? `System default — ${inv.defaultLabel}` : "System default",
      sub: "Follows your sound settings",
    },
  ];
  // A pinned mic that isn't connected keeps its place at the top of the mic rows (M1).
  if (missing && name) {
    rows.push({ type: "mic", value: selectedId!, label: name, bluetooth: false, missing: true });
  }
  for (const m of mics) {
    rows.push({ type: "mic", value: m.id, label: m.label, bluetooth: m.bluetooth, missing: false });
  }
  if (advanced && inv?.advancedSupported) {
    const groups = [
      ...mics.map((m) => ({ label: m.label, paths: m.paths })),
      ...inv.otherPaths,
    ].filter((g) => g.paths.length > 0);
    for (const g of groups) {
      rows.push({ type: "group", label: `${g.label} — all paths` });
      for (const p of g.paths) {
        rows.push({
          type: "path",
          value: p.id,
          label: pathText(p.kind, inv.server),
          techId: techId(p.id),
          badge: pathBadge(p.kind, inv.server),
          server: p.kind === "server",
        });
      }
    }
    if (groups.length === 0) rows.push({ type: "note", label: "No other audio paths found." });
  }

  let triggerLabel: string;
  if (!selectedId) triggerLabel = "System default";
  else if (selMic) triggerLabel = selMic.label;
  else if (selPath) triggerLabel = `${selPath.mic} · ${techId(selPath.path.id)}`;
  else if (missing) triggerLabel = `${name} (not connected)`;
  else triggerLabel = name ?? "System default"; // list not loaded yet

  return { rows, missing, triggerLabel, pinnedLabel: name };
}

/** The label to save with a pick (so an unplugged pin can still be named). */
export function labelForPick(inv: MicInventory | null, id: string): string | null {
  const mic = inv?.mics.find((m) => m.id === id);
  if (mic) return mic.label;
  for (const g of [...(inv?.mics ?? []), ...(inv?.otherPaths ?? [])]) {
    const p = g.paths.find((x) => x.id === id);
    if (p) return p.kind === "server" ? g.label : `${g.label} · ${techId(p.id)}`;
  }
  return null;
}
