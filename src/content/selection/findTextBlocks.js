import {
  getComputedStyleSafe,
  propertyValue,
  renderedSubtreeIsHidden,
} from '../../shared/dom/renderedText.js';

const DEFAULTS = Object.freeze({
  descend: 0.75,
  splitLimit: 3,
  tiny: 0.05,
  maxCut: 0.2,
  minMass: 800,
  maxLinkRatio: 0.5,
  batchSize: 400,
  maxNodes: 50_000,
  maxTimeMs: 1_500,
});

const NOISE_SELECTOR = [
  'nav',
  'aside',
  'header',
  'footer',
  'form',
  '[role="navigation"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="banner"]',
  '[aria-hidden="true"]',
].join(',');

const OWNED_SURFACE_IDS = new Set([
  'pagetollm-selection-toolbar',
  'pagetollm-in-page-rail',
  'pagetollm-canvas-iframe',
]);

const SUBSTANTIVE_CONTAINER_TAGS = new Set(['ARTICLE', 'DIV', 'MAIN', 'SECTION']);

function emptyMetric() {
  return { mass: 0, linkMass: 0 };
}

function normalizedLength(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function abortStatus(signal) {
  return signal?.aborted ? { status: 'cancelled', blocks: [], trace: { reason: 'aborted' } } : null;
}

function nextTask(contentWindow) {
  return new Promise((resolve) => {
    const schedule = contentWindow?.setTimeout?.bind(contentWindow) || globalThis.setTimeout;
    schedule(resolve, 0);
  });
}

/**
 * Measure rendered text once, bottom-up. Exported to keep measurement tests
 * independent from the detector's descent policy.
 * @param {Document} document Live document to scan.
 * @param {object} [options] Detector limits, selection, and abort signal.
 * @returns {Promise<object>} Per-element metrics and scan state.
 */
export async function measureTextMass(document, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const body = document?.body;
  const signal = options.signal;
  const selected = new Set(
    (options.selected || []).filter((element) => element?.ownerDocument === document),
  );
  const metrics = new Map();
  const styleCache = new Map();
  const started = globalThis.performance?.now?.() ?? Date.now();
  let visited = 0;
  let work = 0;
  let nextYield = config.batchSize;
  let skippedSelected = false;
  if (!body) return { status: 'complete', metrics, visited, skippedSelected };

  let ancestorSuppressed = false;
  let ancestor = body.parentElement;
  while (ancestor) {
    if (renderedSubtreeIsHidden(ancestor, styleCache, document.defaultView)) {
      ancestorSuppressed = true;
      break;
    }
    ancestor = ancestor.parentElement;
  }

  const stack = [
    {
      node: body,
      entered: false,
      suppressed: ancestorSuppressed,
      textVisible: true,
      inLink: false,
      parentMetric: null,
    },
  ];
  while (stack.length) {
    if (signal?.aborted) return { status: 'cancelled', metrics, visited, skippedSelected };
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (work >= config.maxNodes || now - started >= config.maxTimeMs) {
      return { status: 'incomplete', metrics, visited, skippedSelected };
    }

    const frame = stack.pop();
    if (frame.kind === 'children') {
      const child = frame.next;
      if (!child) continue;
      const isSummary =
        frame.collapsedDetails &&
        !frame.summarySeen &&
        child.nodeType === 1 &&
        child.tagName === 'SUMMARY';
      stack.push({
        ...frame,
        next: child.nextSibling,
        summarySeen: frame.summarySeen || isSummary,
      });
      stack.push({
        node: child,
        entered: false,
        suppressed: frame.suppressed || (frame.collapsedDetails && !isSummary),
        textVisible: frame.textVisible,
        inLink: frame.inLink,
        parentMetric: frame.parentMetric,
      });
      continue;
    }
    const { node } = frame;
    if (node.nodeType === 3) {
      work += 1;
      if (!frame.suppressed && frame.textVisible) {
        const length = normalizedLength(node.nodeValue);
        frame.parentMetric.mass += length;
        if (frame.inLink) frame.parentMetric.linkMass += length;
      }
    } else if (node.nodeType !== 1) {
      work += 1;
    } else if (!frame.entered) {
      const element = node;
      visited += 1;
      work += 1;
      if (selected.has(element)) {
        skippedSelected = true;
        metrics.set(element, emptyMetric());
        if (work >= config.maxNodes) {
          return { status: 'incomplete', metrics, visited, skippedSelected };
        }
        if (work >= nextYield) {
          nextYield += config.batchSize;
          await nextTask(document.defaultView);
        }
        continue;
      }
      const owned =
        OWNED_SURFACE_IDS.has(element.id) || element.hasAttribute('data-pagetollm-surface');
      const suppressed =
        frame.suppressed ||
        owned ||
        renderedSubtreeIsHidden(element, styleCache, document.defaultView);
      if (suppressed) {
        metrics.set(element, emptyMetric());
        if (work >= config.maxNodes) {
          return { status: 'incomplete', metrics, visited, skippedSelected };
        }
        if (work >= nextYield) {
          nextYield += config.batchSize;
          await nextTask(document.defaultView);
        }
        continue;
      }
      const style = getComputedStyleSafe(element, styleCache, document.defaultView);
      const visibility = propertyValue(element, style, 'visibility');
      const textVisible = visibility
        ? visibility !== 'hidden' && visibility !== 'collapse'
        : frame.textVisible;
      const elementIsLink = frame.inLink || element.matches('a[href]');
      const elementMetric = emptyMetric();
      stack.push({
        ...frame,
        entered: true,
        suppressed,
        textVisible,
        inLink: elementIsLink,
        elementMetric,
      });
      const collapsedDetails = element.tagName === 'DETAILS' && !element.hasAttribute('open');
      stack.push({
        kind: 'children',
        next: element.firstChild,
        collapsedDetails,
        summarySeen: false,
        suppressed,
        textVisible,
        inLink: elementIsLink,
        parentMetric: elementMetric,
      });
    } else {
      const element = node;
      const steeringNoise = element.matches(NOISE_SELECTOR);
      const metric = steeringNoise ? emptyMetric() : frame.elementMetric;
      metrics.set(element, metric);
      if (frame.parentMetric) {
        frame.parentMetric.mass += metric.mass;
        frame.parentMetric.linkMass += metric.linkMass;
      }
    }

    if (work >= nextYield) {
      nextYield += config.batchSize;
      await nextTask(document.defaultView);
    }
  }
  return { status: 'complete', metrics, visited, skippedSelected };
}

function positiveChildren(element, metrics) {
  return Array.from(element.children).filter((child) => (metrics.get(child)?.mass || 0) > 0);
}

function descendAndTrim(body, metrics, config, trace) {
  let node = body;
  let keep = [];
  while (true) {
    const kids = positiveChildren(node, metrics);
    if (!kids.length) {
      keep = [];
      break;
    }
    const nodeMass = metrics.get(node)?.mass || 0;
    const ranked = [...kids].sort((a, b) => metrics.get(b).mass - metrics.get(a).mass);
    const best = ranked[0];
    const bestRatio = nodeMass ? metrics.get(best).mass / nodeMass : 0;
    trace.path.push({ element: node, best, bestRatio });
    if (bestRatio >= config.descend) {
      node = best;
      continue;
    }
    let sum = 0;
    let prefixLength = 0;
    while (prefixLength < ranked.length && sum / nodeMass < config.descend) {
      sum += metrics.get(ranked[prefixLength]).mass;
      prefixLength += 1;
    }
    if (prefixLength <= config.splitLimit) {
      keep = ranked.slice(0, prefixLength);
      for (const excluded of ranked.slice(prefixLength)) {
        trace.dropped.push({
          element: excluded,
          mass: metrics.get(excluded).mass,
          reason: 'descent-prefix',
        });
      }
    } else keep = kids;
    break;
  }

  // Body itself is never a valid result, even when it has only direct text.
  if (node === body) keep = keep.length ? keep : positiveChildren(body, metrics);
  if (!keep.length && node !== body) return [node];

  const nodeMass = metrics.get(node)?.mass || metrics.get(body)?.mass || 0;
  const ranked = [...keep].sort((a, b) => metrics.get(b).mass - metrics.get(a).mass);
  let dropped = 0;
  while (ranked.length > 1) {
    const smallest = ranked[ranked.length - 1];
    const smallMass = metrics.get(smallest).mass;
    if (smallMass / nodeMass < config.tiny && (dropped + smallMass) / nodeMass < config.maxCut) {
      ranked.pop();
      dropped += smallMass;
      trace.dropped.push({ element: smallest, mass: smallMass, reason: 'tiny' });
    } else break;
  }
  const keptMass = ranked.reduce((sum, element) => sum + metrics.get(element).mass, 0);
  const droppedShare = nodeMass ? (nodeMass - keptMass) / nodeMass : 0;
  // A small number of substantial sibling regions (article + comments, or two
  // articles) must stay independently removable. Paragraph/list children still
  // collapse to their shared article root.
  const structuralSplit =
    ranked.length > 1 &&
    ranked.length <= config.splitLimit &&
    ranked.every(
      (element) =>
        SUBSTANTIVE_CONTAINER_TAGS.has(element.tagName) ||
        element.getAttribute('role') === 'article',
    );
  // Prefer one bigger block over many small ones: when the survivors are more
  // than a handful (prose paragraphs around an ad), or when what was cut is a
  // small share of the node, hand back the node itself. Only a short list of
  // structural siblings, or a large excluded share, justifies splitting.
  const joinToNode =
    node !== body &&
    !structuralSplit &&
    (ranked.length > config.splitLimit || droppedShare <= config.maxCut);
  if (joinToNode && ranked.length > 1) {
    trace.joined = { element: node, children: ranked.length, droppedShare };
  }
  const result = joinToNode ? [node] : ranked;
  return result.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & 2 ? 1 : position & 4 ? -1 : 0;
  });
}

function directTextMass(element, metrics) {
  const own = metrics.get(element)?.mass || 0;
  const children = Array.from(element.children).reduce(
    (sum, child) => sum + (metrics.get(child)?.mass || 0),
    0,
  );
  return Math.max(0, own - children);
}

// Splitting descends only into element children, so a split root's own direct
// text nodes have no element to return and are dropped. Their mass is reported
// so callers do not mistake dropped prose for full coverage.
function splitAroundSelections(element, selected, metrics) {
  const results = [];
  let droppedDirectText = 0;
  const stack = [element];
  while (stack.length) {
    const current = stack.pop();
    if (!selected.some((selection) => current.contains(selection))) {
      results.push(current);
      continue;
    }
    droppedDirectText += directTextMass(current, metrics);
    const children = Array.from(current.children);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if ((metrics.get(child)?.mass || 0) > 0) stack.push(child);
    }
  }
  return { results, droppedDirectText };
}

/**
 * Find likely long-read roots in a live light DOM.
 * @param {Document} document Document to scan.
 * @param {object} [options] Thresholds, budgets, selected roots, and abort signal.
 * @returns {Promise<{status: string, blocks: object[], trace: object}>} Detection result.
 */
export async function findTextBlocks(document, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const cancelled = abortStatus(options.signal);
  if (cancelled) return cancelled;
  const measurement = await measureTextMass(document, config);
  if (measurement.status !== 'complete') {
    return {
      status: measurement.status,
      blocks: [],
      trace: { reason: measurement.status, visited: measurement.visited },
    };
  }
  const body = document?.body;
  const trace = { visited: measurement.visited, path: [], dropped: [] };
  const bodyMetric = measurement.metrics.get(body) || emptyMetric();
  if (!bodyMetric.mass) {
    return { status: measurement.skippedSelected ? 'already-selected' : 'none', blocks: [], trace };
  }
  let elements = descendAndTrim(body, measurement.metrics, config, trace);
  const selected = (options.selected || []).filter(
    (element) => element?.ownerDocument === document,
  );
  let droppedDirectText = 0;
  elements = elements.flatMap((element) => {
    const split = splitAroundSelections(element, selected, measurement.metrics);
    droppedDirectText += split.droppedDirectText;
    return split.results;
  });
  trace.droppedDirectText = droppedDirectText;
  elements = elements.filter((element) => element !== body && element !== document.documentElement);
  const mass = elements.reduce((sum, element) => sum + measurement.metrics.get(element).mass, 0);
  const linkMass = elements.reduce(
    (sum, element) => sum + measurement.metrics.get(element).linkMass,
    0,
  );
  trace.result = { mass, linkMass, linkRatio: mass ? linkMass / mass : 0 };
  if (!elements.length || mass < config.minMass) {
    // Only claim full coverage when the unselected text left over, including
    // direct text dropped while splitting, is too small to be worth offering.
    const unselectedMass = mass + droppedDirectText;
    const status =
      measurement.skippedSelected && unselectedMass < config.minMass ? 'already-selected' : 'none';
    return { status, blocks: [], trace };
  }
  if (linkMass / mass > config.maxLinkRatio) {
    return { status: 'none', blocks: [], trace };
  }
  if (options.signal?.aborted)
    return { status: 'cancelled', blocks: [], trace: { ...trace, reason: 'aborted' } };
  const blocks = elements
    .filter((element) => element.isConnected && element.ownerDocument === document)
    .map((element) => ({ element, ...measurement.metrics.get(element) }));
  return { status: blocks.length ? 'found' : 'none', blocks, trace };
}
