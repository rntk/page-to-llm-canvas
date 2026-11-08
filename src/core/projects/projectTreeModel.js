import { PASSAGE, ROOT, summaryText } from '../pipeline/summaryTreeModel.js';
import { sortedUnique } from '../../shared/runtime/sortedUnique.js';

/**
 * Read-only view over a saved project tree snapshot.
 * @param {object|null|undefined} tree
 * @returns {object|null} Null when the snapshot has no nodes.
 */
export function createTreeModel(tree) {
  const nodes = tree?.nodes && typeof tree.nodes === 'object' ? tree.nodes : null;
  if (!nodes || !Object.keys(nodes).length) return null;
  const sentences = Array.isArray(tree.sentences) ? tree.sentences : [];
  const sources = tree.sources && typeof tree.sources === 'object' ? tree.sources : {};

  // Keep historical sources available for stable citation lookup. Their presence
  // does not establish current membership in the saved tree.
  const articleByKey = new Map();
  const sourceKey = (source) => source.recordKey ?? `${source.url || ''}|${source.title || ''}`;
  for (const record of Array.isArray(tree.records) ? tree.records : []) {
    if (record?.key == null) continue;
    articleByKey.set(record.key, { key: record.key, title: record.title, url: record.url || '' });
  }
  for (const source of Object.values(sources)) {
    const key = sourceKey(source);
    if (!articleByKey.has(key)) {
      articleByKey.set(key, { key, title: source.title, url: source.url || '' });
    }
  }

  const hasNode = (id) => typeof id === 'string' && Object.hasOwn(nodes, id);
  const parentOf = new Map();
  for (const node of Object.values(nodes)) {
    for (const child of Array.isArray(node.children) ? node.children : []) {
      if (hasNode(child) && !parentOf.has(child)) parentOf.set(child, node.id);
    }
  }
  const savedRoot = tree.rootId ?? (typeof tree.root === 'string' ? tree.root : null);
  const rootId = hasNode(savedRoot)
    ? savedRoot
    : (Object.values(nodes).find((node) => node.kind === ROOT)?.id ?? null);

  // An unfinished tree has no root yet: a virtual root lists its loose branches.
  const virtualRoot = rootId
    ? null
    : {
        id: 'root',
        kind: ROOT,
        title: String(tree.title || 'Project topics'),
        children: Object.values(nodes)
          .filter((node) => !parentOf.has(node.id))
          .map((node) => node.id),
        sentences: sortedUnique(
          Object.values(nodes)
            .filter((node) => !parentOf.has(node.id))
            .flatMap((node) => node.sentences || []),
        ),
        segments: null,
      };
  const root = virtualRoot || nodes[rootId];

  const getNode = (id) => {
    if (virtualRoot && id === virtualRoot.id) return virtualRoot;
    if (!hasNode(id)) {
      throw new Error(
        `Unknown node_id ${JSON.stringify(String(id))}. Use a node id returned by get_topic or search_topics.`,
      );
    }
    return nodes[id];
  };
  const childrenOf = (node) =>
    node.kind === PASSAGE || !Array.isArray(node.children)
      ? []
      : node.children.filter(hasNode).map((id) => nodes[id]);
  const isLeaf = (node) => childrenOf(node).length === 0;

  const cache = new Map();
  const memo = (kind, node, compute) => {
    const key = `${kind}:${node.id}`;
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  };

  const cite = (id) => {
    const source = sources[id];
    const text = sentences[id - 1];
    if (!source || typeof text !== 'string' || !text.trim()) return null;
    const article = articleByKey.get(sourceKey(source));
    return { id, article, line: source.sentenceId, text: text.trim() };
  };
  const usable = (ids) => ids.filter((id) => cite(id));
  const sentenceIds = (node) => memo('ids', node, () => usable(sortedUnique(node.sentences || [])));
  const articlesOf = (node) =>
    memo('articles', node, () => {
      const seen = new Map();
      for (const id of sentenceIds(node)) {
        const { article } = cite(id);
        if (!seen.has(article.key)) seen.set(article.key, article);
      }
      return [...seen.values()];
    });
  const summaryOf = (node) =>
    memo('summary', node, () => {
      if (node.failed || !Array.isArray(node.segments)) return '';
      return summaryText(node);
    });
  const hasSummary = (node) => !!summaryOf(node);

  const pathTitles = (node) => {
    const titles = [];
    let current = node;
    for (let guard = 0; current && current.kind !== ROOT && guard < 50; guard++) {
      titles.unshift(current.title);
      current = nodes[parentOf.get(current.id)];
    }
    return titles;
  };

  const reachable = () =>
    memo('reachable', root, () => {
      const seen = new Set();
      const order = [];
      const visit = (node) => {
        if (seen.has(node.id) || node === virtualRoot) return;
        seen.add(node.id);
        order.push(node);
        childrenOf(node).forEach(visit);
      };
      if (virtualRoot) childrenOf(virtualRoot).forEach(visit);
      else visit(root);
      return order;
    });

  // Records explicitly define membership, including an empty list. Older
  // snapshots without records fall back to evidence in reachable nodes only.
  const includedKeys = new Set(
    Array.isArray(tree.records)
      ? tree.records.filter((record) => record?.key != null).map((record) => record.key)
      : reachable().flatMap((node) =>
          (node.sentences || []).flatMap((id) => (sources[id] ? [sourceKey(sources[id])] : [])),
        ),
  );
  const articles = [...articleByKey.values()].filter((article) => includedKeys.has(article.key));
  for (const article of articleByKey.values()) {
    article.title = String(article.title || article.url || 'Untitled article');
    article.label = article.title;
  }
  // Only included articles need disambiguation from each other.
  const titleCounts = new Map();
  for (const article of articles) {
    titleCounts.set(article.title, (titleCounts.get(article.title) || 0) + 1);
  }
  for (const article of articles) {
    article.label =
      titleCounts.get(article.title) > 1 && article.url
        ? `${article.title} (${article.url})`
        : article.title;
  }

  return {
    tree,
    root,
    getNode,
    childrenOf,
    isLeaf,
    cite,
    sentenceIds,
    usable,
    articlesOf,
    summaryOf,
    hasSummary,
    pathTitles,
    reachable,
    articles,
  };
}
