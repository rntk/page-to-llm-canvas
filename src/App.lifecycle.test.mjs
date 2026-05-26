import { describe, it, expect } from "vitest";
import appSource from "./App.jsx?raw";

describe("App.jsx pipeline ownership", () => {
  it("does not import runPipeline directly", () => {
    expect(appSource).not.toContain('import { runPipeline }');
  });

  it("does not invoke runPipeline in component code", () => {
    expect(appSource).not.toContain("runPipeline(");
  });

  it("sends ensurePipeline on mount", () => {
    expect(appSource).toContain('"ensurePipeline"');
  });
});

describe("App.jsx record error states", () => {
  it("treats record.status === 'error' as a terminal state (isRecordError)", () => {
    expect(appSource).toContain("record?.status === \"error\"");
  });

  it("passes recordError prop for pipeline errors (not hook errors)", () => {
    expect(appSource).toContain("recordError={isRecordError");
  });

  it("keeps hook-level error distinct from pipeline errors", () => {
    expect(appSource).toContain("!isRecordError && !isMissing && !isDeleted ? error : null");
  });

  it("handles missing record as a distinct state", () => {
    expect(appSource).toContain('error === "record not found"');
  });

  it("handles deleted record as a distinct state", () => {
    expect(appSource).toContain('error === "record deleted"');
  });

  it("sends retryRecord message on retry", () => {
    expect(appSource).toContain('"retryRecord"');
  });

  it("renders spinner only when not done, not error, not missing, not deleted", () => {
    expect(appSource).toContain("!isDone && (");
    expect(appSource).toContain("isMissing");
    expect(appSource).toContain("isDeleted");
  });
});
