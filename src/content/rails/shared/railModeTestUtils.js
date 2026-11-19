import { act } from 'react';

/**
 * Switch a rendered rail's view through the sandwich menu, like a user would.
 *
 * @param {Element} container Element containing the rail head.
 * @param {string} mode Target rail mode.
 */
export async function selectRailMode(container, mode) {
  const button = container.querySelector('.pagetollm-rail-mode-button');
  await act(async () => {
    button.click();
  });
  const option = container.querySelector(`.pagetollm-rail-mode-option[data-mode="${mode}"]`);
  await act(async () => {
    option.click();
  });
}
