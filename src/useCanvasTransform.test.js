import { describe, it, expect } from "vitest";
import { clampScale } from "./useCanvasTransform.js";

describe("clampScale", () => {
  it("returns 1 for non-finite values", () => {
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(1);
    expect(clampScale(-Infinity)).toBe(1);
  });

  it("returns 1 for undefined", () => {
    expect(clampScale(undefined)).toBe(1);
  });

  it("clamps to MIN_SCALE (0.3) for small values", () => {
    expect(clampScale(0)).toBe(0.3);
    expect(clampScale(0.1)).toBe(0.3);
    expect(clampScale(-5)).toBe(0.3);
  });

  it("clamps to MAX_SCALE (3) for large values", () => {
    expect(clampScale(5)).toBe(3);
    expect(clampScale(100)).toBe(3);
  });

  it("passes through values within range", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.5)).toBe(0.5);
    expect(clampScale(2)).toBe(2);
  });

  it("allows exactly MIN_SCALE", () => {
    expect(clampScale(0.3)).toBe(0.3);
  });

  it("allows exactly MAX_SCALE", () => {
    expect(clampScale(3)).toBe(3);
  });
});
