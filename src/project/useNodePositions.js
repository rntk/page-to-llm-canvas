import { useEffect, useRef, useState } from 'react';
import { excerptConnectorPath } from './canvasLayout.js';
import { excerptNodeKey } from './excerptLinks.js';

/**
 * Positions cards in canvas coordinates; excerpts follow their page until moved.
 * @param {object} options Layout, links, surface and viewport refs, gesture starter and foreground callback.
 */
export function useNodePositions({
  layout,
  links,
  surfaceRef,
  viewportRef,
  beginGesture,
  raiseNode,
}) {
  const [moved, setMoved] = useState({});
  const frameRef = useRef(null);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
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
    const surface = surfaceRef.current;
    const nodes = new Map(
      [...surface.querySelectorAll('[data-canvas-node-key]')].map((node) => [
        node.dataset.canvasNodeKey,
        node,
      ]),
    );
    const paths = new Map(
      [...surface.querySelectorAll('.excerpt-link')].map((path) => [path.dataset.excerptId, path]),
    );
    const affected = [...links.pageOf].filter(
      ([excerptId, page]) => String(page.id) === String(key) || excerptNodeKey(excerptId) === key,
    );
    let next = start;
    let didMove = false;
    const paint = () => {
      frameRef.current = null;
      const setPosition = (nodeKey, position) => {
        const node = nodes.get(String(nodeKey));
        if (node) node.style.transform = `translate(${position.x}px, ${position.y}px)`;
      };
      setPosition(key, next);
      for (const [excerptId, page] of affected) {
        const excerptKey = excerptNodeKey(excerptId);
        const movingPage = String(page.id) === String(key);
        const pagePos = movingPage ? next : pagePosition(page.id);
        const excerptPos =
          movingPage && !moved[excerptKey]
            ? {
                x: next.x + layout.excerpts[excerptKey].dx,
                y: next.y + layout.excerpts[excerptKey].dy,
              }
            : movingPage
              ? excerptPosition(excerptId)
              : next;
        if (movingPage && !moved[excerptKey]) setPosition(excerptKey, excerptPos);
        paths.get(String(excerptId))?.setAttribute('d', excerptConnectorPath(pagePos, excerptPos));
      }
    };
    raiseNode(key);
    beginGesture(
      event,
      (dx, dy) => {
        didMove = true;
        next = { x: start.x + dx / zoom, y: start.y + dy / zoom };
        if (frameRef.current === null) frameRef.current = requestAnimationFrame(paint);
      },
      () => {
        if (!didMove) return;
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        // The shared gesture tracker also ends active gestures during unmount.
        if (!surfaceRef.current) return;
        paint();
        setMoved((current) => ({ ...current, [key]: next }));
      },
    );
  };

  return { pagePosition, excerptPosition, startDrag };
}
