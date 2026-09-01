import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  createThemeController,
  themeCycle,
  themeIcon,
  themeLabel,
} from '../shared/runtime/theme.js';
import { useStoredPreference } from './useStoredPreference.js';
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
} from '../../worker/settings/language.js';
import {
  SUMMARIES_DISABLED_KEY,
  DEFAULT_SUMMARIES_DISABLED,
  getStoredSummariesDisabled,
  setStoredSummariesDisabled,
  normalizeSummariesDisabled,
} from '../../worker/settings/summary.js';
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
} from '../../worker/settings/llmConcurrency.js';
import {
  LLM_REQUEST_TIMEOUT_SECONDS_KEY,
  DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  MIN_LLM_REQUEST_TIMEOUT_SECONDS,
  MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  getStoredLlmRequestTimeoutSeconds,
  setStoredLlmRequestTimeoutSeconds,
  normalizeLlmRequestTimeoutSeconds,
} from '../../worker/settings/llmTimeout.js';

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

function StoredPreferenceSection({ store, preference }) {
  const [value, setValue] = useStoredPreference({
    storageKey: preference.storageKey,
    defaultValue: preference.defaultValue,
    readPreference: preference.readPreference,
    writePreference: preference.writePreference,
    normalize: preference.normalize,
    subscribe: store.subscribe,
  });
  const input = (
    <input
      id={preference.id}
      type={preference.type}
      min={preference.min}
      max={preference.max}
      step={preference.type === 'number' ? '1' : undefined}
      checked={preference.type === 'checkbox' ? value : undefined}
      value={preference.type === 'number' ? value : undefined}
      onChange={(event) =>
        setValue(preference.type === 'checkbox' ? event.target.checked : event.target.value)
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
            <div>{input}</div>
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

export function LlmConcurrencySection({ store }) {
  return <StoredPreferenceSection preference={LLM_CONCURRENCY_PREFERENCE} store={store} />;
}

export function LlmRequestTimeoutSection({ store }) {
  return <StoredPreferenceSection preference={LLM_TIMEOUT_PREFERENCE} store={store} />;
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
        <LlmConcurrencySection store={store} />
        <LlmRequestTimeoutSection store={store} />
        <VerboseLogsSection store={store} />
        <HighlightColorSection scheduler={scheduler} store={store} />
      </div>
    </>
  );
}
