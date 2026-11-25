import React from 'react';
import TopicLevelSwitcher from './TopicLevelSwitcher.jsx';
import { TOPIC_SOURCE_IDS, TOPIC_SOURCE_LABELS } from '../shared/topicSource.js';

/**
 * "Topics:" switcher between topic sources.
 * @param {object} props
 * @param {string} props.source Selected topic source id.
 * @param {function(string): void} props.onChange
 * @param {string[]} [props.sources] Ordered list of selectable source ids.
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
export default function TopicSourceSwitcher({
  source,
  onChange,
  sources = TOPIC_SOURCE_IDS,
  className = '',
}) {
  return (
    <TopicLevelSwitcher
      className={className}
      label="Topics:"
      selectedLevel={sources.indexOf(source)}
      maxLevel={sources.length - 1}
      getOptionLabel={(index) => TOPIC_SOURCE_LABELS[sources[index]]}
      onChange={(index) => onChange(sources[index])}
    />
  );
}
