import React from 'react';

// Hoist the static icon to avoid rebuilding it on each render.
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

// Link to the transcript moment, or render nothing when no link exists.
function YouTubeTimestampButton({ link }) {
  if (!link) return null;
  return (
    <a
      className="canvas-youtube-timestamp"
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open YouTube at ${link.label}`}
      // Keep the canvas drag and card toggle handlers from intercepting the link.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {PLAY_ICON}
      <span className="canvas-youtube-timestamp__label">{link.label}</span>
    </a>
  );
}

export default React.memo(YouTubeTimestampButton);
