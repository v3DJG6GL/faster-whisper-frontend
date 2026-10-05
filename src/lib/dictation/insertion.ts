// The insertion settings' shared pure pieces: the method options (labels and order pinned
// once for Settings → Dictation, the Profile editor and App Rules — see
// components/DictationFields.tsx) and how much an insertion override layer sets.

import type { InsertMethod, InsertionOverrides } from "../types";

export const METHOD_OPTIONS: { value: InsertMethod; label: string }[] = [
  { value: "paste", label: "Clipboard paste" },
  { value: "direct", label: "Direct typing" },
  { value: "clipboard", label: "Clipboard only" },
];

/** Does this layer override anything? Drives the "· set" / "· inherit" disclosure suffix. */
export function hasInsertionOverrides(v: InsertionOverrides | undefined): boolean {
  return insertionSetCount(v) > 0;
}

/** How many insertion fields an override object sets (the block's "· n set"). */
export function insertionSetCount(v: InsertionOverrides | undefined): number {
  return v ? Object.values(v).filter((x) => x !== undefined && x !== null).length : 0;
}
