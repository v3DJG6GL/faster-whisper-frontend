import { describe, expect, it } from "vitest";
import { diarizationSummary, separationSummary, speakersText, stageModelText, translationSummary } from "./stageSummary";

describe("speakersText", () => {
  it("names the speaker mode in words", () => {
    expect(speakersText("auto", 0, 2, 5)).toBe("Auto speakers");
    expect(speakersText("count", 3, 2, 5)).toBe("3 speakers");
    expect(speakersText("count", 1, 2, 5)).toBe("1 speaker");
    expect(speakersText("range", 0, 2, 5)).toBe("2–5 speakers");
    expect(speakersText("range", 0, 2, 2)).toBe("2 speakers");
  });
});

describe("stageModelText", () => {
  it("the run's pick, short, else the server's default", () => {
    expect(stageModelText("pyannote/speaker-diarization-3.1", "x")).toBe("speaker-diarization-3.1");
    expect(stageModelText("", "speaker-diarization-community-1")).toBe("Default · speaker-diarization-community-1");
    expect(stageModelText(undefined, "UVR")).toBe("Default · UVR");
  });
});

describe("stage summaries", () => {
  it("separation and diarization", () => {
    expect(separationSummary("UVR-MDX-NET-Inst_HQ_3")).toBe("Model · UVR-MDX-NET-Inst_HQ_3");
    expect(diarizationSummary("Auto speakers", "speaker-diarization-community-1")).toBe(
      "Auto speakers · speaker-diarization-community-1",
    );
  });
  it("translation: targets as codes, mode, model", () => {
    expect(translationSummary(["en", "fr"], "fluent", "Default · HY-MT1.5-7B")).toBe("EN, FR · Fluent · Default · HY-MT1.5-7B");
    expect(translationSummary(["en", "fr", "it", "es", "pt"], "faithful", undefined)).toBe("EN, FR, IT, ES +1 · Faithful");
  });
});
