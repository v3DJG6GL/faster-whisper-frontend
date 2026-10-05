import { useApp } from "@/lib/store";
import { Segmented } from "@/components/ui";
import type { RecordingSettings } from "@/lib/types";

// The keys of RecordingSettings whose value is a boolean (the chip-visibility flags).
type ChipVisKey = {
  [K in keyof RecordingSettings]: RecordingSettings[K] extends boolean ? K : never;
}[keyof RecordingSettings];

// The chip's visibility settings are all the same Off / Always / On-hover tri-state, backed by a
// (visible, onHover) boolean pair on RecordingSettings. One control keyed on those two fields keeps
// the four identical Segmented blocks (live transcript / profile / usage / target) from drifting.
export function HoverModeSegmented({
  visibleKey,
  hoverKey,
  disabled,
  ariaLabel,
}: {
  visibleKey: ChipVisKey;
  hoverKey: ChipVisKey;
  disabled?: boolean;
  // Names the role="group" so a screen reader can tell the four identical Off/Always/On-hover
  // triplets apart (SettingRow auto-labels only a direct Toggle/Select child, not this composite).
  ariaLabel?: string;
}) {
  const visible = useApp((st) => st.settings.recording[visibleKey]);
  const onHover = useApp((st) => st.settings.recording[hoverKey]);
  const updateRecording = useApp((st) => st.updateRecording);
  return (
    <Segmented
      ariaLabel={ariaLabel}
      value={!visible ? "off" : onHover ? "hover" : "always"}
      onChange={(v) =>
        updateRecording(
          (v === "off"
            ? { [visibleKey]: false }
            : v === "hover"
              ? { [visibleKey]: true, [hoverKey]: true }
              : { [visibleKey]: true, [hoverKey]: false }) as Partial<RecordingSettings>,
        )
      }
      disabled={disabled}
      options={[
        { value: "off", label: "Off" },
        { value: "always", label: "Always" },
        { value: "hover", label: "On hover" },
      ]}
    />
  );
}
