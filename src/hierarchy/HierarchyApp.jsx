import React, { useMemo, useState, useRef, useEffect } from "react";
import { useRecord } from "../useRecord.js";
import TopicHierarchyView from "./TopicHierarchyView.jsx";
import { getTopicSentenceNumbers } from "../topicCards.js";
import {
  getHierarchyTopicHighlightColor,
  getHierarchyTopicAccentColor,
} from "../utils/topicColorUtils.js";
import "./hierarchy.css";

function closeView() {
  try {
    window.parent.postMessage({ type: "pagetollm-close" }, "*");
  } catch (_) {
    /* noop */
  }
}

function getSentencesForNode(entry) {
  const sentenceNumbers = new Set();
  const traverse = (nodeEntry) => {
    if (nodeEntry.node.topic) {
      const nums = getTopicSentenceNumbers(nodeEntry.node.topic);
      nums.forEach((num) => sentenceNumbers.add(num));
    }
    if (nodeEntry.children) {
      for (const child of nodeEntry.children.values()) {
        traverse(child);
      }
    }
  };
  traverse(entry);
  return Array.from(sentenceNumbers).sort((a, b) => a - b);
}

export default function HierarchyApp({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const textPaneBodyRef = useRef(null);

  const topics = useMemo(
    () => (Array.isArray(record?.topics) ? record.topics : []),
    [record],
  );
  const sentences = useMemo(
    () => (Array.isArray(record?.sentences) ? record.sentences : []),
    [record],
  );
  const isDone = record?.status === "done";

  useEffect(() => {
    if (selectedTopic && selectedTopic.sentenceNumbers.length > 0 && textPaneBodyRef.current) {
      const firstIndex = selectedTopic.sentenceNumbers[0];
      const targetElement = textPaneBodyRef.current.querySelector(
        `[data-sentence-index="${firstIndex}"]`
      );
      if (targetElement) {
        targetElement.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    }
  }, [selectedTopic]);

  let body;
  if (error && !record) {
    body = <div className="th-page__state">Error: {String(error)}</div>;
  } else if (!record) {
    body = <div className="th-page__state">Loading…</div>;
  } else if (!isDone) {
    body = <div className="th-page__state">Still processing this page…</div>;
  } else {
    body = (
      <TopicHierarchyView
        topics={topics}
        topicSummaries={record?.topic_summaries}
        topicSummaryIndex={record?.topic_summary_index}
        selectedTopicPath={selectedTopic?.path}
        onTopicClick={(entry) => {
          const path = entry.node.fullPath;
          const sentenceNumbers = getSentencesForNode(entry);
          const highlightColor = getHierarchyTopicHighlightColor(
            entry.node.fullPath,
            entry.node.depth
          );
          const accentColor = getHierarchyTopicAccentColor(
            entry.node.fullPath,
            entry.node.depth
          );
          setSelectedTopic({
            path,
            sentenceNumbers,
            highlightColor,
            accentColor,
            clickId: Date.now(),
          });
        }}
      />
    );
  }

  const hasSelection = !!selectedTopic;

  return (
    <div className="th-page">
      <header className="th-page__bar">
        <h1 className="th-page__title">Topic Hierarchy</h1>
        <button
          type="button"
          className="th-page__close"
          onClick={closeView}
          title="Close"
        >
          ×
        </button>
      </header>
      <div className="th-page__content">
        <div className={`th-page__hierarchy-pane ${hasSelection ? "is-split" : ""}`}>
          <div className="th-page__body">{body}</div>
        </div>
        {hasSelection && (
          <div className="th-page__text-pane">
            <header className="th-text-pane__header">
              <div className="th-text-pane__title-container">
                <h2 className="th-text-pane__title">Original Text</h2>
                <div className="th-text-pane__subtitle" title={selectedTopic.path}>
                  Topic: <strong>{selectedTopic.path}</strong>
                </div>
              </div>
              <button
                type="button"
                className="th-text-pane__close"
                onClick={() => setSelectedTopic(null)}
                title="Hide Text"
              >
                ×
              </button>
            </header>
            <div className="th-text-pane__body" ref={textPaneBodyRef}>
              <p className="th-text-pane__paragraph">
                {sentences.map((text, i) => {
                  const oneBased = i + 1;
                  const isHighlighted = selectedTopic.sentenceNumbers.includes(oneBased);
                  const isDimmed = selectedTopic.sentenceNumbers.length > 0 && !isHighlighted;

                  const style = isHighlighted
                    ? {
                        backgroundColor: selectedTopic.highlightColor,
                        borderBottom: `2px solid ${selectedTopic.accentColor}`,
                      }
                    : {};

                  const cls = [
                    "th-sentence",
                    isHighlighted ? "is-highlighted" : "",
                    isDimmed ? "is-dimmed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <span
                      key={i}
                      className={cls}
                      style={style}
                      data-sentence-index={oneBased}
                    >
                      {i > 0 ? " " : ""}
                      {text}
                    </span>
                  );
                })}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
