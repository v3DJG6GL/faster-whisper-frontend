// A login typed into a server address (`user:password@host`) is stored and sent with the address,
// not kept in the keyring: the editor says so under the field, and the list card's hover titles
// name the host instead of showing the password.
import { describe, expect, it } from "vitest";
import { safeDisplayText } from "@/lib/sanitize";
import { addressLoginNotice, addressTitle } from "./Backends";

const SAVED = "The user name and password in this address are saved in plain text with the address: they are not kept in the system keyring";

describe("addressLoginNotice", () => {
  it("names where a Server URL's login is saved and where it travels", () => {
    const want = `${SAVED}, and they travel with settings sync and settings exports even when API keys are left out.`;
    expect(addressLoginNotice("https://anna:hunter2@whisper.example/v1")).toBe(want);
    // Judged as stored: a schemeless address gains its scheme first. A user name alone is a login too.
    expect(addressLoginNotice("  anna@host.lan:8000 ")).toBe(want);
    expect(addressLoginNotice("http:/anna:hunter2@host.lan:8000")).toBe(want);
  });

  it("says only where a device address's login is saved: that address never leaves the device", () => {
    expect(addressLoginNotice("http://anna:hunter2@localhost:8000", true)).toBe(`${SAVED}.`);
  });

  it("stays silent for an address without a login", () => {
    for (const url of ["", "  ", "http://host.lan:8000", "host.lan:8000", "https://whisper.example/v1?user=a@b", "not an address"]) {
      expect(addressLoginNotice(url), url).toBeNull();
      expect(addressLoginNotice(url, true), url).toBeNull();
    }
  });
});

describe("addressTitle", () => {
  it("is the whole address when it carries no login", () => {
    for (const url of ["http://host.lan:8000", "https://whisper.example/v1", "host.lan:8000", "not an address", ""]) {
      expect(addressTitle(url), url).toBe(safeDisplayText(url, 200));
    }
  });

  it("is the host alone when the address carries a login", () => {
    expect(addressTitle("https://anna:hunter2@whisper.example/v1")).toBe("whisper.example");
    expect(addressTitle("http://anna:hunter2@host.lan:8000")).toBe("host.lan:8000");
    // The list card hands over the authority it has parsed for the address line.
    expect(addressTitle("http://otto:geheim@127.0.0.1:9000", { host: "127.0.0.1:9000", hasUserinfo: true })).toBe("127.0.0.1:9000");
    expect(addressTitle("http://plain.lan:8000/v1", { host: "plain.lan:8000", hasUserinfo: false })).toBe("http://plain.lan:8000/v1");
    expect(addressTitle("not an address", null)).toBe("not an address");
  });
});
