import { describe, expect, it } from "vitest";
import { fmtBytes, fmtTimestamp } from "./format";

describe("fmtTimestamp", () => {
  it("never renders 60.0 seconds — rounds to the tenth before splitting", () => {
    // A playhead sampled every ~0.24 s crosses these on ~20 % of minute boundaries.
    expect(fmtTimestamp(59.99)).toBe("1:00.0");
    expect(fmtTimestamp(119.98)).toBe("2:00.0");
    expect(fmtTimestamp(3599.99)).toBe("1:00:00.0");
  });
  it("keeps the ordinary shapes", () => {
    expect(fmtTimestamp(5.24)).toBe("0:05.2");
    expect(fmtTimestamp(83.4)).toBe("1:23.4");
    expect(fmtTimestamp(3725)).toBe("1:02:05.0");
    expect(fmtTimestamp(-3)).toBe("0:00.0");
  });
});

describe("fmtBytes", () => {
  it("classifies on the rounded mantissa, so a boundary value moves up a unit", () => {
    expect(fmtBytes(1023.6)).toBe("1 KB");
    expect(fmtBytes(1048575)).toBe("1.0 MB");
    expect(fmtBytes(1073741000)).toBe("1.00 GB");
  });
  it("keeps the ordinary shapes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(980 * 1024)).toBe("980 KB");
    expect(fmtBytes(41.2 * 1024 * 1024)).toBe("41.2 MB");
    expect(fmtBytes(-1)).toBe("");
  });
});
