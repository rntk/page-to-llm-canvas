import { useEffect } from 'react';

/**
 * Updates the page title when a loaded view supplies one.
 * @param {string|null} title
 */
export function useDocumentTitle(title) {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}
