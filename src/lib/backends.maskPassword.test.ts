// The security-review rows print an address unasked, so the password of a login written into it
// is masked there. The mask is a text rule over an address as written: this pins every shape it
// must place — and every shape it must leave byte for byte, since the same row is what shows a
// user name that looks like a host.
import { describe, expect, it } from "vitest";
import { authorityOf, maskAddressPassword, typedServerUrl } from "./backends";

const M = "•••";

describe("maskAddressPassword", () => {
  it.each([
    // user:password
    ["http://anna:hunter2@old.lan:8000", `http://anna:${M}@old.lan:8000`],
    ["https://anna:hunter2@whisper.example/v1", `https://anna:${M}@whisper.example/v1`],
    // a password with no user name
    ["http://:hunter2@host.lan", `http://:${M}@host.lan`],
    // a password holding ":" and a raw "@": the userinfo ends at the LAST "@" of the authority
    ["http://anna:hun:ter2@host.lan", `http://anna:${M}@host.lan`],
    ["http://anna:hun@ter2@host.lan", `http://anna:${M}@host.lan`],
    ["http://anna:p@localhost:8000@evil.tld/v1", `http://anna:${M}@evil.tld/v1`],
    // a user name that looks like a host stays in view, up to its ":"
    ["http://localhost:8000@evil.tld/v1", `http://localhost:${M}@evil.tld/v1`],
    ["http://good.example:x@evil.tld", `http://good.example:${M}@evil.tld`],
    // percent-encoded: an encoded ":" or "@" is no delimiter
    ["http://an%3Ana:hunter%402@host.lan", `http://an%3Ana:${M}@host.lan`],
    ["http://anna:%68unter2@host.lan", `http://anna:${M}@host.lan`],
    // IPv6 host, port
    ["http://anna:hunter2@[::1]:8000/v1", `http://anna:${M}@[::1]:8000/v1`],
    ["http://anna:hunter2@[fd00::2]", `http://anna:${M}@[fd00::2]`],
    ["https://anna:hunter2@host.lan:8443", `https://anna:${M}@host.lan:8443`],
    // "@" and ":" in the path, query or fragment are not the login
    ["http://anna:hunter2@host.lan/a:b@c?d=e:f@g#h:i@j", `http://anna:${M}@host.lan/a:b@c?d=e:f@g#h:i@j`],
    ["http://anna:hunter2@host.lan?next=x:y@z", `http://anna:${M}@host.lan?next=x:y@z`],
    ["http://anna:hunter2@host.lan#x:y@z", `http://anna:${M}@host.lan#x:y@z`],
    // lenient spellings the parsers read as http(s): backslashes, one slash, none, extra ones
    ["http:\\\\anna:hunter2@host.lan", `http:\\\\anna:${M}@host.lan`],
    ["http:/anna:hunter2@host.lan:8000", `http:/anna:${M}@host.lan:8000`],
    ["https:anna:hunter2@host.lan", `https:anna:${M}@host.lan`],
    ["http:////anna:hunter2@host.lan", `http:////anna:${M}@host.lan`],
    ["http://anna:hunter2@host.lan\\a:b@c", `http://anna:${M}@host.lan\\a:b@c`],
    // uppercase scheme
    ["HTTP://Anna:Hunter2@HOST.LAN:8000/V1", `HTTP://Anna:${M}@HOST.LAN:8000/V1`],
    ["HTTPS://anna:hunter2@host.lan", `HTTPS://anna:${M}@host.lan`],
    // schemeless: a user name that is no scheme (it starts with a digit or a symbol)
    ["1anna:hunter2@host.lan:8000", `1anna:${M}@host.lan:8000`],
    ["_svc:hunter2@host.lan", `_svc:${M}@host.lan`],
    // prose the parsers read as a login at host "work" is one (a space is legal in a userinfo)
    ["see notes: ask anna@work", `see notes:${M}@work`],
    // edge whitespace and a trailing slash stay as written
    ["  http://anna:hunter2@host.lan/  ", `  http://anna:${M}@host.lan/  `],
    // a password that is the probe, or the mask, itself
    ["http://anna:x@host.lan", `http://anna:${M}@host.lan`],
    [`http://anna:${M}@host.lan`, `http://anna:${M}@host.lan`],
    // a tab or newline inside the password is dropped by the parsers: it goes with the password
    ["http://anna:hun\tter\n2@host.lan", `http://anna:${M}@host.lan`],
  ])("masks only the password of %j", (address, shown) => {
    expect(maskAddressPassword(address)).toBe(shown);
    // Everything from the last "@" of the authority on, and the user name, are as written.
    const at = shown.indexOf(`${M}@`);
    expect(address.endsWith(shown.slice(at + M.length))).toBe(true);
    expect(address.startsWith(shown.slice(0, at))).toBe(true);
  });

  it.each([
    // no userinfo
    "http://host.lan:8000",
    "https://whisper.example/v1",
    "host.lan:8000",
    "http://[::1]:8000/v1",
    // a user name only
    "http://anna@host.lan:8000",
    "anna@host.lan:8000",
    "http://localhost@evil.tld",
    // an empty password is no password
    "http://anna:@host.lan",
    "http://:@host.lan",
    "http://@host.lan",
    // "@" and ":" outside the authority
    "http://host.lan:8000/a:b@c",
    "http://host.lan?x=a:b@c",
    "http://host.lan#a:b@c",
    "http://host.lan\\anna:hunter2@evil.tld",
    "http://host.lan/\\anna:hunter2@x",
    // the review rows' own placeholders
    "(no address)",
    "(none: the address would be cleared)",
    // not an address
    "",
    "   ",
    "not an address",
    "mailto:anna:hunter2@host.lan",
    "ftp://anna:hunter2@host.lan",
    "http://anna:hunter2@",
    "http://anna:hunter2@host.lan:99999",
    "http://anna:hunter2@ho st.lan",
    // A scheme-less login whose user name reads as a scheme: the app does not read it as an
    // address anywhere (no host line, no login notice), and it is left alone here too.
    "anna:hunter2@host.lan:8000",
  ])("leaves %j byte for byte", (text) => {
    expect(maskAddressPassword(text)).toBe(text);
  });

  it("agrees with the parser on every masked shape: same host, same user name, a password left", () => {
    for (const address of [
      "http://anna:hunter2@old.lan:8000",
      "http://anna:hun@ter2@host.lan",
      "http://anna:p@localhost:8000@evil.tld/v1",
      "http:\\\\anna:hunter2@host.lan",
      "https:anna:hunter2@host.lan",
      "HTTP://Anna:Hunter2@HOST.LAN:8000/V1",
      "1anna:hunter2@host.lan:8000",
      "http://anna:hunter2@[::1]:8000/v1",
    ]) {
      const before = new URL(typedServerUrl(address));
      const after = new URL(typedServerUrl(maskAddressPassword(address)));
      expect(after.host, address).toBe(before.host);
      expect(after.username, address).toBe(before.username);
      expect(after.pathname + after.search + after.hash, address).toBe(before.pathname + before.search + before.hash);
      expect(decodeURIComponent(after.password), address).toBe(M);
      expect(authorityOf(typedServerUrl(maskAddressPassword(address)))?.hasUserinfo, address).toBe(true);
    }
  });

  it("rebuilds a spelling the text rule cannot place from the parsed parts", () => {
    // The parsers drop a tab or newline anywhere, the scheme included.
    expect(maskAddressPassword("ht\ttp://anna:hunter2@host.lan:8000/v1?a=b")).toBe(
      `http://anna:${M}@host.lan:8000/v1?a=b`,
    );
    expect(maskAddressPassword("http:\n//anna:hunter2@host.lan")).toBe(`http://anna:${M}@host.lan/`);
  });

  it("stays linear on a long address", () => {
    const long = `http://anna:${"p@:".repeat(200_000)}@host.lan/${"a:b@c/".repeat(50_000)}`;
    const t0 = performance.now();
    const shown = maskAddressPassword(long);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(shown.startsWith(`http://anna:${M}@host.lan/a:b@c/`)).toBe(true);
    expect(shown).toHaveLength(long.length - "p@:".repeat(200_000).length + M.length);
  });
});
