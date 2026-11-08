import React, { useMemo } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { createProjectChatContext } from '../core/projects/projectChatTools.js';
import { projectChatKey } from '../core/storage/keys.js';

const pageKey = (page) => [page?.title, page?.url, page?.reason];
const NO_SENTENCES = [];
const NO_TOPICS = [];
const PROJECT_PROMPT =
  'Ask about this project. The assistant searches the merged topics of the included pages and cites the articles it read.';

/**
 * The project's own chat, filling the side chat panel. Turns send no article
 * text: the model gets the project overview (`preamble`) and answers through
 * tools over the merged topic tree, citing articles in prose.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {object} props.tree The project's merged topic tree.
 * @param {object[]} props.eligiblePages Pages included in the chat.
 * @param {object[]} props.skippedPages Pages left out (not saved or still processing).
 * @param {boolean} props.stale Whether pages or topics changed since the merge.
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function ProjectChat({ projectId, tree, eligiblePages, skippedPages, stale, chatPorts }) {
  // A reload of the same merge hands over fresh objects; rebuilding the (costly)
  // tree tools only when the tree itself changes keeps ArticleChat's props stable.
  const treeKey = [tree?.sourceRevision, tree?.runId, tree?.contentRevision].join('\u0000');
  const context = useMemo(
    () => createProjectChatContext(tree),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeKey],
  );
  // The preamble also lists pages and staleness, so it follows their content.
  const pagesKey = JSON.stringify([
    !!stale,
    (eligiblePages || []).map(pageKey),
    (skippedPages || []).map(pageKey),
  ]);
  const preamble = useMemo(
    () => context.buildPreamble({ eligiblePages, skippedPages, stale }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context, pagesKey],
  );
  const { tools } = context;
  const source = useMemo(() => ({ kind: 'project', preamble }), [preamble]);

  return (
    <div className="page-chat-body project-chat">
      <ArticleChat
        recordKey={projectChatKey(projectId)}
        sentences={NO_SENTENCES}
        topics={NO_TOPICS}
        source={source}
        tools={tools}
        emptyPrompt={PROJECT_PROMPT}
        {...chatPorts}
      />
    </div>
  );
}
