export function selectCurrentTopicSummary({
  showSummaryMode,
  activeTopicKey,
  activeTopicCardKey,
  allSummaryCards,
}) {
  if (showSummaryMode || !activeTopicKey) return null;
  const cards = Array.isArray(allSummaryCards) ? allSummaryCards : [];
  const card =
    (activeTopicCardKey && cards.find((c) => c.key === activeTopicCardKey)) ||
    cards.find((c) => c.path === activeTopicKey);
  return card && card.text ? card : null;
}
