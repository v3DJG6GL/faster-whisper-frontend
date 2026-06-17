// A pipeline rule's "card colour" is set by an admin on the backend as a SEMANTIC
// name (red/amber/green/teal/blue/purple/pink — the theme owns the actual colour),
// never a hex. These hexes mirror the backend's own pipeline editor exactly (the
// `data-color` CSS in admin_routes.py / quick_config_routes.py), so the dot we show
// matches the colour the admin picked there. They deliberately sit OUTSIDE the
// Signal functional palette (blue/purple/pink have no Signal token) — they're
// cosmetic admin metadata, so we render the real hue inline rather than snapping to
// the nearest Signal token (which collapsed blue, purple AND pink to the amber
// accent — the "always yellow-ish" bug).
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
  return RULE_DOT_HEX[color] ?? null;
}
