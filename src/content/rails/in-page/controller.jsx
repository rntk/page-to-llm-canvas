import React from 'react';
import { flushSync } from 'react-dom';
import InPageRail from './InPageRail.jsx';
import {
  collectWordEntries,
  buildSentenceWordRanges,
} from '../../../highlights/sentenceHighlight.js';
import { computeMaxTopicLevel } from '../shared/railCards.js';
import { getScrollableAncestor, getRailOriginTop } from './geometry.js';
import { createPageHighlighter } from './pageHighlighter.js';
import { buildRailCards, FALLBACK_RAIL_BODY_HEIGHT } from './railProjection.js';
import {
  fetchRecord,
  findPickedElements,
  assessRecordForRail,
  describeFetchFailure,
} from '../shared/recordFetch.js';
import { browserRuntimeMessenger } from '../../../utils/runtimeMessages.js';
import { createLogger } from '../../../shared/runtime/log.js';

const defaultDialogs = {
  alert: (...args) => globalThis.alert(...args),
  confirm: (...args) => globalThis.confirm(...args),
};
const defaultRuntimeMessenger = {
  ...browserRuntimeMessenger,
  getURL: (path) => globalThis.chrome.runtime.getURL(path),
  ...(typeof globalThis.chrome?.runtime?.openOptionsPage === 'function'
    ? { openOptionsPage: () => globalThis.chrome.runtime.openOptionsPage() }
    : {}),
};

export function createInPageRailController({
  surfaceManager,
  openRecordFrame,
  document: contentDocument = globalThis.document,
  window: contentWindow = contentDocument?.defaultView ?? globalThis.window,
  runtimeMessenger = defaultRuntimeMessenger,
  dialogs = defaultDialogs,
  logger = createLogger('in-page rail'),
  onDestroy,
} = {}) {
  const closeRail = surfaceManager.close;
  const { alert, confirm } = { ...defaultDialogs, ...(dialogs ?? {}) };

  async function openOptionsForRecovery() {
    const url = runtimeMessenger.getURL('options.html#records');
    if (typeof contentWindow.open === 'function' && contentWindow.open(url, '_blank')) return;
    if (typeof runtimeMessenger.openOptionsPage === 'function') {
      await runtimeMessenger.openOptionsPage();
      return;
    }
    alert('PageToLLM: Open the extension Options page to review this analysis.');
  }

  async function openInPageRail(rec, initialMode, options = {}) {
    const guard = surfaceManager.beginLoad();

    // Always re-fetch to get the latest data even if widget data is stale.
    const fetchOutcome = await fetchRecord(rec.key, runtimeMessenger);
    if (guard.isStale()) {
      // A newer rail request has started loading, abort this one!
      return false;
    }

    const fetchFailure = describeFetchFailure(fetchOutcome);
    if (fetchFailure) {
      if (fetchFailure.error) logger.warn('record fetch failed:', fetchFailure.error);
      alert(fetchFailure.message);
      return false;
    }

    const assessment = assessRecordForRail(fetchOutcome.record);
    if (assessment.kind === 'error') {
      await openOptionsForRecovery();
      return false;
    }
    if (assessment.kind === 'needs_attention') {
      await openOptionsForRecovery();
      return false;
    }
    if (assessment.kind === 'in_progress') {
      alert(
        `PageToLLM: Analysis is currently in progress (status: ${assessment.stage}). Please wait a moment and try again.`,
      );
      return false;
    }
    if (assessment.kind === 'no_selectors') {
      const openCanvas = confirm(
        'PageToLLM: This record has no saved selectors.\n\nWould you like to open it in the full canvas view instead?',
      );
      if (openCanvas) {
        openRecordFrame(assessment.record.key);
      }
      return false;
    }
    const record = assessment.record;
    const elements = findPickedElements(record.selectors, contentDocument);
    if (elements.length === 0) {
      const openCanvas = confirm(
        'PageToLLM: Could not locate the original article blocks on this page; the page layout may have changed.\n\nWould you like to open it in the full canvas view instead?',
      );
      if (openCanvas) {
        openRecordFrame(record.key);
      }
      return false;
    }

    const wordEntries = collectWordEntries(elements);
    const sentences = Array.isArray(record.sentences) ? record.sentences : [];
    const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
    const scrollContainer = getScrollableAncestor(elements);

    const state = {
      mode: initialMode,
      selectedLevel: options && typeof options.level === 'number' ? options.level : 0,
    };

    const maxLevel = computeMaxTopicLevel(record);

    // Built before the surface so onTeardown can hand page cleanup (highlights
    // and the resize listener) straight to the adapter.
    const highlighter = createPageHighlighter({
      wordEntries,
      sentenceRanges,
      scrollContainer,
      window: contentWindow,
    });

    const { railEl, railRoot, setRailWidthForMode, isClosed } = surfaceManager.createSurface({
      state,
      onTeardown: () => {
        highlighter.destroy();
        onDestroy?.();
      },
    });

    // The chat body is viewport-sticky. Keep its host fixed as well; otherwise
    // the absolute rail's viewport-sized containing block bounds the sticky
    // child and the whole chat scrolls away with the article.
    const syncRailPosition = () => {
      railEl.style.position = state.mode === 'chat' ? 'fixed' : 'absolute';
      railEl.style.top = '0';
      if (state.mode === 'chat') railEl.style.bottom = '0';
      else railEl.style.removeProperty('bottom');
    };
    syncRailPosition();

    let railOriginTop = 0;

    const projectRail = () =>
      buildRailCards({
        record,
        mode: state.mode,
        selectedLevel: state.selectedLevel,
        sentenceRanges,
        wordEntries,
        railOriginTop,
        scrollContainer,
      });

    const handleSelectMode = (mode) => {
      if (isClosed()) return;
      if (mode === 'canvas') {
        closeRail();
        openRecordFrame(record.key);
        return;
      }
      if (mode === 'hierarchy') {
        closeRail();
        openRecordFrame(record.key, 'hierarchy');
        return;
      }
      if (state.mode === mode) return;
      // highlighter.clearAll() below already clears the chat sentences along
      // with the topic set, so no per-mode special-casing is needed here.
      state.mode = mode;
      railEl.dataset.mode = state.mode;
      syncRailPosition();
      setRailWidthForMode();
      highlighter.clearAll();
      renderRail();
    };

    const handleSelectLevel = (level) => {
      if (isClosed()) return;
      if (state.selectedLevel === level) return;
      state.selectedLevel = level;
      highlighter.clearAll();
      renderRail();
    };

    const handleHighlightCard = (card, on) => {
      const sentenceList = card.sentences || card.sourceSentences || [];
      highlighter.highlightTopic(sentenceList, on);
    };

    const handleScrollToCard = (card) => {
      const sentenceList = card.sentences || card.sourceSentences || [];
      highlighter.scrollToFirst(sentenceList);
    };

    const handleChatHighlight = ({ startLine, endLine }, { focus = false } = {}) => {
      if (isClosed() || guard.isStale()) return;
      highlighter.highlightChatRange(startLine, endLine);
      if (focus) highlighter.scrollToFirst([startLine]);
    };

    const handleClearChatHighlights = () => {
      if (isClosed() || guard.isStale()) return;
      highlighter.clearChatHighlights();
    };

    function renderRail({ measureOnly = false } = {}) {
      if (isClosed() || guard.isStale()) return;
      const { cards, bodyHeight } = railOriginTop
        ? projectRail()
        : { cards: [], bodyHeight: FALLBACK_RAIL_BODY_HEIGHT };
      flushSync(() => {
        railRoot.render(
          <InPageRail
            mode={state.mode}
            maxLevel={maxLevel}
            selectedLevel={state.selectedLevel}
            cards={measureOnly ? [] : cards}
            bodyHeight={measureOnly ? FALLBACK_RAIL_BODY_HEIGHT : bodyHeight}
            onClose={closeRail}
            onSelectMode={handleSelectMode}
            onSelectLevel={handleSelectLevel}
            onHighlightCard={handleHighlightCard}
            onScrollToCard={handleScrollToCard}
            scrollContainer={scrollContainer}
            summariesDisabled={record.summariesDisabled === true}
            sentences={sentences}
            onChatHighlight={handleChatHighlight}
            onClearChatHighlights={handleClearChatHighlights}
            recordKey={record.key}
          />,
        );
      });
    }

    renderRail({ measureOnly: true });
    if (isClosed() || guard.isStale()) return false;
    const bodyRect = railEl.querySelector('.pagetollm-rail-body').getBoundingClientRect();
    railOriginTop = getRailOriginTop(bodyRect, scrollContainer);
    renderRail();

    // In summaries mode the rail height reserves a viewport-sized run below the
    // last card (computeRailTrailingPad), so a resize leaves it stale — too short
    // when the window grows, which is exactly the "summary floats past the rail"
    // case. Re-render to re-measure.
    highlighter.onViewportResize(() => {
      if (isClosed() || guard.isStale() || state.mode !== 'summaries') return;
      renderRail();
    });

    if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
      requestAnimationFrame(() => {
        if (isClosed() || guard.isStale()) return;
        highlighter.highlightTopic(options.sentenceNumbers, true);
        highlighter.scrollToFirst(options.sentenceNumbers);
      });
    }
    return true;
  }

  return { openInPageRail };
}
