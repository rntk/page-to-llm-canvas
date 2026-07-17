import { useCallback, useEffect, useRef, useState } from 'react';

/** Owns the related hover, selection, and hierarchy-level state for topics. */
export function useTopicSelection() {
  const [selectedTopicKey, setSelectedTopicKey] = useState(null);
  const [selectedTopicCardKey, setSelectedTopicCardKey] = useState(null);
  const [hoveredTopicKey, setHoveredTopicKey] = useState(null);
  const [hoveredTopicCardKey, setHoveredTopicCardKey] = useState(null);
  const [selectedLevel, setSelectedLevel] = useState(0);

  // Callbacks can inspect the latest card without changing identity whenever
  // the selection changes.
  const selectedTopicCardKeyRef = useRef(selectedTopicCardKey);
  useEffect(() => {
    selectedTopicCardKeyRef.current = selectedTopicCardKey;
  }, [selectedTopicCardKey]);

  const handleTopicEnter = useCallback((topicKey, cardKey = null) => {
    setHoveredTopicKey(topicKey);
    setHoveredTopicCardKey(cardKey);
  }, []);

  const handleTopicLeave = useCallback((topicKey, cardKey = null) => {
    setHoveredTopicKey((current) => (current === topicKey ? null : current));
    setHoveredTopicCardKey((current) => (!cardKey || current === cardKey ? null : current));
  }, []);

  const toggleTopicSelection = useCallback((topicKey, card) => {
    const cardKey = card?.key || topicKey;
    const shouldDeselect = selectedTopicCardKeyRef.current === cardKey;
    setSelectedTopicKey(shouldDeselect ? null : topicKey);
    setSelectedTopicCardKey(shouldDeselect ? null : cardKey);
  }, []);

  const clearTopicSelection = useCallback(() => {
    setSelectedTopicKey(null);
    setSelectedTopicCardKey(null);
    setHoveredTopicKey(null);
    setHoveredTopicCardKey(null);
  }, []);

  return {
    selectedTopicKey,
    selectedTopicCardKey,
    hoveredTopicKey,
    hoveredTopicCardKey,
    selectedLevel,
    activeTopicKey: hoveredTopicKey || selectedTopicKey,
    activeTopicCardKey: hoveredTopicCardKey || selectedTopicCardKey,
    setSelectedTopicKey,
    setSelectedTopicCardKey,
    setHoveredTopicKey,
    setHoveredTopicCardKey,
    setSelectedLevel,
    handleTopicEnter,
    handleTopicLeave,
    toggleTopicSelection,
    clearTopicSelection,
  };
}
