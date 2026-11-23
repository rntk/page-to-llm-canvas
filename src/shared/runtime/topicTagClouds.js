import { summaryTreeRevision } from './summaryTree.js';
import { TOPIC_SOURCE } from './topicSources.js';

export const TOPIC_TAG_CLOUD_VERSION = 1;

/**
 * Identify the saved inputs used to build topic tag clouds. Pipeline resplits
 * change the topic revision even when the article text stays the same.
 * @param {object} record Saved article or its metadata with summary tree state.
 * @param {string} source Selected topic source.
 * @returns {object}
 */
export function topicTagCloudRevision(record, source) {
  const tree = source === TOPIC_SOURCE.SUMMARY_TREE ? record.summary_tree : null;
  return {
    contentRevision: record.contentRevision ?? null,
    topicsRevision: record.topicsRevision ?? null,
    summaryTreeRevision: summaryTreeRevision({ tree }) ?? null,
  };
}

export function sameTopicTagCloudRevision(left, right) {
  return (
    left?.contentRevision === right.contentRevision &&
    left?.topicsRevision === right.topicsRevision &&
    left?.summaryTreeRevision === right.summaryTreeRevision
  );
}

export function isTopicTagCloudCacheable(source, revision) {
  // Older summary trees may have no saved revision to identify their inputs.
  return source === TOPIC_SOURCE.PIPELINE || revision.summaryTreeRevision !== null;
}

/**
 * Read saved clouds for the selected source and its current inputs.
 * @param {object} record Saved article with its tag clouds.
 * @param {string} source Selected topic source.
 * @param {object} revision Current topic tag cloud revision.
 * @returns {object|null}
 */
export function readSavedTopicTagClouds(record, source, revision) {
  const cloud = record.topic_tag_clouds?.[source];
  if (
    isTopicTagCloudCacheable(source, revision) &&
    cloud?.version === TOPIC_TAG_CLOUD_VERSION &&
    cloud.byPath &&
    sameTopicTagCloudRevision(cloud, revision)
  )
    return cloud;
  return null;
}
