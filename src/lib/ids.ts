// Client-minted ids for server-side entries.

/** A fresh id for a server progress/job entry (a run, a media export, a language check,
 *  a dictation session): 32 hex, the shape the server validates (`^[0-9a-f]{8,64}$`). */
export function newProgressId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
