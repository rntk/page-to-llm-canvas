import React from "react";
import { getHierarchyTopicAccentColor } from "../utils/topicColorUtils.js";
import { isTopicRead } from "../utils/topicReadUtils.js";

/**
 * @typedef {Object} CanvasTopicCard
 * @property {string} key
 * @property {string} fullPath
 * @property {string} displayName
 * @property {number} sentenceCount
 * @property {number} startSentence
 * @property {number} endSentence
 * @property {number} top
 * @property {number} height
 * @property {number} titleFontSize
 * @property {number} depth
 * @property {number} levelIndex
 * @property {number} right
 */

/**
 * @param {{
 *   show: boolean,
 *   selectedLevel: number,
 *   topicCards: Array<{
 *     key: string,
 *     fullPath: string,
 *     displayName: string,
 *     sentenceCount: number,
 *     startSentence: number,
 *     endSentence: number,
 *     top: number,
 *     height: number,
 *     titleFontSize: number,
 *     depth: number,
 *     levelIndex: number,
 *     right: number,
 *   }>,
 *   railWidth: number,
 *   cardWidth: number,
 *   activeTopicKey: string | null,
 *   selectedTopicKey: string | null,
 *   onTopicEnter: (topicKey: string) => void,
 *   onTopicLeave: (topicKey: string) => void,
 *   onTopicClick: (topicKey: string, card: CanvasTopicCard) => void,
 *   readTopics: Set<string> | string[] | null,
 *   onToggleRead: ((topicKey: string) => void) | null,
 * }} props
 */
export default function CanvasTopicHierarchyRail({
  show,
  selectedLevel,
  topicCards,
  railWidth,
  cardWidth,
  activeTopicKey,
  selectedTopicKey,
  onTopicEnter,
  onTopicLeave,
  onTopicClick,
  readTopics,
  onToggleRead,
}) {
  const safeReadTopics =
    readTopics instanceof Set ? readTopics : new Set(readTopics || []);
  const hierarchyCards = React.useMemo(
    () =>
      (Array.isArray(topicCards) ? topicCards : [])
        .filter((card) => card.levelIndex <= selectedLevel)
        .sort(
          (left, right) =>
            left.levelIndex - right.levelIndex ||
            left.top - right.top ||
            left.fullPath.localeCompare(right.fullPath),
        ),
    [selectedLevel, topicCards],
  );

  if (!show) return null;

  return (
    <aside
      className="canvas-topic-hierarchy"
      aria-label="Topic hierarchy"
      onMouseDown={(event) => {
        if (event.target.closest("button, a, input, select, textarea")) {
          event.stopPropagation();
        }
      }}
      style={{
        "--canvas-topic-hierarchy-width": `${railWidth}px`,
        "--topic-card-width": `${cardWidth}px`,
      }}
    >
      <div
        className="canvas-topic-hierarchy__body"
        style={{
          height: hierarchyCards.length
            ? `${Math.max(...hierarchyCards.map((c) => c.top + c.height)) + 20}px`
            : "auto",
        }}
      >
        {hierarchyCards.length === 0 ? (
          <p className="canvas-topic-hierarchy__empty">
            No topics at this level.
          </p>
        ) : (
          <>
            {hierarchyCards.map((card) => {
              const isActive = activeTopicKey === card.fullPath;
              const isSelected = selectedTopicKey === card.fullPath;
              const isRead = isTopicRead(card.fullPath, safeReadTopics);
              const classes = [
                "canvas-topic-hierarchy__card",
                card.levelIndex === 0
                  ? "canvas-topic-hierarchy__card--root"
                  : "canvas-topic-hierarchy__card--child",
                isActive ? "is-active" : "",
                isSelected ? "is-selected" : "",
                isRead ? "is-read" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  key={card.key}
                  type="button"
                  className={classes}
                  style={{
                    "--topic-card-top": `${card.top}px`,
                    "--topic-card-height": `${card.height}px`,
                    "--topic-card-title-font-size": `${card.titleFontSize}px`,
                    "--topic-card-right": `${card.right}px`,
                    "--topic-accent-color": getHierarchyTopicAccentColor(
                      card.fullPath,
                      card.depth,
                    ),
                  }}
                  onMouseEnter={() => onTopicEnter(card.fullPath)}
                  onMouseLeave={() => onTopicLeave(card.fullPath)}
                  onClick={() => {
                    onTopicClick(card.fullPath, card);
                    if (onToggleRead) {
                      onToggleRead(card.fullPath);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (onToggleRead) {
                      onToggleRead(card.fullPath);
                    }
                  }}
                  title={`${card.fullPath}: sentences ${card.startSentence}-${card.endSentence}`}
                >
                  <div className="canvas-topic-hierarchy__card-content">
                    <span className="canvas-topic-hierarchy__card-name">
                      {card.displayName}
                    </span>
                    <span className="canvas-topic-hierarchy__card-meta">
                      {card.sentenceCount} sent.
                    </span>
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}
