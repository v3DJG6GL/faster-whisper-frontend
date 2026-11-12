// The "Dictation would be sent to:" list on the restore/import dialogs caps its rows, and the
// incoming blob picks their order: an id this device already holds whose address the blob changes
// is listed even behind a wall of decoys.
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CONFIG_VERSION, DEFAULT_SYNC, useApp } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { backend } from "@/lib/sync/syncTestFixtures";
import { IncomingAddresses } from "./SettingsSync";

const decoys = (n: number) =>
  Array.from({ length: n }, (_, i) => backend({ id: `decoy${i}`, name: `Decoy ${i}`, serverUrl: `http://decoy${i}.lan:8000` }));

const rows = (list: unknown) => {
  const html = renderToStaticMarkup(<IncomingAddresses list={list} />);
  return [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]);
};

beforeEach(() => {
  useApp.getState().hydrate({
    version: CONFIG_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
    backends: [
      backend({ id: "home", name: "Home", serverUrl: "http://home.lan:8000" }),
      backend({ id: "work", name: "Work", serverUrl: "https://work.example" }),
    ],
    profiles: [],
  });
});

describe("IncomingAddresses", () => {
  it("leaves out a case alias of a held id, as the apply drops it", () => {
    const list = [backend({ id: "HOME", name: "Alias", serverUrl: "http://evil.tld:8000" }), ...decoys(1)];
    expect(rows(list).map((r) => r.split(" →")[0])).toEqual(["Decoy 0"]);
  });

  it("lists a repointed held id that sits past the row cap", () => {
    const list = [...decoys(21), backend({ id: "home", name: "Home", serverUrl: "http://evil.tld:8000" })];
    const shown = rows(list);
    expect(shown).toHaveLength(20);
    expect(shown[0]).toContain("evil.tld");
    expect(renderToStaticMarkup(<IncomingAddresses list={list} />)).toContain("…and 2 more.");
  });

  it("lists every repointed held id, then new ids, then unchanged ones", () => {
    const list = [
      backend({ id: "work", name: "Work", serverUrl: "https://work.example" }),
      ...decoys(2),
      backend({ id: "home", name: "Home", serverUrl: "http://evil.tld:8000" }),
    ];
    const shown = rows(list);
    expect(shown.map((r) => r.split(" →")[0])).toEqual(["Home", "Decoy 0", "Decoy 1", "Work"]);
  });

  it("puts new ids ahead of unchanged ones and keeps the hidden count when nothing held moves", () => {
    const list = [
      backend({ id: "work", name: "Work", serverUrl: "https://work.example/" }),
      ...decoys(25),
      backend({ id: "home", name: "Home", serverUrl: "http://home.lan:8000" }),
    ];
    const html = renderToStaticMarkup(<IncomingAddresses list={list} />);
    const shown = rows(list);
    expect(shown).toHaveLength(20);
    // New ids lead the unchanged ones; "work" differs only by a trailing slash, so it is unchanged.
    expect(shown[0]).toContain("Decoy 0");
    expect(html).toContain("…and 7 more.");
  });

  it("measures a held id at this device's address override", () => {
    useApp.setState({
      settings: { ...useApp.getState().settings, sync: { ...DEFAULT_SYNC, urlOverrides: { home: "http://evil.tld:8000" } } },
    });
    // The incoming copy is at the canonical address, but this device connects to its override,
    // which it keeps: nothing moves.
    const list = [...decoys(21), backend({ id: "home", name: "Home", serverUrl: "http://home.lan:8000" })];
    expect(rows(list).some((r) => r.startsWith("Home"))).toBe(false);
  });

  // The list holds this device's own backends too (the unchanged rows): a hover that showed the
  // whole address would put a login's password on screen while the row itself shows the host.
  describe("the row's hover title", () => {
    const titles = (list: unknown) =>
      [...renderToStaticMarkup(<IncomingAddresses list={list} />).matchAll(/<li[^>]*?(?: title="([^"]*)")?>/g)].map(
        (m) => m[1],
      );

    it("is the whole address when it carries no login", () => {
      const list = [
        backend({ id: "n1", name: "New", serverUrl: "https://new.example/v1?x=a:b@c" }),
        backend({ id: "n2", name: "Odd", serverUrl: "http://[::1]:8000" }),
      ];
      expect(titles(list)).toEqual(["https://new.example/v1?x=a:b@c", "http://[::1]:8000"]);
    });

    it("is only the host when the address carries a login", () => {
      const list = [
        backend({ id: "n1", name: "New", serverUrl: "https://anna:hunter2@whisper.example/v1" }),
        backend({ id: "n2", name: "User", serverUrl: "http://anna@host.lan:8000" }),
        backend({ id: "home", name: "Home", serverUrl: "http://otto:geheim@home.lan:8000" }),
      ];
      const html = renderToStaticMarkup(<IncomingAddresses list={list} />);
      expect(titles(list)).toEqual(["home.lan:8000", "whisper.example", "host.lan:8000"]);
      expect(html).not.toContain("hunter2");
      expect(html).not.toContain("geheim");
    });

    it("covers this device's own unchanged backend, at its address override too", () => {
      useApp.setState({
        backends: [
          backend({ id: "home", name: "Home", serverUrl: "http://otto:geheim@home.lan:8000" }),
          backend({ id: "work", name: "Work", serverUrl: "https://work.example" }),
        ],
        settings: {
          ...useApp.getState().settings,
          sync: { ...DEFAULT_SYNC, urlOverrides: { work: "http://otto:geheim@10.0.0.9:9000" } },
        },
      });
      const list = [
        backend({ id: "home", name: "Home", serverUrl: "http://otto:geheim@home.lan:8000" }),
        backend({ id: "work", name: "Work", serverUrl: "https://work.example" }),
      ];
      const html = renderToStaticMarkup(<IncomingAddresses list={list} />);
      expect(titles(list).sort()).toEqual(["10.0.0.9:9000", "home.lan:8000"]);
      expect(html).not.toContain("geheim");
    });
  });
});
