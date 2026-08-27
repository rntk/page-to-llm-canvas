export function selectCurrentTopicSummary({ showSummaryMode, activeTopic, allSummaryCards }) {
  if (showSummaryMode || !activeTopic) return null;
  const cards = Array.isArray(allSummaryCards) ? allSummaryCards : [];
  const card =
    (activeTopic.cardKey && cards.find((c) => c.key === activeTopic.cardKey)) ||
    cards.find((c) => c.path === activeTopic.path);
  return card && card.text ? card : null;
}
