// Test support for suites with no DOM that run a component as a plain function. Must not import
// react at runtime: suites load it from inside their own vi.mock("react") factory.
import type { ReactElement } from "react";

/** The hook store: state and refs survive "re-renders" by call order. Set `hooks.i = 0` before
 *  each render and `hooks.slots = []` between tests. */
export const hooks = { slots: [] as unknown[], i: 0 };

/** useState / useRef / useEffect over `hooks`, to spread into a vi.mock("react") factory. */
export const fakeHooks = {
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
};

type Props = Record<string, unknown> & { children?: unknown };

/** The first element in a rendered tree (depth first) matching `pred`. */
export function findInTree(node: unknown, pred: (el: ReactElement<Props>) => boolean): ReactElement<Props> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const el = findInTree(n, pred);
      if (el) return el;
    }
    return null;
  }
  const el = node as ReactElement<Props>;
  if (!el.props) return null;
  if (pred(el)) return el;
  return findInTree(el.props.children, pred);
}

/** Calls a rendered element's mousedown handler with a synthetic press; true when it prevented the
 *  default (kept focus where it was). */
export function pressPrevented(onMouseDown: unknown, target: unknown, button = 0): boolean {
  let prevented = false;
  (onMouseDown as (e: unknown) => void)({ button, target, preventDefault: () => (prevented = true) });
  return prevented;
}
