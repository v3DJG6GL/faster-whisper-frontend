import { describe, expect, it } from "vitest";
import { filterStepperText } from "./form";

describe("filterStepperText", () => {
  it("reads a comma as the decimal point on a decimal Stepper", () => {
    expect(filterStepperText("1,5", 0, 1)).toBe("1.5");
    expect(filterStepperText("0,8", 0, 3)).toBe("0.8");
  });

  it("keeps only the first separator, comma or dot", () => {
    expect(filterStepperText("1,5,2", 0, 2)).toBe("1.52");
    expect(filterStepperText("1.5,2", 0, 2)).toBe("1.52");
  });

  it("keeps a leading minus only when the range goes below zero", () => {
    expect(filterStepperText("-0,5", -1, 1)).toBe("-0.5");
    expect(filterStepperText("-0,5", 0, 1)).toBe("0.5");
  });

  it("still drops a comma on an integer Stepper", () => {
    expect(filterStepperText("1,500", 0, 0)).toBe("1500");
  });
});
