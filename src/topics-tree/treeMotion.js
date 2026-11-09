import { useLayoutEffect, useRef } from 'react';
import { flattenTree } from './expansion.js';
import { treeLinks } from './treeLayout.js';

// Fold/unfold motion for the topics tree. Kept light: nodes glide to their new
// place, new ones grow out of their parent, removed ones shrink back into it.

export const MOTION_MS = 180;
export const MOTION_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
/** Ghosts and the motion flag outlive the animation a little so it never gets cut. */
export const MOTION_LINGER_MS = MOTION_MS + 40;

export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Nodes (and their links) that `before` shows but `after` no longer does, each
 * with where it was and where it should retreat to: its nearest surviving ancestor.
 *
 * @param {object|null} before Visible tree before the change.
 * @param {object|null} after Visible tree after the change.
 * @param {Map<string, {left: number, top: number, w: number, h: number}>} positions Placement before the change.
 * @param {(node: object) => boolean} [isCard] Whether a node is a leaf card (link anchor).
 * @returns {Array<{node: object, from: object, to: object, link: string|null}>}
 */
export function leavingNodes(before, after, positions, isCard) {
  if (!before) return [];
  const kept = new Set(flattenTree(after).map((node) => node.key));
  const linkPaths = new Map(treeLinks(before, positions, isCard).map((link) => [link.key, link.d]));
  const leaving = [];
  const walk = (node, anchorKey) => {
    const survives = kept.has(node.key);
    if (!survives) {
      const from = positions.get(node.key);
      const to = positions.get(anchorKey);
      if (from && to) leaving.push({ node, from, to, link: linkPaths.get(node.key) ?? null });
    }
    const nextAnchor = survives ? node.key : anchorKey;
    node.children.forEach((child) => walk(child, nextAnchor));
  };
  walk(before, before.key);
  return leaving;
}

const translate = (position) => `translate(${position.left}px, ${position.top}px)`;

/**
 * Grow an element out of `origin` (normally its parent) the first time it gets
 * a position, but only while a fold/unfold is in motion. Nodes that were there
 * from the start never animate.
 *
 * @param {{current: HTMLElement|null}} elRef
 * @param {{left: number, top: number}|undefined} position
 * @param {{left: number, top: number}|undefined} origin
 * @param {{current: boolean}} motionRef
 */
export function useEnterMotion(elRef, position, origin, motionRef) {
  const placedRef = useRef(false);
  useLayoutEffect(() => {
    if (!position || placedRef.current) return;
    placedRef.current = true;
    const el = elRef.current;
    if (!motionRef.current || !origin || typeof el?.animate !== 'function') return;
    el.animate(
      [
        { opacity: 0, transform: translate(origin) },
        { opacity: 1, transform: translate(position) },
      ],
      { duration: MOTION_MS, easing: MOTION_EASING },
    );
  }, [elRef, position, origin, motionRef]);
}

/**
 * Fade a freshly mounted element in, while a fold/unfold is in motion.
 *
 * @param {{current: Element|null}} elRef
 * @param {{current: boolean}} motionRef
 */
export function useFadeInMotion(elRef, motionRef) {
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!motionRef.current || typeof el?.animate !== 'function') return;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MS, easing: MOTION_EASING });
  }, [elRef, motionRef]);
}
