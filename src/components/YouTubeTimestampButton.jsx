import React from 'react';

// Static play-button glyph — doesn't depend on any prop, so it's hoisted out
// of the component to avoid rebuilding the element tree on every render.
const PLAY_ICON = (
  <svg
    className="canvas-youtube-timestamp__icon"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      d="M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15V9l5.2 3-5.2 3z"
    />
  </svg>
);

// A small "open this moment on YouTube" link rendered on summary / source
// floating cards when the record is a YouTube transcript. `link` is the result
// of getYouTubeTimestampLink ({ url, seconds, label }) or null — callers pass it
// through so the button simply renders nothing when there's no deep-link.
function YouTubeTimestampButton({ link }) {
  if (!link) return null;
  return (
    <a
      className="canvas-youtube-timestamp"
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open YouTube at ${link.label}`}
      // The floating cards live inside the canvas, which captures pointer drags
      // to pan. Stop propagation so clicking the link opens the tab instead of
      // starting a pan / toggling the card.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {PLAY_ICON}
      <span className="canvas-youtube-timestamp__label">{link.label}</span>
    </a>
  );
}

export default React.memo(YouTubeTimestampButton);
