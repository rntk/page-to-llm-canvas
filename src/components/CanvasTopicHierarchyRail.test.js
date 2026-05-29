// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import CanvasTopicHierarchyRail from "./CanvasTopicHierarchyRail.jsx";

function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
    rerender(newElement) {
      act(() => root.render(newElement));
    }
  };
}

describe("CanvasTopicHierarchyRail", () => {
  const defaultProps = {
    show: true,
    selectedLevel: 1,
    topicCards: [
      {
        key: "card1",
        fullPath: "Topic A",
        displayName: "A",
        sentenceCount: 5,
        startSentence: 1,
        endSentence: 5,
        top: 10,
        height: 60,
        titleFontSize: 12,
        depth: 0,
        levelIndex: 0,
        right: 0,
      },
      {
        key: "card2",
        fullPath: "Topic A > Sub B",
        displayName: "B",
        sentenceCount: 12,
        startSentence: 6,
        endSentence: 17,
        top: 80,
        height: 70,
        titleFontSize: 12,
        depth: 1,
        levelIndex: 1,
        right: 10,
      }
    ],
    railWidth: 200,
    cardWidth: 180,
    activeTopicKey: null,
    selectedTopicKey: null,
    onTopicEnter: vi.fn(),
    onTopicLeave: vi.fn(),
    onTopicClick: vi.fn(),
    readTopics: new Set(["Topic A"]),
    onToggleRead: vi.fn(),
  };

  it("returns null when show is false", () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, { ...defaultProps, show: false })
    );
    expect(container.firstChild).toBeNull();
    unmount();
  });

  it("renders empty state when there are no cards at or below selectedLevel", () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        selectedLevel: 0,
        topicCards: [],
      })
    );
    const emptyMsg = container.querySelector(".canvas-topic-hierarchy__empty");
    expect(emptyMsg).not.toBeNull();
    expect(emptyMsg.textContent).toContain("No topics at this level");
    unmount();
  });

  it("handles non-array or null topicCards gracefully", () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: null,
      })
    );
    const emptyMsg = container.querySelector(".canvas-topic-hierarchy__empty");
    expect(emptyMsg).not.toBeNull();
    unmount();
  });

  it("renders cards, handles hover, click, right click and read state (as Set)", () => {
    const onTopicEnter = vi.fn();
    const onTopicLeave = vi.fn();
    const onTopicClick = vi.fn();
    const onToggleRead = vi.fn();

    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        activeTopicKey: "Topic A",
        selectedTopicKey: "Topic A > Sub B",
        onTopicEnter,
        onTopicLeave,
        onTopicClick,
        onToggleRead,
      })
    );

    const buttons = container.querySelectorAll(".canvas-topic-hierarchy__card");
    expect(buttons).toHaveLength(2);

    // card1 (Topic A) is active and is-read (from defaultProps.readTopics Set)
    expect(buttons[0].className).toContain("is-active");
    expect(buttons[0].className).toContain("is-read");
    expect(buttons[0].className).toContain("canvas-topic-hierarchy__card--root");

    // card2 (Topic A > Sub B) is selected
    expect(buttons[1].className).toContain("is-selected");
    expect(buttons[1].className).toContain("canvas-topic-hierarchy__card--child");

    // hover card2
    const mouseOverEvent = new MouseEvent("mouseover", { bubbles: true });
    act(() => {
      buttons[1].dispatchEvent(mouseOverEvent);
    });
    expect(onTopicEnter).toHaveBeenCalledWith("Topic A > Sub B");

    // leave card2
    const mouseOutEvent = new MouseEvent("mouseout", { bubbles: true });
    act(() => {
      buttons[1].dispatchEvent(mouseOutEvent);
    });
    expect(onTopicLeave).toHaveBeenCalledWith("Topic A > Sub B");

    // click card2
    act(() => {
      buttons[1].click();
    });
    expect(onTopicClick).toHaveBeenCalledWith("Topic A > Sub B", expect.objectContaining({ key: "card2" }));
    expect(onToggleRead).toHaveBeenCalledWith("Topic A > Sub B");

    // right click card2 (contextmenu)
    onToggleRead.mockClear();
    const contextMenuEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    vi.spyOn(contextMenuEvent, "preventDefault");
    act(() => {
      buttons[1].dispatchEvent(contextMenuEvent);
    });
    expect(contextMenuEvent.preventDefault).toHaveBeenCalled();
    expect(onToggleRead).toHaveBeenCalledWith("Topic A > Sub B");

    unmount();
  });

  it("handles readTopics as array or null", () => {
    // Array readTopics (without spaces around > as isTopicRead trims and joins them)
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        readTopics: ["Topic A>Sub B"],
      })
    );
    const buttons = container.querySelectorAll(".canvas-topic-hierarchy__card");
    expect(buttons[0].className).not.toContain("is-read");
    expect(buttons[1].className).toContain("is-read");
    unmount();
  });

  it("handles onMouseDown propagation based on target", () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, defaultProps)
    );

    const aside = container.querySelector(".canvas-topic-hierarchy");
    const button = container.querySelector(".canvas-topic-hierarchy__card");

    // Click on button inside aside
    const mousedownOnBtn = new MouseEvent("mousedown", { bubbles: true });
    vi.spyOn(mousedownOnBtn, "stopPropagation");
    act(() => {
      button.dispatchEvent(mousedownOnBtn);
    });
    expect(mousedownOnBtn.stopPropagation).toHaveBeenCalled();

    // Click on aside itself
    const mousedownOnAside = new MouseEvent("mousedown", { bubbles: true });
    vi.spyOn(mousedownOnAside, "stopPropagation");
    act(() => {
      aside.dispatchEvent(mousedownOnAside);
    });
    expect(mousedownOnAside.stopPropagation).not.toHaveBeenCalled();

    unmount();
  });

  it("handles crowding and overlap logic (nudgeCrowdedPair & compact height)", () => {
    // Create two cards that overlap significantly
    const overlappingCards = [
      {
        key: "o1",
        fullPath: "Over 1",
        displayName: "O1",
        sentenceCount: 15,
        startSentence: 1,
        endSentence: 10,
        top: 50,
        height: 80,
        titleFontSize: 12,
        depth: 0,
        levelIndex: 0,
        right: 0,
      },
      {
        key: "o2",
        fullPath: "Over 2",
        displayName: "O2",
        sentenceCount: 3,
        startSentence: 11,
        endSentence: 15,
        top: 60,
        height: 80,
        titleFontSize: 12,
        depth: 0,
        levelIndex: 0,
        right: 0,
      }
    ];

    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: overlappingCards,
      })
    );

    const buttons = container.querySelectorAll(".canvas-topic-hierarchy__card");
    expect(buttons).toHaveLength(2);
    unmount();
  });
});
