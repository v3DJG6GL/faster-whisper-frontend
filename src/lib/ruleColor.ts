import { ownProp } from "./own";

// A pipeline rule's "card colour" is set by an admin on the backend as a SEMANTIC
// name, never a hex. These hexes mirror the backend pipeline editor's `data-color` CSS
// (admin/templates/settings.html, quick_config/templates/quick_config.html), so the dot
// matches the colour the admin picked there. They deliberately sit OUTSIDE the Signal
// functional palette: blue/purple/pink have no Signal token, and snapping them to the
// nearest one would collapse all three onto the amber accent.
const RULE_DOT_HEX: Record<string, string> = {
  red: "#f85149",
  amber: "#d29922",
  green: "#3fb950",
  teal: "#39c5cf",
  blue: "#79c0ff",
  purple: "#bc8cff",
  pink: "#ff7b9c",
};

/** The hex for a rule's admin-set card colour, or null when unset/unrecognised. */
export function ruleDotColor(color?: string | null): string | null {
  if (!color) return null;
  return ownProp(RULE_DOT_HEX, color) ?? null; // own-only: "constructor" is no colour
}
