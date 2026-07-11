import React from 'react';
import YouTubeRail from './YouTubeRail.jsx';
import { buildYouTubeRailCards } from './youtubeRailSync.js';
import { computeMaxTopicLevel } from './recordTransform.js';
import { fetchRecord, createLoadToken } from './recordFetch.js';
import { createRailSurface, closeInPageRail, railLoadingTokenHolder } from './railSurface.js';
import { removeCanvasIframe } from './recordViewIframe.js';

// Prefer YouTube's main player element so we don't accidentally bind to a
// hover-preview thumbnail or an ad's <video>. Falls back to any <video> for
// non-standard embeds.
function getYouTubeVideoElement() {
  return document.querySelector('.html5-main-video') || document.querySelector('video');
}

export async function openYouTubeRail(rec) {
  closeInPageRail();
  removeCanvasIframe();

  const guard = createLoadToken(railLoadingTokenHolder);
  const record = await fetchRecord(rec.key);
  if (guard.isStale()) return;

  if (!record) {
    alert('PageToLLM: Analysis record not found.');
    return;
  }
  // The YouTube rail never touches the page article DOM, so the scroll rail's
  // selector/element gating does not apply — gate only on what the sync needs:
  // a finished analysis with transcript sentences and at least one topic/summary.
  if (record.status !== 'done') {
    alert(
      `PageToLLM: Analysis is not ready yet (status: ${record.status || 'queued'}). Please wait a moment and try again.`,
    );
    return;
  }
  const sentences = Array.isArray(record.sentences) ? record.sentences : [];
  const hasTopics = Array.isArray(record.topics) && record.topics.length > 0;
  const hasSummaries = record.topic_summary_index && typeof record.topic_summary_index === 'object';
  if (sentences.length === 0 || (!hasTopics && !hasSummaries)) {
    alert('PageToLLM: This analysis has no transcript topics to sync with the video.');
    return;
  }

  const state = { mode: 'topics', selectedLevel: 0 };

  const maxLevel = computeMaxTopicLevel(record);

  const { railEl, railRoot, setRailWidthForMode, isClosed } = createRailSurface({
    state,
    youtube: true,
  });

  const getCurrentTime = () => {
    const video = getYouTubeVideoElement();
    if (!video) return null;
    const time = video.currentTime;
    return Number.isFinite(time) ? time : null;
  };

  const seekTo = (seconds) => {
    const video = getYouTubeVideoElement();
    if (!video || !Number.isFinite(seconds)) return;
    try {
      video.currentTime = Math.max(0, seconds);
      if (typeof video.play === 'function') void video.play().catch(() => {});
    } catch (_) {
      /* seeking can throw on a not-yet-ready media element — ignore */
    }
  };

  const handleSelectMode = (mode) => {
    if (isClosed()) return;
    const next = mode === 'summaries' ? 'summaries' : 'topics';
    if (state.mode === next) return;
    state.mode = next;
    railEl.dataset.mode = state.mode;
    setRailWidthForMode();
    renderRail();
  };

  const handleSelectLevel = (level) => {
    if (isClosed()) return;
    if (state.selectedLevel === level) return;
    state.selectedLevel = level;
    renderRail();
  };

  function renderRail() {
    if (isClosed() || guard.isStale()) return;
    const cards = buildYouTubeRailCards({
      record,
      mode: state.mode,
      selectedLevel: state.selectedLevel,
    });
    railRoot.render(
      <YouTubeRail
        mode={state.mode}
        maxLevel={maxLevel}
        selectedLevel={state.selectedLevel}
        cards={cards}
        onSelectMode={handleSelectMode}
        onSelectLevel={handleSelectLevel}
        onClose={closeInPageRail}
        getCurrentTime={getCurrentTime}
        onSeek={seekTo}
      />,
    );
  }

  renderRail();
}
