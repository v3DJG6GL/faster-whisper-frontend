import { Kbd } from "@/components/ui";
import { codesToLabels } from "@/lib/keys";

/** Render a chord's `event.code` list (["ControlLeft","Numpad0"]) as `<kbd>` chips
 *  with human-friendly labels (↑, ⌫, Num 0, AltGr, R-Shift, …). */
export function HotkeyChips({ codes }: { codes: string[] }) {
  const labels = codes && codes.length ? codesToLabels(codes) : [];
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
