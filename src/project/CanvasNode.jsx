import React from 'react';

/**
 * Shared position, stacking and chat fold for page and excerpt cards.
 * @param {object} props
 */
export function CanvasNode({
  nodeKey,
  position,
  chatOpen,
  zIndex,
  raiseNode,
  setChatOpen,
  renderChat,
  foldName,
  foldHint,
  children,
}) {
  const chatId = `canvas-chat-${nodeKey}`;
  return (
    <div
      className="canvas-node"
      data-canvas-node=""
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        zIndex,
      }}
      onPointerDown={() => {
        if (chatOpen) raiseNode(nodeKey);
      }}
    >
      {children}
      {chatOpen && renderChat({ id: chatId, onClose: () => setChatOpen(nodeKey, false) })}
      {renderChat && (
        <button
          type="button"
          className="page-chat-fold"
          aria-expanded={chatOpen}
          aria-controls={chatOpen ? chatId : undefined}
          aria-label={`${chatOpen ? 'Fold' : 'Unfold'} chat for ${foldName}`}
          title={chatOpen ? 'Fold chat' : foldHint}
          onClick={() => setChatOpen(nodeKey, !chatOpen)}
        >
          {chatOpen ? '‹ Chat' : 'Chat ›'}
        </button>
      )}
    </div>
  );
}
