// Parsing and repair of question-tree model responses.

import { extractObject } from './summaryTreeAnswers.js';
import { sortedUnique } from '../../shared/runtime/sortedUnique.js';

const MAX_QUESTION_CHARS = 200;
const MAX_ANSWER_CHARS = 400;
const MAX_POINT_CHARS = 200;
const MAX_POINTS_PER_SECTION = 6;

/**
 * Sanitize a model-supplied string for topic paths and summaries.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function cleanAnswerText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim().slice(0, max);
}

function parseIntLike(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/u.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function expandCitations(from, sectionIds) {
  if (!Array.isArray(from) || !sectionIds.length) return [];
  const allowed = new Set(sectionIds);
  const cited = [];
  for (const entry of from) {
    if (typeof entry === 'number') {
      if (Number.isInteger(entry) && allowed.has(entry)) cited.push(entry);
      continue;
    }
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    const single = /^(\d+)$/u.exec(trimmed);
    if (single) {
      const id = Number(single[1]);
      if (allowed.has(id)) cited.push(id);
      continue;
    }
    const range = /^(\d+)\s*[-–]\s*(\d+)$/u.exec(trimmed);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start <= end) {
        for (const id of sectionIds) {
          if (id >= start && id <= end) cited.push(id);
        }
      }
    }
  }
  return sortedUnique(cited);
}

/**
 * Parse question sections from a model response and repair coverage over `ids`.
 * @param {unknown} raw Model response.
 * @param {number[]} ids Sorted one-based sentence numbers belonging to the chunk.
 * @returns {Array<{
 *   question: string,
 *   answer: string,
 *   sentences: number[],
 *   points: Array<{text: string, sentences: number[]}>
 * }>|null}
 */
export function parseQuestionSections(raw, ids) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const obj = extractObject(raw);
  if (!Array.isArray(obj?.sections) || !obj.sections.length) return null;

  const firstId = ids[0];
  const lastId = ids.at(-1);
  const candidates = [];

  for (const section of obj.sections) {
    if (!section || typeof section !== 'object') continue;
    const question = cleanText(section.question, MAX_QUESTION_CHARS);
    const answer = cleanAnswerText(section.answer, MAX_ANSWER_CHARS);
    const rawStart = parseIntLike(section.start);
    if (!question || !answer || rawStart === null) continue;
    const start = Math.min(lastId, Math.max(firstId, rawStart));
    candidates.push({
      question,
      answer,
      start,
      rawPoints: Array.isArray(section.points) ? section.points : [],
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => a.start - b.start);
  const deduped = [];
  const seenStarts = new Set();
  for (const item of candidates) {
    if (seenStarts.has(item.start)) continue;
    seenStarts.add(item.start);
    deduped.push(item);
  }
  deduped[0].start = firstId;

  const sections = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const start = deduped[i].start;
    const nextStart = i + 1 < deduped.length ? deduped[i + 1].start : Infinity;
    const sectionIds = ids.filter((id) => id >= start && id < nextStart);
    if (!sectionIds.length) continue;

    const points = [];
    for (const point of deduped[i].rawPoints) {
      if (points.length >= MAX_POINTS_PER_SECTION) break;
      if (!point || typeof point !== 'object') continue;
      const text = cleanText(point.text, MAX_POINT_CHARS);
      if (!text) continue;
      const sentences = expandCitations(point.from, sectionIds);
      if (!sentences.length) continue;
      points.push({ text, sentences });
    }

    sections.push({
      question: deduped[i].question,
      answer: deduped[i].answer,
      sentences: sectionIds,
      points,
    });
  }

  return sections.length ? sections : null;
}

/**
 * Parse consecutive question groups covering `[0..count-1]` in order.
 * @param {unknown} raw Model response.
 * @param {number} count Total number of flat sections.
 * @returns {Array<{question: string, answer: string, sections: number[]}>|null}
 */
export function parseQuestionGroups(raw, count) {
  if (!Number.isInteger(count) || count < 2) return null;
  const obj = extractObject(raw);
  const rawGroups = obj?.groups;
  if (!Array.isArray(rawGroups) || rawGroups.length < 2 || rawGroups.length > 9) return null;

  const groups = [];
  const flattened = [];

  for (const group of rawGroups) {
    if (!group || typeof group !== 'object') return null;
    const question = cleanText(group.question, MAX_QUESTION_CHARS);
    const answer = cleanAnswerText(group.answer, MAX_ANSWER_CHARS);
    if (!question || !answer || !Array.isArray(group.items) || !group.items.length) return null;

    const indices = [];
    for (const item of group.items) {
      if (typeof item !== 'string') return null;
      const match = /^Q(\d+)$/iu.exec(item.trim());
      if (!match) return null;
      const index = Number(match[1]) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= count) return null;
      indices.push(index);
      flattened.push(index);
    }

    groups.push({ question, answer, sections: indices });
  }

  if (flattened.length !== count) return null;
  for (let i = 0; i < count; i += 1) {
    if (flattened[i] !== i) return null;
  }

  return groups;
}
