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
    const sentences = Array.isArray(record.sentences) ? record.sentences : [];
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
    railEl.classList.toggle('is-nested-scroll', isNestedScroll);

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
      setRailWidthForMode();
      highlighter.clearAll();
      // Measure the incoming header and body layout. In particular, chat's
      // sticky body can have a different viewport top from the topic body.
      renderRail({ measureOnly: true });
      measureRailOrigin();
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
      // Card boxes measured below include the inner scroller's current
      // viewport position. Preserve that projection origin so the component
      // can compensate if the outer document subsequently moves the scroller.
      const projectedScrollContainerTop = isNestedScroll
        ? scrollContainer.getBoundingClientRect().top
        : 0;
      const { cards, bodyHeight } =
        !measureOnly && Number.isFinite(railOriginTop)
          ? projectRail()
          : { cards: [], bodyHeight: FALLBACK_RAIL_BODY_HEIGHT };
      const commit = () => {
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
            scrollWindow={contentWindow}
            isNestedScroll={isNestedScroll}
            projectedScrollContainerTop={projectedScrollContainerTop}
            summariesDisabled={record.summariesDisabled === true}
            sentences={sentences}
            onChatHighlight={handleChatHighlight}
            onClearChatHighlights={handleClearChatHighlights}
            recordKey={record.key}
          />,
        );
      };
      // Only the measurement shell must be committed before a DOM read.
      if (measureOnly) flushSync(commit);
      else commit();
    }

    const measureRailOrigin = () => {
      const railBody = railEl.querySelector('.pagetollm-rail-body');
      if (!railBody) {
        railOriginTop = undefined;
        return;
      }
      // InPageRail's layout effect for nested scroll has already translated
      // the body by -effectiveScrollOffset (visual only). Boxes are computed
      // from the untransformed position, so measure without the transform.
      const prevTransform = railBody.style.transform;
      const prevOffset = railBody.style.getPropertyValue('--pagetollm-scroll-offset');
      const hadTransform = Boolean(prevTransform || prevOffset);
      if (hadTransform) {
        railBody.style.transform = '';
        railBody.style.removeProperty('--pagetollm-scroll-offset');
      }
      const rect = railBody.getBoundingClientRect();
      railOriginTop = getRailOriginTop(rect, scrollContainer, contentWindow);
      if (hadTransform) {
        railBody.style.transform = prevTransform;
        if (prevOffset) railBody.style.setProperty('--pagetollm-scroll-offset', prevOffset);
        else railBody.style.removeProperty('--pagetollm-scroll-offset');
      }
    };

    renderRail({ measureOnly: true });
    if (isClosed() || guard.isStale()) return false;
    measureRailOrigin();
    renderRail();

    // Re-resolve selectors to handle replaced article blocks and scrollers, and
    // recollect text even when hydration preserves the picked element itself.
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
        // Empty anchors clear detached ranges. A later insertion is observed
        // too, allowing a temporarily removed article to recover automatically.
        elements = nextElements;
        wordEntries = collectWordEntries(elements);
        sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
        scrollContainer = getScrollableAncestor(elements, {
          win: contentWindow,
          body: contentDocument.body,
          docEl: contentDocument.documentElement,
        });
        isNestedScroll = Boolean(scrollContainer && scrollContainer !== contentWindow);
        railEl.classList.toggle('is-nested-scroll', isNestedScroll);
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

    // A viewport resize can reflow the article and move the rail's document
    // origin. Re-measure it before rebuilding card geometry. In summaries
    // mode the rail height also reserves a viewport-sized run below the last
    // card (computeRailTrailingPad), so a resize leaves that reserve stale —
    // too short when the window grows, which is exactly the "summary floats
    // past the rail" case.
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
