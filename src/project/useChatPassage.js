import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The passage behind the chat event the reader picked, for a canvas chat whose
 * source text the canvas does not display. ArticleChat calls `onHighlight` with
 * `{focus: true}` only when an event is selected; streamed and repainted ranges
 * are ignored. `onClearHighlights` runs before every repaint (another event,
 * Escape, a new turn or chat, closing), so the card never outlives its event.
 *
 * @param {function(): (string[]|Promise<string[]>)} getSentences The chat's
 *   one-based lines, as the model saw them.
 * @returns {{
 *   passage: null|{label: string, startLine: number, endLine: number, sentences?: string[], error?: string},
 *   onHighlight: function({startLine: number, endLine: number, label?: string}, {focus?: boolean}=): Promise<void>|undefined,
 *   onClearHighlights: function(): void,
 * }}
 */
export function useChatPassage(getSentences) {
  const [passage, setPassage] = useState(null);
  const attemptRef = useRef(0);
  const getSentencesRef = useRef(getSentences);
  useEffect(() => {
    getSentencesRef.current = getSentences;
  }, [getSentences]);
  useEffect(
    () => () => {
      attemptRef.current += 1;
    },
    [],
  );

  // Both callbacks are stable: ArticleChat is memoized on its props.
  const onHighlight = useCallback((range, { focus = false } = {}) => {
    if (!focus) return undefined;
    const attempt = ++attemptRef.current;
    const { startLine, endLine } = range;
    const label = range.label || '';
    return Promise.resolve()
      .then(() => getSentencesRef.current())
      .then(
        (sentences) => {
          if (attempt !== attemptRef.current) return;
          const lines = Array.isArray(sentences) ? sentences.slice(startLine - 1, endLine) : [];
          setPassage(
            lines.length
              ? { label, startLine, endLine, sentences: lines }
              : {
                  label,
                  startLine,
                  endLine,
                  error: 'These lines are no longer in the source text.',
                },
          );
        },
        (error) => {
          if (attempt !== attemptRef.current) return;
          setPassage({
            label,
            startLine,
            endLine,
            error: error?.message || 'Could not read the source text.',
          });
        },
      );
  }, []);

  const onClearHighlights = useCallback(() => {
    attemptRef.current += 1;
    setPassage((current) => (current ? null : current));
  }, []);

  return { passage, onHighlight, onClearHighlights };
}
