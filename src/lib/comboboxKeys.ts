// Which keys the Combobox's suggestion list takes for itself. Pure, so the rule is testable
// without a DOM.

/** Escape and ArrowUp belong to the list only while it is drawn (`showPopover`: open AND with
 *  candidates). `open` alone turns true on focus, click or a keystroke even when nothing
 *  matches: taking Escape then swallowed the window's own Esc (QuickAdd stayed open, ModelPicker
 *  needed a second press to commit), and taking ArrowUp blocked the caret. */
export function listOwnsKey(key: string, showPopover: boolean): boolean {
  return (key === "Escape" || key === "ArrowUp") && showPopover;
}
