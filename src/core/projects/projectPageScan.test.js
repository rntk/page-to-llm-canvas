import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CHUNKS_PER_PAGE,
  MAX_FINDINGS_PER_PAGE,
  MAX_PASSAGES_PER_PAGE,
  QUOTE_LINE_MAX_CHARS,
  buildPagePassages,
  createDecisionPageJudge,
  createLlmPageJudge,
  formatScanResults,
  mergeChunkVerdicts,
  normalizeFindings,
  parseScanReply,
  readHelpsProbability,
  scanProjectPages,
  selectPassages,
  verdictFromProbabilities,
} from './projectPageScan.js';
import {
  PAGE_SCAN_SYSTEM_PROMPT,
  PASSAGE_CHOICES,
  PASSAGE_HELPS_THRESHOLD,
  PASSAGE_UNRELATED_THRESHOLD,
} from './projectPageScanPrompts.js';
import { UNTRUSTED_CONTENT_TAIL } from '../../shared/runtime/promptSecurity.js';

const makePages = (count) =>
  Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    title: `Page ${index + 1}`,
    url: `https://p${index + 1}.test/`,
  }));

const lines = (count, prefix = 'Line') =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}.`);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('scanProjectPages', () => {
  it('returns results in page order with normalized findings and topics', async () => {
    const pages = makePages(3);
    const loadPage = vi.fn(async (page) => ({
      sentences: lines(10),
      topics: page.page === 1 ? ['Cats', 'Cats', '  ', 'Dogs'] : undefined,
    }));
    const delays = { 1: 30, 2: 0, 3: 10 };
    const judge = vi.fn(async ({ page }) => {
      await new Promise((resolve) => setTimeout(resolve, delays[page.page]));
      if (page.page === 2)
        return { relevance: 'none', summary: 'ignored', findings: [{ startLine: 1 }] };
      return {
        relevance: 'high',
        summary: `About page ${page.page}`,
        findings: [
          { startLine: 8, endLine: 50, note: 'tail' },
          { startLine: 3, endLine: 1, note: 'reversed' },
          { startLine: 'x', endLine: 2 },
          { startLine: 20, endLine: 30 },
          { startLine: 1, endLine: 3, note: 'duplicate of reversed' },
        ],
      };
    });
    const results = await scanProjectPages({ pages, question: 'cats?', loadPage, judge });
    expect(results.map((r) => r.page)).toEqual([1, 2, 3]);
    expect(results[0]).toEqual({
      page: 1,
      title: 'Page 1',
      url: 'https://p1.test/',
      relevance: 'high',
      summary: 'About page 1',
      findings: [
        { startLine: 1, endLine: 3, note: 'reversed', lines: ['Line 1.', 'Line 2.', 'Line 3.'] },
        { startLine: 8, endLine: 10, note: 'tail', lines: ['Line 8.', 'Line 9.', 'Line 10.'] },
      ],
      totalLines: 10,
      topics: ['Cats', 'Dogs'],
    });
    expect(results[1]).toMatchObject({ relevance: 'none', summary: '', findings: [], topics: [] });
    expect(judge.mock.calls[0][0]).toMatchObject({ question: 'cats?', page: pages[0] });
  });

  it('passes cleaned earlier questions to the judge', async () => {
    const judge = vi.fn(async () => ({ relevance: 'none', summary: '', findings: [] }));
    await scanProjectPages({
      pages: makePages(1),
      question: 'q',
      earlierQuestions: ['first', '  ', 'second'],
      loadPage: async () => ({ sentences: ['a'] }),
      judge,
    });
    expect(judge.mock.calls[0][0].earlierQuestions).toEqual(['first', 'second']);
  });

  it('never runs more than `concurrency` pages at once', async () => {
    let active = 0;
    let peak = 0;
    const judge = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { relevance: 'none', summary: '', findings: [] };
    };
    const results = await scanProjectPages({
      pages: makePages(9),
      question: 'q',
      loadPage: async () => ({ sentences: ['a'] }),
      judge,
      concurrency: 2,
    });
    expect(results).toHaveLength(9);
    expect(peak).toBe(2);
  });

  it('isolates load, judge and verdict failures as unknown pages', async () => {
    const loadPage = async (page) => {
      if (page.page === 1) throw new Error('capture failed');
      if (page.page === 2) return { sentences: [] };
      return { sentences: lines(4), topics: ['T'] };
    };
    const judge = async ({ page }) => {
      if (page.page === 3) throw new Error(`model said no ${'x'.repeat(400)}`);
      if (page.page === 4) return { relevance: 'maybe' };
      return { relevance: 'low', summary: 'Some', findings: [] };
    };
    const results = await scanProjectPages({ pages: makePages(5), question: 'q', loadPage, judge });
    expect(results.map((r) => r.relevance)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'low',
    ]);
    expect(results[0].error).toBe('capture failed');
    expect(results[1].error).toMatch(/no readable text/);
    expect(results[2].error.length).toBeLessThanOrEqual(160);
    expect(results[2]).toMatchObject({ totalLines: 4, topics: ['T'], findings: [] });
    expect(results[3].error).toMatch(/invalid relevance/);
  });

  it('reports progress after each page and ignores progress errors', async () => {
    const onProgress = vi.fn(() => {
      throw new Error('ui bug');
    });
    await scanProjectPages({
      pages: makePages(3),
      question: 'q',
      loadPage: async () => ({ sentences: ['a'] }),
      judge: async () => ({ relevance: 'none', summary: '', findings: [] }),
      concurrency: 1,
      onProgress,
    });
    expect(onProgress.mock.calls.map(([event]) => [event.done, event.total, event.page])).toEqual([
      [1, 3, 1],
      [2, 3, 2],
      [3, 3, 3],
    ]);
    expect(onProgress.mock.calls[0][0].result.relevance).toBe('none');
  });

  it('rejects the whole scan with the abort reason, even while a page hangs', async () => {
    const controller = new AbortController();
    const hang = deferred();
    const judge = vi.fn(() => hang.promise);
    const scan = scanProjectPages({
      pages: makePages(4),
      question: 'q',
      loadPage: async () => ({ sentences: ['a'] }),
      judge,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(scan).rejects.toBe(reason);
    hang.resolve({ relevance: 'none', summary: '', findings: [] });
  });

  it('turns a judge failure caused by abort into a scan rejection, not an unknown page', async () => {
    const controller = new AbortController();
    const judge = async () => {
      controller.abort();
      throw new Error('request aborted');
    };
    await expect(
      scanProjectPages({
        pages: makePages(2),
        question: 'q',
        loadPage: async () => ({ sentences: ['a'] }),
        judge,
        concurrency: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects at once when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const loadPage = vi.fn();
    await expect(
      scanProjectPages({
        pages: makePages(1),
        question: 'q',
        loadPage,
        judge: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('keeps a valid scannedThroughLine / scannedLines and drops meaningless ones', async () => {
    const verdicts = [
      { relevance: 'low', summary: '', findings: [], scannedThroughLine: 5 },
      { relevance: 'low', summary: '', findings: [], scannedThroughLine: 10 },
      { relevance: 'low', summary: '', findings: [], scannedLines: 7 },
    ];
    const results = await scanProjectPages({
      pages: makePages(3),
      question: 'q',
      loadPage: async () => ({ sentences: lines(10) }),
      judge: async ({ page }) => verdicts[page.page - 1],
    });
    expect(results[0].scannedThroughLine).toBe(5);
    expect(results[1]).not.toHaveProperty('scannedThroughLine');
    expect(results[2].scannedLines).toBe(7);
  });
});

describe('normalizeFindings', () => {
  it('keeps the first findings in priority order up to the cap, then sorts by line', () => {
    const findings = Array.from({ length: MAX_FINDINGS_PER_PAGE + 4 }, (_, index) => ({
      startLine: 60 - index,
      endLine: 60 - index,
      note: 'n'.repeat(300),
    }));
    const kept = normalizeFindings(findings, { maxLine: 100 });
    expect(MAX_FINDINGS_PER_PAGE).toBe(24);
    expect(kept).toHaveLength(MAX_FINDINGS_PER_PAGE);
    expect(kept.map((f) => f.startLine)).toEqual(
      Array.from({ length: MAX_FINDINGS_PER_PAGE }, (_, index) => 37 + index),
    );
    expect(kept[0].note.length).toBeLessThanOrEqual(200);
  });

  it('drops ranges outside the bounds and clamps partial ones', () => {
    expect(
      normalizeFindings(
        [
          { startLine: 0, endLine: 2 },
          { startLine: 11, endLine: 12 },
          { startLine: 4.5, endLine: 5 },
          { startLine: '7', endLine: '8' },
          { startLine: true, endLine: 1 },
        ],
        { minLine: 1, maxLine: 10 },
      ),
    ).toEqual([
      { startLine: 1, endLine: 2, note: '' },
      { startLine: 7, endLine: 8, note: '' },
    ]);
  });
});

describe('parseScanReply', () => {
  it('parses a plain JSON reply', () => {
    expect(
      parseScanReply(
        '{"relevance":"high","summary":"S.","findings":[{"start_line":2,"end_line":3,"note":"n"}]}',
      ),
    ).toEqual({
      relevance: 'high',
      summary: 'S.',
      findings: [{ startLine: 2, endLine: 3, note: 'n' }],
    });
  });

  it('accepts code fences, surrounding prose, case and missing fields', () => {
    expect(parseScanReply('Here you go:\n```json\n{"relevance": " LOW "}\n```\nDone.')).toEqual({
      relevance: 'low',
      summary: '',
      findings: [],
    });
    expect(
      parseScanReply('Sure. {"note": "a } brace"} then {"relevance":"none","findings":"bad"} ok'),
    ).toEqual({ relevance: 'none', summary: '', findings: [] });
  });

  it('keeps single-line findings and leaves bad numbers to normalization', () => {
    const parsed = parseScanReply(
      '{"relevance":"high","findings":[{"start_line":4},{"start_line":"x"}]}',
    );
    expect(parsed.findings[0]).toEqual({ startLine: 4, endLine: 4, note: '' });
    expect(normalizeFindings(parsed.findings, { maxLine: 10 })).toEqual([
      { startLine: 4, endLine: 4, note: '' },
    ]);
  });

  it('treats unparseable or relevance-less replies as errors', () => {
    expect(() => parseScanReply('The page is not relevant.')).toThrow(/not a JSON object/);
    expect(() => parseScanReply('{"relevance": "maybe"}')).toThrow(/no valid relevance/);
    expect(() => parseScanReply('[1,2]')).toThrow();
    expect(() => parseScanReply('')).toThrow();
  });
});

describe('mergeChunkVerdicts', () => {
  it('lets the highest relevance win and puts high findings first', () => {
    const merged = mergeChunkVerdicts([
      { relevance: 'low', summary: 'Low.', findings: [{ startLine: 1, endLine: 1, note: 'l' }] },
      { relevance: 'none', summary: '', findings: [{ startLine: 5, endLine: 5 }] },
      { relevance: 'high', summary: 'High.', findings: [{ startLine: 9, endLine: 9, note: 'h' }] },
      { relevance: 'high', summary: 'High.', findings: [] },
    ]);
    expect(merged.relevance).toBe('high');
    expect(merged.summary).toBe('High.');
    expect(merged.findings.map((f) => f.startLine)).toEqual([9, 1]);
    expect(mergeChunkVerdicts([{ relevance: 'none', summary: 'x', findings: [] }])).toEqual({
      relevance: 'none',
      summary: '',
      findings: [],
    });
  });
});

describe('createLlmPageJudge', () => {
  const page = { page: 2, title: 'Cats', url: 'https://cats.test/' };

  it('sends a static system prompt, the page data first and the question last', async () => {
    const complete = vi.fn(async () => ({
      ok: true,
      content:
        '{"relevance":"high","summary":"Cats purr.","findings":[{"start_line":2,"end_line":2,"note":"purr"}]}',
    }));
    const judge = createLlmPageJudge({ complete, maxChunkChars: 4000 });
    const verdict = await judge({
      page,
      loaded: { sentences: ['Cats.', 'They purr.'] },
      question: 'Do cats purr?',
    });
    expect(verdict).toEqual({
      relevance: 'high',
      summary: 'Cats purr.',
      findings: [{ startLine: 2, endLine: 2, note: 'purr' }],
    });
    const [{ messages, taskType }] = complete.mock.calls[0];
    expect(taskType).toBe('chat_page_scan');
    expect(messages[0]).toEqual({ role: 'system', content: PAGE_SCAN_SYSTEM_PROMPT });
    expect(PAGE_SCAN_SYSTEM_PROMPT).toContain(UNTRUSTED_CONTENT_TAIL);
    expect(JSON.parse(messages[1].content)).toEqual({
      kind: 'page_chunk',
      page: { title: 'Cats', url: 'https://cats.test/' },
      totalLines: 2,
      startLine: 1,
      endLine: 2,
      numberedText: '1: Cats.\n2: They purr.',
    });
    expect(JSON.parse(messages[2].content)).toEqual({ kind: 'question', text: 'Do cats purr?' });
  });

  it('keeps the page prefix identical across questions', async () => {
    const complete = vi.fn(async () => ({ ok: true, content: '{"relevance":"none"}' }));
    const judge = createLlmPageJudge({ complete, maxChunkChars: 4000 });
    const loaded = { sentences: ['A.', 'B.'] };
    await judge({ page, loaded, question: 'one' });
    await judge({ page, loaded, question: 'two' });
    const [first, second] = complete.mock.calls.map(([call]) => call.messages);
    expect(first.slice(0, 2)).toEqual(second.slice(0, 2));
    expect(first[2]).not.toEqual(second[2]);
  });

  it('scans at most maxChunksPerPage chunks, merges them and clamps findings to each chunk', async () => {
    const sentences = lines(40, 'Sentence number');
    const replies = [
      '{"relevance":"low","summary":"Low.","findings":[{"start_line":1,"end_line":2}]}',
      '{"relevance":"high","summary":"High.","findings":[{"start_line":1,"end_line":999,"note":"x"}]}',
    ];
    const complete = vi.fn(async () => ({ ok: true, content: replies.shift() }));
    const judge = createLlmPageJudge({ complete, maxChunkChars: 200, maxChunksPerPage: 2 });
    const verdict = await judge({ page, loaded: { sentences }, question: 'q' });
    expect(complete).toHaveBeenCalledTimes(2);
    const second = JSON.parse(complete.mock.calls[1][0].messages[1].content);
    expect(verdict.relevance).toBe('high');
    expect(verdict.summary).toBe('High.');
    expect(verdict.findings).toEqual([
      { startLine: second.startLine, endLine: second.endLine, note: 'x' },
      { startLine: 1, endLine: 2, note: '' },
    ]);
    expect(verdict.scannedThroughLine).toBe(second.endLine);
    expect(second.endLine).toBeLessThan(40);
  });

  it('fails the page on a failed request or unparseable reply', async () => {
    const failing = createLlmPageJudge({
      complete: async () => ({ ok: false, error: 'rate limited' }),
      maxChunkChars: 4000,
    });
    await expect(failing({ page, loaded: { sentences: ['A.'] }, question: 'q' })).rejects.toThrow(
      'rate limited',
    );
    const prose = createLlmPageJudge({
      complete: async () => ({ ok: true, content: 'Nothing here.' }),
      maxChunkChars: 4000,
    });
    await expect(prose({ page, loaded: { sentences: ['A.'] }, question: 'q' })).rejects.toThrow(
      /JSON/,
    );
  });

  it('produces an unknown page through scanProjectPages when the reply is bad', async () => {
    const judge = createLlmPageJudge({
      complete: async () => ({ ok: true, content: 'nope' }),
      maxChunkChars: 4000,
    });
    const [result] = await scanProjectPages({
      pages: [page],
      question: 'q',
      loadPage: async () => ({ sentences: ['A.'] }),
      judge,
    });
    expect(result.relevance).toBe('unknown');
    expect(result.error).toMatch(/JSON/);
  });

  it('stops between chunks when aborted', async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => {
      controller.abort();
      return { ok: true, content: '{"relevance":"none"}' };
    });
    const judge = createLlmPageJudge({ complete, maxChunkChars: 60 });
    await expect(
      judge({ page, loaded: { sentences: lines(20) }, question: 'q', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('validates its options', () => {
    expect(() => createLlmPageJudge({ maxChunkChars: 10 })).toThrow(/complete/);
    expect(() =>
      createLlmPageJudge({ complete: vi.fn(), maxChunkChars: 10, maxChunksPerPage: 0 }),
    ).toThrow(/maxChunksPerPage must be a positive integer or Infinity/);
    expect(() =>
      createLlmPageJudge({ complete: vi.fn(), maxChunkChars: 10, maxChunksPerPage: Infinity }),
    ).not.toThrow();
  });

  it('reads every chunk by default and reports no scannedThroughLine', async () => {
    expect(DEFAULT_MAX_CHUNKS_PER_PAGE).toBe(Infinity);
    const sentences = lines(60, 'Sentence number');
    const complete = vi.fn(async () => ({ ok: true, content: '{"relevance":"none"}' }));
    const judge = createLlmPageJudge({ complete, maxChunkChars: 200 });
    const verdict = await judge({ page, loaded: { sentences }, question: 'q' });
    expect(complete.mock.calls.length).toBeGreaterThan(5);
    const ranges = complete.mock.calls.map(([call]) => JSON.parse(call.messages[1].content));
    expect(ranges[0].startLine).toBe(1);
    expect(ranges.at(-1).endLine).toBe(60);
    expect(verdict).not.toHaveProperty('scannedThroughLine');
  });

  it('passes earlier questions to the question message, only when present', async () => {
    const complete = vi.fn(async () => ({ ok: true, content: '{"relevance":"none"}' }));
    const judge = createLlmPageJudge({ complete, maxChunkChars: 4000 });
    const loaded = { sentences: ['A.', 'B.'] };
    await judge({ page, loaded, question: 'And the price?', earlierQuestions: ['What is it?'] });
    await judge({ page, loaded, question: 'No history' });
    const [withEarlier, without] = complete.mock.calls.map(([call]) =>
      JSON.parse(call.messages[2].content),
    );
    expect(withEarlier).toEqual({
      kind: 'question',
      text: 'And the price?',
      earlier_questions: ['What is it?'],
    });
    expect(without).toEqual({ kind: 'question', text: 'No history' });
  });
});

// Decision answers in the server's shape.
const answer = (p) => ({
  choice: p >= 0.5 ? 'helps_answer' : 'unrelated',
  probabilities: { helps_answer: p, unrelated: Math.round((1 - p) * 1e6) / 1e6 },
});

const passageSentences = (count, word = 'filler') =>
  Array.from(
    { length: count },
    (_, index) => `${`${word} sentence ${index + 1} `.padEnd(398, 'x')}.`,
  );

describe('buildPagePassages', () => {
  it('groups whole sentences into windows of about 800–1500 chars', () => {
    const passages = buildPagePassages(passageSentences(10));
    expect(passages.map((p) => [p.startLine, p.endLine])).toEqual([
      [1, 3],
      [4, 6],
      [7, 9],
      [10, 10],
    ]);
    for (const passage of passages) expect(passage.text.length).toBeLessThanOrEqual(1500);
  });

  it('skips empty sentences, keeps line numbers and shortens one oversized sentence', () => {
    const passages = buildPagePassages(['', 'Short.', '  ', 'y'.repeat(3000), 'End.']);
    expect(passages.map((p) => [p.startLine, p.endLine])).toEqual([
      [2, 2],
      [4, 4],
      [5, 5],
    ]);
    expect(passages[1].text.length).toBe(1500);
  });
});

describe('selectPassages', () => {
  it('keeps everything under the cap', () => {
    expect(selectPassages([{ text: 'a' }, { text: 'b' }], 'q', 5)).toEqual([0, 1]);
  });

  it('keeps the lead passage plus the passages sharing the rarest question words', () => {
    const passages = Array.from({ length: 10 }, (_, index) => ({
      text: `the common text ${index === 6 ? 'zebra stripes' : ''} ${index === 3 ? 'zebra' : ''}`,
    }));
    expect(selectPassages(passages, 'the zebra stripes', 3)).toEqual([0, 3, 6]);
  });
});

describe('readHelpsProbability', () => {
  it('validates the answer like the topic splitter', () => {
    expect(readHelpsProbability({ answers: { p1: answer(0.8) } }, 'p1')).toBe(0.8);
    const bad = [
      undefined,
      { choice: 'maybe', probabilities: { helps_answer: 0.5, unrelated: 0.5 } },
      { choice: 'helps_answer', probabilities: { helps_answer: 0.9 } },
      { choice: 'helps_answer', probabilities: { helps_answer: 0.9, unrelated: 0.9 } },
      { choice: 'helps_answer', probabilities: { helps_answer: 1.2, unrelated: -0.2 } },
    ];
    for (const value of bad) {
      expect(() => readHelpsProbability({ answers: { p1: value } }, 'p1')).toThrow(/invalid/);
    }
  });
});

describe('verdictFromProbabilities', () => {
  const judged = (probabilities) =>
    probabilities.map((probability, index) => ({
      index,
      startLine: index * 3 + 1,
      endLine: index * 3 + 3,
      text: `Passage ${index} text`,
      probability,
    }));

  it('uses the documented thresholds', () => {
    expect(PASSAGE_HELPS_THRESHOLD).toBe(0.7);
    expect(PASSAGE_UNRELATED_THRESHOLD).toBe(0.3);
  });

  it('marks passages at or above the helps threshold as merged findings', () => {
    const verdict = verdictFromProbabilities(judged([0.1, 0.7, 0.95, 0.2, 0.8]));
    expect(verdict.relevance).toBe('high');
    expect(verdict.summary).toBe('');
    expect(verdict.findings).toEqual([
      { startLine: 4, endLine: 9, note: '"Passage 1 text" (p=0.95)' },
      { startLine: 13, endLine: 15, note: '"Passage 4 text" (p=0.80)' },
    ]);
  });

  it('reports an unsettled page as low with its best one or two passages', () => {
    const verdict = verdictFromProbabilities(judged([0.31, 0.1, 0.65, 0.5]));
    expect(verdict.relevance).toBe('low');
    expect(verdict.findings.map((f) => f.startLine)).toEqual([7, 10]);
    expect(verdict.findings[0].note).toMatch(/p=0\.65/);
  });

  it('reports none when every passage is below the unrelated threshold', () => {
    expect(verdictFromProbabilities(judged([0.29, 0.0]))).toEqual({
      relevance: 'none',
      summary: '',
      findings: [],
    });
  });
});

describe('createDecisionPageJudge', () => {
  const page = { page: 1, title: 'Zebras', url: 'https://z.test/' };

  const fakeDecide = (probabilityFor) =>
    vi.fn(async (_state, questions) => ({
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          answer(probabilityFor(id, question)),
        ]),
      ),
    }));

  it('asks one choice question per passage with shared state, batched per request', async () => {
    const decide = fakeDecide((id) => (id === 'p3' ? 0.9 : 0.05));
    const judge = createDecisionPageJudge({ decide, passagesPerRequest: 2 });
    const verdict = await judge({
      page,
      loaded: { sentences: passageSentences(12) },
      question: 'How fast?',
    });
    expect(decide).toHaveBeenCalledTimes(2);
    const [state, questions, options] = decide.mock.calls[0];
    expect(state).toMatchObject({ user_question: 'How fast?', page_title: 'Zebras' });
    expect(Object.keys(questions)).toEqual(['p1', 'p2']);
    expect(questions.p1.type).toBe('choice');
    expect(questions.p1.criteria).toEqual(PASSAGE_CHOICES);
    expect(questions.p1.instructions).toContain('filler sentence 1');
    expect(questions.p1.instructions).not.toContain('filler sentence 4 ');
    expect(options.taskType).toBe('chat_page_scan');
    expect(Object.keys(decide.mock.calls[1][1])).toEqual(['p3', 'p4']);
    expect(verdict).toMatchObject({ relevance: 'high', summary: '' });
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ startLine: 7, endLine: 9 });
    expect(verdict.findings[0].note).toMatch(/^"filler sentence 7 x+…" \(p=0\.90\)$/);
    expect(verdict).not.toHaveProperty('scannedLines');
  });

  it('splits a batch that does not fit the context window', async () => {
    const decide = fakeDecide(() => 0.1);
    const judge = createDecisionPageJudge({ decide, contextWindowTokens: 1200 });
    const verdict = await judge({
      page,
      loaded: { sentences: passageSentences(24) },
      question: 'q',
    });
    expect(verdict.relevance).toBe('none');
    const sizes = decide.mock.calls.map(([, questions]) => Object.keys(questions).length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(8);
    expect(Math.max(...sizes)).toBeLessThan(8);
  });

  it('fails when one passage question cannot fit at all', async () => {
    const judge = createDecisionPageJudge({ decide: vi.fn(), contextWindowTokens: 50 });
    await expect(
      judge({ page, loaded: { sentences: passageSentences(3) }, question: 'q' }),
    ).rejects.toThrow(/too small/);
  });

  it('treats a missing or invalid answer as a page error, never as "no"', async () => {
    const decide = vi.fn(async () => ({ answers: { p1: answer(0.1) } }));
    const judge = createDecisionPageJudge({ decide });
    await expect(
      judge({ page, loaded: { sentences: passageSentences(6) }, question: 'q' }),
    ).rejects.toThrow(/invalid decision answer for passage p2/);
    const [result] = await scanProjectPages({
      pages: [page],
      question: 'q',
      loadPage: async () => ({ sentences: passageSentences(6) }),
      judge,
    });
    expect(result.relevance).toBe('unknown');
  });

  it('caps passages per page and reports how many lines were judged', async () => {
    const sentences = passageSentences(30).map((text, index) =>
      index === 25 ? text.replace('xxxxxx', 'zebra ') : text,
    );
    const decide = fakeDecide((_id, question) =>
      question.instructions.includes('zebra') ? 0.9 : 0,
    );
    const judge = createDecisionPageJudge({ decide, maxPassagesPerPage: 3 });
    const verdict = await judge({ page, loaded: { sentences }, question: 'zebra' });
    const asked = decide.mock.calls.flatMap(([, questions]) => Object.keys(questions));
    expect(asked).toHaveLength(3);
    expect(asked[0]).toBe('p1');
    expect(verdict.relevance).toBe('high');
    expect(verdict.findings[0]).toMatchObject({ startLine: 25, endLine: 27 });
    expect(verdict.scannedLines).toBe(9);
  });

  it('judges every passage by default and sends earlier questions in the state', async () => {
    expect(MAX_PASSAGES_PER_PAGE).toBe(Infinity);
    const decide = fakeDecide(() => 0.1);
    const judge = createDecisionPageJudge({ decide });
    const sentences = passageSentences(60);
    const verdict = await judge({
      page,
      loaded: { sentences },
      question: 'q',
      earlierQuestions: ['before?'],
    });
    const asked = decide.mock.calls.flatMap(([, questions]) => Object.keys(questions));
    expect(asked).toHaveLength(buildPagePassages(sentences).length);
    expect(verdict).not.toHaveProperty('scannedLines');
    expect(decide.mock.calls[0][0].earlier_questions).toEqual(['before?']);
    expect(() => createDecisionPageJudge({ decide, maxPassagesPerPage: Infinity })).not.toThrow();
    expect(() => createDecisionPageJudge({ decide, maxPassagesPerPage: 0 })).toThrow(
      /positive integer or Infinity/,
    );
  });

  it('retries transient errors and propagates others', async () => {
    let calls = 0;
    const decide = vi.fn(async (_state, questions) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { status: 503 });
      return {
        answers: Object.fromEntries(Object.keys(questions).map((id) => [id, answer(0.5)])),
      };
    });
    const sleep = vi.fn(async () => {});
    const judge = createDecisionPageJudge({ decide, sleep, random: () => 0 });
    const verdict = await judge({ page, loaded: { sentences: ['One.'] }, question: 'q' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(verdict.relevance).toBe('low');

    const broken = createDecisionPageJudge({
      decide: async () => {
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
      sleep,
    });
    await expect(broken({ page, loaded: { sentences: ['One.'] }, question: 'q' })).rejects.toThrow(
      'bad request',
    );
  });

  it('validates its options', () => {
    expect(() => createDecisionPageJudge({})).toThrow(/decide/);
    expect(() => createDecisionPageJudge({ decide: vi.fn(), maxPassagesPerPage: 0 })).toThrow();
    expect(() => createDecisionPageJudge({ decide: vi.fn(), passagesPerRequest: 1.5 })).toThrow();
  });
});

describe('formatScanResults', () => {
  const result = (page, relevance, extra = {}) => ({
    page,
    title: `Title ${page}`,
    url: `https://${page}.test/`,
    relevance,
    summary: relevance === 'none' || relevance === 'unknown' ? '' : `Summary ${page}.`,
    findings:
      relevance === 'high' || relevance === 'low'
        ? [
            { startLine: 3, endLine: 5, note: `Note ${page}` },
            { startLine: 9, endLine: 9, note: '' },
          ]
        : [],
    totalLines: 20,
    topics: [],
    ...extra,
  });

  const sample = [
    result(1, 'none'),
    result(2, 'low', { topics: Array.from({ length: 10 }, (_, i) => `T${i}`) }),
    result(3, 'unknown', { error: 'capture failed' }),
    result(4, 'high', { scannedThroughLine: 12 }),
    result(5, 'none'),
    result(6, 'none'),
  ];

  it('lists relevant pages first (high, then low), then nothing-relevant and failures', () => {
    const text = formatScanResults(sample, { maxChars: 5000 });
    expect(text).toBe(
      [
        'Page 4 "Title 4" — relevance high (scanned lines 1–12 of 20 only)',
        '  Summary: Summary 4.',
        '  - lines 3–5: Note 4',
        '  - line 9',
        'Page 2 "Title 2" — relevance low',
        '  Summary: Summary 2.',
        '  - lines 3–5: Note 2',
        '  - line 9',
        '  Topics: T0; T1; T2; T3; T4; T5; T6; T7; +2 more',
        'Nothing relevant found on pages: 1, 5–6.',
        'Could not scan:',
        '- page 3 "Title 3": capture failed',
      ].join('\n'),
    );
  });

  it('says when nothing was relevant or nothing was scanned', () => {
    expect(formatScanResults([], { maxChars: 100 })).toBe('No pages were scanned.');
    expect(formatScanResults([result(1, 'none')], { maxChars: 500 })).toBe(
      'No page was found relevant to the question.\nNothing relevant found on pages: 1.',
    );
  });

  it('keeps coverage limits on partly scanned pages with nothing relevant', () => {
    const list = [
      result(1, 'none'),
      result(2, 'none', { scannedThroughLine: 12 }),
      result(3, 'none', { scannedLines: 6 }),
    ];
    expect(formatScanResults(list, { maxChars: 5000 })).toBe(
      [
        'No page was found relevant to the question.',
        'Nothing relevant found on pages: 1.',
        'Nothing relevant in the scanned part (the rest of these pages was not checked):',
        '- page 2 "Title 2" (scanned lines 1–12 of 20 only)',
        '- page 3 "Title 3" (scanned 6 of 20 lines, picked by keywords)',
      ].join('\n'),
    );
    const compact = formatScanResults(
      [...sample, ...list.slice(1).map((r) => ({ ...r, page: r.page + 10 }))],
      {
        maxChars: 300,
      },
    );
    expect(compact.length).toBeLessThanOrEqual(300);
    expect(compact).toContain('only partly scanned');
    expect(compact).toContain('12–13');
  });

  it('drops notes, then topics, then findings, then summaries as the budget shrinks', () => {
    const full = formatScanResults(sample, { maxChars: 5000 });
    const noNotes = formatScanResults(sample, { maxChars: full.length - 1 });
    expect(noNotes).toContain('Findings: lines 3–5, line 9');
    expect(noNotes).not.toContain('Note 4');
    expect(noNotes).toContain('Topics:');
    const noTopics = formatScanResults(sample, { maxChars: noNotes.length - 1 });
    expect(noTopics).not.toContain('Topics:');
    expect(noTopics).toContain('Findings:');
    const noFindings = formatScanResults(sample, { maxChars: noTopics.length - 1 });
    expect(noFindings).not.toContain('Findings:');
    expect(noFindings).toContain('Summary 4.');
    expect(noFindings).toContain('Could not scan pages: 3.');
    const headers = formatScanResults(sample, { maxChars: noFindings.length - 1 });
    expect(headers).not.toContain('Summary');
    expect(headers).toContain('Page 2 "Title 2"');
  });

  describe('quoted lines', () => {
    const quoted = (page, startLine, texts, extra = {}) => ({
      page,
      title: `Title ${page}`,
      url: `https://${page}.test/`,
      relevance: 'high',
      summary: `Summary ${page}.`,
      findings: [{ startLine, endLine: startLine + texts.length - 1, note: 'n', lines: texts }],
      totalLines: 100,
      topics: [],
      ...extra,
    });
    const CUT_NOTE = 'Quotes stop here for space: read the remaining finding lines with read_page.';

    it('quotes each finding line verbatim under the finding', () => {
      const text = formatScanResults(
        [quoted(1, 7, ['Price is $4.50 (tax incl.).', 'Ships in 3-5 days.'])],
        { maxChars: 5000 },
      );
      expect(text).toBe(
        [
          'Page 1 "Title 1" — relevance high',
          '  Summary: Summary 1.',
          '  - lines 7–8: n',
          '    > 7: Price is $4.50 (tax incl.).',
          '    > 8: Ships in 3-5 days.',
        ].join('\n'),
      );
      expect(text).not.toContain(CUT_NOTE);
    });

    it('clips a long quoted line to QUOTE_LINE_MAX_CHARS', () => {
      expect(QUOTE_LINE_MAX_CHARS).toBe(600);
      const text = formatScanResults([quoted(1, 1, ['w'.repeat(2000)])], { maxChars: 5000 });
      const quote = text.split('\n').find((line) => line.startsWith('    > 1: '));
      expect(quote).toBe(`    > 1: ${'w'.repeat(QUOTE_LINE_MAX_CHARS - 1)}…`);
    });

    it('cuts quotes with a note under a tight budget and stays within maxChars', () => {
      const results = [
        quoted(
          1,
          1,
          Array.from({ length: 6 }, (_, i) => `First page line ${i} ${'a'.repeat(150)}`),
        ),
        quoted(
          2,
          1,
          Array.from({ length: 6 }, (_, i) => `Second page line ${i} ${'b'.repeat(150)}`),
        ),
      ];
      const full = formatScanResults(results, { maxChars: 100_000 });
      expect(full).not.toContain(CUT_NOTE);
      expect(full).toContain('Second page line 5');
      const withoutQuotes = formatScanResults(
        results.map((r) => ({ ...r, findings: r.findings.map(({ lines: _l, ...f }) => f) })),
        { maxChars: 100_000 },
      );
      const maxChars = withoutQuotes.length + CUT_NOTE.length + 600;
      const text = formatScanResults(results, { maxChars });
      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(text).toContain(CUT_NOTE);
      expect(text).toContain('> 1: First page line 0');
      expect(text).not.toContain('Second page line 5');
      // Both pages are still listed with their findings.
      expect(text).toContain('Page 2 "Title 2"');
      expect(text).toContain('  - lines 1–6: n');
    });

    it('falls back to the old levels, with no quotes, when level 0 without quotes does not fit', () => {
      const base = quoted(1, 1, ['Some quoted line here.']);
      const results = [
        { ...base, findings: [{ ...base.findings[0], note: 'a rather long finding note' }] },
      ];
      const level0 = formatScanResults(
        [{ ...results[0], findings: [{ ...results[0].findings[0], lines: undefined }] }],
        { maxChars: 5000 },
      );
      const text = formatScanResults(results, { maxChars: level0.length - 1 });
      expect(text).toContain('Findings: line 1');
      expect(text).not.toContain('>');
      expect(text).not.toContain(CUT_NOTE);
    });
  });

  it('then lists only the first relevant pages and counts the rest, always within budget', () => {
    const many = Array.from({ length: 30 }, (_, index) => result(index + 1, 'high'));
    const text = formatScanResults(many, { maxChars: 400 });
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toMatch(/…and \d+ more relevant pages \(/);
    for (const budget of [1, 10, 50, 120]) {
      expect(formatScanResults(many, { maxChars: budget }).length).toBeLessThanOrEqual(budget);
    }
  });
});
