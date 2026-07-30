/**
 * Minimal deterministic topic color utilities (copied/trimmed from main frontend).
 */

import { splitTopicPath } from '../domain/topicDomain.js';

function hashString(value) {
  let hash = 0;
  const input = String(value || '');
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getRootTopicName(topicName) {
  const parts = splitTopicPath(topicName);
  return parts[0] || '';
}

function getTopicDepth(topicName) {
  const parts = splitTopicPath(topicName);
  return Math.max(0, parts.length - 1);
}

function getHierarchyTopicHue(topicName) {
  const rootName = getRootTopicName(topicName);
  return (hashString(rootName) + 170) % 360;
}

export function getHierarchyTopicAccentColor(topicName, depth) {
  const hue = getHierarchyTopicHue(topicName);
  const d = depth !== undefined ? depth : getTopicDepth(topicName);
  const saturation = Math.max(24, 52 - d * 5);
  const lightness = Math.min(66, 42 + d * 5);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function getHierarchyTopicHighlightColor(topicName, depth) {
  const hue = getHierarchyTopicHue(topicName);
  const d = depth !== undefined ? depth : getTopicDepth(topicName);
  const saturation = Math.max(14, 36 - d * 4);
  const lightness = Math.min(97, 94 - d * 2);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Dark-mode variant of the topic card fill. Keeps the same per-root hue for
 * identity but uses a low lightness so the cards read as tinted dark surfaces
 * instead of the bright pastels used in light mode.
 * @param {string} topicName Topic path.
 * @param {number} depth Optional topic depth.
 */
export function getHierarchyTopicHighlightColorDark(topicName, depth) {
  const hue = getHierarchyTopicHue(topicName);
  const d = depth !== undefined ? depth : getTopicDepth(topicName);
  const saturation = Math.max(16, 34 - d * 3);
  const lightness = Math.min(30, 19 + d * 3);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
