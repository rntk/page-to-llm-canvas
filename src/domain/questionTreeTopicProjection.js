/**
 * Pure projection of a saved question tree onto the record's primary topic shape,
 * so the topic views can show Group question -> Question -> Point with answers
 * and cited source sentences.
 */

import { joinTopicPath } from '../shared/runtime/topicPath.js';
import { sortedUnique } from '../shared/runtime/sortedUnique.js';
import { splitSentenceRuns } from './topicDomain.js';

function pathTitle(value) {
  return typeof value === 'string' ? value.replace(/>/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
}

function validSentences(list) {
  return sortedUnique(
    (Array.isArray(list) ? list : []).filter((value) => Number.isInteger(value) && value > 0),
  );
}

function fallbackTitle(sentences) {
  if (!sentences.length) return 'Untitled';
  const first = sentences[0];
  const last = sentences.at(-1);
  return first === last ? `Sentence ${first}` : `Sentences ${first}–${last}`;
}

function uniqueTitle(title, taken) {
  let candidate = title;
  for (let count = 2; taken.has(candidate); count += 1) candidate = `${title} (${count})`;
  taken.add(candidate);
  return candidate;
}

function indexEntry(sentences, text, level) {
  return {
    runs: splitSentenceRuns(sentences).map((run) => ({
      sentences: run,
      text,
    })),
    level,
    source_sentences: sentences,
  };
}

function citedSourceText(sentenceIds, sentenceTexts) {
  if (!Array.isArray(sentenceTexts)) return '';
  return sentenceIds
    .map((id) => (typeof sentenceTexts[id - 1] === 'string' ? sentenceTexts[id - 1].trim() : ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * Convert a saved question tree into `{topics, topic_summary_index}` as stored
 * on a record.
 *
 * @param {object|null|undefined} questionTree
 * @param {string[]|null|undefined} sentenceTexts
 * @returns {{topics: Array<{name: string, sentences: number[]}>,
 *   topic_summary_index: Record<string, {runs: Array<{sentences: number[], text: string}>,
 *   level: number, source_sentences: number[]}>}|null}
 */
export function projectQuestionTreeTopics(questionTree, sentenceTexts = []) {
  const chunks = Array.isArray(questionTree?.chunks) ? questionTree.chunks : [];
  const flat = chunks.flatMap((chunk) => (Array.isArray(chunk?.sections) ? chunk.sections : []));
  if (!flat.length) return null;

  const topics = [];
  const index = {};

  const emitSection = (section, parentParts, takenSiblingTitles) => {
    const sentences = validSentences(section?.sentences);
    if (!sentences.length) return;
    const questionTitle = uniqueTitle(
      pathTitle(section.question) || fallbackTitle(sentences),
      takenSiblingTitles,
    );
    const parts = [...parentParts, questionTitle];
    const path = joinTopicPath(parts);
    const answer = typeof section.answer === 'string' ? section.answer.trim() : '';

    topics.push({ name: path, sentences });
    index[path] = indexEntry(sentences, answer, parts.length - 1);

    const takenPointTitles = new Set();
    const points = Array.isArray(section.points) ? section.points : [];
    for (const point of points) {
      const pointSentences = validSentences(point?.sentences);
      if (!pointSentences.length) continue;
      const pointTitle = uniqueTitle(
        pathTitle(point.text) || fallbackTitle(pointSentences),
        takenPointTitles,
      );
      const pointPath = joinTopicPath([...parts, pointTitle]);
      const sourceText = citedSourceText(pointSentences, sentenceTexts);
      topics.push({ name: pointPath, sentences: pointSentences });
      index[pointPath] = indexEntry(pointSentences, sourceText, parts.length);
    }
  };

  const groups = Array.isArray(questionTree?.groups) ? questionTree.groups : [];
  const topTaken = new Set();

  if (groups.length > 0) {
    for (const group of groups) {
      const sectionIndices = Array.isArray(group?.sections) ? group.sections : [];
      const groupSections = sectionIndices.map((idx) => flat[idx]).filter(Boolean);
      if (!groupSections.length) continue;
      if (groupSections.length === 1) {
        emitSection(groupSections[0], [], topTaken);
        continue;
      }
      const groupSentences = validSentences(groupSections.flatMap((s) => s?.sentences || []));
      if (!groupSentences.length) continue;
      const groupTitle = uniqueTitle(
        pathTitle(group.question) || fallbackTitle(groupSentences),
        topTaken,
      );
      const groupPath = joinTopicPath([groupTitle]);
      const groupAnswer = typeof group.answer === 'string' ? group.answer.trim() : '';
      index[groupPath] = indexEntry(groupSentences, groupAnswer, 0);
      const childTaken = new Set();
      for (const section of groupSections) {
        emitSection(section, [groupTitle], childTaken);
      }
    }
  } else {
    for (const section of flat) {
      emitSection(section, [], topTaken);
    }
  }

  return topics.length ? { topics, topic_summary_index: index } : null;
}
