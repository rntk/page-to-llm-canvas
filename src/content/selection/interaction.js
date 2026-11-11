import {
  canStepUpElement,
  createSelectedEntry,
  moveSelectedEntry,
  removeSelectedEntry,
  selectedBlocksForToolbar,
  stepUpSelectedEntry,
} from './state.js';
import {
  HIGHLIGHTED_ELEMENT_SELECTOR,
  isElementSelected,
  setElementHighlighted,
  setElementSelected,
} from './markers.js';

// Owns synchronous interaction transitions and their DOM side effects.
export function createSelectionInteraction({ document, guardTrustedUserEvent, onChange }) {
  let selectionMode = false;
  let selectedElements = [];
  let pickCounter = 0;
  let dragSrcIndex = null;
  let dragOverIndex = null;
  let isSubmitting = false;
  let isFinding = false;
  let findStatus = '';
  let splittingInstructions = '';
  let summaryInstructions = '';
  let destroyed = false;
  const renderSelectionToolbar = () => onChange();

  function toggleSelectionMode(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    selectionMode = !selectionMode;
    if (selectionMode) {
      enableSelection();
    } else {
      disableSelection();
    }
    renderSelectionToolbar();
  }

  function enableSelection() {
    document.addEventListener('mouseover', highlightElement);
    document.addEventListener('mouseout', unhighlightElement);
    document.addEventListener('click', selectElement, true);
  }

  function disableSelection() {
    document.removeEventListener('mouseover', highlightElement);
    document.removeEventListener('mouseout', unhighlightElement);
    document.removeEventListener('click', selectElement, true);
    document.querySelectorAll(HIGHLIGHTED_ELEMENT_SELECTOR).forEach((el) => {
      setElementHighlighted(el, false);
    });
  }

  function highlightElement(event) {
    if (!selectionMode) return;
    if (event.target.closest('#pagetollm-selection-toolbar')) return;
    const el = event.target;
    if (el && el !== document.body && el !== document.documentElement) {
      setElementHighlighted(el, true);
    }
  }

  function unhighlightElement(event) {
    if (!selectionMode) return;
    if (event.target.closest('#pagetollm-selection-toolbar')) return;
    const el = event.target;
    if (el && !isElementSelected(el)) {
      setElementHighlighted(el, false);
    }
  }

  function selectElement(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || !selectionMode || isSubmitting || isFinding) return;
    if (event.target.closest('#pagetollm-selection-toolbar')) return;

    event.preventDefault();
    event.stopPropagation();

    const el = event.target;
    setElementSelected(el, true);
    pickCounter += 1;
    selectedElements.push(createSelectedEntry(el, pickCounter));
    findStatus = '';

    selectionMode = false;
    disableSelection();

    renderSelectionToolbar();
  }

  function removeBlock(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    const entry = selectedElements[index];
    selectedElements = removeSelectedEntry(selectedElements, index);
    syncSelectedMarker(entry?.el);
    pickCounter = selectedElements.length;
    // Clear stale scan counts after the list changes.
    findStatus = '';
    renderSelectionToolbar();
  }

  function changeSplittingInstructions(event) {
    if (!guardTrustedUserEvent(event) || destroyed || isSubmitting || isFinding) return;
    splittingInstructions = event.target.value;
    renderSelectionToolbar();
  }

  function changeSummaryInstructions(event) {
    if (!guardTrustedUserEvent(event) || destroyed || isSubmitting || isFinding) return;
    summaryInstructions = event.target.value;
    renderSelectionToolbar();
  }

  function stepUpBlock(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    const result = stepUpSelectedEntry(selectedElements, index);
    if (result.oldElement === null || result.newElement === null) return;

    selectedElements = result.entries;
    syncSelectedMarker(result.oldElement);
    syncSelectedMarker(result.newElement);
    pickCounter = selectedElements.length;
    findStatus = '';

    // Show the full parent block that will be captured.
    renderSelectionToolbar();
  }

  function onDragStart(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    dragSrcIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    renderSelectionToolbar();
  }

  function onDragOver(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const nextDragOverIndex = Number.isInteger(index)
      ? index
      : parseInt(event.currentTarget.dataset.index);
    if (dragOverIndex !== nextDragOverIndex) {
      dragOverIndex = nextDragOverIndex;
      renderSelectionToolbar();
    }
  }

  function onDrop(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    event.preventDefault();
    const destIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
    if (dragSrcIndex === null || dragSrcIndex === destIndex) return;

    selectedElements = moveSelectedEntry(selectedElements, dragSrcIndex, destIndex);
    dragOverIndex = null;

    renderSelectionToolbar();
  }

  function onDragEnd(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    dragSrcIndex = null;
    dragOverIndex = null;
    renderSelectionToolbar();
  }

  function syncSelectedMarker(el) {
    if (!el) return;
    setElementSelected(
      el,
      selectedElements.some((entry) => entry.el === el),
    );
  }

  function snapshot() {
    return {
      selectionMode,
      selectedElements,
      dragSrcIndex,
      dragOverIndex,
      isSubmitting,
      isFinding,
      findStatus,
      splittingInstructions,
      summaryInstructions,
    };
  }
  function startFind() {
    selectionMode = false;
    disableSelection();
    dragSrcIndex = null;
    dragOverIndex = null;
    isFinding = true;
    findStatus = 'Finding text blocks…';
    renderSelectionToolbar();
  }
  function finishFind(entries, status) {
    entries.forEach(({ el }) => setElementSelected(el, true));
    selectedElements = entries;
    pickCounter = entries.length;
    findStatus = status;
    isFinding = false;
    renderSelectionToolbar();
  }
  function setSubmitting(value) {
    isSubmitting = value;
    renderSelectionToolbar();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    selectedElements.forEach(({ el }) => setElementSelected(el, false));
    selectedElements = [];
    selectionMode = false;
    disableSelection();
  }
  return {
    snapshot,
    toolbarBlocks: () => selectedBlocksForToolbar(selectedElements, canStepUpElement),
    startFind,
    finishFind,
    setSubmitting,
    destroy,
    toggleSelectionMode,
    removeBlock,
    stepUpBlock,
    changeSplittingInstructions,
    changeSummaryInstructions,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
  };
}
