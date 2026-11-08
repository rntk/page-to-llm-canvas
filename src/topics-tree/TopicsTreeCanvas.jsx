import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import TopicLevelSwitcher from '../components/TopicLevelSwitcher.jsx';
import SourceArticle from './SourceArticle.jsx';
import { formatTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';
import {
  LEAF_KIND,
  currentLevel,
  expandBranch,
  expandToLevel,
  flattenTree,
  groupSentenceSources,
  initialExpanded,
  labelSize,
  pathTo,
  toggleNode,
  topicMaxWidth,
  treeDepth,
  visibleTree,
} from './topicsTreeModel.js';
import { boundsOf, clampCardSize, layoutTree, treeLinks } from './treeLayout.js';
import {
  MOTION_LINGER_MS,
  MOTION_MS,
  leavingNodes,
  prefersReducedMotion,
  useEnterMotion,
  useFadeInMotion,
} from './treeMotion.js';
import { useTreeViewport } from './useTreeViewport.js';

const EMPTY_MAP = new Map();
const NOOP = () => {};

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

const TreeLink = React.memo(function TreeLink({ d, isOnPath, motionRef }) {
  const elRef = useRef(null);
  useFadeInMotion(elRef, motionRef);
  return <path ref={elRef} className={isOnPath ? 'tt-link is-on-path' : 'tt-link'} d={d} />;
});

const TopicNode = React.memo(function TopicNode({
  node,
  isExpanded,
  fontSize,
  isSelected,
  isOnPath,
  position,
  origin,
  motionRef,
  registerElement,
  onToggle,
  onExpandBranch,
  summaryShown,
  onToggleSummary,
}) {
  const summaryId = useId();
  const className = [
    'tt-node',
    `tt-node--${node.kind}`,
    node.hiddenCount ? 'is-collapsed' : '',
    isSelected ? 'is-selected' : '',
    isOnPath ? 'is-on-path' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const elRef = useRef(null);
  const ref = useCallback(
    (el) => {
      elRef.current = el;
      registerElement(node.key, el);
    },
    [registerElement, node.key],
  );
  useEnterMotion(elRef, position, origin, motionRef);
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
      {node.summarySameAsParent && (
        <div className="tt-node__summary-toggle">
          <span>Same summary as parent · </span>
          <button
            type="button"
            className="tt-link-button"
            aria-expanded={summaryShown}
            aria-controls={summaryId}
            onClick={(event) => {
              event.stopPropagation();
              onToggleSummary(node.key);
            }}
          >
            {summaryShown ? 'Hide summary' : 'Show summary'}
          </button>
        </div>
      )}
      {node.summary && (
        <p
          id={summaryId}
          className="tt-node__prose"
          hidden={node.summarySameAsParent && !summaryShown}
        >
          {node.summary}
        </p>
      )}
      <div className="tt-node__meta">
        <button
          type="button"
          className="tt-node__count"
          title="Unfold this branch down to its sources"
          onClick={(event) => {
            event.stopPropagation();
            onExpandBranch(node.key);
          }}
        >
          {pluralize(node.sentences.length, 'sentence')}
        </button>
        {node.sourceCount > 0 && <span>· {pluralize(node.sourceCount, 'article')}</span>}
        {node.hiddenCount > 0 && <span>· +{node.hiddenCount} hidden</span>}
      </div>
    </div>
  );
});

const LeafCard = React.memo(function LeafCard({
  node,
  articleSentences,
  sentenceSources,
  isSelected,
  isOnPath,
  isFront,
  position,
  origin,
  size,
  motionRef,
  registerElement,
  onSelect,
  onStartDrag,
  onShowInPage,
  leafChat,
  chatOpen = false,
  onToggleChat,
}) {
  const elRef = useRef(null);
  const ref = useCallback(
    (el) => {
      elRef.current = el;
      registerElement(node.key, el);
    },
    [registerElement, node.key],
  );
  useEnterMotion(elRef, position, origin, motionRef);
  const hasChat = !!leafChat && leafChat.available(node);
  // A source card carries its topic's path, so show it whole to name that topic.
  const parentPath = formatTopicPath(splitTopicPath(node.path));
  const className = [
    'tt-card',
    size ? 'is-sized' : '',
    isSelected ? 'is-selected' : '',
    isOnPath ? 'is-on-path' : '',
    isFront || chatOpen ? 'is-front' : '',
    chatOpen ? 'is-chat-open' : '',
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
        {groupSentenceSources(node.sentences, sentenceSources).map((group) => (
          <section className="tt-source-group" key={group.id}>
            {group.source && <SourceArticle source={group.source} />}
            <ol className="tt-passages">
              {group.sentences.map(({ number, sourceNumber }) => (
                <li
                  key={number}
                  value={sourceNumber ?? undefined}
                  className={sourceNumber === null ? 'tt-passages__unknown' : undefined}
                >
                  {articleSentences[number - 1] || ''}
                </li>
              ))}
            </ol>
          </section>
        ))}
        {onShowInPage && (
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
        )}
      </div>
      <div
        className="tt-card__resize"
        title="Drag to resize"
        aria-hidden="true"
        onPointerDown={(event) => onStartDrag(event, node.key, 'resize')}
      />
      {chatOpen && hasChat && leafChat.render(node, { onClose: () => onToggleChat(node.key) })}
      {hasChat && (
        <button
          type="button"
          className="tt-card__chat-fold"
          aria-expanded={chatOpen}
          aria-label={`${chatOpen ? 'Fold' : 'Unfold'} chat for this source text`}
          title={chatOpen ? 'Fold chat' : 'Chat about this source text'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleChat(node.key);
          }}
        >
          {chatOpen ? '‹ Chat' : 'Chat ›'}
        </button>
      )}
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
 * @param {object|null} [props.sentenceSources] Source article and local line for synthetic rows.
 * @param {(node: object) => void} [props.onShowInPage]
 * @param {{available: function(object): boolean, render: function(object, {onClose: function(): void}): import('react').ReactNode}|null} [props.leafChat]
 *   Gives source cards a Chat tab that unfolds this chat beside them. Keep it
 *   referentially stable.
 * @param {HTMLElement|null} [props.controlsHost] Element the view controls render into
 *   (the page bar); no controls are shown without one.
 */
export default function TopicsTreeCanvas({
  tree,
  sentences,
  sentenceSources = null,
  onShowInPage,
  leafChat = null,
  controlsHost = null,
}) {
  const { canvasRef, stageRef, transformRef, boundsRef, translateBy, fit } = useTreeViewport();
  const [expanded, setExpanded] = useState(() => initialExpanded(tree));
  const [shownSummaries, setShownSummaries] = useState(() => new Set());
  const [openChats, setOpenChats] = useState(() => new Set());
  const [selectedKey, setSelectedKey] = useState(tree.key);
  const [frontKey, setFrontKey] = useState(null);
  const [exclusive, setExclusive] = useState(false);
  const [offsets, setOffsets] = useState(() => new Map());
  const [cardSizes, setCardSizes] = useState(() => new Map());
  const [sizes, setSizes] = useState(() => new Map());
  const [measureTick, setMeasureTick] = useState(0);
  // Live card move/resize: the layout is frozen while the pointer is down.
  const [drag, setDrag] = useState(null);
  // Nodes that just folded away, kept on screen while they shrink into their parent.
  const [leaving, setLeaving] = useState([]);

  const elementsRef = useRef(new Map());
  const pendingAnchorRef = useRef(null);
  const pendingFitRef = useRef(true);
  const dragCleanupRef = useRef(null);
  // True while a fold/unfold animates: only then do new nodes and links animate in.
  const motionRef = useRef(false);
  const motionTimerRef = useRef(null);

  const visible = useMemo(() => visibleTree(tree, expanded), [tree, expanded]);
  const nodes = useMemo(() => flattenTree(visible), [visible]);
  const parentKeys = useMemo(() => {
    const parents = new Map();
    nodes.forEach((node) => node.children.forEach((child) => parents.set(child.key, node.key)));
    return parents;
  }, [nodes]);
  const positions = useMemo(
    () => layoutTree(visible, sizes, { offsets }),
    [visible, sizes, offsets],
  );
  const displayPositions = useMemo(() => {
    if (drag) return new Map(drag.frozen).set(drag.key, drag.pos);
    return positions || EMPTY_MAP;
  }, [drag, positions]);
  useLayoutEffect(() => {
    boundsRef.current = boundsOf(displayPositions.values());
  }, [boundsRef, displayPositions]);
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
  const latestRef = useRef({ positions, offsets, displayPositions, expanded, visible });
  useLayoutEffect(() => {
    latestRef.current = { positions, offsets, displayPositions, expanded, visible };
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
  }, [
    drag,
    sizes,
    positions,
    visible,
    cardSizes,
    shownSummaries,
    measureTick,
    fit,
    translateBy,
    transformRef,
  ]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      clearTimeout(motionTimerRef.current);
    },
    [],
  );

  // Switch to a new fold state, animating the change unless the user prefers
  // reduced motion. Layout transitions are keyed off `data-motion` on the canvas
  // (CSS); entering nodes read `motionRef`; leaving ones are kept as ghosts.
  const changeExpanded = useCallback(
    (update) => {
      const { expanded: prev, visible: before, displayPositions: placed } = latestRef.current;
      const next = update(prev);
      clearTimeout(motionTimerRef.current);
      const canvas = canvasRef.current;
      if (prefersReducedMotion() || !canvas) {
        motionRef.current = false;
        delete canvas?.dataset.motion;
        setLeaving([]);
      } else {
        motionRef.current = true;
        canvas.dataset.motion = 'on';
        setLeaving(
          leavingNodes(before, visibleTree(tree, next), placed, (node) => node.kind === LEAF_KIND),
        );
        motionTimerRef.current = setTimeout(() => {
          motionRef.current = false;
          delete canvas.dataset.motion;
          setLeaving((current) => (current.length ? [] : current));
        }, MOTION_LINGER_MS);
      }
      setExpanded(next);
    },
    [canvasRef, tree],
  );

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
      changeExpanded((prev) => toggleNode(tree, prev, key, exclusive));
    },
    [anchorOn, changeExpanded, tree, exclusive],
  );

  const handleExpandBranch = useCallback(
    (key) => {
      anchorOn(key);
      setSelectedKey(key);
      changeExpanded((prev) => expandBranch(tree, prev, key));
    },
    [anchorOn, changeExpanded, tree],
  );

  const handleToggleSummary = useCallback(
    (key) => {
      anchorOn(key);
      setShownSummaries((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [anchorOn],
  );

  const handleToggleChat = useCallback((key) => {
    setOpenChats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setFrontKey(key);
  }, []);

  const handleSelectCard = useCallback((key) => {
    setSelectedKey(key);
    setFrontKey(key);
  }, []);

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
    changeExpanded(() => expandToLevel(tree, topicLevel + TOPIC_LEVEL_OFFSET));
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
      <div
        ref={canvasRef}
        className={`tt-canvas${drag ? ' is-dragging' : ''}`}
        style={{ '--tt-motion': `${MOTION_MS}ms` }}
      >
        <div ref={stageRef} className="tt-stage">
          <svg className="tt-links" aria-hidden="true">
            {links.map((link) => (
              <TreeLink
                key={link.key}
                d={link.d}
                isOnPath={onPath.has(link.key)}
                motionRef={motionRef}
              />
            ))}
            {leaving.map(({ node, link }) =>
              link ? (
                <path key={`leaving:${node.key}`} className="tt-link is-leaving" d={link} />
              ) : null,
            )}
          </svg>
          <div className="tt-nodes">
            {nodes.map((node) =>
              node.kind === LEAF_KIND ? (
                <LeafCard
                  key={node.key}
                  node={node}
                  articleSentences={sentences}
                  sentenceSources={sentenceSources}
                  isSelected={node.key === selectedKey}
                  isOnPath={onPath.has(node.key)}
                  isFront={node.key === frontKey}
                  position={displayPositions.get(node.key)}
                  origin={displayPositions.get(parentKeys.get(node.key))}
                  motionRef={motionRef}
                  size={
                    drag?.key === node.key && drag.mode === 'resize'
                      ? drag.pos
                      : cardSizes.get(node.key)
                  }
                  registerElement={registerElement}
                  onSelect={handleSelectCard}
                  onStartDrag={handleStartDrag}
                  onShowInPage={onShowInPage}
                  leafChat={leafChat}
                  chatOpen={openChats.has(node.key)}
                  onToggleChat={handleToggleChat}
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
                  origin={displayPositions.get(parentKeys.get(node.key))}
                  motionRef={motionRef}
                  registerElement={registerElement}
                  onToggle={handleToggle}
                  onExpandBranch={handleExpandBranch}
                  summaryShown={shownSummaries.has(node.key)}
                  onToggleSummary={handleToggleSummary}
                />
              ),
            )}
            {leaving.map(({ node, from, to }) => (
              <div
                key={`leaving:${node.key}`}
                className="tt-leaving"
                aria-hidden="true"
                inert
                style={{
                  '--tt-dx': `${to.left - from.left}px`,
                  '--tt-dy': `${to.top - from.top}px`,
                }}
              >
                {node.kind === LEAF_KIND ? (
                  <LeafCard
                    node={node}
                    articleSentences={sentences}
                    sentenceSources={sentenceSources}
                    isSelected={false}
                    isOnPath={false}
                    isFront={false}
                    position={from}
                    size={cardSizes.get(node.key)}
                    motionRef={motionRef}
                    registerElement={NOOP}
                    onSelect={NOOP}
                    onStartDrag={NOOP}
                  />
                ) : (
                  <TopicNode
                    node={node}
                    isExpanded={false}
                    fontSize={labelSize(node, totalSentences)}
                    isSelected={false}
                    isOnPath={false}
                    position={from}
                    motionRef={motionRef}
                    registerElement={NOOP}
                    onToggle={NOOP}
                    onExpandBranch={NOOP}
                    summaryShown={shownSummaries.has(node.key)}
                    onToggleSummary={NOOP}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
        <p className="tt-hint tt-muted">
          Drag or use arrow keys to pan · Page Up/Down to move by a page · Home/End to reach the
          ends · wheel to zoom (Ctrl+wheel over a card) · click a topic to unfold it · drag a card
          header to move it, its corner to resize
        </p>
      </div>
    </div>
  );
}
