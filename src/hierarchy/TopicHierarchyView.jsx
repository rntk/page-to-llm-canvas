import React, { useMemo } from 'react';
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

function getLeafSummary(node, summaryLookup) {
  return (
    getSummaryText(node.topic?.summary) ||
    getSummaryText(node.topic?.topic_summary) ||
    getSummaryText(node.topic?.summary_text) ||
    summaryLookup.get(node.fullPath) ||
    summaryLookup.get(spacedTopicPath(node.fullPath)) ||
    ''
  );
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
    const summary = getLeafSummary(node, summaryLookup);
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

  return (
    <div
      className="th-node"
      style={{ '--th-row-span': entry.leafCount ?? countLeafDescendants(entry) }}
    >
      <div
        className={`th-node__label ${isSelected ? 'is-selected' : ''}`}
        style={{
          borderLeftColor: accentColor,
          '--th-accent-color': accentColor,
          '--th-card-bg': highlightColor,
          '--th-card-bg-dark': highlightColorDark,
        }}
        title={node.fullPath.replace(/>/g, ' ')}
        onClick={() => onTopicClick?.(entry)}
      >
        <span className="th-node__label-content">
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
          onTopicClick={onTopicClick}
        />
      ))}
    </div>
  );
}
