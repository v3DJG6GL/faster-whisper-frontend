import { describe, expect, it } from "vitest";
import {
  buildMicView,
  isAlsaPin,
  isLegacyPin,
  labelForPick,
  pathText,
  pinHost,
  techId,
} from "./micOptions";
import type { MicInventory } from "./types";

const RODE = "pulseaudio:alsa_input.usb-R__DE_R__DE_PodMic_USB_6F0EDA88-00.mono-fallback";
const C920 = "pulseaudio:alsa_input.usb-046d_HD_Pro_Webcam_C920-02.iec958-stereo";
const BOSE = "pulseaudio:bluez_input.BC:87:FA:9A:DF:30";

function inv(withPaths = false): MicInventory {
  return {
    server: "PipeWire",
    defaultLabel: "RØDE PodMic USB Mono",
    mics: [
      {
        id: C920,
        label: "C920 PRO HD Webcam",
        bluetooth: false,
        isDefault: false,
        paths: withPaths
          ? [
              { id: C920, kind: "server" },
              { id: "alsa:sysdefault:CARD=C920", kind: "alsa-shared" },
            ]
          : [],
      },
      {
        id: RODE,
        label: "RØDE PodMic USB Mono",
        bluetooth: false,
        isDefault: true,
        paths: withPaths
          ? [
              { id: RODE, kind: "server" },
              { id: "alsa:sysdefault:CARD=USB", kind: "alsa-shared" },
              { id: "alsa:plughw:CARD=USB,DEV=0", kind: "alsa-exclusive" },
              { id: "alsa:hw:CARD=USB,DEV=0", kind: "alsa-raw" },
              { id: "alsa:dsnoop:CARD=USB,DEV=0", kind: "alsa-dsnoop" },
            ]
          : [],
      },
      { id: BOSE, label: "Bose QC Ultra Headphones", bluetooth: true, isDefault: false, paths: [] },
    ],
    otherPaths: withPaths
      ? [{ label: "HDA Intel PCH", paths: [{ id: "alsa:sysdefault:CARD=PCH", kind: "alsa-shared" }] }]
      : [],
    advancedSupported: true,
  };
}

describe("pins", () => {
  it("tells device ids from legacy display names", () => {
    expect(pinHost(RODE)).toBe("pulseaudio");
    expect(pinHost("wasapi:{0.0.1.00000000}.{abc}")).toBe("wasapi");
    expect(isLegacyPin("RØDE PodMic USB, USB Audio")).toBe(true);
    expect(isLegacyPin("Mikrofon (Realtek(R) Audio)")).toBe(true);
    expect(isLegacyPin("Headset: Left")).toBe(true); // a colon, but not a known host
    expect(isLegacyPin(RODE)).toBe(false);
    expect(isLegacyPin(null)).toBe(false);
    expect(isLegacyPin("pulseaudio:")).toBe(true); // no device part
    expect(isAlsaPin("alsa:hw:CARD=USB,DEV=0")).toBe(true);
    expect(isAlsaPin(RODE)).toBe(false);
    expect(techId("alsa:hw:CARD=USB,DEV=0")).toBe("hw:CARD=USB,DEV=0");
  });
});

describe("buildMicView", () => {
  it("leads with System default naming the current device, then one row per mic", () => {
    const v = buildMicView(inv(), null, null, false);
    expect(v.rows.map((r) => r.type)).toEqual(["default", "mic", "mic", "mic"]);
    expect(v.rows[0]).toMatchObject({ label: "System default — RØDE PodMic USB Mono" });
    expect(v.rows[3]).toMatchObject({ label: "Bose QC Ultra Headphones", bluetooth: true });
    expect(v.triggerLabel).toBe("System default");
    expect(v.missing).toBe(false);
  });

  it("keeps an unplugged pin selected and named, at the top of the mics", () => {
    const gone = "pulseaudio:alsa_input.usb-Blue_Yeti-00.analog-stereo";
    const v = buildMicView(inv(), gone, "Blue Yeti", false);
    expect(v.missing).toBe(true);
    expect(v.rows[1]).toEqual({ type: "mic", value: gone, label: "Blue Yeti", bluetooth: false, missing: true });
    expect(v.triggerLabel).toBe("Blue Yeti (not connected)");
  });

  it("does not call a pin missing before the list has loaded", () => {
    const v = buildMicView(null, RODE, "RØDE PodMic USB Mono", false);
    expect(v.missing).toBe(false);
    expect(v.triggerLabel).toBe("RØDE PodMic USB Mono");
    expect(v.rows[0]).toMatchObject({ label: "System default" });
  });

  it("names a legacy pin by its own text when it can't be found", () => {
    const v = buildMicView(inv(), "Old USB Mic, USB Audio", null, false);
    expect(v.triggerLabel).toBe("Old USB Mic, USB Audio (not connected)");
  });

  it("adds grouped, labelled paths only with the advanced switch", () => {
    const v = buildMicView(inv(true), "alsa:hw:CARD=USB,DEV=0", "RØDE PodMic USB Mono · hw:CARD=USB,DEV=0", true);
    const groups = v.rows.filter((r) => r.type === "group").map((r) => r.label);
    expect(groups).toEqual([
      "C920 PRO HD Webcam — all paths",
      "RØDE PodMic USB Mono — all paths",
      "HDA Intel PCH — all paths",
    ]);
    const rode = v.rows.filter((r) => r.type === "path" && r.techId.includes("CARD=USB"));
    expect(rode.map((r) => r.type === "path" && r.label)).toEqual([
      "Direct, shared, converts format",
      "Direct, exclusive, converts format",
      "Direct, exclusive, raw hardware",
      "Direct, shared, no conversion",
    ]);
    expect(v.missing).toBe(false);
    expect(v.triggerLabel).toBe("RØDE PodMic USB Mono · hw:CARD=USB,DEV=0");
    expect(buildMicView(inv(true), null, null, false).rows.some((r) => r.type === "path")).toBe(false);
  });

  it("labels the server path after the server", () => {
    expect(pathText("server", "PipeWire")).toBe("Via PipeWire — shared, any format");
    expect(pathText("server", "PulseAudio")).toBe("Via PulseAudio — shared, any format");
  });
});

describe("labelForPick", () => {
  it("saves the mic's name, or mic + path for a raw path", () => {
    expect(labelForPick(inv(true), RODE)).toBe("RØDE PodMic USB Mono");
    expect(labelForPick(inv(true), "alsa:plughw:CARD=USB,DEV=0")).toBe("RØDE PodMic USB Mono · plughw:CARD=USB,DEV=0");
    expect(labelForPick(inv(true), "alsa:sysdefault:CARD=PCH")).toBe("HDA Intel PCH · sysdefault:CARD=PCH");
    expect(labelForPick(inv(), "nope")).toBeNull();
  });
});
