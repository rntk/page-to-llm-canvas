import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  createThemeController,
  themeCycle,
  themeIcon,
  themeLabel,
} from '../shared/runtime/theme.js';
import { useStoredPreference } from './useStoredPreference.js';
import { browserScheduler } from '../shared/runtime/browserHosts.js';
import {
  HIGHLIGHT_COLOR_KEY,
  DEFAULT_HIGHLIGHT_COLOR,
  getStoredHighlightColor,
  setStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
} from '../highlights/highlightSettings.js';
import {
  PREFER_CONTENT_LANGUAGE_KEY,
  DEFAULT_PREFER_CONTENT_LANGUAGE,
  getStoredPreferContentLanguage,
  setStoredPreferContentLanguage,
  normalizePreferContentLanguage,
} from '../core/settings/language.js';
import {
  SUMMARIES_DISABLED_KEY,
  DEFAULT_SUMMARIES_DISABLED,
  getStoredSummariesDisabled,
  setStoredSummariesDisabled,
  normalizeSummariesDisabled,
} from '../core/settings/summary.js';
import {
  VERBOSE_LOGS_KEY,
  DEFAULT_VERBOSE_LOGS,
  getStoredVerboseLogs,
  setStoredVerboseLogs,
  normalizeVerboseLogs,
} from '../shared/runtime/verboseLogSettings.js';
import {
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MIN_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS,
  getStoredMaxParallelLlmRequests,
  setStoredMaxParallelLlmRequests,
  normalizeMaxParallelLlmRequests,
} from '../core/settings/llmConcurrency.js';
import {
  LLM_REQUEST_TIMEOUT_SECONDS_KEY,
  DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  MIN_LLM_REQUEST_TIMEOUT_SECONDS,
  MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  getStoredLlmRequestTimeoutSeconds,
  setStoredLlmRequestTimeoutSeconds,
  normalizeLlmRequestTimeoutSeconds,
} from '../core/settings/llmTimeout.js';
import {
  DECISION_SPLIT_THRESHOLD_KEY,
  DEFAULT_DECISION_SPLIT_THRESHOLD,
  MIN_DECISION_SPLIT_THRESHOLD,
  MAX_DECISION_SPLIT_THRESHOLD,
  DECISION_SPLIT_THRESHOLD_STEP,
  getStoredDecisionSplitThreshold,
  setStoredDecisionSplitThreshold,
  normalizeDecisionSplitThreshold,
} from '../core/settings/decisionThreshold.js';

function ThemeToggle() {
  const [controller] = useState(() => createThemeController());
  const [state, setState] = useState(() => controller.current());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.init();
    return unsubscribe;
  }, [controller]);

  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {themeCycle(state.allowSystem).map((option) => (
        <button
          key={option}
          type="button"
          className={`theme-option${state.preference === option ? ' active' : ''}`}
          aria-pressed={state.preference === option}
          onClick={() => controller.setPreference(option)}
        >
          {themeIcon(option)} {themeLabel(option)}
        </button>
      ))}
    </div>
  );
}

const HIGHLIGHT_PERSIST_DEBOUNCE_MS = 150;

function HighlightColorSection({ store, scheduler }) {
  const [color, setColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
  const persistTimer = useRef(null);
  const pendingColor = useRef(null);

  const previewColor = useCallback((nextColor) => {
    const normalized = normalizeHighlightColor(nextColor);
    setColor(normalized);
    applyHighlightColorToElement(document.documentElement, normalized);
    return normalized;
  }, []);

  const persistColor = useCallback(
    async (normalized) => {
      try {
        await setStoredHighlightColor(normalized);
      } catch (_) {
        const stored = await getStoredHighlightColor();
        previewColor(stored);
      }
    },
    [previewColor],
  );

  const flushPendingPersist = useCallback(() => {
    if (persistTimer.current) {
      scheduler.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    if (pendingColor.current != null) {
      const next = pendingColor.current;
      pendingColor.current = null;
      void persistColor(next);
    }
  }, [persistColor, scheduler]);

  useEffect(() => {
    let isCurrent = true;

    async function loadHighlightColor() {
      const stored = await getStoredHighlightColor();
      if (!isCurrent) return;
      previewColor(stored);
    }

    void loadHighlightColor();
    const unsubscribe = store.subscribe(HIGHLIGHT_COLOR_KEY, (newValue) => {
      if (newValue === undefined) {
        if (persistTimer.current) scheduler.clearTimeout(persistTimer.current);
        persistTimer.current = null;
        pendingColor.current = null;
      }
      previewColor(newValue);
    });

    return () => {
      isCurrent = false;
      unsubscribe();
      flushPendingPersist();
    };
  }, [previewColor, flushPendingPersist, scheduler, store]);

  const handleColorInput = useCallback(
    (nextColor) => {
      const normalized = previewColor(nextColor);
      pendingColor.current = normalized;
      if (persistTimer.current) scheduler.clearTimeout(persistTimer.current);
      persistTimer.current = scheduler.setTimeout(() => {
        persistTimer.current = null;
        const next = pendingColor.current;
        pendingColor.current = null;
        if (next != null) void persistColor(next);
      }, HIGHLIGHT_PERSIST_DEBOUNCE_MS);
    },
    [previewColor, persistColor, scheduler],
  );

  const resetColor = useCallback(() => {
    if (persistTimer.current) {
      scheduler.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    pendingColor.current = null;
    const normalized = previewColor(DEFAULT_HIGHLIGHT_COLOR);
    void persistColor(normalized);
  }, [previewColor, persistColor, scheduler]);

  return (
    <div className="settings-group">
      <h3>Highlight color</h3>
      <div className="highlight-color-control">
        <label htmlFor="highlight-color">Text and picked block highlight</label>
        <div className="highlight-color-row">
          <input
            id="highlight-color"
            type="color"
            value={color}
            onChange={(event) => handleColorInput(event.target.value)}
          />
          <span className="highlight-color-swatch" aria-hidden="true" />
          <span className="mono">{color}</span>
          <button type="button" onClick={resetColor}>
            Reset
          </button>
        </div>
        <div className="note">
          Used for sentence highlights, source preview highlights, and picked block backgrounds.
        </div>
      </div>
    </div>
  );
}

const CONTENT_LANGUAGE_PREFERENCE = {
  title: 'Language',
  id: 'prefer-content-language',
  type: 'checkbox',
  label: 'Prefer the language of the content',
  note: 'When enabled, topic labels and summaries are written in the dominant language of the analyzed content instead of always defaulting to English.',
  storageKey: PREFER_CONTENT_LANGUAGE_KEY,
  defaultValue: DEFAULT_PREFER_CONTENT_LANGUAGE,
  readPreference: getStoredPreferContentLanguage,
  writePreference: setStoredPreferContentLanguage,
  normalize: normalizePreferContentLanguage,
};

const SUMMARY_GENERATION_PREFERENCE = {
  title: 'Summaries',
  id: 'disable-summaries',
  type: 'checkbox',
  label: 'Disable summary generation',
  note: 'When enabled, processing stops after topic detection: topic labels and article structure are still computed, but no summaries are generated. Existing records keep their summaries until reprocessed. Records processed without summaries get a "Generate summaries" action below, which fills in the summaries from the already-computed topics without reprocessing the page.',
  storageKey: SUMMARIES_DISABLED_KEY,
  defaultValue: DEFAULT_SUMMARIES_DISABLED,
  readPreference: getStoredSummariesDisabled,
  writePreference: setStoredSummariesDisabled,
  normalize: normalizeSummariesDisabled,
};

const LLM_CONCURRENCY_PREFERENCE = {
  title: 'LLM concurrency',
  id: 'max-parallel-llm-requests',
  type: 'number',
  label: 'Maximum parallel requests',
  note: 'Limits LLM calls across all pages being processed at the same time. Extra calls wait in a shared queue. Changes apply to queued and future calls.',
  min: MIN_PARALLEL_LLM_REQUESTS,
  max: MAX_PARALLEL_LLM_REQUESTS,
  storageKey: MAX_PARALLEL_LLM_REQUESTS_KEY,
  defaultValue: DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  readPreference: getStoredMaxParallelLlmRequests,
  writePreference: setStoredMaxParallelLlmRequests,
  normalize: normalizeMaxParallelLlmRequests,
};

const LLM_TIMEOUT_PREFERENCE = {
  title: 'LLM request timeout',
  id: 'llm-request-timeout-seconds',
  type: 'number',
  label: 'Timeout (seconds)',
  note: 'Maximum time allowed for each LLM request. The default is 120 seconds. Changes apply to new requests and retry attempts.',
  min: MIN_LLM_REQUEST_TIMEOUT_SECONDS,
  max: MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  storageKey: LLM_REQUEST_TIMEOUT_SECONDS_KEY,
  defaultValue: DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  readPreference: getStoredLlmRequestTimeoutSeconds,
  writePreference: setStoredLlmRequestTimeoutSeconds,
  normalize: normalizeLlmRequestTimeoutSeconds,
};

const DECISION_SPLIT_THRESHOLD_PREFERENCE = {
  title: 'Decision topic splitting',
  id: 'decision-split-threshold',
  type: 'range',
  label: 'Split threshold',
  note: 'Used when a decision API topic splitter is configured. A new topic starts where the model’s split probability is at or above this value. Lower values produce more, smaller topics; higher values produce fewer, larger ones. The default is 0.50. Applies to the next processing run.',
  min: MIN_DECISION_SPLIT_THRESHOLD,
  max: MAX_DECISION_SPLIT_THRESHOLD,
  step: DECISION_SPLIT_THRESHOLD_STEP,
  storageKey: DECISION_SPLIT_THRESHOLD_KEY,
  defaultValue: DEFAULT_DECISION_SPLIT_THRESHOLD,
  readPreference: getStoredDecisionSplitThreshold,
  writePreference: setStoredDecisionSplitThreshold,
  normalize: normalizeDecisionSplitThreshold,
};

const VERBOSE_LOGS_PREFERENCE = {
  title: 'Diagnostics',
  id: 'verbose-logs',
  type: 'checkbox',
  label: 'Verbose pipeline and chat logs',
  note: "When enabled, each pipeline stage and chat turn — including every per-chunk, per-topic, and chat LLM request and response — is written to the relevant console. Pipeline events are also written to the record's processing log. Leave off for quieter runs; only lifecycle and error events are recorded then. Applies to the next pipeline or chat turn after the toggle changes.",
  storageKey: VERBOSE_LOGS_KEY,
  defaultValue: DEFAULT_VERBOSE_LOGS,
  readPreference: getStoredVerboseLogs,
  writePreference: setStoredVerboseLogs,
  normalize: normalizeVerboseLogs,
};

const NUMBER_COMMIT_DEBOUNCE_MS = 800;

/**
 * Local text draft for a numeric preference input. Typing only edits the
 * draft; the value is normalized and persisted on blur, Enter, or after a short
 * pause, so intermediate keystrokes ("1", "12" while typing "120") are never
 * stored and the field can be cleared while editing. While no draft exists the
 * displayed text follows the stored value, including external changes.
 * @param {{value: unknown, setValue: Function, enabled: boolean, scheduler: {setTimeout: Function, clearTimeout: Function}}} options
 */
function useNumberDraft({ value, setValue, enabled, scheduler }) {
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  const timerRef = useRef(null);
  const setValueRef = useRef(setValue);
  const schedulerRef = useRef(scheduler);
  useEffect(() => {
    setValueRef.current = setValue;
    schedulerRef.current = scheduler;
  }, [setValue, scheduler]);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      schedulerRef.current.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const commit = useCallback(() => {
    clearTimer();
    const pending = draftRef.current;
    if (pending == null) return;
    draftRef.current = null;
    setDraft(null);
    void setValueRef.current(pending);
  }, [clearTimer]);

  const edit = useCallback(
    (text) => {
      draftRef.current = text;
      setDraft(text);
      clearTimer();
      timerRef.current = schedulerRef.current.setTimeout(() => {
        timerRef.current = null;
        // An empty draft would normalize to the default; wait for blur/Enter.
        if (draftRef.current != null && draftRef.current.trim() !== '') commit();
      }, NUMBER_COMMIT_DEBOUNCE_MS);
    },
    [clearTimer, commit],
  );

  useEffect(
    () => () => {
      // Persist a finished edit on unmount, but never turn a cleared field
      // into the default value implicitly.
      if (draftRef.current != null && draftRef.current.trim() !== '') {
        void setValueRef.current(draftRef.current);
      }
      draftRef.current = null;
      clearTimer();
    },
    [clearTimer],
  );

  if (!enabled) return { text: value, onEdit: undefined, onCommit: undefined };
  return { text: draft ?? String(value), onEdit: edit, onCommit: commit };
}

function StoredPreferenceSection({ store, preference, scheduler = browserScheduler }) {
  const [value, setValue] = useStoredPreference({
    storageKey: preference.storageKey,
    defaultValue: preference.defaultValue,
    readPreference: preference.readPreference,
    writePreference: preference.writePreference,
    normalize: preference.normalize,
    subscribe: store.subscribe,
  });
  const isCheckbox = preference.type === 'checkbox';
  const isNumber = preference.type === 'number';
  const numberDraft = useNumberDraft({ value, setValue, enabled: isNumber, scheduler });
  const input = (
    <input
      id={preference.id}
      type={preference.type}
      min={preference.min}
      max={preference.max}
      step={isCheckbox ? undefined : (preference.step ?? '1')}
      checked={isCheckbox ? value : undefined}
      value={isCheckbox ? undefined : isNumber ? numberDraft.text : value}
      onChange={(event) =>
        isNumber
          ? numberDraft.onEdit(event.target.value)
          : setValue(isCheckbox ? event.target.checked : event.target.value)
      }
      onBlur={isNumber ? numberDraft.onCommit : undefined}
      onKeyDown={
        isNumber
          ? (event) => {
              if (event.key === 'Enter') numberDraft.onCommit();
            }
          : undefined
      }
    />
  );

  return (
    <div className="settings-group">
      <h3>{preference.title}</h3>
      <div className="field">
        {preference.type === 'checkbox' ? (
          <label htmlFor={preference.id}>
            {input} {preference.label}
          </label>
        ) : (
          <>
            <label htmlFor={preference.id}>{preference.label}</label>
            <div>
              {input}
              {preference.type === 'range' && <span className="mono"> {value.toFixed(2)}</span>}
            </div>
          </>
        )}
        <div className="note">{preference.note}</div>
      </div>
    </div>
  );
}

export function ContentLanguageSection({ store }) {
  return <StoredPreferenceSection preference={CONTENT_LANGUAGE_PREFERENCE} store={store} />;
}

export function SummaryGenerationSection({ store }) {
  return <StoredPreferenceSection preference={SUMMARY_GENERATION_PREFERENCE} store={store} />;
}

export function LlmConcurrencySection({ store, scheduler }) {
  return (
    <StoredPreferenceSection
      preference={LLM_CONCURRENCY_PREFERENCE}
      store={store}
      scheduler={scheduler}
    />
  );
}

export function LlmRequestTimeoutSection({ store, scheduler }) {
  return (
    <StoredPreferenceSection
      preference={LLM_TIMEOUT_PREFERENCE}
      store={store}
      scheduler={scheduler}
    />
  );
}

export function DecisionSplitThresholdSection({ store }) {
  return <StoredPreferenceSection preference={DECISION_SPLIT_THRESHOLD_PREFERENCE} store={store} />;
}

export function VerboseLogsSection({ store }) {
  return <StoredPreferenceSection preference={VERBOSE_LOGS_PREFERENCE} store={store} />;
}

export function GeneralSettingsPanel({ store, scheduler }) {
  return (
    <>
      <h2>General</h2>
      <div className="settings-list">
        <div className="settings-group">
          <h3>Theme</h3>
          <div>
            <ThemeToggle />
            <div className="note">Choose how the settings and canvas interface are displayed.</div>
          </div>
        </div>
        <ContentLanguageSection store={store} />
        <SummaryGenerationSection store={store} />
        <LlmConcurrencySection store={store} scheduler={scheduler} />
        <LlmRequestTimeoutSection store={store} scheduler={scheduler} />
        <DecisionSplitThresholdSection store={store} />
        <VerboseLogsSection store={store} />
        <HighlightColorSection scheduler={scheduler} store={store} />
      </div>
    </>
  );
}
