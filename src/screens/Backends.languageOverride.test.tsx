// The backend editor's DEFAULT_LANGUAGE row carries the override dot, like its DEFAULT_MODEL and
// DEFAULT_PROMPT siblings, whenever a run from this backend sends its own language.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import type { Backend } from "@/lib/types";
import { Editor } from "./Backends";

// The Defaults block starts collapsed and a static render cannot click it open: render every
// disclosure open.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    DisclosureCard: (props: ComponentProps<typeof actual.DisclosureCard>) => actual.DisclosureCard({ ...props, open: true }),
  };
});

const backend = (language: string): Backend => ({
  id: "b1",
  name: "Test",
  serverUrl: "http://localhost:8000",
  hasApiKey: false,
  model: "",
  endpoint: "batch",
  language,
  prompt: "",
  responseFormat: "json",
});

// The markup of the DEFAULT_LANGUAGE row's title line, up to the next row's title.
const languageRow = (language: string) => {
  const html = renderToStaticMarkup(<Editor initial={backend(language)} onSave={() => {}} onCancel={() => {}} />);
  const start = html.indexOf(">DEFAULT_LANGUAGE<");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(">Endpoint<", start));
};

describe("backend editor DEFAULT_LANGUAGE row", () => {
  it("marks the row overridden when the backend sends its own language", () => {
    expect(languageRow("de")).toContain('aria-label="overridden"');
  });

  it("shows no override mark while the backend inherits the server's language", () => {
    expect(languageRow("")).not.toContain('aria-label="overridden"');
  });
});
