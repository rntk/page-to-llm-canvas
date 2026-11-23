import React from 'react';

export function TopicTagCloud({ tags, name, className = '' }) {
  // Leaf terms start at 0.7. Shared terms can earn higher scores on branches.
  const minWeight = 0.7;
  const maxWeight = Math.max(1, ...tags.map(({ weight }) => weight));

  return (
    <ul
      className={['topic-tag-cloud', className].filter(Boolean).join(' ')}
      aria-label={`Tags for ${name}`}
    >
      {tags.map(({ word, weight }) => {
        const fraction = Math.max(0, weight - minWeight) / (maxWeight - minWeight);
        return (
          <li key={word} style={{ fontSize: `${0.85 + 1.05 * fraction}rem` }}>
            {word}
          </li>
        );
      })}
    </ul>
  );
}

export function TopicTagCloudSwitcher({ selected, onChange }) {
  return (
    <div
      className="topic-tag-cloud-switcher th-page__level-switcher topic-level-switcher__buttons"
      role="group"
      aria-label="Card content"
    >
      <button
        type="button"
        className={`topic-level-switcher__button${selected ? '' : ' active'}`}
        aria-pressed={!selected}
        onClick={() => onChange(false)}
      >
        Summaries
      </button>
      <button
        type="button"
        className={`topic-level-switcher__button${selected ? ' active' : ''}`}
        aria-pressed={selected}
        onClick={() => onChange(true)}
      >
        Tag clouds
      </button>
    </div>
  );
}

export function TopicTagCloudStatus({ loading, error, byPath, retry }) {
  if (error) {
    return (
      <div className="th-tag-cloud-notice" role="alert">
        <span>Could not generate tag clouds. {error}</span>
        <button type="button" className="th-page__close-btn" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }

  const empty = byPath && !Object.values(byPath).some((tags) => tags.length > 0);
  const message = loading
    ? 'Generating tag clouds…'
    : empty
      ? 'No tags are available for these topics.'
      : '';
  return message ? (
    <div className="th-tag-cloud-notice" role="status">
      {message}
    </div>
  ) : null;
}
