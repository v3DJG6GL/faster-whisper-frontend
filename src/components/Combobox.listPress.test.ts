import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// No DOM in this suite: Combobox runs as a plain function over a tiny hook store (state and refs
// survive "re-renders" by call order), and its returned tree is walked for the handlers.
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
    useId: () => "cb",
  };
});
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/lib/useAnchoredRect", () => ({
  useAnchoredRect: () => ({ top: 0, left: 0, width: 120, height: 24, bottom: 24, right: 120 }),
  popoverBox: () => ({ style: { left: 0, width: 120 }, room: 500 }),
}));

import { Combobox } from "./Combobox";

type Props = Record<string, unknown> & { children?: unknown };
const render = () => {
  hooks.i = 0;
  return Combobox({ value: "", onChange: () => {}, onSelect: () => {}, suggestions: ["alpha", "beta"] }) as ReactElement<Props>;
};

/** The first element in the tree matching `pred`. */
function find(node: unknown, pred: (el: ReactElement<Props>) => boolean): ReactElement<Props> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const el = find(n, pred);
      if (el) return el;
    }
    return null;
  }
  const el = node as ReactElement<Props>;
  if (!el.props) return null;
  if (pred(el)) return el;
  return find(el.props.children, pred);
}
const inputOf = (tree: unknown) => find(tree, (el) => el.props.role === "combobox")!;
const listOf = (tree: unknown) => find(tree, (el) => el.type === "ul");
const panelOf = (tree: unknown) =>
  find(tree, (el) => typeof el.props.onMouseDown === "function" && el.props.role === undefined)!;

let ups: { fn: () => void; opts: unknown }[];
let doc: { body: object; activeElement: unknown; addEventListener: (t: string, fn: () => void, o: unknown) => void };

beforeEach(() => {
  hooks.slots = [];
  ups = [];
  const body = {};
  doc = {
    body,
    activeElement: body,
    addEventListener: (type, fn, opts) => {
      if (type === "mouseup") ups.push({ fn, opts });
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { innerWidth: 1000 });
});
afterEach(() => vi.unstubAllGlobals());

describe("Combobox suggestion list press", () => {
  it("a press on the listbox itself keeps its default, keeps the list open through a blur its parents never see, and refocuses on release", () => {
    render();
    (inputOf(render()).props.onFocus as () => void)();
    let tree = render();
    expect(listOf(tree)).not.toBeNull();
    const input = inputOf(tree);
    let refocused = 0;
    (input.props as unknown as { ref: { current: unknown } }).ref.current = { focus: () => refocused++ };

    const press = (target: unknown) => {
      let prevented = false;
      (panelOf(tree).props.onMouseDown as (e: unknown) => void)({ button: 0, target, preventDefault: () => (prevented = true) });
      return prevented;
    };
    // The footer and the rows' chrome still keep focus in the input, and arm nothing.
    expect(press({ id: "" })).toBe(true);
    expect(ups).toHaveLength(0);
    // WebKit drags an element's scrollbar only on a press that was not prevented.
    expect(press({ id: "cb-list" })).toBe(false);
    expect(ups).toHaveLength(1);
    expect(ups[0].opts).toEqual({ once: true, capture: true });

    // That press blurs the input: the list must stay open for the drag, and the blur must not
    // reach a parent's focusout handler (ModelPicker would commit a half-typed filter mid-pick).
    let stopped = 0;
    const blur = { stopPropagation: () => stopped++ };
    (input.props.onBlur as (e: unknown) => void)(blur);
    expect(stopped).toBe(1);
    tree = render();
    expect(listOf(tree)).not.toBeNull();

    // The release (anywhere) hands focus back to the input.
    ups[0].fn();
    expect(refocused).toBe(1);

    // An ordinary blur afterwards closes the list again, and bubbles as usual.
    (inputOf(tree).props.onBlur as (e: unknown) => void)(blur);
    expect(stopped).toBe(1);
    expect(listOf(render())).toBeNull();
  });

  // WebKitGTK's context menu takes the pointer grab on mousedown, so that button's mouseup never
  // reaches the page: an armed release would fire on the next click and pull focus back from it.
  it.each([
    ["right", 2],
    ["middle", 1],
  ])("a %s press on the listbox arms nothing and keeps focus in the input", (_n, button) => {
    render();
    (inputOf(render()).props.onFocus as () => void)();
    const tree = render();
    let prevented = false;
    (panelOf(tree).props.onMouseDown as (e: unknown) => void)({
      button,
      target: { id: "cb-list" },
      preventDefault: () => (prevented = true),
    });
    expect(prevented).toBe(true);
    expect(ups).toHaveLength(0);
    // Nothing marks a list press, so a later blur closes the list and reaches the parents.
    let stopped = 0;
    (inputOf(tree).props.onBlur as (e: unknown) => void)({ stopPropagation: () => stopped++ });
    expect(stopped).toBe(0);
    expect(listOf(render())).toBeNull();
  });
});
