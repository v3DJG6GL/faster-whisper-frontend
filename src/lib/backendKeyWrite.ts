// What the backend editor's Save does once its keyring write has landed. The write can sit behind a
// wallet prompt for as long as the user likes; meanwhile the editor may have been left (sidebar →
// Discard, back arrow) or the key field retyped. Either way the draft must not be saved.

export type KeyWriteOutcome =
  /** Commit the draft: the keyring now holds exactly the key the user is saving. */
  | { kind: "save" }
  /** The editor unmounted mid-write: the user walked away from this draft, so save nothing. */
  | { kind: "abandoned"; rollBack: boolean }
  /** The key was retyped mid-write: the keyring holds the OLD one, so the editor stays open. */
  | { kind: "retyped"; rollBack: boolean };

/**
 * `rollBack`: delete the key just written. Only a backend not in the store yet — it owns no keyring
 * entry, so the write would orphan one; a saved backend already routes with the key just stored.
 * Leaving wins over retyping: an unmounted editor has nowhere to show the retype message.
 */
export function keyWriteOutcome(o: { left: boolean; retyped: boolean; inStore: boolean }): KeyWriteOutcome {
  if (o.left) return { kind: "abandoned", rollBack: !o.inStore };
  if (o.retyped) return { kind: "retyped", rollBack: !o.inStore };
  return { kind: "save" };
}
