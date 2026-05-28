import React, { useMemo } from "react";
import { buildTopicTree, countLeafDescendants } from "../utils/topicTree.js";
import {
  getHierarchyTopicHighlightColor,
  getHierarchyTopicAccentColor,
} from "../utils/topicColorUtils.js";

function getSentenceCount(topic) {
  return Array.isArray(topic?.sentences) ? topic.sentences.length : 0;
}

function normalizeTopicPath(path) {
  return String(path || "")
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(">");
}

function spacedTopicPath(path) {
  return normalizeTopicPath(path).split(">").filter(Boolean).join(" > ");
}

function getSummaryText(summary) {
  if (!summary) return "";
  if (typeof summary === "string") return summary.trim();
  if (typeof summary !== "object") return "";

  const text = typeof summary.text === "string" ? summary.text.trim() : "";
  const bullets = Array.isArray(summary.bullets)
    ? summary.bullets
        .filter((bullet) => typeof bullet === "string" && bullet.trim())
        .map((bullet) => bullet.trim())
    : [];

  return [text, ...bullets].filter(Boolean).join(" ");
}

function buildSummaryLookup(topicSummaries, topicSummaryIndex) {
  const lookup = new Map();
  const addSummary = (path, summary) => {
    const text = getSummaryText(summary);
    const normalizedPath = normalizeTopicPath(path);
    if (!text || !normalizedPath) return;
    lookup.set(normalizedPath, text);
    lookup.set(spacedTopicPath(normalizedPath), text);
  };

  if (topicSummaries && typeof topicSummaries === "object") {
    Object.entries(topicSummaries).forEach(([path, summary]) => addSummary(path, summary));
  }

  if (topicSummaryIndex && typeof topicSummaryIndex === "object") {
    Object.entries(topicSummaryIndex).forEach(([path, summary]) => addSummary(path, summary));
  }

  return lookup;
}

function getLeafSummary(node, summaryLookup) {
  return (
    getSummaryText(node.topic?.summary) ||
    getSummaryText(node.topic?.topic_summary) ||
    getSummaryText(node.topic?.summary_text) ||
    summaryLookup.get(node.fullPath) ||
    summaryLookup.get(spacedTopicPath(node.fullPath)) ||
    ""
  );
}

function HierarchyNode({ entry, summaryLookup, selectedTopicPath, onTopicClick }) {
  const { node } = entry;
  const children = Array.from(entry.children.values());
  const isLeaf = children.length === 0;
  const highlightColor = getHierarchyTopicHighlightColor(node.fullPath, node.depth);
  const accentColor = getHierarchyTopicAccentColor(node.fullPath, node.depth);
  const isSelected = selectedTopicPath === node.fullPath;

  if (isLeaf) {
    const sentenceCount = getSentenceCount(node.topic);
    const summary = getLeafSummary(node, summaryLookup);
    return (
      <div className="th-leaf-row">
        <div
          className={`th-leaf ${isSelected ? "is-selected" : ""}`}
          style={{
            backgroundColor: highlightColor,
            borderLeftColor: accentColor,
            "--th-accent-color": accentColor,
          }}
          title={`${node.fullPath} (${sentenceCount} sentences)`}
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
    <div className="th-node" style={{ "--th-row-span": countLeafDescendants(entry) }}>
      <div
        className={`th-node__label ${isSelected ? "is-selected" : ""}`}
        style={{
          backgroundColor: highlightColor,
          borderLeftColor: accentColor,
          "--th-accent-color": accentColor,
        }}
        title={node.fullPath}
        onClick={() => onTopicClick?.(entry)}
      >
        <span className="th-node__label-text">{node.name}</span>
        <span className="th-node__drill" aria-hidden="true">&gt;</span>
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
}

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
