import { describe, expect, it } from "vitest";
import { sanitizeAppRules } from "./sync";

describe("sanitizeAppRules cap", () => {
  it("keeps the first 500 distinct rules, deduped on id and on the normalized appId", () => {
    const raw: unknown[] = [null, { id: 1, appId: "x" }, { id: "blank", appId: "​" }];
    for (let i = 0; i < 700; i++) {
      raw.push({ id: `r${i}`, appId: `App${i}`, block: i % 2 === 0 });
      raw.push({ id: `r${i}`, appId: `other${i}` }); // same id
      raw.push({ id: `s${i}`, appId: ` app${i} ` }); // same app once normalized
    }
    const out = sanitizeAppRules(raw);
    expect(out).toHaveLength(500);
    expect(out.map((r) => r.id)).toEqual(Array.from({ length: 500 }, (_, i) => `r${i}`));
    expect(out[0]).toMatchObject({ block: true, autoEnter: undefined });
    expect(out[1].block).toBe(false);
  });

  it("returns every rule of a list under the cap", () => {
    const out = sanitizeAppRules([{ id: "a", appId: "konsole", autoEnter: true }, { id: "b", appId: "firefox" }]);
    expect(out.map((r) => r.appId)).toEqual(["konsole", "firefox"]);
    expect(out[0].autoEnter).toBeUndefined();
  });
});
