import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// No DOM in this suite: the Stepper runs as a plain function over a tiny hook store (state and
// refs survive "re-renders" by call order), and its returned tree is walked for the input.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = hooks.i++;
      if (!(i in hooks.slots)) hooks.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        hooks.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.slots[i]) : v;
      };
      return [hooks.slots[i], set];
    },
    useRef: (init: unknown) => {
      const i = hooks.i++;
      if (!(i in hooks.slots)) hooks.slots[i] = { current: init };
      return hooks.slots[i];
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
});

import { Stepper } from "./form";

type InputProps = {
  onFocus: (e: unknown) => void;
  onChange: (e: unknown) => void;
  onKeyDown: (e: unknown) => void;
};

/** The first element of `type` in the tree. */
function findElement(node: unknown, type: string): ReactElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const el = findElement(n, type);
      if (el) return el;
    }
    return null;
  }
  const el = node as ReactElement<{ children?: unknown }>;
  if (el.type === type) return el;
  return el.props ? findElement(el.props.children, type) : null;
}

beforeEach(() => {
  hooks.slots = [];
  vi.stubGlobal("requestAnimationFrame", () => 0);
});
afterEach(() => vi.unstubAllGlobals());

describe("Stepper arrow steps on an inheriting field", () => {
  it("retyping an out-of-range inherited value and pressing ↑ pins no override at the bound", () => {
    const onChange = vi.fn();
    const input = () => {
      hooks.i = 0;
      const tree = Stepper({ value: undefined, inherited: 500, max: 100, onChange }) as ReactElement;
      return (findElement(tree, "input") as ReactElement<InputProps>).props;
    };
    input().onFocus({ currentTarget: { select() {} } });
    // Select-all and type the inherited value again: an edit, but commit() reads it unchanged.
    input().onChange({ target: { value: "500" } });
    input().onKeyDown({ key: "ArrowUp", altKey: false, preventDefault() {}, stopPropagation() {} });
    expect(onChange).not.toHaveBeenCalled();
  });
});
