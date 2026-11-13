import { useCallback, useEffect, useRef, useState } from 'react';

/** Id prefix of chat evidence cards, distinct from saved excerpt ids. */
export const CHAT_EVIDENCE_PREFIX = 'chat-evidence:';

/** @param {{pageUrl: string, startLine: number, endLine: number}} range */
export const chatEvidenceId = (range) =>
  `${CHAT_EVIDENCE_PREFIX}${range.pageUrl}#${range.startLine}-${range.endLine}`;

/** @param {{id?: string}} item */
export const isChatEvidence = (item) =>
  typeof item?.id === 'string' && item.id.startsWith(CHAT_EVIDENCE_PREFIX);

/**
 * @typedef {object} ChatEvidence
 * @property {string} id
 * @property {string} url The cited page.
 * @property {string} title
 * @property {string} text The cited lines, joined.
 * @property {string} label
 * @property {number} startLine
 * @property {number} endLine
 * @property {boolean} [loading]
 * @property {string} [error]
 */

/**
 * The page highlight behind the project chat event the reader picked, as one
 * canvas card. ArticleChat calls `onHighlight` with `{focus: true}` only when an
 * event is picked; streamed and repainted ranges (and ranges without a page)
 * are ignored, so the canvas stays quiet until the reader asks. The card goes
 * away when it is dismissed or when ArticleChat clears its highlights (another
 * event, a new turn or chat, the panel hidden). A range with no stored
 * `excerpt` is read from its page by URL.
 *
 * @param {function(string): Promise<{sentences?: string[]}>} readPage Reads a page's text by URL.
 * @returns {{evidence: ChatEvidence[], onHighlight: function(object, {focus?: boolean}=): void,
 *   onClearHighlights: function(): void, dismiss: function(string): void}}
 */
export function useChatEvidence(readPage) {
  const [evidence, setEvidence] = useState([]);
  const generationRef = useRef(0);
  const readPageRef = useRef(readPage);
  useEffect(() => {
    readPageRef.current = readPage;
  }, [readPage]);
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  // Both callbacks are stable: ArticleChat is memoized on its props.
  const onHighlight = useCallback((range, { focus = false } = {}) => {
    if (!focus || !range?.pageUrl) return;
    generationRef.current += 1;
    const id = chatEvidenceId(range);
    const stored = Array.isArray(range.excerpt) && range.excerpt.length > 0;
    const item = {
      id,
      url: range.pageUrl,
      title: range.pageTitle || range.pageUrl,
      text: stored ? range.excerpt.join(' ') : '',
      label: range.label || '',
      startLine: range.startLine,
      endLine: range.endLine,
      ...(stored ? {} : { loading: true }),
    };
    setEvidence([item]);
    if (stored) return;
    const generation = generationRef.current;
    const update = (patch) => {
      if (generation !== generationRef.current) return;
      setEvidence((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, loading: false, ...patch } : entry)),
      );
    };
    Promise.resolve()
      .then(() => readPageRef.current(range.pageUrl))
      .then(
        (result) => {
          const lines = Array.isArray(result?.sentences)
            ? result.sentences.slice(range.startLine - 1, range.endLine)
            : [];
          update(
            lines.length
              ? { text: lines.join(' ') }
              : { error: 'These lines are no longer in the page text.' },
          );
        },
        (error) => update({ error: error?.message || 'Could not read the page.' }),
      );
  }, []);

  const onClearHighlights = useCallback(() => {
    generationRef.current += 1;
    setEvidence((current) => (current.length ? [] : current));
  }, []);

  const dismiss = useCallback((id) => {
    generationRef.current += 1;
    setEvidence((current) => current.filter((entry) => entry.id !== id));
  }, []);

  return { evidence, onHighlight, onClearHighlights, dismiss };
}
