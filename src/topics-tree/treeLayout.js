// Topics tree canvas geometry. Pure: measured node sizes come from the DOM.

export const CARD_MIN = { w: 240, h: 120 };

/** Default gaps (stage px) between depth columns, siblings and cousins. */
export const LAYOUT_GAPS = Object.freeze({ column: 64, sibling: 12, branch: 44 });

/** Link target height on a leaf card: its header, not its (possibly tall) middle. */
const CARD_ANCHOR_Y = 20;

/**
 * Left edge of every depth column so no column overlaps the widest node before it.
 * @param {number[]} widths Widest node per depth.
 * @param {number} gap Space between columns.
 */
export function columnOffsets(widths, gap) {
  const offsets = [0];
  for (let depth = 1; depth < widths.length; depth += 1) {
    offsets[depth] = offsets[depth - 1] + (widths[depth - 1] || 0) + gap;
  }
  return offsets;
}

/**
 * Lay out one subtree around its own centre (y = 0). The contour holds the
 * subtree's vertical extent per relative depth, so the next sibling can be
 * pushed down just far enough to clear every column the two share.
 * @param {object} node Visible display node.
 * @param {(node: object) => {w: number, h: number}} sizeOf Measured size lookup.
 * @param {{sibling: number, branch: number}} gaps Vertical gaps.
 */
function layoutSubtree(node, sizeOf, gaps) {
  const { h } = sizeOf(node);
  const own = { top: -h / 2, bottom: h / 2 };
  if (!node.children.length) return { node, contour: [own], children: [] };

  const placed = node.children.map((child) => layoutSubtree(child, sizeOf, gaps));
  const merged = [];
  const offsets = placed.map((sub, index) => {
    let shift = 0;
    if (index > 0) {
      shift = -Infinity;
      const shared = Math.min(merged.length, sub.contour.length);
      for (let depth = 0; depth < shared; depth += 1) {
        const gap = depth === 0 ? gaps.sibling : gaps.branch;
        shift = Math.max(shift, merged[depth].bottom - sub.contour[depth].top + gap);
      }
    }
    sub.contour.forEach((extent, depth) => {
      const top = extent.top + shift;
      const bottom = extent.bottom + shift;
      merged[depth] = merged[depth]
        ? { top: Math.min(merged[depth].top, top), bottom: Math.max(merged[depth].bottom, bottom) }
        : { top, bottom };
    });
    return shift;
  });

  // Centre the parent on its first and last child.
  const centre = (offsets[0] + offsets.at(-1)) / 2;
  return {
    node,
    contour: [
      own,
      ...merged.map(({ top, bottom }) => ({ top: top - centre, bottom: bottom - centre })),
    ],
    children: placed.map((sub, index) => ({ ...sub, offset: offsets[index] - centre })),
  };
}

/**
 * Place every node of a visible tree.
 *
 * @param {object|null} tree Visible display tree (children only for expanded nodes).
 * @param {Map<string, {w: number, h: number}>} sizes Measured size per node key.
 * @param {object} [options]
 * @param {{column: number, sibling: number, branch: number}} [options.gaps]
 * @param {Map<string, {dx: number, dy: number}>} [options.offsets] Manual card moves.
 * @returns {Map<string, {left: number, top: number, w: number, h: number}>|null}
 *   null while any node is still unmeasured.
 */
export function layoutTree(tree, sizes, { gaps = LAYOUT_GAPS, offsets = new Map() } = {}) {
  if (!tree) return new Map();
  const widths = [];
  let complete = true;
  const scan = (node, depth) => {
    const size = sizes.get(node.key);
    if (!size) {
      complete = false;
      return;
    }
    widths[depth] = Math.max(widths[depth] || 0, size.w);
    node.children.forEach((child) => scan(child, depth + 1));
  };
  scan(tree, 0);
  if (!complete) return null;

  const columns = columnOffsets(widths, gaps.column);
  const sizeOf = (node) => sizes.get(node.key);
  const positions = new Map();
  const place = (sub, depth, y) => {
    const { w, h } = sizeOf(sub.node);
    const shift = offsets.get(sub.node.key) || { dx: 0, dy: 0 };
    positions.set(sub.node.key, {
      left: columns[depth] + shift.dx,
      top: y - h / 2 + shift.dy,
      w,
      h,
    });
    sub.children.forEach((child) => place(child, depth + 1, y + child.offset));
  };
  place(layoutSubtree(tree, sizeOf, gaps), 0, 0);
  return positions;
}

/**
 * SVG path data for every parent → child edge of the visible tree, as
 * horizontal cubic links from the parent's right edge to the child's left edge.
 *
 * @param {object|null} tree Visible display tree.
 * @param {Map<string, {left: number, top: number, w: number, h: number}>} positions Placed nodes.
 * @param {(node: object) => boolean} [isCard] Whether a child is a leaf card.
 * @returns {Array<{key: string, d: string}>} keyed by the child node.
 */
export function treeLinks(tree, positions, isCard = () => false) {
  const links = [];
  const walk = (node) => {
    const from = positions.get(node.key);
    node.children.forEach((child) => {
      const to = positions.get(child.key);
      if (from && to) {
        const x0 = from.left + from.w + 4;
        const y0 = from.top + from.h / 2;
        const x1 = to.left - 4;
        const y1 = isCard(child) ? to.top + Math.min(CARD_ANCHOR_Y, to.h / 2) : to.top + to.h / 2;
        const mx = (x0 + x1) / 2;
        links.push({ key: child.key, d: `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}` });
      }
      walk(child);
    });
  };
  if (tree) walk(tree);
  return links;
}

/**
 * Keep a user-resized card readable.
 * @param {number} width Requested width.
 * @param {number} height Requested height.
 */
export function clampCardSize(width, height) {
  return {
    w: Math.max(CARD_MIN.w, Math.round(width)),
    h: Math.max(CARD_MIN.h, Math.round(height)),
  };
}

/** @param {Iterable<{left: number, top: number, w: number, h: number}>} rects */
export function boundsOf(rects) {
  const list = Array.from(rects || []);
  if (!list.length) return null;
  const minX = Math.min(...list.map((r) => r.left));
  const minY = Math.min(...list.map((r) => r.top));
  const maxX = Math.max(...list.map((r) => r.left + r.w));
  const maxY = Math.max(...list.map((r) => r.top + r.h));
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Transform that fits `bounds` into the viewport (never enlarging past 1:1),
 * centred on the axis that fits and left/top aligned on the one that does not.
 *
 * @param {{minX: number, minY: number, width: number, height: number}|null} bounds Content bounds.
 * @param {{width: number, height: number}} viewport Canvas size.
 * @param {number} [pad] Margin kept around the content.
 * @param {number} [minScale] Smallest scale a fit may choose.
 * @returns {{k: number, x: number, y: number}}
 */
export function fitTransform(bounds, viewport, pad = 24, minScale = 0.15) {
  if (!bounds) return { k: 1, x: pad, y: viewport.height / 2 };
  const k = Math.max(
    minScale,
    Math.min(
      1,
      (viewport.width - 2 * pad) / Math.max(1, bounds.width),
      (viewport.height - 2 * pad) / Math.max(1, bounds.height),
    ),
  );
  const place = (size, start, extent) =>
    size * k <= extent - 2 * pad ? (extent - size * k) / 2 - start * k : pad - start * k;
  return {
    k,
    x: place(bounds.width, bounds.minX, viewport.width),
    y: place(bounds.height, bounds.minY, viewport.height),
  };
}
