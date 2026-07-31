import React from 'react';
import { flushSync } from 'react-dom';
import InPageRail from './InPageRail.jsx';
import { splitError, retryRecord } from '../../../utils/errorUtils.js';
import { resolveColumnOverlaps } from '../../../domain/topicCards.js';
import {
  HIGHLIGHT_NAME,
  CHAT_HIGHLIGHT_NAME,
  supportsHighlightApi,
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
  paintSentenceHighlight,
} from '../../../highlights/sentenceHighlight.js';
import {
  topicAccentColor,
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
  computeMaxTopicLevel,
} from '../shared/railCards.js';
import { getScrollableAncestor, getRailOriginTop, computeCardVerticalBox } from './geometry.js';
import {
  fetchRecord,
  findPickedElements,
  assessRecordForRail,
  createLoadToken,
} from '../shared/recordFetch.js';
import { createRailSurface, closeInPageRail, railLoadingTokenHolder } from '../shared/surface.js';
import {
  openCanvasIframe,
  openHierarchyIframe,
  removeCanvasIframe,
} from '../../record-view/iframeManager.js';

export async function openInPageRail(rec, initialMode, options = {}) {
  closeInPageRail();
  removeCanvasIframe();

  const guard = createLoadToken(railLoadingTokenHolder);

  // Always re-fetch to get the latest data even if widget data is stale.
  const fetched = await fetchRecord(rec.key);
  if (guard.isStale()) {
    // A newer rail request has started loading, abort this one!
    return;
  }

  const assessment = assessRecordForRail(fetched);
  if (assessment.kind === 'not_found') {
    alert('PageToLLM: Analysis record not found.');
    return;
  }
  if (assessment.kind === 'error') {
    const { message } = splitError(
      assessment.record.error || 'Unknown error occurred during processing.',
    );
    const retry = confirm(
      `PageToLLM: Processing failed.\n\nError: ${message}\n\nWould you like to retry analyzing this page?`,
    );
    if (retry) {
      try {
        await retryRecord(assessment.record.key, 'InPageRail');
        openCanvasIframe(assessment.record.key);
      } catch (err) {
        alert('Retry failed: ' + (err.message || String(err)));
      }
    }
    return;
  }
  if (assessment.kind === 'needs_attention') {
    const open = confirm(
      'PageToLLM: Some topics could not be summarized after several retries.\n\n' +
        'Open the canvas view to retry or skip them?',
    );
    if (open) {
      openCanvasIframe(assessment.record.key);
    }
    return;
  }
  if (assessment.kind === 'in_progress') {
    alert(
      `PageToLLM: Analysis is currently in progress (status: ${assessment.stage}). Please wait a moment and try again.`,
    );
    return;
  }
  if (assessment.kind === 'no_selectors') {
    const openCanvas = confirm(
      'PageToLLM: This record has no saved selectors.\n\nWould you like to open it in the full canvas view instead?',
    );
    if (openCanvas) {
      openCanvasIframe(assessment.record.key);
    }
    return;
  }
  const record = assessment.record;
  const elements = findPickedElements(record.selectors);
  if (elements.length === 0) {
    const openCanvas = confirm(
      'PageToLLM: Could not locate the original article blocks on this page; the page layout may have changed.\n\nWould you like to open it in the full canvas view instead?',
    );
    if (openCanvas) {
      openCanvasIframe(record.key);
    }
    return;
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

  const { railEl, railRoot, setRailWidthForMode, isClosed } = createRailSurface({
    state,
    onTeardown: () => {
      if (supportsHighlightApi()) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
        CSS.highlights.delete(CHAT_HIGHLIGHT_NAME);
      }
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

  // Native CSS Custom Highlight API: topic and chat sentences are painted as
  // two separate named highlights (mirrors the canvas modal), so chat
  // highlights stay visually distinct via ::highlight(pagetollm-chat-sentence)
  // instead of being merged into the topic highlight. Unlike per-word spans, a
  // single Range per sentence paints continuously across whitespace and inline
  // tags, so there are no gaps between words.
  const activeTopicSentences = new Set();
  const activeChatSentences = new Set();

  function rebuildHighlight() {
    if (!supportsHighlightApi()) return;
    paintSentenceHighlight(HIGHLIGHT_NAME, activeTopicSentences, { wordEntries, sentenceRanges });
    paintSentenceHighlight(CHAT_HIGHLIGHT_NAME, activeChatSentences, {
      wordEntries,
      sentenceRanges,
    });
  }

  function clearAllHighlights() {
    activeTopicSentences.clear();
    activeChatSentences.clear();
    rebuildHighlight();
  }

  function highlightTopic(sentenceList, on) {
    for (const sNum of sentenceList) {
      if (on) activeTopicSentences.add(sNum);
      else activeTopicSentences.delete(sNum);
    }
    rebuildHighlight();
  }

  function scrollToFirst(sentenceList) {
    if (!sentenceList || !sentenceList.length) return;
    const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceList[0]);
    if (!domRange) return;
    const rect = domRange.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    if (scrollContainer && scrollContainer !== window) {
      const cRect = scrollContainer.getBoundingClientRect();
      const delta = rect.top - cRect.top - scrollContainer.clientHeight / 2;
      scrollContainer.scrollTo({ top: scrollContainer.scrollTop + delta, behavior: 'smooth' });
    } else {
      const targetY = rect.top + window.scrollY - window.innerHeight / 2;
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    }
  }

  function buildRailCards() {
    const isSummary = state.mode === 'summaries';
    const entries = isSummary
      ? buildSummaryEntries(record).entries
      : buildHierarchicalTopicEntries(record, state.selectedLevel);
    const eligible = entries.filter((e) => e.level === state.selectedLevel);

    const cardSpecs = [];
    for (const e of eligible) {
      const allSentences = isSummary ? e.sourceSentences : e.sentences;
      const runs = splitIntoContiguousRuns(allSentences);
      for (const run of runs) {
        const box = computeCardVerticalBox(
          run,
          sentenceRanges,
          wordEntries,
          railOriginTop,
          scrollContainer,
        );
        if (!box) continue;
        const accent = topicAccentColor(e.path, e.level || 0);
        cardSpecs.push({
          ...e,
          id: `${e.path}-${run.join('-')}`,
          sentences: run,
          allSentences,
          box,
          accent,
        });
      }
    }

    // Mirror the canvas hierarchy rail: cards in a column must never overlap.
    // Each card already spans one contiguous sentence run, but a mis-measured
    // run can stretch a card across its neighbours and hide the cards in
    // between. resolveColumnOverlaps clips/pushes them into a clean stack.
    const resolved = resolveColumnOverlaps(
      cardSpecs.map((card) => ({
        key: card.id,
        levelIndex: card.level || 0,
        startSentence: card.sentences[0] ?? 0,
        fullPath: card.path,
        top: card.box.top,
        height: card.box.height,
      })),
    );
    const adjustedById = new Map(resolved.map((card) => [card.key, card]));
    for (const card of cardSpecs) {
      const adjusted = adjustedById.get(card.id);
      if (adjusted) card.box = { top: adjusted.top, height: adjusted.height };
    }
    cardSpecs.sort((a, b) => a.box.top - b.box.top);

    const railHeight = cardSpecs.length
      ? Math.max(...cardSpecs.map((c) => c.box.top + c.box.height)) + 80
      : 200;
    return { cards: cardSpecs, bodyHeight: railHeight };
  }

  const handleSelectMode = (mode) => {
    if (isClosed()) return;
    if (mode === 'canvas') {
      closeInPageRail();
      openCanvasIframe(record.key);
      return;
    }
    if (mode === 'hierarchy') {
      closeInPageRail();
      openHierarchyIframe(record.key);
      return;
    }
    if (state.mode === mode) return;
    // clearAllHighlights() below already clears activeChatSentences along
    // with the topic set, so no per-mode special-casing is needed here.
    state.mode = mode;
    railEl.dataset.mode = state.mode;
    syncRailPosition();
    setRailWidthForMode();
    clearAllHighlights();
    renderRail();
  };

  const handleSelectLevel = (level) => {
    if (isClosed()) return;
    if (state.selectedLevel === level) return;
    state.selectedLevel = level;
    clearAllHighlights();
    renderRail();
  };

  const handleHighlightCard = (card, on) => {
    const sentenceList = card.sentences || card.sourceSentences || [];
    highlightTopic(sentenceList, on);
  };

  const handleScrollToCard = (card) => {
    const sentenceList = card.sentences || card.sourceSentences || [];
    scrollToFirst(sentenceList);
  };

  const handleChatHighlight = ({ startLine, endLine }, { focus = false } = {}) => {
    if (isClosed() || guard.isStale()) return;
    for (let line = startLine; line <= endLine; line += 1) {
      activeChatSentences.add(line);
    }
    rebuildHighlight();
    if (focus) scrollToFirst([startLine]);
  };

  const handleClearChatHighlights = () => {
    if (isClosed() || guard.isStale()) return;
    activeChatSentences.clear();
    rebuildHighlight();
  };

  function renderRail({ measureOnly = false } = {}) {
    if (isClosed() || guard.isStale()) return;
    const { cards, bodyHeight } = railOriginTop ? buildRailCards() : { cards: [], bodyHeight: 200 };
    flushSync(() => {
      railRoot.render(
        <InPageRail
          mode={state.mode}
          maxLevel={maxLevel}
          selectedLevel={state.selectedLevel}
          cards={measureOnly ? [] : cards}
          bodyHeight={measureOnly ? 200 : bodyHeight}
          onClose={closeInPageRail}
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
  if (isClosed() || guard.isStale()) return;
  const bodyRect = railEl.querySelector('.pagetollm-rail-body').getBoundingClientRect();
  railOriginTop = getRailOriginTop(bodyRect, scrollContainer);
  renderRail();

  if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
    requestAnimationFrame(() => {
      if (isClosed() || guard.isStale()) return;
      highlightTopic(options.sentenceNumbers, true);
      scrollToFirst(options.sentenceNumbers);
    });
  }
}
