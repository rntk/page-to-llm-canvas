import React, { useMemo } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { createProjectChatContext } from '../core/projects/projectChatTools.js';
import { projectChatKey } from '../core/storage/keys.js';

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
 * @param {?HTMLElement} [props.headerActionsTarget] Where the chat's History/New
 *   actions render (the panel header); see ArticleChat.
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function ProjectChat({
  projectId,
  tree,
  eligiblePages,
  skippedPages,
  stale,
  headerActionsTarget,
  chatPorts,
}) {
  // useProjectView keeps an unchanged merge's objects identical across reloads,
  // so the (costly) tree tools and ArticleChat's props only change with content.
  const context = useMemo(() => createProjectChatContext(tree), [tree]);
  const preamble = useMemo(
    () => context.buildPreamble({ eligiblePages, skippedPages, stale }),
    [context, eligiblePages, skippedPages, stale],
  );
  const { tools } = context;
  const source = useMemo(() => ({ kind: 'project', preamble }), [preamble]);

  return (
    <div className="page-chat-body project-chat">
      <ArticleChat
        recordKey={projectChatKey(projectId)}
        source={source}
        tools={tools}
        emptyPrompt={PROJECT_PROMPT}
        headerActionsTarget={headerActionsTarget}
        {...chatPorts}
      />
    </div>
  );
}
