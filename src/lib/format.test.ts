import { describe, expect, it } from "vitest";
import { fmtBytes, fmtTimestamp, relTime } from "./format";

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
    expect(fmtTimestamp(Infinity)).toBe("0:00.0");
    expect(fmtTimestamp(NaN)).toBe("0:00.0");
  });
});

describe("fmtBytes", () => {
  it("classifies on the rounded mantissa, so a boundary value moves up a unit", () => {
    expect(fmtBytes(999.6)).toBe("1 KB");
    expect(fmtBytes(999_950)).toBe("1.0 MB");
    expect(fmtBytes(999_995_000)).toBe("1.00 GB");
    // Decimal, like yt-dlp and the server log: 139 240 575 B is 139.2 MB.
    expect(fmtBytes(139_240_575)).toBe("139.2 MB");
  });
  it("keeps the ordinary shapes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(980 * 1000)).toBe("980 KB");
    expect(fmtBytes(41.2 * 1e6)).toBe("41.2 MB");
    expect(fmtBytes(-1)).toBe("");
  });
});

describe("relTime", () => {
  it("floors at the tier edges — never '60m ago' or '24h ago'", () => {
    expect(relTime(0, 59.5 * 60_000)).toBe("59m ago");
    expect(relTime(0, 3_600_000 - 1)).toBe("59m ago");
    expect(relTime(0, 23.5 * 3_600_000)).toBe("23h ago");
    expect(relTime(0, 86_400_000 - 1)).toBe("23h ago");
  });
  it("keeps the ordinary shapes", () => {
    expect(relTime(0, 30_000)).toBe("just now");
    expect(relTime(0, 4 * 60_000 + 20_000)).toBe("4m ago");
    expect(relTime(0, 3 * 3_600_000)).toBe("3h ago");
  });
});
