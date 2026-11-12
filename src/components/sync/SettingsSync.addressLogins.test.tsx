// A settings export writes every server address as stored, so a login typed into one
// (`user:password@host`) is in the file with or without "Include API keys": the Backup card says so.
import { describe, expect, it } from "vitest";
import { backend } from "@/lib/sync/syncTestFixtures";
import { addressLoginCount, addressLoginsNotice } from "./SettingsSync";

const plain = backend({ id: "plain", name: "Plain", serverUrl: "http://plain.lan:8000" });
const login = backend({ id: "login", name: "Login", serverUrl: "https://anna:hunter2@whisper.example/v1" });
const user = backend({ id: "user", name: "User", serverUrl: "http://anna@host.lan:8000" });

describe("server addresses that carry a login", () => {
  it("are counted over the whole list", () => {
    expect(addressLoginCount([])).toBe(0);
    expect(addressLoginCount([plain, backend({ id: "x", name: "X", serverUrl: "" })])).toBe(0);
    expect(addressLoginCount([plain, login])).toBe(1);
    expect(addressLoginCount([login, plain, user])).toBe(2);
  });

  it("are named by number, never by address", () => {
    expect(addressLoginsNotice(1)).toBe("1 server address carries a user name and password, which the file holds in plain text — with or without the API keys.");
    expect(addressLoginsNotice(2)).toBe("2 server addresses carry a user name and password, which the file holds in plain text — with or without the API keys.");
  });
});
