/**
 * Minimal deterministic topic color utilities (copied/trimmed from main frontend).
 */

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
  const parts = String(topicName || '')
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts[0] || '';
}

function getTopicDepth(topicName) {
  const parts = String(topicName || '')
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
  return Math.max(0, parts.length - 1);
}

export function getHierarchyTopicAccentColor(topicName, depth) {
  const rootName = getRootTopicName(topicName);
  const hue = hashString(rootName) % 360;
  const d = depth !== undefined ? depth : getTopicDepth(topicName);
  const saturation = Math.max(30, 60 - d * 6);
  const lightness = Math.min(62, 38 + d * 6);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function getHierarchyTopicHighlightColor(topicName, depth) {
  const rootName = getRootTopicName(topicName);
  const hue = hashString(rootName) % 360;
  const d = depth !== undefined ? depth : getTopicDepth(topicName);
  const saturation = Math.max(18, 46 - d * 5);
  const lightness = Math.min(96, 92 - d * 3);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function getTopicAccentColor(topicName) {
  const hue = hashString(topicName) % 360;
  return `hsl(${hue}, 42%, 46%)`;
}
