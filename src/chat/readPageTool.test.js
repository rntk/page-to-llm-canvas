import { describe, expect, it, vi } from 'vitest';
import { READ_PAGE_TOOL, createReadPageTool, locateExcerpt } from './readPageTool.js';

const page = Array.from({ length: 20 }, (_, index) => `Page sentence number ${index + 1} here.`);

describe('locateExcerpt', () => {
  it('finds the page line where the excerpt starts', () => {
    expect(locateExcerpt(page, ['Page sentence number 12 here.'])).toBe(12);
  });

  it('matches a selection that starts mid-sentence', () => {
    expect(locateExcerpt(page, ['number 7 here. Page sentence number 8 here.'])).toBe(7);
  });

  it('returns null when the excerpt is not on the page', () => {
    expect(locateExcerpt(page, ['Something else entirely.'])).toBe(null);
    expect(locateExcerpt(page, [])).toBe(null);
  });
});

describe('createReadPageTool', () => {
  const tool = (sentences = page, extra = {}) =>
    createReadPageTool({
      excerptSentences: ['Page sentence number 12 here.'],
      loadPage: vi.fn(async () => ({ sentences, ...extra })),
    });

  it('exposes the read_page definition', () => {
    expect(tool().definition).toBe(READ_PAGE_TOOL);
  });

  it('starts a few lines before the excerpt by default', async () => {
    const result = JSON.parse(await tool().run({}, { maxChars: 10_000 }));
    expect(result).toMatchObject({
      kind: 'page_text',
      totalLines: 20,
      excerptStartsAtLine: 12,
      startLine: 7,
      endLine: 20,
    });
    expect(result.nextStartLine).toBeUndefined();
    expect(result.numberedText.split('\n')[0]).toBe('7: Page sentence number 7 here.');
  });

  it('pages through the text within the character budget', async () => {
    const result = JSON.parse(await tool().run({ start_line: 1 }, { maxChars: 520 }));
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBeLessThan(20);
    expect(result.nextStartLine).toBe(result.endLine + 1);
  });

  it('clamps start_line and reports a truncated capture', async () => {
    const result = JSON.parse(
      await tool(page, { truncated: true }).run({ start_line: 99 }, { maxChars: 10_000 }),
    );
    expect(result).toMatchObject({ startLine: 20, endLine: 20, truncated: true });
  });

  it('returns part of a line that does not fit, and fails with no budget', async () => {
    const long = tool(['x'.repeat(5000)]);
    const result = JSON.parse(await long.run({}, { maxChars: 1000 }));
    expect(result.numberedText).toHaveLength(600);
    await expect(long.run({}, { maxChars: 100 })).rejects.toThrow(/no context budget/);
  });

  it('fails for a page without text', async () => {
    await expect(tool([]).run({}, { maxChars: 1000 })).rejects.toThrow(/no readable text/);
  });
});
