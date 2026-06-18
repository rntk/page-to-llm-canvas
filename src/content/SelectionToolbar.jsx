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
  onStepUpBlock,
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
  const pickHint = isPicking
    ? 'Stop picking page blocks'
    : 'Pick page blocks to include in the summary';
  const submitHint =
    selectedBlocks.length > 0
      ? 'Submit the selected blocks for processing'
      : 'Select at least one block before submitting';
  const cancelHint = 'Cancel selection and close this toolbar';

  return (
    <>
      <div id="pagetollm-toolbar-top">
        <button
          id="pagetollm-pick-btn"
          className={isPicking ? 'active' : ''}
          type="button"
          disabled={isSubmitting}
          title={pickHint}
          aria-label={pickHint}
          onClick={onTogglePicking}
        >
          {isPicking ? 'Picking...' : 'Pick Block'}
        </button>
        <button
          id="pagetollm-submit-btn"
          type="button"
          disabled={selectedBlocks.length === 0 || isSubmitting}
          title={submitHint}
          aria-label={submitHint}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
        <button
          id="pagetollm-cancel-btn"
          type="button"
          disabled={isSubmitting}
          title={cancelHint}
          aria-label={cancelHint}
          onClick={onCancel}
        >
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
                className="pagetollm-stepup-btn"
                type="button"
                title="Expand selection to parent block"
                aria-label="Expand selection to parent block"
                disabled={isSubmitting || block.canStepUp === false}
                onClick={(event) => onStepUpBlock(event, index)}
              >
                &#8593;
              </button>
              <button
                className="pagetollm-remove-btn"
                type="button"
                title="Remove block"
                disabled={isSubmitting}
                onClick={(event) => onRemoveBlock(event, index)}
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
