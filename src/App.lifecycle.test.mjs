import { describe, it, expect } from 'vitest';
import appSource from './App.jsx?raw';

describe('App.jsx pipeline ownership', () => {
  it('does not import runPipeline directly', () => {
    expect(appSource).not.toContain('import { runPipeline }');
  });

  it('does not invoke runPipeline in component code', () => {
    expect(appSource).not.toContain('runPipeline(');
  });

  it('sends ensurePipeline on mount', () => {
    expect(appSource).toContain('MSG.ensurePipeline');
  });
});

describe('App.jsx record error states', () => {
  it("treats record.status === 'error' as a terminal state (isRecordError)", () => {
    expect(appSource).toContain("record?.status === 'error'");
  });

  it('passes recordError prop for pipeline errors (not hook errors)', () => {
    expect(appSource).toContain('recordError={isRecordError');
  });

  it('keeps hook-level error distinct from pipeline errors', () => {
    expect(appSource).toContain('!isRecordError && !isMissing && !isDeleted ? error : null');
  });

  it('handles missing record as a distinct state', () => {
    expect(appSource).toContain("error === 'record not found'");
  });

  it('handles deleted record as a distinct state', () => {
    expect(appSource).toContain("error === 'record deleted'");
  });

  it('sends retryRecord message on retry', () => {
    expect(appSource).toContain('retryRecord');
  });

  it('renders spinner only when not done, not needs-attention, not missing, not deleted', () => {
    expect(appSource).toContain('!isDone && !isNeedsAttention && (');
    expect(appSource).toContain('isMissing');
    expect(appSource).toContain('isDeleted');
  });

  it('renders the summary-errors popup when the record is parked for review', () => {
    expect(appSource).toContain('isNeedsAttention && (');
    expect(appSource).toContain('SummaryErrorsOverlay');
    expect(appSource).toContain('resolveSummaryErrors');
  });
});

describe('App.jsx optional-summary handling (record.summariesDisabled)', () => {
  it('derives summariesDisabled from the record', () => {
    expect(appSource).toContain('record?.summariesDisabled === true');
  });

  it('guards the summary-mode toggle so it is a no-op when summaries are disabled', () => {
    expect(appSource).toContain('if (summariesDisabled) return;');
  });

  it('forces summary mode off when summaries are disabled (derived, not effect-reset)', () => {
    expect(appSource).toContain('showSummaryModeRaw && !summariesDisabled');
  });

  it('suppresses the floating current-topic summary card when summaries are disabled', () => {
    expect(appSource).toContain('if (summariesDisabled) return null;');
  });

  it('tells CanvasZoomControls whether summary mode is available', () => {
    expect(appSource).toContain('summaryModeAvailable={!summariesDisabled}');
  });
});
