import {
  canonicalTopicPath,
  splitTopicPath,
  joinTopicPath,
} from '../../shared/runtime/topicPath.js';
import { parallelMap } from '../llm/concurrency.js';
import { runFailFastStage } from './failFastStage.js';
import { buildTopicTree } from './topicTreeMerge.js';
import { MAX_TOPIC_TAGS } from './topicTagCloudConstants.js';

const LEAF_WORKERS = 2;

/**
 * Build clouds from unique leaf paths and roll their scores up to each ancestor.
 * @param {object} options Inputs for cloud generation.
 * @param {Array<{name: string, sentences: number[]}>} options.topics Topic assignments.
 * @param {string[]} options.sentences Source sentences indexed from zero.
 * @param {Function} options.rank Ranks a leaf's text.
 * @param {AbortSignal} [options.signal] Caller cancellation.
 * @returns {Promise<Record<string, Array<{word: string, weight: number}>>>} Clouds keyed by canonical path.
 */
export async function buildTopicTagClouds({ topics, sentences, rank, signal }) {
  const normalized = (topics || []).map((topic) => ({
    name: canonicalTopicPath(topic?.name),
    sentences: (topic?.sentences || []).filter(
      (number) => Number.isInteger(number) && number > 0 && number <= sentences.length,
    ),
  }));
  const { nodes } = buildTopicTree(normalized);
  const leaves = [...nodes.values()].filter((node) => node.path && node.children.length === 0);
  const ranked = await runFailFastStage({ signal }, parallelMap, (runtime, map) =>
    map(leaves, LEAF_WORKERS, (node) => {
      const text = node.sourceSentences.map((number) => sentences[number - 1]).join(' ');
      return rank({ text, title: node.path, signal: runtime.signal });
    }),
  );
  const clouds = new Map();
  leaves.forEach((node, index) => {
    const segments = splitTopicPath(node.path);
    for (let depth = 1; depth <= segments.length; depth++) {
      const ancestor = joinTopicPath(segments.slice(0, depth));
      if (!clouds.has(ancestor)) clouds.set(ancestor, new Map());
      const scores = clouds.get(ancestor);
      for (const tag of ranked[index] || []) {
        if (typeof tag?.word !== 'string' || !tag.word.trim() || !Number.isFinite(tag.weight))
          continue;
        const word = tag.word.trim();
        const key = word.normalize('NFC').toLowerCase();
        const current = scores.get(key);
        if (current) current.weight += tag.weight;
        else scores.set(key, { word, weight: tag.weight });
      }
    }
  });
  return Object.fromEntries(
    [...clouds].map(([path, scores]) => [
      path,
      [...scores.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_TOPIC_TAGS),
    ]),
  );
}
