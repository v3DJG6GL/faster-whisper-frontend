// What the backend editor's Save does once its keyring write has landed. The write can sit behind a
// wallet prompt for as long as the user likes; meanwhile the editor may have been left (sidebar or
// a history Back → Discard) or the key field retyped. Either way the draft must not be saved.

import type { Backend } from "./types";

/** Longest API key this app stores, in UTF-16 code units — one bound for both writers: Rust's
 *  `set_backend_key` refuses a longer key (MAX_SECRET_UTF16) and sync drops a longer synced one.
 *  A longer local key would be left out of this device's own snapshot stash, and a later push
 *  would then erase it on the server for every peer. Real API keys and JWTs are far shorter. */
export const MAX_SECRET_LEN = 4096;
/** What the key fields say for a key over MAX_SECRET_LEN (the words Rust's refusal uses). */
export const KEY_TOO_LONG = `The API key is longer than ${MAX_SECRET_LEN} characters, so it was not stored.`;

export type KeyWriteOutcome =
  /** Commit the draft: the keyring now holds exactly the key the user is saving. */
  | { kind: "save" }
  /** The editor unmounted mid-write: the user walked away from this draft, so save nothing. */
  | { kind: "abandoned"; rollBack: boolean; keptInStore: boolean }
  /** The key was retyped mid-write: the keyring holds the OLD one, so the editor stays open. */
  | { kind: "retyped"; rollBack: boolean; keptInStore: boolean };

/**
 * `rollBack`: delete the key just written. Only a backend not in the store yet — it owns no keyring
 * entry, so the write would orphan one. `keptInStore`: a saved backend, which routes with the key
 * just stored from now on — the store must learn of the key change (adoptWrittenKey), as a save
 * would tell it. Leaving wins over retyping: an unmounted editor has nowhere to show the retype
 * message.
 */
export function keyWriteOutcome(o: { left: boolean; retyped: boolean; inStore: boolean }): KeyWriteOutcome {
  if (o.left) return { kind: "abandoned", rollBack: !o.inStore, keptInStore: o.inStore };
  if (o.retyped) return { kind: "retyped", rollBack: !o.inStore, keptInStore: o.inStore };
  return { kind: "save" };
}

/** A key written for saved backend `id` stays although its draft was not saved (keptInStore):
 *  every request now authenticates with it. Do the key-change bookkeeping a save does — the
 *  stored backend claims a key (a keyless one gained one: its badge, the editor's removal and
 *  Sync's warning read it), and the old caller's connection verdict, caps and usage go
 *  (`forget`, which also moves the credential generation so in-flight old-caller answers drop). */
export function adoptWrittenKey(
  id: string,
  store: { backends: Backend[]; upsertBackend: (b: Backend) => void },
  forget: (id: string) => void,
): void {
  const stored = store.backends.find((x) => x.id === id);
  if (!stored) return;
  if (!stored.hasApiKey) store.upsertBackend({ ...stored, hasApiKey: true });
  forget(id);
}
