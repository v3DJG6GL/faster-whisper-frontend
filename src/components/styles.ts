// Tailwind class strings shared by several components. They live in a plain module, not in a
// .tsx next to a component, so every component file exports components only (a clean
// fast-refresh boundary) and importers don't pull in a component module for a string.

/** The portaled popover's frame — ListPicker's popover and ui/buttons.tsx's SplitButton menu. */
export const POPOVER_PANEL =
  "animate-combobox-pop overflow-hidden rounded-xl border border-line-strong bg-panel shadow-[0_12px_32px_-8px_rgba(0,0,0,0.55)]";

/** The width a single-line control takes in a row's right column (the full width when the row
 *  is too narrow and the control drops under the title). */
export const OVERRIDE_CONTROL_W = "w-full @[560px]:w-56";
