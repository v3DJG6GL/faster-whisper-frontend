// A PATCH the server refuses for good must not be a retryable "error": quick-add would re-PATCH
// the same map on every summon. A refused LIST (locked, deleted, hidden, retyped, quick-config
// access revoked) is "refused", whose re-sync re-runs the write gate that shows "List locked" /
// "re-pin one"; refused ROWS (422, dictionary cap) are "rejected" and kept for the user to fix.
// Anything else stays "error": the re-sync a "refused" triggers would replace the unsaved rows.
import { describe, expect, it } from "vitest";
import { quickAddRejectReason, quickAddSaveOutcome, selectionEdges, type QuickAddSaveOutcome } from "./quickAddSave";
import { envPinnedOf, RULE_LIST_SETTING, saveLanded } from "./pipelineMap";
import type { PipelineSaveResult } from "./types";

function reply(over: Partial<PipelineSaveResult>): PipelineSaveResult {
  return { ok: false, status: 0, saved: [], conflicts: [], requires_restart: false, ...over };
}

/** Pre-run 68f08787: QuickAdd.tsx flushSave's inline verdict (no "refused"). */
function preRun(res: PipelineSaveResult): QuickAddSaveOutcome {
  const pinned = res.ok && envPinnedOf(res).includes(RULE_LIST_SETTING);
  return pinned ? "pinned" : saveLanded(res) ? "saved" : "error";
}
/** eea3e152: every 403 refused, by status alone. */
function byStatus(res: PipelineSaveResult): QuickAddSaveOutcome {
  if (res.ok && envPinnedOf(res).includes(RULE_LIST_SETTING)) return "pinned";
  if (saveLanded(res)) return "saved";
  return res.status === 403 ? "refused" : "error";
}

// [row, reply, pre-run, eea3e152, now] — the backend texts are quick_config/routes.py's.
const MATRIX: Array<[string, PipelineSaveResult, QuickAddSaveOutcome, QuickAddSaveOutcome, QuickAddSaveOutcome]> = [
  ["ok + landed", reply({ ok: true, status: 200 }), "saved", "saved", "saved"],
  ["2xx, unreadable reply", reply({ ok: false, status: 200 }), "saved", "saved", "saved"],
  ["ok + env-pinned rule list", reply({ ok: true, status: 200, env_pinned_ignored: ["PIPELINE_RULES"] }), "pinned", "pinned", "pinned"],
  ["ok + another env pin", reply({ ok: true, status: 200, env_pinned_ignored: ["OTHER"] }), "saved", "saved", "saved"],
  ["403 locked", reply({ status: 403, detail: "rule 'my-words' is locked and cannot be edited" }), "error", "refused", "refused"],
  ["403 terminal", reply({ status: 403, detail: "the terminal rule cannot be edited" }), "error", "refused", "refused"],
  ["403 not visible (admin)", reply({ status: 403, detail: "rule 'my-words' is not visible to your user" }), "error", "refused", "refused"],
  ["403 other (WAF)", reply({ status: 403, detail: "<html>Request blocked by ModSecurity</html>" }), "error", "refused", "error"],
  ["403 no detail", reply({ status: 403 }), "error", "refused", "error"],
  ["403 quick-config access revoked", reply({ status: 403, detail: "no access to /quick-config" }), "error", "refused", "refused"],
  ["403 another page's gate", reply({ status: 403, detail: "no access to /logs" }), "error", "refused", "error"],
  ["400 unknown slug", reply({ status: 400, detail: "unknown rule slug: 'my-words' (adding rules is not allowed)" }), "error", "error", "refused"],
  ["400 rule no longer a map", reply({ status: 400, detail: "field 'map' is not editable on rule 'my-words' (type=regex-list)" }), "error", "error", "refused"],
  ["400 too many entries", reply({ status: 400, detail: "too many dictionary entries in one request (server cap: 5000 entries in total)" }), "error", "error", "rejected"],
  ["400 dictionary full", reply({ status: 400, detail: "this dictionary is full (server cap: 2000 entries) — delete some entries before adding new ones" }), "error", "error", "rejected"],
  ["401", reply({ status: 401, detail: "invalid API key" }), "error", "error", "error"],
  ["422", reply({ status: 422, errors: [{ loc: "rules_patch", msg: "bad" }] }), "error", "error", "rejected"],
  ["500", reply({ status: 500, detail: "internal error" }), "error", "error", "error"],
  ["502 proxy", reply({ status: 502, detail: "Bad Gateway" }), "error", "error", "error"],
  ["network (0)", reply({ status: 0, detail: "connection refused" }), "error", "error", "error"],
  ["network (-1)", reply({ status: -1 }), "error", "error", "error"],
];

describe("quickAddSaveOutcome reply-shape matrix", () => {
  for (const [row, res, pre, mid, now] of MATRIX) {
    it(`${row}: ${pre} (pre-run) → ${mid} (eea3e152) → ${now}`, () => {
      expect(preRun(res)).toBe(pre);
      expect(byStatus(res)).toBe(mid);
      expect(quickAddSaveOutcome(res)).toBe(now);
    });
  }

  it("re-syncs after a save to a pinned list the server no longer has (deleted or hidden)", () => {
    // As "error", every summon would re-PATCH the same refused map and never show "re-pin one".
    expect(quickAddSaveOutcome(reply({ status: 400, detail: "unknown rule slug: 'x' (adding rules is not allowed)" }))).toBe("refused");
  });

  it("re-syncs after a save the server refuses for good: rule type changed, or quick-config access revoked", () => {
    // As "error", every summon would re-PATCH a map the server can never take from this caller.
    expect(quickAddSaveOutcome(reply({ status: 400, detail: "field 'map' is not editable on rule 'x' (type=regex-list)" }))).toBe("refused");
    expect(quickAddSaveOutcome(reply({ status: 403, detail: "no access to /quick-config" }))).toBe("refused");
    expect(quickAddSaveOutcome(reply({ status: 403 }))).toBe("error");
    expect(quickAddSaveOutcome(reply({ status: 502 }))).toBe("error");
  });

  it("keeps the user's rows on a 403 that names no lock (a re-sync would drop the addition)", () => {
    expect(quickAddSaveOutcome(reply({ status: 403, detail: "Forbidden" }))).toBe("error");
  });

  it("does not retry a 422 forever: the server's schema refuses the rows, and says why", () => {
    // As "error", every summon would re-PATCH the same rows (one key outside the word-list pattern)
    // and get the same 422, so no later mapping would reach the server, behind a bare "retry".
    const res = reply({
      status: 422,
      errors: [{ loc: "body.rules_patch.my-words.map.don't.[key]", msg: "String should match pattern '^[\\w \\-.,!?ßẞÄÖÜäöü]{1,64}$'" }],
    });
    expect(quickAddSaveOutcome(res)).toBe("rejected");
    expect(quickAddRejectReason(res)).toMatch(/^String should match pattern/);
    expect(quickAddRejectReason(reply({ status: 422, errors: [{}], detail: "map key too long" }))).toBe("map key too long");
    expect(quickAddRejectReason(reply({ status: 422 }))).toBe("The server refused a mapping in this list.");
  });

  it("does not retry a full dictionary: the server's cap refuses the rows, and its reason is shown", () => {
    // As "error", it would show a bare "retry" with no reason, and every summon would re-PATCH
    // the same over-cap map.
    const full = reply({ status: 400, detail: "this dictionary is full (server cap: 10000 entries) — delete some entries before adding new ones" });
    expect(quickAddSaveOutcome(full)).toBe("rejected");
    expect(quickAddRejectReason(full)).toMatch(/^this dictionary is full .* delete some entries/);
    // Any other 400 stays retryable.
    expect(quickAddSaveOutcome(reply({ status: 400, detail: "bad request" }))).toBe("error");
  });
});

/** Pre-fix QuickAdd.tsx replaceSelectionAfterClose: the edges by `$`-anchored regex. */
function regexEdges(current: string, typed: boolean): { lead: string; trail: string } {
  return {
    lead: (typed ? /^[ \t\u00a0]*/ : /^\s*/).exec(current)![0],
    trail: (typed ? /[ \t\u00a0]*$/ : /\s*$/).exec(current)![0],
  };
}

describe("selectionEdges (correct-on-close edge whitespace)", () => {
  const SHAPES = [
    "word", " word", "word ", "  word\t", "\u00a0word\u00a0", "word\n", "\nword\r\n", " \n word \n ",
    "word\n ", " \nword", "\u2003word\u3000", "\ufeffword\u2028", "two words", "a  \t  b", "", " ", "\n", " \t\n\u00a0 ",
  ];
  for (const typed of [false, true]) {
    for (const shape of SHAPES) {
      it(`${typed ? "typed" : "paste"} route, ${JSON.stringify(shape)}: same edges as the pre-fix regexes`, () => {
        expect(selectionEdges(shape, typed)).toEqual(regexEdges(shape, typed));
      });
    }
  }

  it("a 64K selection with a long blank run inside is read in linear time", () => {
    // `/\s*$/` retries at every position of the run — quadratic, seconds of a frozen window.
    const current = "a" + " ".repeat(64 * 1024 - 2) + "b";
    for (const typed of [false, true]) {
      const t0 = performance.now();
      expect(selectionEdges(current, typed)).toEqual({ lead: "", trail: "" });
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });
});
