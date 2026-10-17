import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// No DOM in this suite: ListPicker runs as a plain function over a tiny hook store (state and refs
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
    useId: () => "lp",
  };
});
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/lib/useAnchoredRect", () => ({
  useAnchoredRect: () => ({ top: 0, left: 0, width: 120, height: 24, bottom: 24, right: 120 }),
  popoverBox: () => ({ style: {}, room: 500 }),
}));
vi.mock("@/lib/useOutsidePress", () => ({ useOutsidePress: () => {} }));

import { ListPicker, type TriggerProps } from "./ListPicker";

type Row = { id: string };
const rows: Row[] = [{ id: "de" }, { id: "fr" }];

let trigger: TriggerProps;
const props = (disabled: boolean) => ({
  label: "Target language",
  sections: () => [{ title: "", rows }],
  multi: true,
  rowKey: (r: Row) => r.id,
  isSelected: () => false,
  onPick: () => {},
  renderRow: (r: Row) => r.id,
  renderTrigger: (p: TriggerProps) => {
    trigger = p;
    return null;
  },
  keys: null,
  disabled,
});
const render = (disabled: boolean) => {
  hooks.i = 0;
  return ListPicker<Row>(props(disabled)) as ReactElement;
};

/** The first handler named `onKeyDown` in the popover (the search field's). */
function listKeyHandler(node: unknown): ((e: unknown) => void) | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const h = listKeyHandler(n);
      if (h) return h;
    }
    return null;
  }
  const p = (node as { props?: Record<string, unknown> }).props;
  if (!p) return null;
  if (typeof p.onKeyDown === "function") return p.onKeyDown as (e: unknown) => void;
  return listKeyHandler(p.children);
}

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

const key = (k: string) => ({ key: k, repeat: false, keyCode: 0, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });

beforeEach(() => {
  hooks.slots = [];
  vi.stubGlobal("document", { body: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("ListPicker trigger while the popover is open", () => {
  it("stays focusable when `disabled` turns true mid-open, so Esc hands focus back to it", () => {
    render(false);
    // A native button: focus() is a no-op while its rendered `disabled` is set.
    let focused = false;
    (trigger.ref as { current: unknown }).current = {
      focus: () => {
        if (!trigger.disabled) focused = true;
      },
    };
    trigger.onKeyDown(key("ArrowDown") as never);
    // The pick filled the last slot: the caller now passes disabled while the list is still open.
    const tree = render(true);
    expect(trigger["aria-expanded"]).toBe(true);
    expect(trigger.disabled).toBeFalsy();

    const onListKey = listKeyHandler((tree.props as { children: unknown }).children);
    expect(onListKey).not.toBeNull();
    onListKey!(key("Escape"));
    expect(focused).toBe(true);

    // Closed again: the caller's `disabled` applies as before.
    render(true);
    expect(trigger["aria-expanded"]).toBe(false);
    expect(trigger.disabled).toBe(true);
  });

  it("stays focusable after that close while it holds focus, so focus is not dropped to <body>", () => {
    render(false);
    // A native button: focus() is a no-op while its rendered `disabled` is set, and taking focus
    // fires its onFocus.
    let focused = false;
    (trigger.ref as { current: unknown }).current = {
      focus: () => {
        if (trigger.disabled) return;
        focused = true;
        trigger.onFocus?.();
      },
    };
    trigger.onKeyDown(key("ArrowDown") as never);
    // The search field takes focus; then the pick fills the last slot.
    trigger.onBlur?.();
    const tree = render(true);
    listKeyHandler((tree.props as { children: unknown }).children)!(key("Escape"));
    expect(focused).toBe(true);

    // The close render: a focused button set natively disabled would drop focus to <body>.
    render(true);
    expect(trigger["aria-expanded"]).toBe(false);
    expect(trigger.disabled).toBeFalsy();
    expect(trigger["aria-disabled"]).toBe(true);
    // Still refuses to open: a click (Enter or Space on the button) or ↓.
    trigger.onClick();
    render(true);
    expect(trigger["aria-expanded"]).toBe(false);
    trigger.onKeyDown(key("ArrowDown") as never);
    render(true);
    expect(trigger["aria-expanded"]).toBe(false);

    // Focus moves on: now it is natively disabled.
    trigger.onBlur?.();
    render(true);
    expect(trigger.disabled).toBe(true);
  });

  it("is not announced or drawn as disabled while open — it still closes the list", () => {
    render(false);
    trigger.onKeyDown(key("ArrowDown") as never);
    // The pick filled the last slot with the list still up.
    render(true);
    expect(trigger["aria-expanded"]).toBe(true);
    expect(trigger["aria-disabled"]).toBeFalsy();
    // A click on it closes the list, as an enabled trigger would.
    trigger.onClick();
    render(true);
    expect(trigger["aria-expanded"]).toBe(false);
    expect(trigger["aria-disabled"]).toBe(true);
  });

  it("a disabled closed trigger does not open", () => {
    render(true);
    trigger.onKeyDown(key("ArrowDown") as never);
    render(true);
    expect(trigger["aria-expanded"]).toBe(false);
  });
});

describe("ListPicker popover focus", () => {
  it("a press on the panel's chrome keeps focus in the search field, so Esc still closes the list", () => {
    render(false);
    trigger.onKeyDown(key("ArrowDown") as never);
    const tree = render(false);
    const panel = (tree.props as { children: unknown[] }).children[1] as ReactElement<{
      onMouseDown?: (e: unknown) => void;
    }>;
    const input = findElement(panel, "input") as ReactElement<{ ref: { current: unknown } }>;
    const field = {};
    input.props.ref.current = field;
    const press = (target: unknown) => {
      let prevented = false;
      panel.props.onMouseDown?.({ target, preventDefault: () => (prevented = true) });
      return prevented;
    };
    // The magnifier, a section header, the hint line: focus would otherwise drop to <body>.
    expect(press({})).toBe(true);
    // The field itself keeps its press (caret placement, selection).
    expect(press(field)).toBe(false);
  });
});
