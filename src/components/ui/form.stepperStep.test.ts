import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { findInTree, hooks } from "../plainRender.testkit";

// No DOM in this suite: the Stepper runs as a plain function over a tiny hook store (state and
// refs survive "re-renders" by call order), and its returned tree is walked for the input.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../plainRender.testkit")).fakeHooks,
  useLayoutEffect: () => {},
}));

import { Stepper } from "./form";

type InputProps = {
  onFocus: (e: unknown) => void;
  onChange: (e: unknown) => void;
  onKeyDown: (e: unknown) => void;
};

const findElement = (node: unknown, type: string): ReactElement | null => findInTree(node, (el) => el.type === type);

type ButtonProps = {
  "aria-label": string;
  onClick?: (e: unknown) => void;
  onKeyDown?: (e: unknown) => void;
};

/** The element of `type` whose aria-label starts with `label`. */
const findLabelled = (node: unknown, type: string, label: string): ReactElement | null =>
  findInTree(node, (el) => el.type === type && !!(el.props["aria-label"] as string | undefined)?.startsWith(label));

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

describe("Stepper −/+ activated without a pointer", () => {
  const button = (label: "Decrease" | "Increase", value: number, onChange: (v: number) => void) => {
    hooks.i = 0;
    const tree = Stepper({ value, min: 0, max: 10, onChange, ariaLabel: "timeout" }) as ReactElement;
    return (findLabelled(tree, "button", label) as ReactElement<ButtonProps>).props;
  };

  it("a click with detail 0 (screen reader, voice control, keyboard) steps once", () => {
    const up = vi.fn();
    button("Increase", 5, up).onClick?.({ detail: 0 });
    expect(up).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledWith(6);
    hooks.slots = [];
    const down = vi.fn();
    button("Decrease", 5, down).onClick?.({ detail: 0 });
    expect(down).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledWith(4);
  });

  it("a mouse click (detail 1) does not step again after its pointerdown", () => {
    for (const label of ["Increase", "Decrease"] as const) {
      hooks.slots = [];
      const onChange = vi.fn();
      const props = button(label, 5, onChange);
      expect(props.onClick).toBeTypeOf("function");
      props.onClick?.({ detail: 1 });
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it("Enter/Space keydown steps nothing itself (its native click does), so a key press steps once", () => {
    for (const label of ["Increase", "Decrease"] as const) {
      for (const key of ["Enter", " "]) {
        hooks.slots = [];
        const onChange = vi.fn();
        button(label, 5, onChange).onKeyDown?.({ key, preventDefault() {} });
        expect(onChange).not.toHaveBeenCalled();
      }
    }
  });

  it("at a bound a detail-0 click steps nothing", () => {
    const up = vi.fn();
    const inc = button("Increase", 10, up);
    expect(inc.onClick).toBeTypeOf("function");
    inc.onClick?.({ detail: 0 });
    expect(up).not.toHaveBeenCalled();
    hooks.slots = [];
    const down = vi.fn();
    const dec = button("Decrease", 0, down);
    expect(dec.onClick).toBeTypeOf("function");
    dec.onClick?.({ detail: 0 });
    expect(down).not.toHaveBeenCalled();
  });
});
