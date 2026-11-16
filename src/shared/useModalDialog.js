import { useEffect } from 'react';

/**
 * Open a native `<dialog>` as a modal for the component's lifetime.
 *
 * `showModal()` provides the top layer, `::backdrop`, inert page content and focus
 * containment. Focus is restored by hand: React detaches the element before the
 * browser's close handling could run.
 *
 * @param {{current: HTMLDialogElement|null}} dialogRef Rendered dialog element.
 * @param {{initialFocus?: {current: HTMLElement|null}}} [options] Element to focus after opening.
 */
export function useModalDialog(dialogRef, { initialFocus } = {}) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    // For a shadow-root host, document.activeElement is only the host.
    const previous = dialog.getRootNode().activeElement || dialog.ownerDocument.activeElement;
    if (!dialog.open) dialog.showModal();
    initialFocus?.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
    // Open once per mount; callers unmount the dialog to close it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Whether a click landed on the backdrop: the target is the dialog itself and the
 * point is outside its border box.
 * @param {{target: EventTarget, currentTarget: Element, clientX: number, clientY: number}} event
 * @returns {boolean} True when the click was outside the dialog box.
 */
export function clickedOutsideDialog(event) {
  if (event.target !== event.currentTarget) return false;
  const rect = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}
