import { useCallback, useState } from 'react';

/** Keeps unfolded chats and the foreground node together. */
export function useOpenChats() {
  const [openChats, setOpenChats] = useState(() => new Set());
  const [topId, raiseNode] = useState(null);

  const setChatOpen = useCallback((key, open) => {
    setOpenChats((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
    if (open) raiseNode(key);
  }, []);

  // An unfolded chat overlaps its neighbours, so keep it above them.
  const nodeZIndex = (key, chatOpen) => (key === topId ? 3 : chatOpen ? 2 : 1);
  return { openChats, setChatOpen, raiseNode, nodeZIndex };
}
