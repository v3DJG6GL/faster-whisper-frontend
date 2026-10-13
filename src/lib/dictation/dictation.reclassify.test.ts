// The chord family's "reclassify" over a running session: the hold → hands-free upgrade is
// only for a HOLD session. Over a session already running hands-free (from Home, the chip or
// another hands-free Profile) the superset press is a hands-free hotkey pressed while busy,
// and stops that session gracefully — it must not discard it (restart) or relabel it (upgrade).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import type { Backend, Profile } from "../types";

const st = vi.hoisted(() => ({
  startLive: vi.fn(() => Promise.resolve()),
  stopLive: vi.fn(() => Promise.resolve()),
  cancelLive: vi.fn(() => Promise.resolve()),
  requestStopIfStarting: vi.fn(() => false),
  cancelStopIfStarting: vi.fn(() => false),
  isStarting: vi.fn(() => false),
  queuePendingHoldStart: vi.fn(),
  voidPendingHoldStart: vi.fn(),
  registerPendingStartRunner: vi.fn(),
  reclassifyLive: vi.fn(),
  abortDictationTranslate: vi.fn(),
  isCapturing: vi.fn(() => true),
  setSettleTargetPicker: vi.fn(),
  setRouteHint: vi.fn(),
  restartLiveAs: vi.fn(),
  liveActivation: vi.fn((): "hold" | "handsfree" | null => "hold"),
}));
vi.mock("./streaming", () => st);

import { dictate } from "./dictation";

const backend = (id: string, language = "de"): Backend =>
  ({ id, name: id, serverUrl: "http://s", model: "m", language, endpoint: "stream" }) as unknown as Backend;
const profile = (id: string, backendId: string, activation: "hold" | "handsfree"): Profile =>
  ({ id, name: id, enabled: true, backendId, activation, hotkey: [] }) as unknown as Profile;

const HOLD = profile("hold", "b1", "hold");
const HF_SAME = profile("hf-same", "b1", "handsfree");
const HF_OTHER = profile("hf-other", "b2", "handsfree");
const HOME_HF = profile("home", "b1", "handsfree");

beforeEach(() => {
  useApp.setState({
    status: "listening",
    profiles: [HOLD, HF_SAME, HF_OTHER, HOME_HF],
    backends: [backend("b1"), backend("b2", "fr")],
  } as never);
});
afterEach(() => vi.clearAllMocks());

describe("dictate(reclassify) over a running session", () => {
  for (const [label, hf] of [["same", HF_SAME], ["different", HF_OTHER]] as const) {
    it(`stops a hands-free session gracefully (${label} session shape)`, () => {
      useApp.setState({ activeProfile: HOME_HF.id } as never);
      st.liveActivation.mockReturnValue("handsfree");
      dictate(hf.id, "reclassify");
      expect(st.stopLive).toHaveBeenCalledTimes(1);
      expect(st.cancelLive).not.toHaveBeenCalled();
      expect(st.restartLiveAs).not.toHaveBeenCalled();
      expect(st.reclassifyLive).not.toHaveBeenCalled();
    });
  }

  it("stops a hold Profile that Home started hands-free (runtime activation, not the Profile's)", () => {
    useApp.setState({ activeProfile: HOLD.id } as never);
    st.liveActivation.mockReturnValue("handsfree");
    dictate(HF_SAME.id, "reclassify");
    expect(st.stopLive).toHaveBeenCalledTimes(1);
    expect(st.reclassifyLive).not.toHaveBeenCalled();
  });

  it("still upgrades a HOLD session in place when the shapes match", () => {
    useApp.setState({ activeProfile: HOLD.id } as never);
    st.liveActivation.mockReturnValue("hold");
    dictate(HF_SAME.id, "reclassify");
    expect(st.reclassifyLive).toHaveBeenCalledWith(HF_SAME);
    expect(st.stopLive).not.toHaveBeenCalled();
  });

  it("still restarts a HOLD session as the hands-free Profile when the shapes differ", () => {
    useApp.setState({ activeProfile: HOLD.id } as never);
    st.liveActivation.mockReturnValue("hold");
    dictate(HF_OTHER.id, "reclassify");
    expect(st.restartLiveAs).toHaveBeenCalledTimes(1);
    expect(st.stopLive).not.toHaveBeenCalled();
  });
});
