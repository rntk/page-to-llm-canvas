import { useState } from 'react';
import { excerptNodeKey } from './excerptLinks.js';

/**
 * Positions cards in canvas coordinates; excerpts follow their page until moved.
 * @param {object} options Layout, links, viewport ref, gesture starter and foreground callback.
 */
export function useNodePositions({ layout, links, viewportRef, beginGesture, raiseNode }) {
  const [moved, setMoved] = useState({});
  const pagePosition = (tabId) => moved[tabId] || layout.pages[tabId];
  const excerptPosition = (excerptId) => {
    const key = excerptNodeKey(excerptId);
    if (moved[key]) return moved[key];
    const slot = layout.excerpts[key];
    const page = links.pageOf.get(excerptId);
    if (!page) return { x: slot.x, y: slot.y };
    const origin = pagePosition(page.id);
    return { x: origin.x + slot.dx, y: origin.y + slot.dy };
  };

  const startDrag = (key, start, event) => {
    if (event.button !== 0) return;
    const zoom = viewportRef.current.zoom;
    raiseNode(key);
    beginGesture(event, (dx, dy) =>
      setMoved((current) => ({
        ...current,
        [key]: { x: start.x + dx / zoom, y: start.y + dy / zoom },
      })),
    );
  };

  return { pagePosition, excerptPosition, startDrag };
}
