import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Generic overflow menu for actions attached to a topic card.
 * @param {{actions: Array, topic: object, classPrefix?: string}} props
 */
export default function TopicActionsMenu({ actions, topic, classPrefix = 'topic-actions' }) {
  const [menu, setMenu] = React.useState(null);
  const [error, setError] = React.useState('');
  const [pendingActionId, setPendingActionId] = React.useState(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const triggerClass = `${classPrefix}__actions-trigger`;
  const menuClass = `${classPrefix}__actions-menu`;

  React.useLayoutEffect(() => {
    if (!menu) return;
    const menuRect = menuRef.current?.getBoundingClientRect();
    if (!menuRect) return;
    const margin = 8;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const width = menuRect.width || 176;
    const height = menuRect.height || 0;
    const left = Math.min(
      Math.max(margin, menu.anchorRight - width),
      Math.max(margin, viewportWidth - width - margin),
    );
    const below = menu.anchorBottom + 4;
    const above = menu.anchorTop - height - 4;
    const top =
      below + height <= viewportHeight - margin
        ? below
        : above >= margin
          ? above
          : Math.max(margin, Math.min(below, viewportHeight - height - margin));
    if (left !== menu.left || top !== menu.top)
      setMenu((current) => (current ? { ...current, left, top } : current));
  }, [menu]);

  const closeMenu = React.useCallback(({ restoreFocus = false } = {}) => {
    setMenu(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!menu) return undefined;
    const closeOnOutside = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) {
        return;
      }
      closeMenu();
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu({ restoreFocus: true });
      }
    };
    const closeOnWheel = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    const closeOnViewportChange = () => closeMenu();
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('wheel', closeOnWheel, { capture: true, passive: true });
    window.addEventListener('resize', closeOnViewportChange);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('wheel', closeOnWheel, { capture: true });
      window.removeEventListener('resize', closeOnViewportChange);
    };
  }, [menu, closeMenu]);

  React.useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);

  const toggleMenu = (event) => {
    event.stopPropagation();
    if (menu) {
      closeMenu();
      return;
    }
    setError('');
    const rect = event.currentTarget.getBoundingClientRect();
    const colorScheme = window.getComputedStyle(event.currentTarget).colorScheme;
    setMenu({
      top: rect.bottom + 4,
      left: Math.max(8, rect.right - 176),
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      anchorRight: rect.right,
      colorScheme,
    });
  };

  const moveFocus = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    const items = [
      ...(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || []),
    ];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length].focus();
  };

  const runAction = async (action) => {
    if (pendingActionId) return;
    setError('');
    setPendingActionId(action.id);
    try {
      const result = await action.onSelect(topic);
      if (result?.stale) {
        setError('This topic changed. Refresh the view and try again.');
        return;
      }
      if (result?.ok === false) throw new Error(result.error || 'Action failed.');
      closeMenu();
    } catch (cause) {
      setError(cause?.message || 'Action failed.');
    } finally {
      setPendingActionId(null);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        aria-label={`More actions for ${topic.path}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={toggleMenu}
      >
        <span aria-hidden="true">···</span>
      </button>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className={menuClass}
            role="menu"
            aria-label={`Actions for ${topic.path}`}
            aria-busy={pendingActionId !== null}
            style={{ top: `${menu.top}px`, left: `${menu.left}px`, colorScheme: menu.colorScheme }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={moveFocus}
          >
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                disabled={pendingActionId !== null}
                title={action.title?.(topic)}
                onClick={() => void runAction(action)}
              >
                {action.label}
              </button>
            ))}
            {error && <p role="alert">{error}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
