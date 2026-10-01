import { projectArticleView } from '../../../domain/articleView.js';
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
import { buildRailCards } from './railProjection.js';
import {
  fetchRecord,
  findPickedElements,
  assessRecordForRail,
  describeFetchFailure,
} from '../shared/recordFetch.js';
import { createOptionsRecoveryOpener } from '../shared/optionsRecovery.js';
import { createRailState, normalizeRailMode } from '../shared/railState.js';
import { browserRuntimeMessenger } from '../../../utils/runtimeMessages.js';
import { createLogger } from '../../../shared/runtime/log.js';
import { MSG } from '../../../shared/runtime/messages.js';
import { createResplitAction } from '../../../shared/runtime/topicResplit.js';

const defaultDialogs = {
  alert: (...args) => globalThis.alert(...args),
  confirm: (...args) => globalThis.confirm(...args),
};
const defaultRuntimeMessenger = {
  ...browserRuntimeMessenger,
  getURL: (path) => globalThis.chrome.runtime.getURL(path),
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
  const openOptionsForRecovery = createOptionsRecoveryOpener({ runtimeMessenger, alert, logger });

  async function openInPageRail(rec, initialMode = 'topics', options = {}) {
    const guard = surfaceManager.beginLoad();

    // Re-fetch even when the widget supplied a record.
    const fetchOutcome = await fetchRecord(rec.key, runtimeMessenger);
    if (guard.isStale()) {
      // A newer rail request superseded this one.
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
    let elements = findPickedElements(record.selectors, contentDocument);
    if (elements.length === 0) {
      const openCanvas = confirm(
        'PageToLLM: Could not locate the original article blocks on this page; the page layout may have changed.\n\nWould you like to open it in the full canvas view instead?',
      );
      if (openCanvas) {
        openRecordFrame(record.key);
      }
      return false;
    }

    let wordEntries = collectWordEntries(elements);
    const { sentences } = projectArticleView(record);
    let sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
    let scrollContainer = getScrollableAncestor(elements, {
      win: contentWindow,
      body: contentDocument.body,
      docEl: contentDocument.documentElement,
    });
    let isNestedScroll = Boolean(scrollContainer && scrollContainer !== contentWindow);
    let mutationObserver;
    let mutationFrameId = 0;
    let pendingMutations = [];

    const state = createRailState(initialMode, options);
    // Use cards when margin notes are hard to read on this page.
    state.topicLayout = 'notes';

    const maxLevel = computeMaxTopicLevel(record);

    // Create the adapter before the surface so teardown can release page resources.
    const highlighter = createPageHighlighter({
      wordEntries,
      sentenceRanges,
      scrollContainer,
      window: contentWindow,
    });

    const surface = surfaceManager.createSurface({
      state,
      onTeardown: () => {
        mutationObserver?.disconnect();
        if (mutationFrameId) contentWindow.cancelAnimationFrame(mutationFrameId);
        pendingMutations = [];
        highlighter.destroy();
        onDestroy?.();
      },
    });
    if (!surface) {
      highlighter.destroy();
      return false;
    }
    const { railEl, railRoot, setRailWidthForMode, isClosed } = surface;
    railEl.dataset.topicLayout = state.topicLayout;

    const topicActions = [
      createResplitAction({
        topics: record.topics,
        request: (topic) =>
          runtimeMessenger.send({ type: MSG.resplitTopic, key: record.key, ...topic }),
        onAccepted: closeRail,
        confirm,
      }),
    ];

    let railOriginTop;

    const projectRail = () =>
      buildRailCards({
        record,
        mode: state.mode,
        selectedLevel: state.selectedLevel,
        sentenceRanges,
        wordEntries,
        railOriginTop,
        scrollContainer,
        win: contentWindow,
      });

    const handleSelectMode = (mode) => {
      if (isClosed()) return;
      const next = normalizeRailMode(mode);
      if (state.mode === next) return;
      // clearAll removes both topic and chat highlights.
      state.mode = next;
      railEl.dataset.mode = state.mode;
      setRailWidthForMode();
      highlighter.clearAll();
      // Chat's sticky body may have a different viewport origin.
      renderRail({ measureOnly: true });
      measureRailOrigin();
      renderRail();
    };

    const handleSelectTopicLayout = (layout) => {
      if (isClosed()) return;
      if (state.topicLayout === layout) return;
      state.topicLayout = layout;
      railEl.dataset.topicLayout = layout;
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
      const sentenceList = card.sentences || [];
      highlighter.highlightTopic(sentenceList, on);
    };

    const handleScrollToCard = (card) => {
      const sentenceList = card.sentences || [];
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
      // Preserve the scroller's viewport origin for later outer-page movement.
      const projectedScrollContainerTop = isNestedScroll
        ? scrollContainer.getBoundingClientRect().top
        : 0;
      const cards = !measureOnly && Number.isFinite(railOriginTop) ? projectRail() : [];
      const commit = () => {
        railRoot.render(
          <InPageRail
            mode={state.mode}
            maxLevel={maxLevel}
            selectedLevel={state.selectedLevel}
            cards={cards}
            topicActions={topicActions}
            onClose={closeRail}
            onSelectMode={handleSelectMode}
            onSelectLevel={handleSelectLevel}
            topicLayout={state.topicLayout}
            onSelectTopicLayout={handleSelectTopicLayout}
            onHighlightCard={handleHighlightCard}
            onScrollToCard={handleScrollToCard}
            scrollContainer={scrollContainer}
            scrollWindow={contentWindow}
            isNestedScroll={isNestedScroll}
            projectedScrollContainerTop={projectedScrollContainerTop}
            railOriginTop={railOriginTop}
            summariesDisabled={record.summariesDisabled === true}
            sentences={sentences}
            onChatHighlight={handleChatHighlight}
            onClearChatHighlights={handleClearChatHighlights}
            recordKey={record.key}
            contentRevision={record.contentRevision}
          />,
        );
      };
      // Only the measurement shell must be committed before a DOM read.
      if (measureOnly) flushSync(commit);
      else commit();
    }

    // The fixed body's rect is the card projection origin.
    const measureRailOrigin = () => {
      const railBody = railEl.querySelector('.pagetollm-rail-body');
      railOriginTop = railBody ? getRailOriginTop(railBody.getBoundingClientRect()) : undefined;
    };

    renderRail({ measureOnly: true });
    if (isClosed() || guard.isStale()) return false;
    measureRailOrigin();
    renderRail();

    // Re-resolve selectors and text after article or scroller mutations.
    mutationObserver = new contentWindow.MutationObserver((mutations) => {
      if (isClosed() || guard.isStale()) return;
      const pageMutations = mutations.filter(({ target }) => !railEl.contains(target));
      if (pageMutations.length === 0) return;
      for (const mutation of pageMutations) pendingMutations.push(mutation);
      if (mutationFrameId) return;
      mutationFrameId = contentWindow.requestAnimationFrame(() => {
        mutationFrameId = 0;
        const frameMutations = pendingMutations;
        pendingMutations = [];
        if (isClosed() || guard.isStale()) return;
        // Even unrelated mutation batches share one selector pass per frame.
        const nextElements = findPickedElements(record.selectors, contentDocument);
        const changed =
          nextElements.length !== elements.length ||
          nextElements.some((element, index) => element !== elements[index]) ||
          frameMutations.some(({ target, addedNodes, removedNodes }) =>
            elements.some(
              (element) =>
                element.contains(target) ||
                [...addedNodes, ...removedNodes].some((node) => node.contains(element)),
            ),
          );
        if (!changed) return;
        // Clear detached ranges; later insertions can restore anchors.
        elements = nextElements;
        wordEntries = collectWordEntries(elements);
        sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
        scrollContainer = getScrollableAncestor(elements, {
          win: contentWindow,
          body: contentDocument.body,
          docEl: contentDocument.documentElement,
        });
        isNestedScroll = Boolean(scrollContainer && scrollContainer !== contentWindow);
        highlighter.updateAnchors({ wordEntries, sentenceRanges, scrollContainer });
        // Chat citations still need fresh anchors, but display no rail cards.
        if (state.mode === 'chat') return;
        measureRailOrigin();
        renderRail();
      });
    });
    mutationObserver.observe(contentDocument.documentElement, {
      // Avoid style/class animation traffic (including our own positioning).
      // Attribute-only visibility changes are intentionally not tracked here.
      childList: true,
      characterData: true,
      subtree: true,
    });

    // Re-measure the origin and sentences after viewport reflow.
    highlighter.onViewportResize(() => {
      if (isClosed() || guard.isStale() || state.mode === 'chat') return;
      measureRailOrigin();
      renderRail();
    });

    if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
      contentWindow.requestAnimationFrame(() => {
        if (isClosed() || guard.isStale()) return;
        highlighter.highlightTopic(options.sentenceNumbers, true);
        highlighter.scrollToFirst(options.sentenceNumbers);
      });
    }
    return true;
  }

  return { openInPageRail };
}
