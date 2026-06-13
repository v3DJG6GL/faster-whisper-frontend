import { Kbd } from "@/components/ui";
import { accelToLabels } from "@/lib/keys";

/** Render an accelerator string ("Ctrl+Shift+Numpad0") as `<kbd>` chips with
 *  human-friendly labels (↑, ⌫, Num 0, …). */
export function HotkeyChips({ hotkey }: { hotkey: string }) {
  const labels = hotkey ? accelToLabels(hotkey) : [];
  if (labels.length === 0) {
    return <span className="text-[12.5px] text-faint">Not set</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      {labels.map((k, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-faint">+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}
