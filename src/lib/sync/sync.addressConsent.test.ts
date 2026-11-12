// The security review opens by itself on a pull, and a new-server or moved-address row prints the
// addresses it is about. A login written into one (`user:password@host`) must not put its
// password on screen there: the row masks it as it renders, and only then. The row's `detail`
// stays whole, since it is part of the identity a re-raised review is matched by.

import { describe, expect, it } from "vitest";
import {
  categorySelection,
  consentBackendText,
  consentDetailCap,
  consentDetailText,
  securityChanges,
  type SecurityChange,
} from "./sync";
import { safeIdentityText } from "../sanitize";
import { backend } from "./syncTestFixtures";

const CATS = categorySelection(true);
const M = "•••";

/** The address rows a pull of `incoming` raises on a device holding `local`. */
const rows = (incoming: unknown[], local: unknown[]): SecurityChange[] =>
  securityChanges({ backends: { list: incoming } } as never, { backends: { list: local } } as never, CATS).filter(
    (c) => c.kind === "new-backend" || c.kind === "server-url",
  );

/** What every other row shows: the detail as it is, capped. */
const plain = (c: SecurityChange) => safeIdentityText(c.detail, consentDetailCap(c.kind));

describe("a moved-address row", () => {
  const moved = (from: string, to: string) => rows([backend({ serverUrl: to })], [backend({ serverUrl: from })])[0];

  it("masks the password on both sides of the arrow and keeps the row's detail whole", () => {
    const c = moved("http://anna:hunter2@old.lan:8000", "https://anna:s3cret@new.example");
    expect(c.kind).toBe("server-url");
    expect(c.detail).toBe("http://anna:hunter2@old.lan:8000 → https://anna:s3cret@new.example");
    expect(c.url).toBe("https://anna:s3cret@new.example");
    expect(consentDetailText(c)).toBe(`http://anna:${M}@old.lan:8000 → https://anna:${M}@new.example`);
  });

  it("masks this device's side alone, and the peer's side alone", () => {
    expect(consentDetailText(moved("http://anna:hunter2@old.lan", "http://new.lan:8000"))).toBe(
      `http://anna:${M}@old.lan → http://new.lan:8000`,
    );
    expect(consentDetailText(moved("http://old.lan:8000", "http://anna:hunter2@new.lan"))).toBe(
      `http://old.lan:8000 → http://anna:${M}@new.lan`,
    );
  });

  it("keeps a user name that looks like a host, and the real host, in view", () => {
    const c = moved("http://10.0.0.2:8000", "http://localhost:8000@evil.tld/v1");
    expect(consentDetailText(c)).toBe(`http://10.0.0.2:8000 → http://localhost:${M}@evil.tld/v1`);
  });

  it("says so when only the password differs, where the two sides would read the same", () => {
    const c = moved("http://anna:hunter2@host.lan:8000", "http://anna:hunter3@host.lan:8000");
    expect(consentDetailText(c)).toBe(
      `http://anna:${M}@host.lan:8000 → http://anna:${M}@host.lan:8000 · only the password differs`,
    );
    // Any other difference shows by itself.
    for (const to of ["http://anna:hunter2@host.lan:8001", "http://anne:hunter2@host.lan:8000", "http://anna@host.lan:8000"]) {
      expect(consentDetailText(moved("http://anna:hunter2@host.lan:8000", to))).not.toContain("only the password");
    }
    // An empty password is none: the sides differ visibly.
    expect(consentDetailText(moved("http://anna:@host.lan", "http://anna:hunter2@host.lan"))).toBe(
      `http://anna:@host.lan → http://anna:${M}@host.lan`,
    );
  });

  it("keeps the note in view when the addresses run past the cap", () => {
    const path = `/${"v".repeat(300)}`;
    const c = moved(`http://anna:hunter2@host.lan${path}`, `http://anna:hunter3@host.lan${path}`);
    const shown = consentDetailText(c);
    expect(shown.endsWith("… · only the password differs")).toBe(true);
    expect(shown).not.toContain("hunter");
  });

  it("masks before the cap, so a cut cannot leave half a password", () => {
    // Unmasked, the 200-code-point cut would land inside the password and show its head.
    const c = moved("http://10.0.0.2:8000", `http://anna:${"Secret9".repeat(60)}@new.lan:8000`);
    expect(plain(c)).toContain("Secret9");
    expect(consentDetailText(c)).toBe(`http://10.0.0.2:8000 → http://anna:${M}@new.lan:8000`);
  });

  it("splits at the row's own address, whatever arrows the addresses hold", () => {
    // The peer's address carries the separator: this device's password is still masked.
    const c = moved("http://anna:hunter2@old.lan", "http://new.lan/a → http://b:c@d");
    expect(c.detail).toBe("http://anna:hunter2@old.lan → http://new.lan/a → http://b:c@d");
    expect(consentDetailText(c)).toBe(`http://anna:${M}@old.lan → http://new.lan/a → http://b:c@d`);
    // A row built without its `url` is split at every arrow.
    expect(consentDetailText({ kind: "server-url", detail: "http://a:pw1@h → http://a:pw2@h" })).toBe(
      `http://a:${M}@h → http://a:${M}@h · only the password differs`,
    );
    expect(consentDetailText({ kind: "server-url", detail: "http://a:pw1@h → http://x/ → http://b:pw2@i" })).toBe(
      `http://a:${M}@h → http://x/ → http://b:${M}@i`,
    );
  });

  it("renders an address with no password, and the placeholders, as before", () => {
    for (const [from, to] of [
      ["http://old.lan:8000", "https://new.example/v1"],
      ["http://anna@old.lan:8000", "http://anne@new.lan:8000"],
      ["http://old.lan:8000/a:b@c", "http://new.lan:8000?x=a:b@c"],
      ["", "http://new.lan:8000"],
      ["http://old.lan:8000", "ftp://anna:hunter2@blanked.example"],
    ]) {
      const c = moved(from, to);
      expect(consentDetailText(c), c.detail).toBe(plain(c));
    }
    expect(consentDetailText(moved("", "http://new.lan:8000"))).toBe("(no address) → http://new.lan:8000");
    expect(consentDetailText(moved("http://old.lan:8000", "ftp://x.example"))).toBe(
      "http://old.lan:8000 → (none: the address would be cleared)",
    );
    expect(consentDetailText(moved("http://anna:hunter2@old.lan", "ftp://x.example"))).toBe(
      `http://anna:${M}@old.lan → (none: the address would be cleared)`,
    );
  });
});

describe("a new-server row", () => {
  const added = (serverUrl: string) => rows([backend({ id: "b2", serverUrl })], [backend()])[0];

  it("masks the password and keeps the row's detail whole", () => {
    const c = added("https://anna:hunter2@whisper.example/v1");
    expect(c.kind).toBe("new-backend");
    expect(c.detail).toBe("https://anna:hunter2@whisper.example/v1");
    expect(consentDetailText(c)).toBe(`https://anna:${M}@whisper.example/v1`);
  });

  it("renders an address with no password, and the placeholder, as before", () => {
    for (const url of ["http://new.lan:8000", "http://anna@new.lan", "http://new.lan/a:b@c", "ftp://anna:hunter2@x.example"]) {
      const c = added(url);
      expect(consentDetailText(c), c.detail).toBe(plain(c));
    }
    expect(consentDetailText(added("ftp://x.example"))).toBe("(no address)");
  });
});

describe("the other rows", () => {
  it("are not read as addresses", () => {
    // Text shaped like a login in a row that is not an address row stays as it is.
    for (const kind of ["api-key", "typed-text", "dictation-retention"] as const) {
      const c = { kind, detail: "http://anna:hunter2@host.lan → http://anna:hunter3@host.lan" };
      expect(consentDetailText(c)).toBe(safeIdentityText(c.detail, consentDetailCap(kind)));
    }
  });
});

describe("a row's backend label", () => {
  const all = (incoming: unknown[], local: unknown[]): SecurityChange[] =>
    securityChanges({ backends: { list: incoming } } as never, { backends: { list: local } } as never, CATS);

  it("shows a real name as written", () => {
    const [c] = rows([backend({ name: "Work", serverUrl: "http://new.lan" })], [backend({ name: "Work" })]);
    expect(c.backend).toBe("Work");
    expect(consentBackendText(c)).toBe("Work");
    expect(consentBackendText({ backend: "" })).toBe("");
    // A name that is itself an address without a password is a name like any other.
    expect(consentBackendText({ backend: "http://anna@host.lan:8000" })).toBe("http://anna@host.lan:8000");
    expect(consentBackendText({ backend: "http://host.lan:8000" })).toBe("http://host.lan:8000");
  });

  it("masks the password of the address a blank-named backend is labelled by, on every row kind", () => {
    const local = backend({ name: "", serverUrl: "http://anna:hunter2@old.lan:8000" });
    const incoming = backend({ name: "", serverUrl: "http://anna:hunter2@new.lan:8000" });
    const changes = all([incoming], [local]);
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      // The label is the row's identity and stays whole; only what is drawn is masked.
      expect(c.backend).toBe("http://anna:hunter2@old.lan:8000");
      expect(consentBackendText(c)).toBe(`http://anna:${M}@old.lan:8000`);
      expect(`${consentBackendText(c)} · ${consentDetailText(c)}`).not.toContain("hunter2");
    }
    // A backend new to this device is labelled by the peer's address.
    const [added] = all([backend({ id: "b-new", name: " ", serverUrl: "https://bob:s3cret@peer.example" })], []);
    expect(added.kind).toBe("new-backend");
    expect(consentBackendText(added)).toBe(`https://bob:${M}@peer.example`);
  });

  it("masks before the cap, so a cut cannot leave half a password", () => {
    const url = `http://anna:${"p".repeat(200)}@host.lan`;
    expect(consentBackendText({ backend: url })).toBe(`http://anna:${M}@host.lan`);
  });
});
