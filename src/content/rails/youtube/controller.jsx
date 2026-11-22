import { projectArticleView } from '../../../domain/articleView.js';
import React from 'react';
import YouTubeRail from './YouTubeRail.jsx';
import { buildYouTubeRailCards } from './sync.js';
import { formatTimestampLabel, getTimestampForSentences } from '../../../utils/youtubeTimestamp.js';
import { computeMaxTopicLevel } from '../shared/railCards.js';
import { createRecordLoader } from '../shared/recordLoader.js';
import { resolveRailLevel } from '../shared/railState.js';
import { RAIL_MODE } from '../../../shared/runtime/contracts.js';
import { browserRuntimeMessenger } from '../../../utils/runtimeMessages.js';
import { createLogger } from '../../../shared/runtime/log.js';
import { MSG } from '../../../shared/runtime/messages.js';
import { createResplitAction } from '../../../shared/runtime/topicResplit.js';

const defaultDialogs = {
  alert: (...args) => globalThis.alert(...args),
};

export function createYouTubeRailController({
  surfaceManager,
  document: contentDocument = globalThis.document,
  runtimeMessenger = browserRuntimeMessenger,
  dialogs = defaultDialogs,
  logger = createLogger('youtube rail'),
  onDestroy,
} = {}) {
  const closeRail = surfaceManager.close;
  const { alert } = { ...defaultDialogs, ...(dialogs ?? {}) };
  const recordLoader = createRecordLoader({ surfaceManager, runtimeMessenger, alert, logger });
  let videoElement = null;

  // Prefer YouTube's main player element so we don't accidentally bind to a
  // hover-preview thumbnail or an ad's <video>. Falls back to any <video> for
  // non-standard embeds.
  const getYouTubeVideoElement = () => {
    if (videoElement?.isConnected) return videoElement;
    videoElement =
      contentDocument.querySelector('.html5-main-video') || contentDocument.querySelector('video');
    return videoElement;
  };

  // While an ad plays the main <video> carries the ad stream, so its clock and
  // seek position do not belong to the transcript.
  const isAdPlaying = () =>
    Boolean(contentDocument.querySelector('.html5-video-player.ad-showing, .ad-interrupting'));

  async function openYouTubeRail(rec, initialMode = RAIL_MODE.TOPICS, options = {}) {
    const { guard, assessment } = await recordLoader.load(rec.key);
    if (!assessment || guard.isStale()) return false;
    const record = assessment.record;
    // No page article DOM here, so no selector gating: require only transcript
    // sentences and at least one topic/summary.
    const { sentences, topics } = projectArticleView(record);
    const hasTopics = topics.length > 0;
    const hasSummaries =
      record.topic_summary_index && typeof record.topic_summary_index === 'object';
    if (sentences.length === 0 || (!hasTopics && !hasSummaries)) {
      alert('PageToLLM: This analysis has no transcript topics to sync with the video.');
      return false;
    }

    let selectedLevel = resolveRailLevel(options);

    const maxLevel = computeMaxTopicLevel(record);

    const surface = surfaceManager.createSurface({
      initialMode,
      youtube: true,
      onTeardown: onDestroy,
    });
    if (!surface) return false;
    const { railRoot, setMode, setSide, isClosed } = surface;
    const topicActions = [
      createResplitAction({
        topics,
        request: (topic) =>
          runtimeMessenger.send({ type: MSG.resplitTopic, key: record.key, ...topic }),
        onAccepted: closeRail,
      }),
    ];

    const getCurrentTime = () => {
      if (isAdPlaying()) return null;
      const video = getYouTubeVideoElement();
      if (!video) return null;
      const time = video.currentTime;
      return Number.isFinite(time) ? time : null;
    };

    // Report play/pause and seeks so the rail can stop polling a paused clock.
    const subscribePlayback = (listener) => {
      const video = getYouTubeVideoElement();
      if (!video) return () => {};
      const notify = () => listener({ playing: !video.paused && !video.ended });
      const events = ['play', 'playing', 'pause', 'ended', 'seeked'];
      events.forEach((name) => video.addEventListener(name, notify));
      notify();
      return () => events.forEach((name) => video.removeEventListener(name, notify));
    };

    const seekTo = async (seconds) => {
      const video = getYouTubeVideoElement();
      if (!Number.isFinite(seconds)) {
        return { ok: false, message: 'This evidence has no usable video timestamp.' };
      }
      if (isAdPlaying()) {
        return {
          ok: false,
          tone: 'warning',
          message: 'An ad is playing. Wait for it to finish, then try again.',
        };
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
      if (!setMode(mode)) return;
      renderRail();
    };

    const handleSelectSide = (side) => {
      if (!setSide(side)) return;
      renderRail();
    };

    const handleSelectLevel = (level) => {
      if (isClosed()) return;
      if (selectedLevel === level) return;
      selectedLevel = level;
      renderRail();
    };

    // Chat events use 1-based transcript line ranges. Deliberate selection arrives
    // with `focus: true`; seek to the first line's nearest timestamp like a card click.
    const getChatEventTimestamp = ({ startLine }) =>
      getTimestampForSentences(sentences, [startLine]);

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

    // Cards for every level of a mode, built once per mode; the rail compares
    // levels to hint at a better one. The selected level's cards feed the list.
    const levelCardsByMode = new Map();
    const getLevelCards = (mode) => {
      if (mode === RAIL_MODE.CHAT) return [];
      if (!levelCardsByMode.has(mode)) {
        levelCardsByMode.set(
          mode,
          Array.from({ length: maxLevel + 1 }, (_, level) =>
            buildYouTubeRailCards({ record, mode, selectedLevel: level }),
          ),
        );
      }
      return levelCardsByMode.get(mode);
    };

    function renderRail() {
      if (isClosed() || guard.isStale()) return;
      const { mode, side } = surface;
      const levelCards = getLevelCards(mode);
      const cards =
        mode === RAIL_MODE.CHAT
          ? []
          : (levelCards[selectedLevel] ??
            buildYouTubeRailCards({
              record,
              mode,
              selectedLevel,
            }));
      railRoot.render(
        <YouTubeRail
          mode={mode}
          maxLevel={maxLevel}
          selectedLevel={selectedLevel}
          cards={cards}
          levelCards={levelCards}
          topicActions={topicActions}
          onSelectMode={handleSelectMode}
          onSelectLevel={handleSelectLevel}
          side={side}
          onSelectSide={handleSelectSide}
          onClose={closeRail}
          getCurrentTime={getCurrentTime}
          subscribePlayback={subscribePlayback}
          onSeek={seekTo}
          topics={record.topics}
          sentences={sentences}
          recordKey={record.key}
          contentRevision={record.contentRevision}
          onChatHighlight={handleChatHighlight}
          getChatEventTimestamp={getChatEventTimestamp}
        />,
      );
    }

    try {
      renderRail();
    } catch (err) {
      // Never leave a blank rail without a close button.
      closeRail();
      throw err;
    }

    if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
      const seconds = getTimestampForSentences(sentences, options.sentenceNumbers);
      if (seconds != null) {
        void seekTo(seconds);
      }
    }
    return true;
  }

  return { openYouTubeRail };
}
