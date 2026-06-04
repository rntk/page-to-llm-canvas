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
      <div id="rsstag-toolbar-top">
        <button
          id="rsstag-pick-btn"
          className={isPicking ? 'active' : ''}
          type="button"
          disabled={isSubmitting}
          onClick={onTogglePicking}
        >
          {isPicking ? 'Picking...' : 'Pick Block'}
        </button>
        <button
          id="rsstag-submit-btn"
          type="button"
          disabled={selectedBlocks.length === 0 || isSubmitting}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
        <button id="rsstag-cancel-btn" type="button" disabled={isSubmitting} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ul id="rsstag-block-list">
        {selectedBlocks.map((block, index) => {
          const classes = [
            'rsstag-block-item',
            draggingIndex === index ? 'rsstag-dragging' : '',
            dragOverIndex === index && draggingIndex !== index ? 'rsstag-drag-over' : '',
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
              <span className="rsstag-drag-handle" title="Drag to reorder">
                &#9776;
              </span>
              <span className="rsstag-block-label">Block {block.originalNumber}</span>
              <button
                className="rsstag-remove-btn"
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
