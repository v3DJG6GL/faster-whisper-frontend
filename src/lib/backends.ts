// Backend-resolution helpers shared by transport call sites.

import type { AppSettings, Backend, ConnectionInfo } from "./types";
import { classifyConnection } from "./serverKind";
import { backendDisplayName, dropJoiners, safeIdentityText } from "./sanitize";
import { WHISPER_ALIAS } from "./backendChipLabels";
import { languageCodeOf } from "./languages";

/** Rust `str::trim` at both edges: the Unicode White_Space property (U+FEFF is not in it). */
const RUST_TRIM =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** The preprocessing WHATWG performs BEFORE it looks for a scheme, reproduced so the tests below
 *  judge the same string the parsers do.
 *
 *  Both the browser's `URL` and Rust's `url` crate (behind reqwest) delete every ASCII tab, LF and
 *  CR from ANYWHERE in the input, and strip leading/trailing C0 controls and spaces. Testing the
 *  raw string instead let `"h<TAB>ttp://evil.tld"` read as SCHEMELESS here — so it was stored, and
 *  `http://` was prepended for display, making every helper below see host `"http"` (dotless, so
 *  `isLocalAddress` returned true and the not-encrypted warning was suppressed) while reqwest
 *  resolved evil.tld and sent it the bearer key, the uploaded audio and the sync blob — which
 *  carries every backend's plaintext key. A leading NUL was the same bug via the other rule: JS
 *  `trim()` does not strip C0, but both parsers do.
 *
 *  Before both, the Rust transport `str::trim`s the stored address (base_url, the stream URL),
 *  which strips the Unicode White_Space set at the edges — U+00A0, U+2028, U+3000 … A synced
 *  "http://localhost:8000@evil.tld<NBSP>" then connected to evil.tld while every helper here saw an
 *  unparseable address and showed no host and no plaintext warning. So the edges lose that set
 *  first, exactly: not JS `\s`, which also holds U+FEFF (Rust's trim keeps it; so do the parsers,
 *  and the address then fails to parse on both sides). Inside the address nothing changes. */
export function stripUrlNoise(raw: string): string {
  return (
    raw
      .replace(RUST_TRIM, "")
      .replace(/[\t\n\r]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "")
  );
}

/** Loose user input → a connectable URL: trim, strip trailing slashes, default
 *  the scheme to http (LAN servers are the common case). Shared by the
 *  first-run gate and the Backends connect step so both accept "host:8000". */
export function normalizeUrl(raw: string): string {
  const t = stripUrlNoise(raw).replace(/\/+$/, "");
  if (/^https?:\/\//i.test(t)) return t;
  return isSchemelessAddress(t) ? `http://${t}` : "";
}

/** A Server URL typed in the Backend editor → the form to STORE and send: a schemeless
 *  `host:8000` gains `http://` (as the connect step and the sync sanitizer already store it),
 *  because the Rust transport only trims and reqwest rejects an address without a scheme —
 *  the field showed it as valid while Test, Save and every transcription failed. An http(s)
 *  URL is kept as typed (no trailing-slash stripping, so a stored URL is not re-evicted on
 *  an unchanged save), and anything else stays verbatim so the connect error still names it. */
export function storedTypedUrl(raw: string): string {
  // A lenient http(s) scheme (`http:/h`, `HTTPS:\\h`) is canonicalised first: WHATWG reads it as
  // `http://h`, but it fails the two-slash test, so it used to be stored verbatim — reqwest then
  // connected in cleartext while the not-encrypted warning (which parsed it as nothing) stayed
  // silent and the WS URL built from it was garbage. With NO slash (`http:evil.tld:8000`) the
  // parsers still read a special scheme followed by the authority, so it gains `//` too — unless
  // the remainder is a port (the isSchemelessAddress rule): `http:8000` (host `http`, port 8000)
  // keeps its schemeless meaning, and a bare `http:` is left alone. A URL that already passes
  // is left untouched, so a stored URL is not rewritten (and re-evicted) on an unchanged save.
  let t = stripUrlNoise(raw.trim());
  if (!/^https?:\/\//i.test(t)) {
    const canon = (_m: string, s: string) => `${s.toLowerCase()}://`;
    t = t.replace(/^(https?):[\\/]+/i, canon).replace(/^(https?):(?![\\/]|\d+(?:\/|$))(?=\S)/i, canon);
  }
  return !t || /^https?:\/\//i.test(t) ? t : normalizeUrl(t) || t;
}

/** A typed address → the connectable form: the stored form (storedTypedUrl), then normalised.
 *  ONE spelling for every screen that tests or compares a typed address (setup, the connect step,
 *  the not-encrypted warning) — Onboarding's live-target guard only holds while its two sides
 *  are computed identically. "" when the address is not usable. */
export function typedServerUrl(raw: string): string {
  return normalizeUrl(storedTypedUrl(raw));
}

/** The backend the Backends connect-first restore hands the just-typed API key to: the first one
 *  whose stored address normalizes to the server it connected to. ONE rule for the restore that
 *  writes the key and the consent dialog that must not call that backend keyless. */
export function backendForAddress(list: Backend[], address: string): Backend | undefined {
  const target = normalizeUrl(address);
  return list.find((b) => normalizeUrl(b.serverUrl) === target);
}

/** The restore dialog's key fates (`backendKeyFates`) once the caller supplies a key for
 *  `keyFor`: the backend that key lands on (`backendForAddress` over the list the restore
 *  installs) neither needs one re-entered nor keeps this device's old key — the restore writes
 *  the typed key over it. No address → unchanged. */
export function fatesAfterSuppliedKey<F extends { missing: Backend[]; moved: { backend: Backend }[] }>(
  fates: F,
  installed: Backend[],
  keyFor?: string,
): F {
  const supplied = keyFor ? backendForAddress(installed, keyFor) : undefined;
  if (!supplied) return fates;
  return {
    ...fates,
    missing: fates.missing.filter((b) => b.id !== supplied.id),
    moved: fates.moved.filter((m) => m.backend.id !== supplied.id),
  };
}

/** Does this string carry NO scheme, so that prefixing `http://` is honest?
 *
 *  The two-slash test above is not the same rule the parsers use. WHATWG (the browser's `URL`,
 *  and Rust's `url` crate behind reqwest) also honours a scheme written with ONE slash, a
 *  backslash, or none at all — so `https:/evil.tld` fails the test above, gets `http://`
 *  PREPENDED, and then reads as host `https` to every helper here while reqwest connects to
 *  evil.tld. That made the address shown on the backends card and in the sync consent dialog
 *  disagree with where the audio and the bearer key actually went, and (host `http`, no dot)
 *  it also read as a bare LAN name, which suppressed the not-encrypted warning.
 *
 *  A colon alone cannot be the test: `host:8000` is the LAN form this function exists to
 *  accept. A scheme is a colon whose remainder is not a port, so require digits after it. */
function isSchemelessAddress(t: string): boolean {
  const m = t.match(/^[a-z][a-z0-9+.-]*:(.*)$/is);
  return !m || /^\d+(\/|$)/.test(m[1]);
}

/** May this address be STORED as a backend's `serverUrl`? Applied where an address arrives from
 *  somewhere other than the user's own keyboard (a sync pull, an imported file), because those
 *  paths keep the string verbatim and hand it straight to the transport. */
export function isStorableServerUrl(raw: string): boolean {
  const t = stripUrlNoise(raw);
  return t === "" || /^https?:\/\//i.test(t) || isSchemelessAddress(t);
}

/** True for addresses that never leave the user's own machine or LAN, where plain http is the
 *  normal, expected setup: loopback, an mDNS/`.local` name, a bare hostname with no dot, and the
 *  private + link-local IPv4 ranges. Everything else is a route across networks the user does
 *  not control. */
function isLocalAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".home.arpa") || h.endsWith(".internal")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare LAN hostname
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  // ULA / link-local, but ONLY for an IPv6 LITERAL — an IPv6 address always contains ":".
  // Testing the prefix on any non-dotted-quad host classified every public DNS name beginning
  // "fc" or "fd" (fcc.gov, fdic.gov, fc2.com …) as LAN and silently suppressed the warning.
  if (!v4) return h.includes(":") && (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:"));
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  // 0.0.0.0/8 = "this host", never routed — the bind-all address uvicorn prints at startup.
  return (
    a === 0 || a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

/** A warning to show next to a server address that is BOTH unencrypted and outside the user's
 *  own network, or `null` when there is nothing to warn about. Over such a link the API key, the
 *  microphone audio, the transcripts and the whole synced settings blob travel readable — and an
 *  attacker on the path can also rewrite what comes back. Deliberately silent for LAN and
 *  loopback addresses: a self-hosted server without a certificate is the common, intended case,
 *  and a warning that fires there is one the user learns to ignore. */
export function insecureUrlWarning(url: string): string | null {
  let parsed: URL;
  try {
    // Judge the form that is stored and sent, so a lenient `http:/host` is warned about too.
    parsed = new URL(typedServerUrl(url));
  } catch {
    return null; // not a parseable address yet — the connect attempt reports that on its own
  }
  if (parsed.protocol !== "http:") return null;
  if (isLocalAddress(parsed.hostname)) return null;
  return `This address is not encrypted and is outside your own network. Your API key, your microphone audio and everything you dictate would travel readable by anyone on the route. Use https:// if the server supports it.`;
}

/** THE fresh-Backend factory — every surface that mints one (Backends manual
 *  add, Backends connect-first add, Onboarding) goes through here, so the
 *  defaults can't diverge. With a connection: name from the host, batch endpoint
 *  for standard servers, and the model: a full server's default (the inherit
 *  alias, like the language — decided 2026-10-09: /v1/models has no default
 *  marker, so its loaded model may be one another client asked for), a standard
 *  server's loaded (else first) model, since there the alias is a literal name. */
export function newBackendDraft(conn?: {
  serverUrl: string;
  hasApiKey: boolean;
  info: ConnectionInfo;
}): Backend {
  const base: Backend = {
    id: crypto.randomUUID(),
    name: "New backend",
    serverUrl: "http://localhost:8000",
    hasApiKey: false,
    model: WHISPER_ALIAS,
    endpoint: "stream",
    // "" = the server's DEFAULT_LANGUAGE (W6, decided 2026-10-05): a backend added from now on
    // starts on the server's language; backends that already exist keep their "auto".
    language: "",
    prompt: "",
    responseFormat: "verbose_json",
  };
  if (!conn) return base;
  const kind = classifyConnection(conn.info);
  return {
    ...base,
    name: nameFromUrl(conn.serverUrl),
    serverUrl: conn.serverUrl,
    hasApiKey: conn.hasApiKey,
    model:
      kind === "standard"
        ? (conn.info.models.find((m) => m.loaded)?.id ?? conn.info.models[0]?.id ?? base.model)
        : base.model,
    endpoint: kind === "standard" ? "batch" : "stream",
  };
}

/**
 * A Backend's "Default vocabulary / prompt" as the tri-state the wire speaks:
 * `undefined` = inherit (omit the field, so the server's DEFAULT_PROMPT applies),
 * `""` = explicit clear (send an empty prompt, suppressing the inherited one),
 * a value = use it.
 *
 * Stored as a PAIR (`prompt` + `promptCleared`) rather than an optional string, so
 * `Backend.prompt` stays a required string in the Rust config struct: omitting it
 * would make a config written by this build unparseable to any earlier one, and
 * Rust's recovery for an unparseable config is "rename to config.json.bak and load
 * defaults" — i.e. a downgrade would wipe every backend, profile and hotkey. A
 * build that predates the flag simply reads the "" as the inherit it always meant.
 */
export function backendPrompt(b: Pick<Backend, "prompt" | "promptCleared">): string | undefined {
  if (b.prompt) return b.prompt;
  return b.promptCleared ? "" : undefined;
}

/**
 * Effective language: a set per-Profile override wins; else the Backend's. Trims the
 * override so a padded value never reaches a server request — five call sites used to
 * open-code this and only one of them trimmed the value it returned. A word naming a Whisper
 * language (a synced "english") is returned as its code: the server's handshake takes only
 * codes, and the session, its shape, the target picker and every route label must agree on
 * the value that is sent. "auto", blank and anything else stay as given.
 */
export function effectiveLanguage<B extends string | undefined>(
  profileLang: string | undefined,
  backendLang: B,
): string | B {
  const own = profileLang?.trim();
  if (own) return languageCodeOf(own);
  // Trimmed like the profile side (a synced " de " would be sent padded); a whitespace-only
  // value stays as given — still sent, it reads "??".
  const inh = backendLang?.trim();
  return inh ? languageCodeOf(inh) : backendLang;
}

/**
 * Effective server override-profile name: a set own pick (a Profile's, or a Transcribe run's)
 * wins; else the Backend's. Both sides trimmed and a blank inherits, so a blank inherited name is
 * `undefined` (omit the field); NO_OVERRIDE_PROFILE passes through verbatim (it forces "no
 * profile" server-side). startLiveInner, sessionShape, Profiles and Transcribe share it so the
 * profile a label shows is the one a run sends — hand-copied, the copies drifted apart.
 */
export function effectiveOverrideProfile(
  own: string | undefined,
  backendProfile: string | undefined,
): string | undefined {
  return own?.trim() || backendProfile?.trim() || undefined;
}

/**
 * Effective translation model id: a set own pick (a Profile's, or a Transcribe / retro-translate
 * run's) wins; else the Backend's. Both sides trimmed and a blank inherits — the stored values are
 * synced, so stray spaces must not reach the wire or name a different model than the preload plan
 * warms; a blank inherited id is `undefined` (the server's default). The one rule for live
 * dictation, its session shape, the target picker, Transcribe and retro translate.
 */
export function effectiveTranslationModel(
  own: string | undefined,
  backendModel: string | undefined,
): string | undefined {
  return own?.trim() || backendModel?.trim() || undefined;
}

/** Write `backendPrompt`'s tri-state back onto a Backend — spread the result into
 *  the draft (both keys always, so a reset drops a stale flag). */
export function backendPromptFields(
  v: string | undefined,
): Pick<Backend, "prompt" | "promptCleared"> {
  // A non-empty prompt is a set value; the flag only ever qualifies an empty one.
  return { prompt: v ?? "", promptCleared: v === "" ? true : undefined };
}

/** A human default name for a backend at `url` — its host, or a fallback. */
export function nameFromUrl(url: string): string {
  try {
    return new URL(url).host || "My server";
  } catch {
    return "My server";
  }
}

/**
 * The server address to actually CONNECT to for a backend: the per-device
 * override (settings.sync.urlOverrides — "use this address on this device",
 * never synced) when set, else the canonical serverUrl. Keeps synced configs
 * working when machines reach the same server differently (localhost on the
 * box that runs it, a LAN IP elsewhere) without the two URLs ping-ponging
 * through sync. Display contexts keep showing backend.serverUrl.
 */
export function effectiveServerUrl(backend: Backend, settings: AppSettings): string {
  // Read the value out FIRST and type-check it. `?.` guards nullish but NOT prototype-inherited:
  // a backend whose id is "constructor" / "toString" / "valueOf" makes this lookup return a
  // function off Object.prototype, which is non-nullish, so `.trim()` threw — inside a render
  // body, in a tree with no error boundary, so the window unmounted. The `__..__` filter that
  // polices ids only rejects the keyring namespace, so those ids survive sanitization.
  const raw = settings.sync?.urlOverrides?.[backend.id];
  // Stored form, as Server URL is saved: a schemeless `host:8000` typed into "Address on this
  // device" gains `http://`. The Rust transport only trims and reqwest refuses an address without
  // a scheme, so every request for the backend failed while the card showed the address as fine.
  const override = typeof raw === "string" ? storedTypedUrl(raw) : "";
  return override ? override : backend.serverUrl;
}

/** What the app will ACTUALLY connect to, plus a flag when the address hides it behind userinfo.
 *
 *  A URL's real authority is whatever follows the LAST `@`, so `http://localhost:8000@evil.tld/v1`
 *  has host `evil.tld` while reading as loopback. Every surface that shows the user an address to
 *  judge — the security-review dialog, the restore/import previews, the backend cards — parses it
 *  through here rather than printing the raw string. */
export function authorityOf(raw: string): { host: string; hasUserinfo: boolean } | null {
  try {
    const u = new URL(normalizeUrl(raw));
    return { host: u.host, hasUserinfo: !!u.username || !!u.password };
  } catch {
    return null;
  }
}

/** The disambiguating separator. Defined once so the label builder and the forgery test below can
 *  never drift apart — the whole guard rests on the two meaning the same string. */
const SEP = " \u00b7 ";

/** Display labels for a backend list, disambiguated when two of them collide.
 *
 *  The labels are defanged before rendering, which DELETES zero-width and bidi characters — so two
 *  distinct backends named `"Work"` and `"Work\u200b"` draw identically, while the option value
 *  stays the distinct id. A backend RENAME raises no security-review prompt, so a sync server can
 *  relabel an already-approved second backend to collide with the user's real one on an unattended
 *  pull; the affected controls are the ones that decide which server receives a profile's audio and
 *  bearer key, and none of them shows the address. This is the two-arm conflict Segmented's
 *  collision fallback, generalized to an N-option list: on a collision, name the thing the option
 *  actually selects. Legitimate duplicates ("Local" on two machines) simply gain a host suffix.
 *
 *  List-level by design. The per-item form was O(n^2) with an 80-codepoint scan per comparison,
 *  called from three unmemoized render bodies over a list `MAX_SYNCED_ENTRIES` bounds at 500 —
 *  measured at 233ms per render pass. One pass builds the collision counts, then labels. */
export function backendOptions(all: Backend[], max = 80): { value: string; label: string }[] {
  // Joiners (ZWNJ/ZWJ) are dropped from the KEY only: the identity fold keeps interior ones, so
  // `"Wo\u200drk"` would count apart from `"Work"` while drawing exactly like it.
  const norm = (s: string) => dropJoiners(s).replace(/\s+/g, " ").trim().toLowerCase();
  // `safeIdentityText`, not `safeDisplayText`: G4 moved the three identity renders beside a trust
  // decision onto it and this fourth site was missed. `safeDisplayText` passes the invisible class
  // `isInvisibleKeyChar` enumerates — U+2800, U+034F, the variation selectors, the tags block —
  // and `norm`'s `\s+` does not match any of them either, so `"Work" + 90×U+2800` and `"Work"`
  // both draw as exactly `Work` while counting as two distinct labels: neither collides, neither
  // is suffixed, and the Q14 guard is inert for the whole class. A rename raises no
  // SecurityChange, so it arrives on the unattended pull. The pickers this feeds choose which
  // server receives a profile's audio and bearer key, which receives an uploaded file, and which
  // receives the whole synced blob — and none of them shows an address.
  // safeIdentityText drops the invisible head itself: a joiner-only name then takes the blank
  // branch, and a leading-joiner "Work" collides with "Work" and gets its host suffix.
  const labels = all.map((b) => safeIdentityText(b.name, max));
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(norm(l), (counts.get(norm(l)) ?? 0) + 1);
  // A name that already CONTAINS the separator is forced into the suffix branch whatever the
  // counts say. That, and not a second counting pass, is what makes the suffix unforgeable: the
  // collision test compares WHOLE labels, so an impostor renamed to `"Work · good.tld"` is
  // distinct from the real `"Work"` and neither collides — leaving the real one bare while the
  // impostor alone renders in the form that now MEANS "disambiguated, at good.tld". Suffixing it
  // appends its REAL host, so the forgery reads `Work · good.tld · evil.tld` and gives itself away.
  // Tested on the joiner-stripped label like `norm`: an interior ZWJ ("Work \u00b7\u200d good.tld")
  // hides the separator from a raw `includes` while the label draws exactly as the suffixed form.
  // (`safeIdentityText` now folds a joiner touching whitespace itself; the strip stays as the
  // backstop for any joiner the fold keeps.)
  const forgesSuffix = (l: string) => dropJoiners(l).includes(SEP);
  const out = all.map((b, i) => {
    const label = labels[i];
    if (label && (counts.get(norm(label)) ?? 0) < 2 && !forgesSuffix(label)) {
      return { value: b.id, label };
    }
    // The stored address, not the effective one: a per-device URL override is machine-local and
    // rarely set, and this only has to tell two same-named entries apart. A blanked serverUrl (one
    // `isStorableServerUrl` refused) has no host, so fall back to an id fragment.
    const host = authorityOf(b.serverUrl)?.host;
    const suffix = host || `#${b.id.slice(0, 8)}`;
    // A blank name reads "Untitled backend" as backendDisplayName shows it on the Backends list,
    // not a bare host; the raw `label` above still decides the branch, so a blank name always
    // takes the suffix and the final #id pass still separates two blank ones on one host.
    return { value: b.id, label: `${label || backendDisplayName("")}${SEP}${suffix}` };
  });
  // A final pass for labels that are STILL identical — same name AND same host, or two names that
  // both forged their way into the suffix branch. The id fragment is the only term left that a
  // remote name cannot usefully reproduce: it can print some `#aaaaaaaa`, but not one matching the
  // id of the option it wants to be mistaken for, and a wrong fragment beside the right one is
  // itself the tell. Callers append their own suffixes (` (no API key)`) AFTER this function, so
  // the collision test can never be the last word on its own.
  const finalCounts = new Map<string, number>();
  for (const o of out) finalCounts.set(norm(o.label), (finalCounts.get(norm(o.label)) ?? 0) + 1);
  return out.map((o) =>
    (finalCounts.get(norm(o.label)) ?? 0) < 2
      ? o
      : { value: o.value, label: `${o.label}${SEP}#${o.value.slice(0, 8)}` },
  );
}

const labelCache = new WeakMap<Backend[], Map<string, string>>();
/** `backendOptions`' label per backend id — how every surface that names a profile's backend
 *  reads it, so two same-named backends carry their host suffix there as in the pickers. Cached
 *  per list (the store replaces the array on every edit), so per-row callers stay one pass. */
export function backendLabels(all: Backend[]): Map<string, string> {
  let m = labelCache.get(all);
  if (!m) {
    m = new Map(backendOptions(all).map((o) => [o.value, o.label]));
    labelCache.set(all, m);
  }
  return m;
}

/** A backend as the pickers name it; one no longer in `all` (deleted mid-run) falls back to its
 *  own display name. */
export function backendLabel(all: Backend[], b: Backend): string {
  return backendLabels(all).get(b.id) ?? backendDisplayName(b.name);
}

/** backendLabel for a configured id; null when the id is unset or no longer configured. */
export function backendLabelById(all: Backend[], id: string | null | undefined): string | null {
  return id ? (backendLabels(all).get(id) ?? null) : null;
}
