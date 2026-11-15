import React from 'react';
import TopicLevelSwitcher from './TopicLevelSwitcher.jsx';
import { TOPIC_SOURCE_IDS, TOPIC_SOURCE_LABELS } from '../shared/topicSource.js';

/**
 * "Topics:" switcher between the pipeline's topics and the summary tree.
 * @param {object} props
 * @param {string} props.source Selected topic source id.
 * @param {function(string): void} props.onChange
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
export default function TopicSourceSwitcher({ source, onChange, className = '' }) {
  return (
    <TopicLevelSwitcher
      className={className}
      label="Topics:"
      selectedLevel={TOPIC_SOURCE_IDS.indexOf(source)}
      maxLevel={TOPIC_SOURCE_IDS.length - 1}
      getOptionLabel={(index) => TOPIC_SOURCE_LABELS[TOPIC_SOURCE_IDS[index]]}
      onChange={(index) => onChange(TOPIC_SOURCE_IDS[index])}
    />
  );
}
