import { collectWordEntries, buildSentenceWordRanges } from '../sentenceHighlight.js';

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function preserveWhitespaceGaps(intervals, text) {
  if (intervals.length < 2) return intervals;
  const preserved = [intervals[0]];
  for (const interval of intervals.slice(1)) {
    const previous = preserved[preserved.length - 1];
    const gap = text.slice(previous.end, interval.start);
    if (gap.trim() === '') {
      previous.end = interval.end;
    } else {
      preserved.push(interval);
    }
  }
  return preserved;
}

function pruneEmptyElements(root) {
  const keepEmptyTags = new Set([
    'BR',
    'IMG',
    'HR',
    'IFRAME',
    'VIDEO',
    'AUDIO',
    'SOURCE',
    'PICTURE',
  ]);
  // Reverse document order is bottom-up: a parent is visited only after its
  // descendants, so a single pass handles cascading emptiness (a parent left
  // empty by removed children is itself empty by the time we reach it). This
  // replaces a previous while(changed) loop that re-scanned the whole tree.
  Array.from(root.querySelectorAll('*'))
    .reverse()
    .forEach((el) => {
      if (keepEmptyTags.has(el.tagName)) return;
      if (el.textContent.trim() === '' && el.querySelector('img, video, audio, iframe') === null) {
        el.remove();
      }
    });
}

function normalizeSentenceNumbers(sourceSentences, sentenceOffset) {
  return sourceSentences.map((sentenceNumber) => sentenceNumber + sentenceOffset);
}

function collectTextNodes(root) {
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    textNodes.push(textNode);
  }
  return textNodes;
}

function splitPreviewIntervals(contextIntervals, highlightIntervals) {
  const boundaries = new Set();
  contextIntervals.forEach((interval) => {
    boundaries.add(interval.start);
    boundaries.add(interval.end);
  });
  highlightIntervals.forEach((interval) => {
    boundaries.add(interval.start);
    boundaries.add(interval.end);
  });

  const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
  const splitIntervals = [];
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index];
    const end = sortedBoundaries[index + 1];
    if (end <= start) continue;
    const inContext = contextIntervals.some(
      (interval) => interval.start < end && interval.end > start,
    );
    if (!inContext) continue;
    splitIntervals.push({
      start,
      end,
      highlighted: highlightIntervals.some(
        (interval) => interval.start < end && interval.end > start,
      ),
    });
  }
  return splitIntervals;
}

function getPreviewIntervals(sourceModel, sourceSentences, sentenceOffset) {
  return normalizeSentenceNumbers(sourceSentences, sentenceOffset).flatMap(
    (sentenceNumber) => sourceModel.sentenceIntervalsByNumber.get(sentenceNumber) || [],
  );
}

export function buildPreviewSourceModel(articleHtml, sentences) {
  if (!articleHtml || !Array.isArray(sentences) || sentences.length === 0) {
    return null;
  }
  if (typeof document === 'undefined') {
    return null;
  }

  const container = document.createElement('div');
  container.innerHTML = articleHtml;
  const wordEntries = collectWordEntries([container]);
  const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
  const textNodes = collectTextNodes(container);
  const textNodeIndexByNode = new Map(textNodes.map((node, index) => [node, index]));
  const sentenceIntervalsByNumber = new Map();

  for (const [sentenceNumber, wordRange] of sentenceRanges) {
    const startEntry = wordEntries[wordRange.startIdx];
    const endEntry = wordEntries[wordRange.endIdx];
    if (!startEntry || !endEntry) continue;

    const startNodeIndex = textNodeIndexByNode.get(startEntry.node);
    const endNodeIndex = textNodeIndexByNode.get(endEntry.node);
    if (startNodeIndex === undefined || endNodeIndex === undefined) continue;

    const intervals = [];
    for (let nodeIndex = startNodeIndex; nodeIndex <= endNodeIndex; nodeIndex += 1) {
      const node = textNodes[nodeIndex];
      intervals.push({
        nodeIndex,
        start: nodeIndex === startNodeIndex ? startEntry.start : 0,
        end: nodeIndex === endNodeIndex ? endEntry.end : node.nodeValue.length,
      });
    }
    sentenceIntervalsByNumber.set(sentenceNumber, intervals);
  }

  return {
    container,
    sentenceIntervalsByNumber,
  };
}

export function buildHighlightedSentencePreviewHtml(
  sourceModel,
  contextSentences,
  highlightSentences,
) {
  if (!sourceModel || !Array.isArray(contextSentences) || !Array.isArray(highlightSentences)) {
    return '';
  }
  if (contextSentences.length === 0 || typeof document === 'undefined') {
    return '';
  }

  const sentenceOffset = [...contextSentences, ...highlightSentences].some(
    (sentenceNumber) => sentenceNumber === 0,
  )
    ? 1
    : 0;

  const contextIntervalsByNode = new Map();
  const highlightIntervalsByNode = new Map();
  getPreviewIntervals(sourceModel, contextSentences, sentenceOffset).forEach((interval) => {
    const nodeIntervals = contextIntervalsByNode.get(interval.nodeIndex) || [];
    nodeIntervals.push(interval);
    contextIntervalsByNode.set(interval.nodeIndex, nodeIntervals);
  });
  if (contextIntervalsByNode.size === 0) return '';

  getPreviewIntervals(sourceModel, highlightSentences, sentenceOffset).forEach((interval) => {
    const nodeIntervals = highlightIntervalsByNode.get(interval.nodeIndex) || [];
    nodeIntervals.push(interval);
    highlightIntervalsByNode.set(interval.nodeIndex, nodeIntervals);
  });

  const container = sourceModel.container.cloneNode(true);
  const textNodes = collectTextNodes(container);

  textNodes.forEach((node, nodeIndex) => {
    const mergedContextIntervals = preserveWhitespaceGaps(
      mergeIntervals(contextIntervalsByNode.get(nodeIndex) || []),
      node.nodeValue,
    );
    if (mergedContextIntervals.length === 0) {
      node.remove();
      return;
    }

    const splitIntervals = splitPreviewIntervals(
      mergedContextIntervals,
      mergeIntervals(highlightIntervalsByNode.get(nodeIndex) || []),
    );
    const fragment = document.createDocumentFragment();
    for (const interval of splitIntervals) {
      const text = node.nodeValue.slice(interval.start, interval.end);
      if (!text.trim()) continue;
      if (!interval.highlighted) {
        fragment.appendChild(document.createTextNode(text));
        continue;
      }
      const mark = document.createElement('mark');
      mark.className = 'canvas-summary-source-preview__highlight';
      mark.textContent = text;
      fragment.appendChild(mark);
    }
    node.replaceWith(fragment);
  });

  pruneEmptyElements(container);
  return container.innerHTML;
}

export { mergeIntervals, preserveWhitespaceGaps };
