import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import TopicLevelSwitcher from '../components/TopicLevelSwitcher.jsx';
import { formatTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';
import {
  LEAF_KIND,
  currentLevel,
  expandBranch,
  expandToLevel,
  flattenTree,
  initialExpanded,
  labelSize,
  pathTo,
  toggleNode,
  topicMaxWidth,
  treeDepth,
  visibleTree,
} from './topicsTreeModel.js';
import { boundsOf, clampCardSize, layoutTree, treeLinks } from './treeLayout.js';
import { useTreeViewport } from './useTreeViewport.js';

const EMPTY_MAP = new Map();

// The root is tree level 1 and top-level topics are level 2, so topic level L
// (as shown by the level switcher) is tree level L + 2.
const TOPIC_LEVEL_OFFSET = 2;

function sameSizes(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, size] of a) {
    const other = b.get(key);
    if (!other || other.w !== size.w || other.h !== size.h) return false;
  }
  return true;
}

function placementStyle(position) {
  return position
    ? { transform: `translate(${position.left}px, ${position.top}px)` }
    : { visibility: 'hidden' };
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const TopicNode = React.memo(function TopicNode({
  node,
  isExpanded,
  fontSize,
  isSelected,
  isOnPath,
  position,
  registerElement,
  onToggle,
  onExpandBranch,
}) {
  const className = [
    'tt-node',
    `tt-node--${node.kind}`,
    node.hiddenCount ? 'is-collapsed' : '',
    isSelected ? 'is-selected' : '',
    isOnPath ? 'is-on-path' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const ref = useCallback((el) => registerElement(node.key, el), [registerElement, node.key]);
  return (
    <div
      ref={ref}
      className={className}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      style={{
        ...placementStyle(position),
        '--tt-font': `${fontSize}px`,
        maxWidth: `${topicMaxWidth(fontSize)}px`,
      }}
      onClick={() => onToggle(node.key)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onToggle(node.key);
      }}
    >
      <div className="tt-node__title">{node.title}</div>
      {node.summary && <p className="tt-node__prose">{node.summary}</p>}
      <div className="tt-node__meta">
        <button
          type="button"
          className="tt-node__count"
          title="Unfold this branch down to its leaf topics"
          onClick={(event) => {
            event.stopPropagation();
            onExpandBranch(node.key);
          }}
        >
          {pluralize(node.sentences.length, 'sentence')}
        </button>
        {node.hiddenCount > 0 && <span>· +{node.hiddenCount} hidden</span>}
      </div>
    </div>
  );
});

const LeafCard = React.memo(function LeafCard({
  node,
  articleSentences,
  isSelected,
  isOnPath,
  isFront,
  position,
  size,
  registerElement,
  onSelect,
  onStartDrag,
  onContentResize,
  onShowInPage,
}) {
  const [showSources, setShowSources] = useState(false);
  const ref = useCallback((el) => registerElement(node.key, el), [registerElement, node.key]);
  const parentPath = formatTopicPath(splitTopicPath(node.path).slice(0, -1));
  const className = [
    'tt-card',
    size ? 'is-sized' : '',
    isSelected ? 'is-selected' : '',
    isOnPath ? 'is-on-path' : '',
    isFront ? 'is-front' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article
      ref={ref}
      className={className}
      style={{
        ...placementStyle(position),
        ...(size ? { width: `${size.w}px`, height: `${size.h}px` } : {}),
      }}
      onClick={() => onSelect(node.key)}
    >
      <header
        className="tt-card__head"
        title="Drag to move"
        onPointerDown={(event) => onStartDrag(event, node.key, 'move')}
      >
        <div className="tt-card__title">{node.title}</div>
        {parentPath && <div className="tt-muted">{parentPath}</div>}
      </header>
      <div className="tt-card__body">
        {node.summary ? (
          <p className="tt-card__summary">{node.summary}</p>
        ) : (
          <p className="tt-muted">No summary for this topic.</p>
        )}
        {node.sentences.length > 0 && (
          <details
            className="tt-card__more"
            onToggle={(event) => {
              setShowSources(event.currentTarget.open);
              onContentResize(node.key);
            }}
          >
            <summary>Source sentences ({node.sentences.length})</summary>
            {showSources && (
              <ol className="tt-passages">
                {node.sentences.map((number) => (
                  <li key={number} value={number}>
                    {articleSentences[number - 1] || ''}
                  </li>
                ))}
              </ol>
            )}
          </details>
        )}
        <p className="tt-card__links">
          <button
            type="button"
            className="tt-link-button"
            onClick={(event) => {
              event.stopPropagation();
              onShowInPage(node);
            }}
          >
            Show in page
          </button>
        </p>
      </div>
      <div
        className="tt-card__resize"
        title="Drag to resize"
        aria-hidden="true"
        onPointerDown={(event) => onStartDrag(event, node.key, 'resize')}
      />
    </article>
  );
});

/**
 * Progressive-disclosure topics tree: topic nodes and leaf-topic cards in an
 * HTML layer over an SVG link layer, both inside one pan/zoom stage. Node sizes
 * are measured from the DOM, so the layout follows the real rendered text.
 *
 * Remount (via `key`) to start over with a different tree.
 *
 * @param {object} props
 * @param {object} props.tree Display tree from `buildTopicsDisplayTree`.
 * @param {string[]} props.sentences Article sentences (1-based numbers index into it).
 * @param {(node: object) => void} props.onShowInPage
 * @param {HTMLElement|null} [props.controlsHost] Element the view controls render into
 *   (the page bar); no controls are shown without one.
 */
export default function TopicsTreeCanvas({ tree, sentences, onShowInPage, controlsHost = null }) {
  const { canvasRef, stageRef, transformRef, translateBy, fit } = useTreeViewport();
  const [expanded, setExpanded] = useState(() => initialExpanded(tree));
  const [selectedKey, setSelectedKey] = useState(tree.key);
  const [frontKey, setFrontKey] = useState(null);
  const [exclusive, setExclusive] = useState(false);
  const [offsets, setOffsets] = useState(() => new Map());
  const [cardSizes, setCardSizes] = useState(() => new Map());
  const [sizes, setSizes] = useState(() => new Map());
  const [measureTick, setMeasureTick] = useState(0);
  // Live card move/resize: the layout is frozen while the pointer is down.
  const [drag, setDrag] = useState(null);

  const elementsRef = useRef(new Map());
  const pendingAnchorRef = useRef(null);
  const pendingFitRef = useRef(true);
  const dragCleanupRef = useRef(null);

  const visible = useMemo(() => visibleTree(tree, expanded), [tree, expanded]);
  const nodes = useMemo(() => flattenTree(visible), [visible]);
  const positions = useMemo(
    () => layoutTree(visible, sizes, { offsets }),
    [visible, sizes, offsets],
  );
  const displayPositions = useMemo(() => {
    if (drag) return new Map(drag.frozen).set(drag.key, drag.pos);
    return positions || EMPTY_MAP;
  }, [drag, positions]);
  const onPath = useMemo(
    () => new Set(pathTo(tree, selectedKey).map((node) => node.key)),
    [tree, selectedKey],
  );
  const links = useMemo(
    () => treeLinks(visible, displayPositions, (node) => node.kind === LEAF_KIND),
    [visible, displayPositions],
  );
  const maxTopicLevel = Math.max(0, treeDepth(tree) - TOPIC_LEVEL_OFFSET);
  const level = currentLevel(tree, expanded);
  const selectedTopicLevel = level === null ? null : level - TOPIC_LEVEL_OFFSET;
  const totalSentences = tree.sentences.length;

  const registerElement = useCallback((key, el) => {
    if (el) elementsRef.current.set(key, el);
    else elementsRef.current.delete(key);
  }, []);

  // Handlers read the latest layout through a ref so they stay stable for the
  // memoized nodes.
  const latestRef = useRef({ positions, offsets, displayPositions });
  useLayoutEffect(() => {
    latestRef.current = { positions, offsets, displayPositions };
  });

  // After a change that can resize nodes: re-measure, and only once the sizes
  // are settled keep the anchored node still on screen (or fit the view when
  // asked to). Measuring first matters: e.g. a finished resize must relayout
  // before it is anchored.
  useLayoutEffect(() => {
    if (drag) return;
    const next = new Map();
    elementsRef.current.forEach((el, key) => {
      next.set(key, { w: el.offsetWidth, h: el.offsetHeight });
    });
    if (!sameSizes(next, sizes)) {
      // Measure-then-layout needs a second pass before paint by design.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSizes(next);
      return;
    }
    if (!positions) return;
    if (pendingFitRef.current) {
      pendingFitRef.current = false;
      pendingAnchorRef.current = null;
      fit(boundsOf(positions.values()));
      return;
    }
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    pendingAnchorRef.current = null;
    const after = positions.get(anchor.key);
    if (!after) return;
    const { k } = transformRef.current;
    translateBy((anchor.before.left - after.left) * k, (anchor.before.top - after.top) * k);
  }, [drag, sizes, positions, visible, cardSizes, measureTick, fit, translateBy, transformRef]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const anchorOn = useCallback((key) => {
    const before = latestRef.current.displayPositions.get(key);
    pendingAnchorRef.current = before ? { key, before } : null;
  }, []);

  // Commit once more so the effect above re-measures and applies pending work.
  const remeasure = useCallback(() => setMeasureTick((tick) => tick + 1), []);

  const requestFit = useCallback(() => {
    pendingFitRef.current = true;
    remeasure();
  }, [remeasure]);

  const handleToggle = useCallback(
    (key) => {
      anchorOn(key);
      setSelectedKey(key);
      setExpanded((prev) => toggleNode(tree, prev, key, exclusive));
    },
    [anchorOn, tree, exclusive],
  );

  const handleExpandBranch = useCallback(
    (key) => {
      anchorOn(key);
      setSelectedKey(key);
      setExpanded((prev) => expandBranch(tree, prev, key));
    },
    [anchorOn, tree],
  );

  const handleSelectCard = useCallback((key) => {
    setSelectedKey(key);
    setFrontKey(key);
  }, []);

  const handleContentResize = useCallback(
    (key) => {
      anchorOn(key);
      remeasure();
    },
    [anchorOn, remeasure],
  );

  const handleStartDrag = useCallback(
    (event, key, mode) => {
      const { positions: layout, offsets: moved } = latestRef.current;
      if (event.button !== 0 || !layout) return;
      const start = layout.get(key);
      if (!start) return;
      event.preventDefault();
      event.stopPropagation();
      handleSelectCard(key);
      const origin = { x: event.clientX, y: event.clientY };
      const shift = moved.get(key) || { dx: 0, dy: 0 };
      let latest = { ...start };
      setDrag({ key, mode, pos: latest, frozen: layout });

      const onMove = (moveEvent) => {
        const k = transformRef.current.k || 1;
        const dx = (moveEvent.clientX - origin.x) / k;
        const dy = (moveEvent.clientY - origin.y) / k;
        latest =
          mode === 'move'
            ? { ...start, left: start.left + dx, top: start.top + dy }
            : { ...start, ...clampCardSize(start.w + dx, start.h + dy) };
        setDrag((current) => (current ? { ...current, pos: latest } : current));
      };
      const onUp = () => {
        dragCleanupRef.current?.();
        if (mode === 'move') {
          setOffsets((prev) =>
            new Map(prev).set(key, {
              dx: shift.dx + latest.left - start.left,
              dy: shift.dy + latest.top - start.top,
            }),
          );
        } else {
          pendingAnchorRef.current = { key, before: latest };
          setCardSizes((prev) => new Map(prev).set(key, { w: latest.w, h: latest.h }));
        }
        setDrag(null);
      };
      dragCleanupRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        dragCleanupRef.current = null;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [handleSelectCard, transformRef],
  );

  const handleSelectLevel = (topicLevel) => {
    setExpanded(expandToLevel(tree, topicLevel + TOPIC_LEVEL_OFFSET));
    setSelectedKey(tree.key);
    requestFit();
  };

  return (
    <div className="tt-view">
      {controlsHost &&
        createPortal(
          <div className="tt-controls" role="toolbar" aria-label="Topics tree controls">
            <label className="tt-check">
              <input
                type="checkbox"
                checked={exclusive}
                onChange={(event) => setExclusive(event.target.checked)}
              />
              One branch at a time
            </label>
            {maxTopicLevel > 0 && (
              <TopicLevelSwitcher
                className="th-page__level-switcher"
                label="Levels:"
                selectedLevel={selectedTopicLevel}
                maxLevel={maxTopicLevel}
                onChange={handleSelectLevel}
              />
            )}
            <button
              type="button"
              className="tt-btn"
              onClick={() => fit(boundsOf(displayPositions.values()))}
            >
              Fit
            </button>
          </div>,
          controlsHost,
        )}
      <div ref={canvasRef} className={`tt-canvas${drag ? ' is-dragging' : ''}`}>
        <div ref={stageRef} className="tt-stage">
          <svg className="tt-links" aria-hidden="true">
            {links.map((link) => (
              <path
                key={link.key}
                className={onPath.has(link.key) ? 'tt-link is-on-path' : 'tt-link'}
                d={link.d}
              />
            ))}
          </svg>
          <div className="tt-nodes">
            {nodes.map((node) =>
              node.kind === LEAF_KIND ? (
                <LeafCard
                  key={node.key}
                  node={node}
                  articleSentences={sentences}
                  isSelected={node.key === selectedKey}
                  isOnPath={onPath.has(node.key)}
                  isFront={node.key === frontKey}
                  position={displayPositions.get(node.key)}
                  size={
                    drag?.key === node.key && drag.mode === 'resize'
                      ? drag.pos
                      : cardSizes.get(node.key)
                  }
                  registerElement={registerElement}
                  onSelect={handleSelectCard}
                  onStartDrag={handleStartDrag}
                  onContentResize={handleContentResize}
                  onShowInPage={onShowInPage}
                />
              ) : (
                <TopicNode
                  key={node.key}
                  node={node}
                  isExpanded={expanded.has(node.key)}
                  fontSize={labelSize(node, totalSentences)}
                  isSelected={node.key === selectedKey}
                  isOnPath={onPath.has(node.key)}
                  position={displayPositions.get(node.key)}
                  registerElement={registerElement}
                  onToggle={handleToggle}
                  onExpandBranch={handleExpandBranch}
                />
              ),
            )}
          </div>
        </div>
        <p className="tt-hint tt-muted">
          Drag to pan · wheel to zoom (Ctrl+wheel over a card) · click a topic to unfold it · drag a
          card header to move it, its corner to resize
        </p>
      </div>
    </div>
  );
}
