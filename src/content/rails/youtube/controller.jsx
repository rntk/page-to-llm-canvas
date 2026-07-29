import React from 'react';
import YouTubeRail from './YouTubeRail.jsx';
import { buildYouTubeRailCards } from './sync.js';
import { formatTimestampLabel, getTimestampForSentences } from '../../../utils/youtubeTimestamp.js';
import { computeMaxTopicLevel } from '../shared/railCards.js';
import { fetchRecord, createLoadToken } from '../shared/recordFetch.js';
import { createRailSurface, closeInPageRail, railLoadingTokenHolder } from '../shared/surface.js';
import { removeCanvasIframe } from '../../record-view/iframeManager.js';

// Prefer YouTube's main player element so we don't accidentally bind to a
// hover-preview thumbnail or an ad's <video>. Falls back to any <video> for
// non-standard embeds.
function getYouTubeVideoElement() {
  return document.querySelector('.html5-main-video') || document.querySelector('video');
}

export async function openYouTubeRail(rec, initialMode = 'topics', options = {}) {
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

  const state = {
    mode: initialMode === 'summaries' || initialMode === 'chat' ? initialMode : 'topics',
    selectedLevel: options && typeof options.level === 'number' ? options.level : 0,
  };

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

  const seekTo = async (seconds) => {
    const video = getYouTubeVideoElement();
    if (!Number.isFinite(seconds)) {
      return { ok: false, message: 'This evidence has no usable video timestamp.' };
    }
    if (!video) {
      return {
        ok: false,
        message: 'The video player is not available yet. Wait for it to load, then try again.',
      };
    }
    const target = Math.max(0, seconds);
    const label = formatTimestampLabel(target);
    try {
      video.currentTime = target;
    } catch (_) {
      return {
        ok: false,
        message: 'The video cannot seek yet. Wait for it to finish loading, then try again.',
      };
    }
    if (typeof video.play === 'function') {
      try {
        await video.play();
      } catch (_) {
        return {
          ok: true,
          tone: 'warning',
          message: `Jumped to ${label}. Playback did not start; press Play in the video player.`,
        };
      }
    }
    return { ok: true, message: `Jumped to ${label}.` };
  };

  const handleSelectMode = (mode) => {
    if (isClosed()) return;
    const next = mode === 'summaries' || mode === 'chat' ? mode : 'topics';
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

  // Stored chat events use 1-based transcript line ranges. Deliberate event
  // selection arrives with `focus: true`; resolve the first line to its
  // nearest transcript timestamp and use the exact same seek path as a
  // topic/summary card click.
  const getChatEventTimestamp = ({ startLine }) => getTimestampForSentences(sentences, [startLine]);

  const handleChatHighlight = ({ startLine }, { focus = false } = {}) => {
    if (isClosed() || guard.isStale()) {
      return { ok: false, message: 'This chat view is no longer open.' };
    }
    if (!focus) return;
    const seconds = getChatEventTimestamp({ startLine });
    if (seconds == null) {
      return { ok: false, message: 'This evidence has no transcript timestamp.' };
    }
    return seekTo(seconds);
  };

  function renderRail() {
    if (isClosed() || guard.isStale()) return;
    const cards =
      state.mode === 'chat'
        ? []
        : buildYouTubeRailCards({
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
        sentences={sentences}
        recordKey={record.key}
        onChatHighlight={handleChatHighlight}
        getChatEventTimestamp={getChatEventTimestamp}
      />,
    );
  }

  renderRail();

  if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
    const seconds = getTimestampForSentences(sentences, options.sentenceNumbers);
    if (seconds != null) {
      void seekTo(seconds);
    }
  }
}
