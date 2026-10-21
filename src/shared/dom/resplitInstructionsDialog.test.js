// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showResplitInstructionsDialog } from './resplitInstructionsDialog.js';
import { completeResplitDialog, resplitDialogRoot } from '../../../test/resplitDialog.mjs';

const theme = vi.hoisted(() => ({ read: vi.fn(), subscribe: vi.fn() }));
vi.mock('../runtime/theme.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getStoredTheme: theme.read,
}));
vi.mock('../runtime/localStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribeLocalKey: theme.subscribe,
}));

const topic = { path: 'Science', startSentence: 2, endSentence: 4 };
const dialogRoot = resplitDialogRoot;

beforeEach(() => {
  theme.read.mockReset().mockResolvedValue(undefined);
  theme.subscribe.mockReset().mockReturnValue(vi.fn());
});

describe('resplit instructions dialog', () => {
  it.each(['light', 'dark', 'system'])(
    'uses the extension’s %s theme preference',
    async (preference) => {
      theme.read.mockResolvedValue(preference);
      const pending = showResplitInstructionsDialog({ topic, hasSubtopics: false });
      await Promise.resolve();
      const host = document.getElementById('pagetollm-resplit-dialog');
      expect(host.getAttribute('data-theme')).toBe(preference === 'system' ? null : preference);
      completeResplitDialog({ cancel: true });
      await pending;
    },
  );

  it('follows theme changes, ignores an outdated initial read, and unsubscribes on close', async () => {
    let resolveTheme;
    theme.read.mockReturnValue(
      new Promise((resolve) => {
        resolveTheme = resolve;
      }),
    );
    const stopWatching = vi.fn();
    theme.subscribe.mockReturnValue(stopWatching);
    const pending = showResplitInstructionsDialog({ topic, hasSubtopics: false });
    const host = document.getElementById('pagetollm-resplit-dialog');
    const [key, onThemeChange] = theme.subscribe.mock.calls[0];
    expect(key).toBe('pagetollm-theme');
    onThemeChange('dark');
    resolveTheme('light');
    await Promise.resolve();
    expect(host.getAttribute('data-theme')).toBe('dark');
    onThemeChange('system');
    expect(host.hasAttribute('data-theme')).toBe(false);
    completeResplitDialog({ cancel: true });
    await pending;
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it('starts with the current rail theme before loading the stored preference', async () => {
    const rail = document.createElement('div');
    rail.id = 'pagetollm-in-page-rail';
    rail.setAttribute('data-theme', 'dark');
    document.body.append(rail);
    const pending = showResplitInstructionsDialog({ topic, hasSubtopics: false });
    expect(document.getElementById('pagetollm-resplit-dialog').getAttribute('data-theme')).toBe(
      'dark',
    );
    completeResplitDialog({ cancel: true });
    rail.remove();
    await pending;
  });

  it('collects both fields, shows the target and replacement notice, and restores focus', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const pending = showResplitInstructionsDialog({ topic, hasSubtopics: true });
    expect(document.getElementById('pagetollm-resplit-dialog').shadowRoot).toBeNull();
    expect(dialogRoot().querySelector('dialog').open).toBe(true);
    expect(dialogRoot().querySelector('#resplit-target').textContent).toBe(
      'Science · Sentences 2–4',
    );
    expect(dialogRoot().querySelector('#resplit-description').textContent).toContain(
      'replaces its subtopics',
    );
    expect(dialogRoot().activeElement.tagName).toBe('TEXTAREA');
    completeResplitDialog({
      splittingInstructions: ' Split by company. ',
      summaryInstructions: ' Focus on ABC. ',
    });
    await expect(pending).resolves.toEqual({
      splittingInstructions: 'Split by company.',
      summaryInstructions: 'Focus on ABC.',
    });
    expect(document.getElementById('pagetollm-resplit-dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it.each(['cancel', 'escape'])(
    'discards input on %s and opens the next dialog empty',
    async (method) => {
      const pending = showResplitInstructionsDialog({ topic, hasSubtopics: false });
      dialogRoot().querySelector('textarea').value = 'Discard this guidance.';
      if (method === 'cancel') completeResplitDialog({ cancel: true });
      else
        dialogRoot()
          .querySelector('dialog')
          .dispatchEvent(new Event('cancel', { cancelable: true }));
      await expect(pending).resolves.toBeNull();
      const next = showResplitInstructionsDialog({ topic, hasSubtopics: false });
      expect([...dialogRoot().querySelectorAll('textarea')].map((field) => field.value)).toEqual([
        '',
        '',
      ]);
      completeResplitDialog();
      await expect(next).resolves.toEqual({ splittingInstructions: '', summaryInstructions: '' });
    },
  );

  it('renders topic labels as text', async () => {
    const path = '<img src=x onerror="alert(1)">';
    const pending = showResplitInstructionsDialog({
      topic: { ...topic, path },
      hasSubtopics: false,
    });
    expect(dialogRoot().querySelector('#resplit-target').textContent).toContain(path);
    expect(dialogRoot().querySelector('img')).toBeNull();
    completeResplitDialog({ cancel: true });
    await pending;
  });
});
