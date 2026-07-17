// Shadow-DOM stylesheet for the selection toolbar. Kept as a string so it can be
// injected into the toolbar's closed shadow root (the palette variables are
// tagged on the host element by surfacePreferences and flipped by content.css).
export const TOOLBAR_SHADOW_STYLES = `
  #pagetollm-toolbar-top {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  button {
    padding: 6px 12px;
    border: 1px solid var(--ink);
    border-radius: 0;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease,
      opacity 0.15s ease;
    white-space: nowrap;
  }

  #pagetollm-pick-btn {
    background: var(--surface);
    color: var(--ink);
  }

  #pagetollm-pick-btn.active {
    background: var(--ink);
    color: var(--surface);
  }

  #pagetollm-submit-btn {
    background: var(--ink);
    color: var(--surface);
  }

  #pagetollm-submit-btn:disabled {
    background: var(--surface);
    color: var(--on-surface-muted);
    border-color: var(--ghost);
    cursor: not-allowed;
  }

  #pagetollm-cancel-btn {
    background: var(--surface);
    color: var(--accent);
    border-color: var(--accent);
    margin-left: auto;
  }

  #pagetollm-cancel-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--surface);
  }

  button:hover:not(:disabled, .active, #pagetollm-cancel-btn) {
    background: var(--ink);
    color: var(--surface);
  }

  #pagetollm-block-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  #pagetollm-block-list:empty {
    display: none;
  }

  .pagetollm-block-item {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface-low);
    border-radius: 0;
    padding: 5px 8px;
    cursor: default;
    user-select: none;
    border: 1px solid var(--ghost);
    transition: border-color 0.1s ease;
  }

  .pagetollm-block-item.pagetollm-drag-over {
    border-color: var(--ink);
  }

  .pagetollm-block-item.pagetollm-dragging {
    opacity: 0.4;
  }

  .pagetollm-drag-handle {
    cursor: grab;
    color: var(--on-surface-muted);
    font-size: 17px;
    flex-shrink: 0;
  }

  .pagetollm-drag-handle:active {
    cursor: grabbing;
  }

  .pagetollm-block-label {
    font-size: 14px;
    font-weight: 600;
    flex: 1;
  }

  .pagetollm-remove-btn {
    background: transparent !important;
    color: var(--on-surface-muted) !important;
    padding: 0 4px !important;
    font-size: 14px !important;
    font-weight: 400 !important;
    border: none !important;
    border-radius: 0 !important;
    line-height: 1;
  }

  .pagetollm-remove-btn:hover:not(:disabled) {
    color: var(--accent) !important;
    background: transparent !important;
  }

  .pagetollm-stepup-btn {
    background: transparent !important;
    color: var(--on-surface-muted) !important;
    padding: 0 4px !important;
    font-size: 15px !important;
    font-weight: 700 !important;
    border: none !important;
    border-radius: 0 !important;
    line-height: 1;
  }

  .pagetollm-stepup-btn:hover:not(:disabled) {
    color: var(--ink) !important;
    background: transparent !important;
  }

  .pagetollm-stepup-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
`;
