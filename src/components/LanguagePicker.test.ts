import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// No DOM in this suite: the pickers and ListPicker run as plain functions over a tiny hook store
// (state and refs survive "re-renders" by call order), and the returned trees are walked.
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
    useId: () => "lp",
  };
});
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.mock("@/lib/useAnchoredRect", () => ({
  useAnchoredRect: () => null,
  popoverBox: () => ({ style: {}, room: 500 }),
}));
vi.mock("@/lib/useOutsidePress", () => ({ useOutsidePress: () => {} }));
vi.mock("@/lib/store", () => ({ useApp: (sel: (s: unknown) => unknown) => sel({ settings: {} }) }));
vi.mock("@/lib/recent", () => ({ cleanRecent: () => [], rememberRecent: () => {} }));

import { TargetLanguagePicker } from "./LanguagePicker";

type ButtonProps = { disabled?: boolean; onFocus?: () => void; "aria-disabled"?: boolean };

/** One render of the default "+ language" trigger; returns its <button>'s props. */
const render = (disabled: boolean): ButtonProps => {
  hooks.i = 0;
  const picker = TargetLanguagePicker({ value: [], onChange: () => {}, supported: null, max: 3, disabled }) as ReactElement<
    Record<string, unknown>
  >;
  const tree = (picker.type as (p: unknown) => ReactElement<{ children: unknown }>)(picker.props);
  const kids = [tree.props.children].flat() as ReactElement<{ children: ReactElement<ButtonProps> }>[];
  // The wrapper <span> (the tooltip) holds the button.
  return kids[0].props.children.props;
};

beforeEach(() => {
  hooks.slots = [];
});

describe("TargetLanguagePicker default '+ language' trigger", () => {
  it("is not natively disabled while it holds the keyboard focus, so focus is not dropped to <body>", () => {
    const button = render(false);
    button.onFocus?.();
    // A run starts (the hotkey): the caller's `disabled` turns true under the focus.
    const after = render(true);
    expect(after.disabled).toBeFalsy();
    expect(after["aria-disabled"]).toBe(true);
  });
});
