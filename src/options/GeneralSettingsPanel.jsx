import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createThemeController, themeCycle, themeIcon, themeLabel } from '../../theme.js';
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
} from '../../worker/settings/verboseLog.js';
import {
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MIN_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS,
  getStoredMaxParallelLlmRequests,
  setStoredMaxParallelLlmRequests,
  normalizeMaxParallelLlmRequests,
} from '../../worker/settings/llmConcurrency.js';

export function ThemeToggle() {
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

export function HighlightColorSection() {
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
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    if (pendingColor.current != null) {
      const next = pendingColor.current;
      pendingColor.current = null;
      void persistColor(next);
    }
  }, [persistColor]);

  useEffect(() => {
    let isCurrent = true;

    async function loadHighlightColor() {
      const stored = await getStoredHighlightColor();
      if (!isCurrent) return;
      previewColor(stored);
    }

    void loadHighlightColor();
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== 'local' || !changes || !changes[HIGHLIGHT_COLOR_KEY]) return;
      if (changes[HIGHLIGHT_COLOR_KEY].newValue === undefined) {
        if (persistTimer.current) clearTimeout(persistTimer.current);
        persistTimer.current = null;
        pendingColor.current = null;
      }
      previewColor(changes[HIGHLIGHT_COLOR_KEY].newValue);
    };
    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch (_) {
      /* noop */
    }
    return () => {
      isCurrent = false;
      try {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      } catch (_) {
        /* noop */
      }
      flushPendingPersist();
    };
  }, [previewColor, flushPendingPersist]);

  const handleColorInput = useCallback(
    (nextColor) => {
      const normalized = previewColor(nextColor);
      pendingColor.current = normalized;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        persistTimer.current = null;
        const next = pendingColor.current;
        pendingColor.current = null;
        if (next != null) void persistColor(next);
      }, HIGHLIGHT_PERSIST_DEBOUNCE_MS);
    },
    [previewColor, persistColor],
  );

  const resetColor = useCallback(() => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    pendingColor.current = null;
    const normalized = previewColor(DEFAULT_HIGHLIGHT_COLOR);
    void persistColor(normalized);
  }, [previewColor, persistColor]);

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

export function ContentLanguageSection() {
  const [preferContentLanguage, setPreferContentLanguage] = useStoredPreference({
    storageKey: PREFER_CONTENT_LANGUAGE_KEY,
    defaultValue: DEFAULT_PREFER_CONTENT_LANGUAGE,
    readPreference: getStoredPreferContentLanguage,
    writePreference: setStoredPreferContentLanguage,
    normalize: normalizePreferContentLanguage,
  });

  return (
    <div className="settings-group">
      <h3>Language</h3>
      <div className="field">
        <label htmlFor="prefer-content-language">
          <input
            id="prefer-content-language"
            type="checkbox"
            checked={preferContentLanguage}
            onChange={(event) => setPreferContentLanguage(event.target.checked)}
          />{' '}
          Prefer the language of the content
        </label>
        <div className="note">
          When enabled, topic labels and summaries are written in the dominant language of the
          analyzed content instead of always defaulting to English.
        </div>
      </div>
    </div>
  );
}

export function SummaryGenerationSection() {
  const [summariesDisabled, setSummariesDisabled] = useStoredPreference({
    storageKey: SUMMARIES_DISABLED_KEY,
    defaultValue: DEFAULT_SUMMARIES_DISABLED,
    readPreference: getStoredSummariesDisabled,
    writePreference: setStoredSummariesDisabled,
    normalize: normalizeSummariesDisabled,
  });

  return (
    <div className="settings-group">
      <h3>Summaries</h3>
      <div className="field">
        <label htmlFor="disable-summaries">
          <input
            id="disable-summaries"
            type="checkbox"
            checked={summariesDisabled}
            onChange={(event) => setSummariesDisabled(event.target.checked)}
          />{' '}
          Disable summary generation
        </label>
        <div className="note">
          When enabled, processing stops after topic detection: topic labels and article structure
          are still computed, but no summaries are generated. Existing records keep their summaries
          until reprocessed. Records processed without summaries get a &quot;Generate
          summaries&quot; action below, which fills in the summaries from the already-computed
          topics without reprocessing the page.
        </div>
      </div>
    </div>
  );
}

export function LlmConcurrencySection() {
  const [maxParallelRequests, setMaxParallelRequests] = useStoredPreference({
    storageKey: MAX_PARALLEL_LLM_REQUESTS_KEY,
    defaultValue: DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
    readPreference: getStoredMaxParallelLlmRequests,
    writePreference: setStoredMaxParallelLlmRequests,
    normalize: normalizeMaxParallelLlmRequests,
  });

  return (
    <div className="settings-group">
      <h3>LLM concurrency</h3>
      <div className="field">
        <label htmlFor="max-parallel-llm-requests">Maximum parallel requests</label>
        <div>
          <input
            id="max-parallel-llm-requests"
            type="number"
            min={MIN_PARALLEL_LLM_REQUESTS}
            max={MAX_PARALLEL_LLM_REQUESTS}
            step="1"
            value={maxParallelRequests}
            onChange={(event) => setMaxParallelRequests(event.target.value)}
          />
        </div>
        <div className="note">
          Limits LLM calls across all pages being processed at the same time. Extra calls wait in a
          shared queue. Changes apply to queued and future calls.
        </div>
      </div>
    </div>
  );
}

export function VerboseLogsSection() {
  const [verboseLogs, setVerboseLogs] = useStoredPreference({
    storageKey: VERBOSE_LOGS_KEY,
    defaultValue: DEFAULT_VERBOSE_LOGS,
    readPreference: getStoredVerboseLogs,
    writePreference: setStoredVerboseLogs,
    normalize: normalizeVerboseLogs,
  });

  return (
    <div className="settings-group">
      <h3>Diagnostics</h3>
      <div className="field">
        <label htmlFor="verbose-logs">
          <input
            id="verbose-logs"
            type="checkbox"
            checked={verboseLogs}
            onChange={(event) => setVerboseLogs(event.target.checked)}
          />{' '}
          Verbose pipeline and chat logs
        </label>
        <div className="note">
          When enabled, each pipeline stage and chat turn — including every per-chunk, per-topic,
          and chat LLM request and response — is written to the relevant console. Pipeline events
          are also written to the record&apos;s processing log. Leave off for quieter runs; only
          lifecycle and error events are recorded then. Applies to the next pipeline or chat turn
          after the toggle changes.
        </div>
      </div>
    </div>
  );
}

export function GeneralSettingsPanel() {
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
        <ContentLanguageSection />
        <SummaryGenerationSection />
        <LlmConcurrencySection />
        <VerboseLogsSection />
        <HighlightColorSection />
      </div>
    </>
  );
}
