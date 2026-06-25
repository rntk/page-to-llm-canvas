import React, { useMemo, useState, useCallback } from 'react';
import { buildTopicTree, countLeafDescendants } from '../utils/topicTree.js';
import {
  getHierarchyTopicHighlightColor,
  getHierarchyTopicHighlightColorDark,
  getHierarchyTopicAccentColor,
} from '../utils/topicColorUtils.js';
import { spacedTopicPath, getSummaryText, buildSummaryLookup } from './topicViewUtils.js';

const hierarchyColorCache = new Map();

function getSentenceCount(topic) {
  return Array.isArray(topic?.sentences) ? topic.sentences.length : 0;
}

function getNodeSummary(node, summaryLookup) {
  return (
    getSummaryText(node.topic?.summary) ||
    getSummaryText(node.topic?.topic_summary) ||
    getSummaryText(node.topic?.summary_text) ||
    summaryLookup.get(node.fullPath) ||
    summaryLookup.get(spacedTopicPath(node.fullPath)) ||
    ''
  );
}

/**
 * Effective vertical span (in leaf-rows) for each node given the current
 * collapsed set. A collapsed branch shrinks to a single row, so its ancestors
 * shrink too; without this the parent's reserved row-span would leave a gap.
 * Returns a Map keyed by node.uid.
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

function getCachedHierarchyColors(fullPath, depth) {
  const key = `${fullPath}|${depth}`;
  let colors = hierarchyColorCache.get(key);
  if (!colors) {
    colors = {
      highlightColor: getHierarchyTopicHighlightColor(fullPath, depth),
      highlightColorDark: getHierarchyTopicHighlightColorDark(fullPath, depth),
      accentColor: getHierarchyTopicAccentColor(fullPath, depth),
    };
    hierarchyColorCache.set(key, colors);
  }
  return colors;
}

const HierarchyNode = React.memo(function HierarchyNode({
  entry,
  summaryLookup,
  selectedTopicPath,
  collapsedPaths,
  spanMap,
  onToggleCollapse,
  onTopicClick,
}) {
  const { node } = entry;
  const children = Array.from(entry.children.values());
  const isLeaf = children.length === 0;
  const { highlightColor, highlightColorDark, accentColor } = getCachedHierarchyColors(
    node.fullPath,
    node.depth,
  );
  const isSelected = selectedTopicPath === node.fullPath;

  if (isLeaf) {
    const sentenceCount = getSentenceCount(node.topic);
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
          title={`${node.fullPath.replace(/>/g, ' ')} (${sentenceCount} sentences)`}
          onClick={() => onTopicClick?.(entry)}
        >
          <span className="th-leaf__label">{node.name}</span>
          {sentenceCount > 0 && <span className="th-leaf__count">{sentenceCount}</span>}
        </div>
        {summary && (
          <div className="th-leaf-summary" title={summary}>
            {summary}
          </div>
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
          </span>
        </div>
        {summary && (
          <div className="th-node__summary" title={summary}>
            {summary}
          </div>
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
          <span className="th-node__drill" aria-hidden="true"></span>
        </span>
      </div>
      <div className="th-node__children">
        {children.map((child) => (
          <HierarchyNode
            key={child.node.uid}
            entry={child}
            summaryLookup={summaryLookup}
            selectedTopicPath={selectedTopicPath}
            collapsedPaths={collapsedPaths}
            spanMap={spanMap}
            onToggleCollapse={onToggleCollapse}
            onTopicClick={onTopicClick}
          />
        ))}
      </div>
    </div>
  );
});

export default function TopicHierarchyView({
  topics,
  topicSummaries,
  topicSummaryIndex,
  selectedTopicPath,
  onTopicClick,
}) {
  const roots = useMemo(() => buildTopicTree(topics, 0), [topics]);
  const summaryLookup = useMemo(
    () => buildSummaryLookup(topicSummaries, topicSummaryIndex),
    [topicSummaries, topicSummaryIndex],
  );

  const [collapsedPaths, setCollapsedPaths] = useState(() => new Set());
  const handleToggleCollapse = useCallback((fullPath) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  }, []);

  const spanMap = useMemo(() => buildSpanMap(roots, collapsedPaths), [roots, collapsedPaths]);

  if (roots.length === 0) {
    return <div className="th-empty">No topics available.</div>;
  }

  return (
    <div className="th-root">
      {roots.map((root) => (
        <HierarchyNode
          key={root.node.uid}
          entry={root}
          summaryLookup={summaryLookup}
          selectedTopicPath={selectedTopicPath}
          collapsedPaths={collapsedPaths}
          spanMap={spanMap}
          onToggleCollapse={handleToggleCollapse}
          onTopicClick={onTopicClick}
        />
      ))}
    </div>
  );
}
