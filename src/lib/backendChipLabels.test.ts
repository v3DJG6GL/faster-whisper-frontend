import { describe, expect, it } from "vitest";
import { backendChips, deviceChip, modelDevice, versionChip, withBackendChips } from "./backendChipLabels";
import type { ConnectionInfo, ServerModel } from "./types";

const models: ServerModel[] = [
  { id: "Systran/faster-whisper-large-v3", loaded: true, device: "cuda" },
  { id: "small", loaded: false, device: "cpu" },
];

describe("versionChip / deviceChip", () => {
  it("prefixes a version once", () => {
    expect(versionChip("0.1.153")).toBe("v0.1.153");
    expect(versionChip("v0.1.153")).toBe("v0.1.153");
    expect(versionChip("")).toBeUndefined();
    expect(versionChip("evil build ‮")).toBeUndefined();
  });
  it("uppercases a device token, refuses anything else", () => {
    expect(deviceChip("cuda")).toBe("CUDA");
    expect(deviceChip("cuda:1")).toBe("CUDA:1");
    expect(deviceChip("a very long device name")).toBeUndefined();
    expect(deviceChip(undefined)).toBeUndefined();
  });
});

describe("modelDevice", () => {
  it("the device of the model the backend names", () => {
    expect(modelDevice(models, "small")).toBe("CPU");
    expect(modelDevice(models, "faster-whisper-large-v3")).toBe("CUDA");
  });
  it("a backend without a model: the loaded one", () => {
    expect(modelDevice(models, "")).toBe("CUDA");
    expect(modelDevice([], "")).toBeUndefined();
  });
  it("the OpenAI alias whisper-1 is the server default: the loaded one, unless listed by id", () => {
    expect(modelDevice(models, "whisper-1")).toBe("CUDA");
    expect(modelDevice([...models, { id: "whisper-1", loaded: false, device: "cpu" }], "whisper-1")).toBe("CPU");
  });
  it("the server default among loaded models on different devices is unknown: no chip", () => {
    const split: ServerModel[] = [
      { id: "small", loaded: true, device: "cpu" },
      { id: "Systran/faster-whisper-large-v3", loaded: true, device: "cuda" },
    ];
    expect(modelDevice(split, "")).toBeUndefined();
    expect(modelDevice(split, "whisper-1")).toBeUndefined();
    expect(modelDevice(split, "small")).toBe("CPU");
    const same: ServerModel[] = [
      { id: "small", loaded: true, device: "cuda" },
      { id: "Systran/faster-whisper-large-v3", loaded: true, device: "cuda" },
      { id: "medium", loaded: false, device: "cpu" },
    ];
    expect(modelDevice(same, "")).toBe("CUDA");
  });
  it("an unknown model has no chip", () => {
    expect(modelDevice(models, "medium")).toBeUndefined();
  });
});

describe("withBackendChips", () => {
  it("attaches each backend's chips to its picker option", () => {
    const conn: ConnectionInfo = { ok: true, openMode: false, models, serverVersion: "0.1.153" };
    const backends = [{ id: "a", model: "small" }, { id: "b", model: "" }];
    const out = withBackendChips([{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "", label: "None" }], backends, { a: conn });
    expect(out).toEqual([{ value: "a", label: "A", chips: ["v0.1.153", "CPU"] }, { value: "b", label: "B" }, { value: "", label: "None" }]);
  });
});

describe("backendChips", () => {
  it("version then device, each only when known", () => {
    const conn: ConnectionInfo = { ok: true, openMode: false, models, serverVersion: "0.1.153" };
    expect(backendChips({ model: "" }, conn)).toEqual(["v0.1.153", "CUDA"]);
    expect(backendChips({ model: "" }, { ...conn, serverVersion: undefined })).toEqual(["CUDA"]);
    expect(backendChips({ model: "" }, { ...conn, ok: false })).toEqual([]);
    expect(backendChips({ model: "" }, undefined)).toEqual([]);
  });
});
