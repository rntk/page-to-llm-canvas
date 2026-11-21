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
    const translate = (node, position) => {
      if (node) node.style.transform = `translate(${position.x}px, ${position.y}px)`;
    };
    const dragNode = nodes.get(String(key));
    // Resolve what stays fixed during the drag once, so each frame only interpolates.
    // Page drag: its excerpts follow by slot offset unless moved. Excerpt drag: its page stays put.
    const connectors = [];
    for (const [excerptId, page] of links.pageOf) {
      const excerptKey = excerptNodeKey(excerptId);
      const movingPage = String(page.id) === String(key);
      if (!movingPage && excerptKey !== key) continue;
      const follows = movingPage && !moved[excerptKey];
      connectors.push({
        path: paths.get(String(excerptId)),
        node: follows ? nodes.get(excerptKey) : null,
        offset: follows ? layout.excerpts[excerptKey] : null,
        fixedPage: movingPage ? null : pagePosition(page.id),
        fixedExcerpt: movingPage && !follows ? excerptPosition(excerptId) : null,
      });
    }
    let next = start;
    let didMove = false;
    const paint = () => {
      frameRef.current = null;
      translate(dragNode, next);
      for (const { path, node, offset, fixedPage, fixedExcerpt } of connectors) {
        const excerptPos = offset
          ? { x: next.x + offset.dx, y: next.y + offset.dy }
          : fixedExcerpt || next;
        if (offset) translate(node, excerptPos);
        path?.setAttribute('d', excerptConnectorPath(fixedPage || next, excerptPos));
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
        // Gesture end also fires on unmount, when the surface is gone.
        if (!surfaceRef.current) return;
        paint();
        setMoved((current) => ({ ...current, [key]: next }));
      },
    );
  };

  return { pagePosition, excerptPosition, startDrag };
}
