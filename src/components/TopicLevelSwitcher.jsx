import React from 'react';

/**
 * @param {object} props
 * @param {number} props.selectedLevel
 * @param {number} props.maxLevel
 * @param {function(number): void} props.onChange
 * @param {string} [props.label]
 * @param {string} [props.className]
 * @param {function(number): string} [props.getOptionLabel]
 * @returns {JSX.Element}
 */
export default function TopicLevelSwitcher({
  selectedLevel,
  maxLevel,
  onChange,
  label = 'Level:',
  className = '',
  getOptionLabel = (level) => `L${level}`,
}) {
  const rootClassName = ['topic-level-switcher', className].filter(Boolean).join(' ');

  return (
    <div className={rootClassName}>
      {label && <span className="topic-level-switcher__label">{label}</span>}
      <div className="topic-level-switcher__buttons">
        {Array.from({ length: maxLevel + 1 }, (_, level) => (
          <button
            key={level}
            type="button"
            className={`topic-level-switcher__button${selectedLevel === level ? ' active' : ''}`}
            onClick={() => onChange(level)}
          >
            {getOptionLabel(level)}
          </button>
        ))}
      </div>
    </div>
  );
}
