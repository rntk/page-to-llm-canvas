import React, { useMemo, useState, useCallback, useLayoutEffect, useRef } from 'react';
import { buildTopicTree, countLeafDescendants } from '../domain/topicTree.js';
import {
  getHierarchyTopicHighlightColor,
  getHierarchyTopicHighlightColorDark,
  getHierarchyTopicAccentColor,
} from '../domain/topicColorUtils.js';
import { spacedTopicPath, buildSummaryLookup } from './topicViewUtils.js';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from '../components/YouTubeTimestampButton.jsx';
import { getSentencesForNode } from './hierarchyUtils.js';

// Always render hierarchy timestamps as h:mm:ss (e.g. 0:58:59, 1:27:35) so every
// label occupies the same three columns and the links never shift left/right.
const HIERARCHY_LABEL_OPTIONS = { forceHours: true };

// Card-width measurement bounds. Every card is stretched to the widest card's
// natural width so the columns line up and titles never get truncated; these
// just keep one pathological heading from blowing the whole column out (cap) or
// collapsing it to nothing on a near-empty tree (floor).
const MIN_CARD_WIDTH = 180;
const CARD_WIDTH_CAP_INSET = 24;

function getNodeSummary(node, summaryLookup) {
  return summaryLookup.get(node.fullPath) || '';
}

/**
 * Effective vertical span (in leaf-rows) for each node given the current
 * collapsed set. A collapsed branch shrinks to a single row, so its ancestors
 * shrink too; without this the parent's reserved row-span would leave a gap.
 * Returns a Map keyed by node.uid.
 * @param {object[]} roots Root hierarchy entries.
 * @param {Set<string>} collapsedPaths Collapsed node paths.
 */
function buildSpanMap(roots, collapsedPaths) {
  const map = new Map();
  const compute = (entry) => {
    const children = Array.from(entry.children.values());
    if (children.length === 0 || collapsedPaths.has(entry.node.fullPath)) {
      map.set(entry.node.uid, 1);
      return 1;
    }
    const span = children.reduce((total, child) => total + compute(child), 0);
    map.set(entry.node.uid, span);
    return span;
  };
  roots.forEach(compute);
  return map;
}

function createHierarchyColorCache(_tree) {
  return { colorsByUid: new Map() };
}

function getHierarchyColors(colorCache, node) {
  let colors = colorCache.colorsByUid.get(node.uid);
  if (!colors) {
    colors = {
      highlightColor: getHierarchyTopicHighlightColor(node.fullPath, node.depth),
      highlightColorDark: getHierarchyTopicHighlightColorDark(node.fullPath, node.depth),
      accentColor: getHierarchyTopicAccentColor(node.fullPath, node.depth),
    };
    colorCache.colorsByUid.set(node.uid, colors);
  }
  return colors;
}

function TopicSummary({ className, entry, summary, onSummaryClick }) {
  const openSummary = (event) => {
    event.stopPropagation();
    onSummaryClick?.({
      path: spacedTopicPath(entry.node.fullPath),
      text: summary,
      sourceSentences: getSentencesForNode(entry),
    });
  };

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      title="Click to view full summary"
      onClick={openSummary}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openSummary(event);
      }}
    >
      {summary}
    </div>
  );
}

const HierarchyNode = React.memo(function HierarchyNode({
  entry,
  colorCache,
  summaryLookup,
  selectedTopicPath,
  collapsedPaths,
  spanMap,
  onToggleCollapse,
  onTopicClick,
  onSummaryClick,
  sourceUrl,
  sentences,
  isYouTube,
}) {
  const { node } = entry;
  const children = Array.from(entry.children.values());
  const isLeaf = children.length === 0;
  const { highlightColor, highlightColorDark, accentColor } = getHierarchyColors(colorCache, node);
  const isSelected = selectedTopicPath === node.fullPath;

  const youtubeLink = useMemo(() => {
    if (!isYouTube) return null;
    const sourceSentences = getSentencesForNode(entry);
    // h:mm:ss for every label so the links stay in a straight, fixed-width column.
    return getYouTubeTimestampLink({
      sourceUrl,
      sentences,
      sourceSentences,
      labelOptions: HIERARCHY_LABEL_OPTIONS,
    });
  }, [isYouTube, entry, sourceUrl, sentences]);

  if (isLeaf) {
    const summary = getNodeSummary(node, summaryLookup);
    return (
      <div className="th-leaf-row">
        <div
          className={`th-leaf ${isSelected ? 'is-selected' : ''}`}
          style={{
            borderLeftColor: accentColor,
            '--th-accent-color': accentColor,
            '--th-card-bg': highlightColor,
            '--th-card-bg-dark': highlightColorDark,
          }}
          title={node.fullPath.replace(/>/g, ' ')}
          onClick={() => onTopicClick?.(entry)}
        >
          <span className="th-leaf__spacer" aria-hidden="true" />
          <span className="th-leaf__label">{node.name}</span>
          <YouTubeTimestampButton link={youtubeLink} />
        </div>
        {summary && (
          <TopicSummary
            className="th-leaf-summary"
            entry={entry}
            summary={summary}
            onSummaryClick={onSummaryClick}
          />
        )}
      </div>
    );
  }

  const isCollapsed = collapsedPaths.has(node.fullPath);
  const cardStyle = {
    borderLeftColor: accentColor,
    '--th-accent-color': accentColor,
    '--th-card-bg': highlightColor,
    '--th-card-bg-dark': highlightColorDark,
  };

  const handleToggle = (event) => {
    // Keep the fold toggle separate from the card's scroll-to-sentences click so
    // the (large) button cannot accidentally trigger a navigation redirect.
    event.stopPropagation();
    onToggleCollapse?.(node.fullPath);
  };

  const toggleButton = (
    <button
      type="button"
      className="th-node__toggle"
      onClick={handleToggle}
      aria-expanded={!isCollapsed}
      aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
      title={isCollapsed ? 'Show sub-topics' : 'Collapse sub-topics'}
    >
      <span aria-hidden="true">{isCollapsed ? '›' : '‹'}</span>
    </button>
  );

  if (isCollapsed) {
    const summary = getNodeSummary(node, summaryLookup);
    return (
      <div className="th-node th-node--collapsed" style={{ '--th-row-span': 1 }}>
        <div
          className={`th-node__label ${isSelected ? 'is-selected' : ''}`}
          style={cardStyle}
          title={node.fullPath.replace(/>/g, ' ')}
          onClick={() => onTopicClick?.(entry)}
        >
          <span className="th-node__label-content">
            {toggleButton}
            <span className="th-node__label-text">{node.name}</span>
            <YouTubeTimestampButton link={youtubeLink} />
          </span>
        </div>
        {summary && (
          <TopicSummary
            className="th-node__summary"
            entry={entry}
            summary={summary}
            onSummaryClick={onSummaryClick}
          />
        )}
      </div>
    );
  }

  const rowSpan = spanMap.get(node.uid) ?? entry.leafCount ?? countLeafDescendants(entry);

  return (
    <div className="th-node" style={{ '--th-row-span': rowSpan }}>
      <div
        className={`th-node__label ${isSelected ? 'is-selected' : ''}`}
        style={cardStyle}
        title={node.fullPath.replace(/>/g, ' ')}
        onClick={() => onTopicClick?.(entry)}
      >
        <span className="th-node__label-content">
          {toggleButton}
          <span className="th-node__label-text">{node.name}</span>
          <YouTubeTimestampButton link={youtubeLink} />
          <span className="th-node__drill" aria-hidden="true"></span>
        </span>
      </div>
      <div className="th-node__children">
        {children.map((child) => (
          <HierarchyNode
            key={child.node.uid}
            entry={child}
            colorCache={colorCache}
            summaryLookup={summaryLookup}
            selectedTopicPath={selectedTopicPath}
            collapsedPaths={collapsedPaths}
            spanMap={spanMap}
            onToggleCollapse={onToggleCollapse}
            onTopicClick={onTopicClick}
            onSummaryClick={onSummaryClick}
            sourceUrl={sourceUrl}
            sentences={sentences}
            isYouTube={isYouTube}
          />
        ))}
      </div>
    </div>
  );
});

export default function TopicHierarchyView({
  topics,
  topicSummaryIndex,
  selectedTopicPath,
  onTopicClick,
  onSummaryClick,
  collapsedPaths: controlledCollapsedPaths,
  onToggleCollapse: controlledToggleCollapse,
  sourceUrl,
  sentences,
}) {
  const roots = useMemo(() => buildTopicTree(topics, 0), [topics]);
  // This lazy cache is owned by the current tree. Collapsed descendants do not
  // pay the color-hashing cost until first rendered, and replacing the topics
  // releases colors belonging to the previous tree.
  const colorCache = useMemo(() => createHierarchyColorCache(roots), [roots]);
  const summaryLookup = useMemo(() => buildSummaryLookup(topicSummaryIndex), [topicSummaryIndex]);

  const [localCollapsedPaths, setLocalCollapsedPaths] = useState(() => new Set());

  const collapsedPaths =
    controlledCollapsedPaths !== undefined ? controlledCollapsedPaths : localCollapsedPaths;

  const handleToggleCollapse = useCallback(
    (fullPath) => {
      if (controlledToggleCollapse) {
        controlledToggleCollapse(fullPath);
      } else {
        setLocalCollapsedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(fullPath)) {
            next.delete(fullPath);
          } else {
            next.add(fullPath);
          }
          return next;
        });
      }
    },
    [controlledToggleCollapse],
  );

  const spanMap = useMemo(() => buildSpanMap(roots, collapsedPaths), [roots, collapsedPaths]);
  const isYouTube = useMemo(() => Boolean(getYouTubeVideoId(sourceUrl)), [sourceUrl]);

  const rootRef = useRef(null);
  const measuredCardWidthRef = useRef(0);
  const measurementContentRef = useRef({ roots: null, isYouTube: null });

  // Stretch every card to the widest card's natural width so columns align and
  // titles are never truncated. Measure at `max-content`, then lock the shared
  // `--th-card-width`. Fold/unfold changes can reveal previously hidden wider
  // cards, so remeasure them; keep the fold/unfold width monotonic so collapsing
  // a branch does not make the column jump narrower.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const contentChanged =
      measurementContentRef.current.roots !== roots ||
      measurementContentRef.current.isYouTube !== isYouTube;
    if (contentChanged) {
      measuredCardWidthRef.current = 0;
      measurementContentRef.current = { roots, isYouTube };
    }

    root.style.setProperty('--th-card-width', 'max-content');
    let widest = 0;
    root.querySelectorAll('.th-node__label, .th-leaf').forEach((el) => {
      widest = Math.max(widest, el.offsetWidth);
    });
    if (widest <= 0) {
      // No layout yet (e.g. jsdom): keep the CSS default (max-content).
      root.style.removeProperty('--th-card-width');
      return;
    }
    const cap = Math.max(MIN_CARD_WIDTH, root.clientWidth - CARD_WIDTH_CAP_INSET);
    const width = Math.max(MIN_CARD_WIDTH, Math.min(Math.ceil(widest), cap));
    measuredCardWidthRef.current = Math.min(cap, Math.max(measuredCardWidthRef.current, width));
    root.style.setProperty('--th-card-width', `${measuredCardWidthRef.current}px`);
    // Summaries live in a separate column
    // and don't change card width, so they're intentionally excluded — re-firing
    // on async summary load could re-measure while branches are folded.
  }, [roots, isYouTube, collapsedPaths]);

  if (roots.length === 0) {
    return <div className="th-empty">No topics available.</div>;
  }

  return (
    <div className="th-root" ref={rootRef}>
      {roots.map((root) => (
        <HierarchyNode
          key={root.node.uid}
          entry={root}
          colorCache={colorCache}
          summaryLookup={summaryLookup}
          selectedTopicPath={selectedTopicPath}
          collapsedPaths={collapsedPaths}
          spanMap={spanMap}
          onToggleCollapse={handleToggleCollapse}
          onTopicClick={onTopicClick}
          onSummaryClick={onSummaryClick}
          sourceUrl={sourceUrl}
          sentences={sentences}
          isYouTube={isYouTube}
        />
      ))}
    </div>
  );
}
