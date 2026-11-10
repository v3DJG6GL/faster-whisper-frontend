// The backend editor's header names the host requests actually reach: an address that hides it
// behind userinfo shows the parsed host and the list card's warning badge, at any length.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Backend } from "@/lib/types";
import { Editor } from "./Backends";

const backend = (serverUrl: string): Backend => ({
  id: "b1",
  name: "Test",
  serverUrl,
  hasApiKey: false,
  model: "",
  endpoint: "batch",
  language: "",
  prompt: "",
  responseFormat: "json",
});

// The header's address line and what follows it, up to the connection status pill.
const header = (serverUrl: string) => {
  const html = renderToStaticMarkup(<Editor initial={backend(serverUrl)} onSave={() => {}} onCancel={() => {}} />);
  const start = html.indexOf(">Test<");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(">Untested<", start));
};

describe("backend editor header address", () => {
  it("shows the real host and the warning for a short address with userinfo", () => {
    const h = header(`http://localhost:8000${"x".repeat(60)}@evil.tld/v1`);
    expect(h).toContain(">evil.tld<");
    expect(h).not.toContain("localhost");
    expect(h).toContain("address hides the real host");
  });

  it("keeps the whole address and no warning for a plain one", () => {
    const h = header("http://localhost:8000/v1");
    expect(h).toContain(">http://localhost:8000/v1<");
    expect(h).not.toContain("address hides the real host");
  });
});
