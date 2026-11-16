import { beforeEach, vi } from 'vitest';

// Capture closed shadow roots (production uses mode: 'closed') so tests can reach them.
const roots = new WeakMap();
const attachShadow = Element.prototype.attachShadow;
beforeEach(() => {
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (options) {
    const root = attachShadow.call(this, options);
    roots.set(this, root);
    return root;
  });
});

export function resplitDialogRoot() {
  return roots.get(document.getElementById('pagetollm-resplit-dialog'));
}

/** Complete the actual resplit dialog in view integration tests. */
export function completeResplitDialog({
  cancel = false,
  splittingInstructions = '',
  summaryInstructions = '',
} = {}) {
  const shadow = resplitDialogRoot();
  if (cancel) {
    shadow.querySelector('button[type="button"]').click();
    return;
  }
  shadow.querySelector('#resplit-splitting-instructions').value = splittingInstructions;
  shadow.querySelector('#resplit-summary-instructions').value = summaryInstructions;
  shadow
    .querySelector('form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
