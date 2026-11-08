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
  return (
    <div
      className="canvas-node"
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        zIndex,
      }}
      onPointerDown={() => {
        if (chatOpen) raiseNode(nodeKey);
      }}
    >
      {children}
      {chatOpen && renderChat({ onClose: () => setChatOpen(nodeKey, false) })}
      {renderChat && (
        <button
          type="button"
          className="page-chat-fold"
          aria-expanded={chatOpen}
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
