// Test support for suites with no DOM that run a component as a plain function. Must not import
// react at runtime: suites load it from inside their own vi.mock("react") factory.

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
