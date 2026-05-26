import React from "react";

/**
 * @param {{
 *   selectedLevel: number,
 *   maxLevel: number,
 *   onChange: (level: number) => void,
 *   label?: string,
 *   className?: string,
 *   getOptionLabel?: (level: number) => string,
 * }} props
 * @returns {import("react").JSX.Element}
 */
export default function TopicLevelSwitcher({
  selectedLevel,
  maxLevel,
  onChange,
  label = "Level:",
  className = "",
  getOptionLabel = (level) => `L${level}`,
}) {
  const rootClassName = ["topic-level-switcher", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClassName}>
      {label && <span className="topic-level-switcher__label">{label}</span>}
      <div className="topic-level-switcher__buttons">
        {Array.from({ length: maxLevel + 1 }, (_, level) => (
          <button
            key={level}
            type="button"
            className={`topic-level-switcher__button${selectedLevel === level ? " active" : ""}`}
            onClick={() => onChange(level)}
          >
            {getOptionLabel(level)}
          </button>
        ))}
      </div>
    </div>
  );
}

