import { Segmented } from "@/components/ui";
import { inheritLabel, onOff } from "@/lib/inherit";
import { type DecodeDefault } from "@/lib/types";

/** A pipeline stage's switch (music separation, diarization) as a tri-state: "Default · on/off"
 *  takes the server's default for this caller (request-default-settings), On/Off say it. The
 *  same pattern as the VAD row; an unknown default leaves the bare "Default". */
export function StageSwitch({
  value,
  serverDefault,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: boolean | undefined;
  serverDefault: DecodeDefault | undefined;
  onChange: (v: boolean | undefined) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const def = typeof serverDefault?.value === "boolean" ? serverDefault.value : undefined;
  // A server-locked stage runs as the server says whatever the request asks: show its
  // value, not the user's pick (which stays stored for a server without the lock).
  const locked = serverDefault?.locked === true;
  return (
    <Segmented
      ariaLabel={ariaLabel}
      disabled={disabled || locked}
      value={locked ? "inherit" : value === true ? "on" : value === false ? "off" : "inherit"}
      onChange={(v) => onChange(v === "inherit" ? undefined : v === "on")}
      options={[
        {
          value: "inherit",
          label: inheritLabel(onOff(def), locked ? "Set by server" : "Default"),
          title: locked ? "Fixed by the server's admin" : serverDefault ? "This server's default" : undefined,
        },
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ]}
    />
  );
}
