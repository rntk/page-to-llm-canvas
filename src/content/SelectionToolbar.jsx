import React from 'react';

export default function SelectionToolbar({
  isPicking,
  isSubmitting,
  selectedBlocks,
  draggingIndex,
  dragOverIndex,
  onTogglePicking,
  onSubmit,
  onCancel,
  onRemoveBlock,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const submitLabel = isSubmitting
    ? 'Submitting...'
    : selectedBlocks.length > 0
      ? `Submit (${selectedBlocks.length})`
      : 'Submit';

  return (
    <>
      <div id="pagetollm-toolbar-top">
        <button
          id="pagetollm-pick-btn"
          className={isPicking ? 'active' : ''}
          type="button"
          disabled={isSubmitting}
          onClick={onTogglePicking}
        >
          {isPicking ? 'Picking...' : 'Pick Block'}
        </button>
        <button
          id="pagetollm-submit-btn"
          type="button"
          disabled={selectedBlocks.length === 0 || isSubmitting}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
        <button id="pagetollm-cancel-btn" type="button" disabled={isSubmitting} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ul id="pagetollm-block-list">
        {selectedBlocks.map((block, index) => {
          const classes = [
            'pagetollm-block-item',
            draggingIndex === index ? 'pagetollm-dragging' : '',
            dragOverIndex === index && draggingIndex !== index ? 'pagetollm-drag-over' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li
              key={block.id}
              className={classes}
              draggable={!isSubmitting}
              data-index={index}
              onDragStart={(event) => !isSubmitting && onDragStart(event, index)}
              onDragOver={(event) => !isSubmitting && onDragOver(event, index)}
              onDrop={(event) => !isSubmitting && onDrop(event, index)}
              onDragEnd={onDragEnd}
            >
              <span className="pagetollm-drag-handle" title="Drag to reorder">
                &#9776;
              </span>
              <span className="pagetollm-block-label">Block {block.originalNumber}</span>
              <button
                className="pagetollm-remove-btn"
                type="button"
                title="Remove block"
                disabled={isSubmitting}
                onClick={() => onRemoveBlock(index)}
              >
                &#10005;
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
