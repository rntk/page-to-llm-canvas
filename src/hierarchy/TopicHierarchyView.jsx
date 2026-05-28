import React, { useMemo } from "react";
import { buildTopicTree, countLeafDescendants } from "../utils/topicTree.js";
import {
  getHierarchyTopicHighlightColor,
  getHierarchyTopicAccentColor,
} from "../utils/topicColorUtils.js";

function getSentenceCount(topic) {
  return Array.isArray(topic?.sentences) ? topic.sentences.length : 0;
}

function HierarchyNode({ entry }) {
  const { node } = entry;
  const children = Array.from(entry.children.values());
  const isLeaf = children.length === 0;
  const highlightColor = getHierarchyTopicHighlightColor(node.fullPath, node.depth);
  const accentColor = getHierarchyTopicAccentColor(node.fullPath, node.depth);

  if (isLeaf) {
    const sentenceCount = getSentenceCount(node.topic);
    return (
      <div
        className="th-leaf"
        style={{ backgroundColor: highlightColor, borderLeftColor: accentColor }}
        title={`${node.fullPath} (${sentenceCount} sentences)`}
      >
        <span className="th-leaf__label">{node.name}</span>
        {sentenceCount > 0 && <span className="th-leaf__count">{sentenceCount}</span>}
      </div>
    );
  }

  return (
    <div className="th-node" style={{ "--th-row-span": countLeafDescendants(entry) }}>
      <div
        className="th-node__label"
        style={{ backgroundColor: highlightColor, borderLeftColor: accentColor }}
        title={node.fullPath}
      >
        <span className="th-node__label-text">{node.name}</span>
        <span className="th-node__drill" aria-hidden="true">&gt;</span>
      </div>
      <div className="th-node__children">
        {children.map((child) => (
          <HierarchyNode key={child.node.uid} entry={child} />
        ))}
      </div>
    </div>
  );
}

export default function TopicHierarchyView({ topics }) {
  const roots = useMemo(() => buildTopicTree(topics, 0), [topics]);

  if (roots.length === 0) {
    return <div className="th-empty">No topics available.</div>;
  }

  return (
    <div className="th-root">
      {roots.map((root) => (
        <HierarchyNode key={root.node.uid} entry={root} />
      ))}
    </div>
  );
}
