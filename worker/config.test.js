import { describe, it, expect } from "vitest";
import {
  LLM_ENDPOINT,
  LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_MODEL,
} from "./config.js";

describe("config exports", () => {
  it("exports a non-empty LLM_ENDPOINT string", () => {
    expect(typeof LLM_ENDPOINT).toBe("string");
    expect(LLM_ENDPOINT.length).toBeGreaterThan(0);
  });

  it("exports a positive LLM_REQUEST_TIMEOUT_MS number", () => {
    expect(typeof LLM_REQUEST_TIMEOUT_MS).toBe("number");
    expect(LLM_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("exports a non-empty DEFAULT_MODEL string", () => {
    expect(typeof DEFAULT_MODEL).toBe("string");
    expect(DEFAULT_MODEL.length).toBeGreaterThan(0);
  });
});
