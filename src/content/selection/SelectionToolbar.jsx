import React from 'react';

export default function SelectionToolbar({
  isPicking,
  isSubmitting,
  isFinding,
  status,
  selectedBlocks,
  draggingIndex,
  dragOverIndex,
  onTogglePicking,
  onFind,
  onSubmit,
  onCancel,
  onRemoveBlock,
  onStepUpBlock,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const isBusy = isSubmitting || isFinding;
  const submitLabel = isSubmitting
    ? 'Submitting...'
    : selectedBlocks.length > 0
      ? `Submit (${selectedBlocks.length})`
      : 'Submit';
  const pickHint = isPicking
    ? 'Stop picking page blocks'
    : 'Pick page blocks to include in the summary';
  const submitHint = isSubmitting
    ? 'Preparing and submitting the selected blocks'
    : selectedBlocks.length > 0
      ? 'Submit the selected blocks for processing'
      : 'Select at least one block before submitting';
  const cancelHint = 'Cancel selection and close this toolbar';
  const findHint = 'Find article text on this page';

  return (
    <>
      <div id="pagetollm-toolbar-top" aria-busy={isBusy}>
        <button
          id="pagetollm-pick-btn"
          className={isPicking ? 'active' : ''}
          type="button"
          disabled={isBusy}
          title={pickHint}
          aria-label={pickHint}
          onClick={onTogglePicking}
        >
          {isPicking ? 'Picking...' : 'Pick Block'}
        </button>
        <button
          id="pagetollm-find-btn"
          className={isFinding ? 'finding' : ''}
          type="button"
          disabled={isBusy}
          title={findHint}
          aria-label={findHint}
          onClick={onFind}
        >
          {isFinding ? 'Finding...' : 'Find'}
        </button>
        <button
          id="pagetollm-submit-btn"
          className={isSubmitting ? 'submitting' : ''}
          type="button"
          disabled={selectedBlocks.length === 0 || isBusy}
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
      <div id="pagetollm-toolbar-status" role="status" aria-live="polite">
        {status}
      </div>
      {isSubmitting && (
        <div
          id="pagetollm-submit-progress"
          role="progressbar"
          aria-label="Preparing selected page content"
        >
          <span />
        </div>
      )}
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
              draggable={!isBusy}
              data-index={index}
              onDragStart={(event) => !isBusy && onDragStart(event, index)}
              onDragOver={(event) => !isBusy && onDragOver(event, index)}
              onDrop={(event) => !isBusy && onDrop(event, index)}
              onDragEnd={(event) => !isBusy && onDragEnd(event)}
            >
              <span className="pagetollm-drag-handle" title="Drag to reorder">
                &#9776;
              </span>
              <span
                className="pagetollm-block-label"
                title={
                  block.snippetTitle || block.snippet
                    ? `${block.originalNumber}. ${block.snippetTitle || block.snippet}`
                    : undefined
                }
              >
                {block.snippet
                  ? `${block.originalNumber}. ${block.snippet}`
                  : `Block ${block.originalNumber}`}
              </span>
              <button
                className="pagetollm-stepup-btn"
                type="button"
                title="Expand selection to parent block"
                aria-label="Expand selection to parent block"
                disabled={isBusy || block.canStepUp === false}
                onClick={(event) => onStepUpBlock(event, index)}
              >
                &#8593;
              </button>
              <button
                className="pagetollm-remove-btn"
                type="button"
                title="Remove block"
                disabled={isBusy}
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
