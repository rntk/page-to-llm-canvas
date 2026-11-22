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
import { canDrawNotes } from './marginNotes.js';
import { findPickedElements, assessRecordForRail } from '../shared/recordFetch.js';
import { createRecordLoader } from '../shared/recordLoader.js';
import { resolveRailLevel } from '../shared/railState.js';
import { RAIL_MODE } from '../../../shared/runtime/contracts.js';
import { browserRuntimeMessenger } from '../../../utils/runtimeMessages.js';
import { createLogger } from '../../../shared/runtime/log.js';
import { MSG } from '../../../shared/runtime/messages.js';
import { createResplitAction } from '../../../shared/runtime/topicResplit.js';

// Trailing delay before unrelated page mutations trigger a selector pass.
const UNRELATED_MUTATION_RESOLVE_MS = 500;

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
  const recordLoader = createRecordLoader({ surfaceManager, runtimeMessenger, alert, logger });

  async function openInPageRail(rec, initialMode = RAIL_MODE.TOPICS, options = {}) {
    // Re-fetch even when the widget supplied a record.
    const { guard, assessment } = await recordLoader.load(rec.key, {
      assess: assessRecordForRail,
    });
    if (!assessment || guard.isStale()) return false;
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
    let unrelatedResolveId = 0;
    let pendingMutations = [];

    let selectedLevel = resolveRailLevel(options);
    // Use cards when margin notes are hard to read on this page.
    let preferredTopicLayout = 'notes';

    const maxLevel = computeMaxTopicLevel(record);

    // Create the adapter before the surface so teardown can release page resources.
    const highlighter = createPageHighlighter({
      wordEntries,
      sentenceRanges,
      scrollContainer,
      window: contentWindow,
    });

    const surface = surfaceManager.createSurface({
      initialMode,
      onTeardown: () => {
        mutationObserver?.disconnect();
        if (mutationFrameId) contentWindow.cancelAnimationFrame(mutationFrameId);
        if (unrelatedResolveId) contentWindow.clearTimeout(unrelatedResolveId);
        pendingMutations = [];
        highlighter.destroy();
        onDestroy?.();
      },
    });
    if (!surface) {
      highlighter.destroy();
      return false;
    }
    const { railEl, railRoot, setMode, setSide, isClosed } = surface;
    railEl.dataset.topicLayout = preferredTopicLayout;

    const topicActions = [
      createResplitAction({
        topics: record.topics,
        request: (topic) =>
          runtimeMessenger.send({ type: MSG.resplitTopic, key: record.key, ...topic }),
        onAccepted: closeRail,
      }),
    ];

    let railOriginTop;

    const projectRail = (level = selectedLevel) =>
      buildRailCards({
        record,
        mode: surface.mode,
        selectedLevel: level,
        sentenceRanges,
        wordEntries,
        railOriginTop,
        scrollContainer,
        win: contentWindow,
      });

    const handleSelectMode = (mode) => {
      if (!setMode(mode)) return;
      highlighter.clearAll();
      // Chat's sticky body may have a different viewport origin.
      renderRail({ measureOnly: true });
      measureRailOrigin();
      renderRail();
    };

    const handleSelectSide = (side) => {
      if (!setSide(side)) return;
      // Chat citations stay selected in the mounted chat; their ranges follow the reflow.
      if (surface.mode !== RAIL_MODE.CHAT) highlighter.clearAll();
      // The page reflows around the moved reserve; re-measure before projecting.
      renderRail({ measureOnly: true });
      measureRailOrigin();
      renderRail();
    };

    const handleSelectTopicLayout = (layout) => {
      if (isClosed()) return;
      if (preferredTopicLayout === layout) return;
      preferredTopicLayout = layout;
      railEl.dataset.topicLayout = layout;
      highlighter.clearAll();
      renderRail();
    };

    const handleSelectLevel = (level) => {
      if (isClosed()) return;
      if (selectedLevel === level) return;
      selectedLevel = level;
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
      const { mode, side } = surface;
      // Preserve the scroller's viewport origin for later outer-page movement.
      const projectedScrollContainerTop = isNestedScroll
        ? scrollContainer.getBoundingClientRect().top
        : 0;
      const canProject = mode !== RAIL_MODE.CHAT && !measureOnly && Number.isFinite(railOriginTop);
      // Summaries mode hints at better levels, so every level is projected;
      // the selected level's cards are reused rather than projected twice.
      let levelCards;
      if (canProject && mode === RAIL_MODE.SUMMARIES && maxLevel > 0) {
        levelCards = new Map();
        for (let level = 0; level <= maxLevel; level += 1) {
          levelCards.set(level, projectRail(level));
        }
      }
      const cards = !canProject ? [] : (levelCards?.get(selectedLevel) ?? projectRail());
      // Margin notes need room beside the text; otherwise show the in-rail cards.
      const notesAvailable = canDrawNotes(cards, side);
      const topicLayout = notesAvailable ? preferredTopicLayout : 'cards';
      railEl.dataset.topicLayout = topicLayout;
      const commit = () => {
        railRoot.render(
          <InPageRail
            mode={mode}
            maxLevel={maxLevel}
            selectedLevel={selectedLevel}
            cards={cards}
            levelCards={levelCards}
            topicActions={topicActions}
            onClose={closeRail}
            onSelectMode={handleSelectMode}
            onSelectLevel={handleSelectLevel}
            topicLayout={topicLayout}
            onSelectTopicLayout={notesAvailable ? handleSelectTopicLayout : undefined}
            side={side}
            onSelectSide={handleSelectSide}
            onHighlightCard={handleHighlightCard}
            onScrollToCard={handleScrollToCard}
            scrollContainer={scrollContainer}
            scrollWindow={contentWindow}
            isNestedScroll={isNestedScroll}
            projectedScrollContainerTop={projectedScrollContainerTop}
            railOriginTop={railOriginTop}
            summariesDisabled={record.summariesDisabled === true}
            isMeasuring={measureOnly}
            onOpenFullView={() => openRecordFrame(record.key)}
            topics={record.topics}
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

    try {
      renderRail({ measureOnly: true });
      if (isClosed() || guard.isStale()) return false;
      measureRailOrigin();
      renderRail();
    } catch (err) {
      // Never leave a blank rail without a close button.
      closeRail();
      throw err;
    }

    // Re-resolve picked roots; `touched` mutations force a refresh even when
    // the selectors still match the same elements.
    const resolveElements = (touched) => {
      const nextElements = findPickedElements(record.selectors, contentDocument);
      const changed =
        nextElements.length !== elements.length ||
        nextElements.some((element, index) => element !== elements[index]) ||
        touched;
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
      if (surface.mode === RAIL_MODE.CHAT) return;
      measureRailOrigin();
      renderRail();
    };

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
        const touchesPicked = frameMutations.some(({ target, addedNodes, removedNodes }) =>
          elements.some(
            (element) =>
              element.contains(target) ||
              [...addedNodes, ...removedNodes].some((node) => node.contains(element)),
          ),
        );
        // Pages that mutate every frame (tickers, ads) must not cost a selector
        // pass per frame: unrelated batches re-resolve on a trailing timer. With
        // nothing picked, every batch is a candidate for recovery.
        if (!touchesPicked && elements.length > 0) {
          if (!unrelatedResolveId) {
            unrelatedResolveId = contentWindow.setTimeout(() => {
              unrelatedResolveId = 0;
              if (isClosed() || guard.isStale()) return;
              resolveElements(false);
            }, UNRELATED_MUTATION_RESOLVE_MS);
          }
          return;
        }
        resolveElements(true);
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
      if (isClosed() || guard.isStale() || surface.mode === RAIL_MODE.CHAT) return;
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
