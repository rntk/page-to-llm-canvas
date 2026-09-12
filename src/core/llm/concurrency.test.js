import { describe, it, expect, vi } from 'vitest';

// These helpers are re-imported per test so each case gets a fresh module
// instance, matching how the pipeline pulls them in.
async function getConcurrency() {
  vi.resetModules();
  return await import('./concurrency.js');
}

describe('parallelMap', () => {
  it('maps elements in parallel under concurrency limit', async () => {
    const { parallelMap } = await getConcurrency();
    const items = [1, 2, 3, 4, 5];
    const log = [];
    const fn = async (x) => {
      log.push(`start ${x}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`end ${x}`);
      return x * 2;
    };

    const res = await parallelMap(items, 2, fn);
    expect(res).toEqual([2, 4, 6, 8, 10]);
    expect(log[0]).toBe('start 1');
    expect(log[1]).toBe('start 2');

    const start3Index = log.indexOf('start 3');
    const end1Index = log.indexOf('end 1');
    const end2Index = log.indexOf('end 2');
    expect(start3Index).toBeGreaterThan(Math.min(end1Index, end2Index));
  });

  it('handles empty items array', async () => {
    const { parallelMap } = await getConcurrency();
    const res = await parallelMap([], 2, async (x) => x);
    expect(res).toEqual([]);
  });

  it('runs the first item to completion before the concurrent burst when warmupFirst', async () => {
    const { parallelMap } = await getConcurrency();
    const items = [1, 2, 3, 4, 5];
    const log = [];
    const fn = async (x) => {
      log.push(`start ${x}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`end ${x}`);
      return x * 2;
    };

    const res = await parallelMap(items, 2, fn, { warmupFirst: true });
    expect(res).toEqual([2, 4, 6, 8, 10]);
    // The lead item finishes entirely before anything else starts.
    expect(log.slice(0, 2)).toEqual(['start 1', 'end 1']);
    expect(log.indexOf('start 2')).toBeGreaterThan(log.indexOf('end 1'));
  });

  it('does not warm up a single-item list (keeps it in the parallel phase)', async () => {
    const { parallelMap } = await getConcurrency();
    const order = [];
    const fn = async (x) => {
      order.push(x);
      return x;
    };
    const res = await parallelMap([1], 4, fn, { warmupFirst: true });
    expect(res).toEqual([1]);
    expect(order).toEqual([1]);
  });

  it('stops claiming new items once one item rejects, but lets in-flight items finish', async () => {
    const { parallelMap } = await getConcurrency();
    const items = [1, 2, 3, 4];
    const calls = [];
    const err = new Error('item 1 failed');
    let rejectFirst;
    let resolveSecond;

    const fn = vi.fn((x) => {
      calls.push(x);
      if (x === 1) return new Promise((_resolve, reject) => (rejectFirst = reject));
      if (x === 2) return new Promise((resolve) => (resolveSecond = () => resolve(20)));
      return Promise.resolve(x * 10);
    });

    const mapPromise = parallelMap(items, 2, fn);
    // Attach the rejection handler now, before triggering the failure below,
    // so the promise is never briefly unobserved (which Node flags as an
    // unhandled rejection even when a handler follows shortly after).
    const assertion = expect(mapPromise).rejects.toBe(err);
    // Both workers claim their first item synchronously (no await before the
    // first fn call), so items 1 and 2 are in flight immediately.
    expect(calls).toEqual([1, 2]);

    rejectFirst(err);
    // Let item 1's rejection propagate and flip `failed` before item 2's
    // worker loops back to (not) claim a new item.
    await new Promise((r) => setTimeout(r, 0));

    resolveSecond();

    await assertion;
    // Items 3 and 4 were never started once the failure was recorded.
    expect(calls).toEqual([1, 2]);
  });

  it('never releases the burst when stopBurst reports the warmup item failed', async () => {
    const { parallelMap } = await getConcurrency();
    const calls = [];
    const fn = vi.fn(async (x) => {
      calls.push(x);
      // The caller records the failure instead of throwing, exactly as the
      // pipeline stages do to keep a sibling's paid-for response.
      return x === 1 ? { item: x, error: new Error('401 unauthorized') } : { item: x };
    });

    const res = await parallelMap([1, 2, 3, 4], 2, fn, {
      warmupFirst: true,
      stopBurst: (result) => Boolean(result.error),
    });

    expect(calls).toEqual([1]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res[0].error).toBeInstanceOf(Error);
    // Unclaimed items leave holes rather than looking like empty successes.
    expect(res.slice(1)).toEqual([undefined, undefined, undefined]);
  });

  it('stops claiming new items when stopBurst fires mid-burst, keeping in-flight results', async () => {
    const { parallelMap } = await getConcurrency();
    const calls = [];
    let resolveFirst;
    let resolveSecond;

    const fn = vi.fn((x) => {
      calls.push(x);
      if (x === 1) return new Promise((resolve) => (resolveFirst = resolve));
      if (x === 2) return new Promise((resolve) => (resolveSecond = resolve));
      return Promise.resolve({ item: x });
    });

    const mapPromise = parallelMap([1, 2, 3, 4], 2, fn, {
      stopBurst: (result) => Boolean(result.error),
    });
    expect(calls).toEqual([1, 2]);

    resolveFirst({ item: 1, error: new Error('401 unauthorized') });
    await new Promise((r) => setTimeout(r, 0));
    resolveSecond({ item: 2 });

    // The recorded failure stops the queue without rejecting: the sibling that
    // was already in flight still lands in the results.
    const res = await mapPromise;
    expect(calls).toEqual([1, 2]);
    expect(res[0].error).toBeInstanceOf(Error);
    expect(res[1]).toEqual({ item: 2 });
    expect(res.slice(2)).toEqual([undefined, undefined]);
  });

  it('keeps dispatching when stopBurst declines a recorded failure', async () => {
    const { parallelMap } = await getConcurrency();
    const calls = [];
    const fn = vi.fn(async (x) => {
      calls.push(x);
      return x === 1 ? { item: x, retryable: true, error: new Error('429') } : { item: x };
    });

    const res = await parallelMap([1, 2, 3, 4], 2, fn, {
      warmupFirst: true,
      stopBurst: (result) => Boolean(result.error) && !result.retryable,
    });

    expect(calls.sort()).toEqual([1, 2, 3, 4]);
    expect(res).toHaveLength(4);
  });
});

describe('createLimiter', () => {
  it('never runs more tasks than the limit concurrently', async () => {
    const { createLimiter } = await getConcurrency();
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;
    const task = async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return x * 2;
    };

    const res = await Promise.all([1, 2, 3, 4, 5].map((x) => limit(() => task(x))));
    expect(res).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBe(2);
  });

  it('propagates rejections and keeps admitting queued tasks', async () => {
    const { createLimiter } = await getConcurrency();
    const limit = createLimiter(1);
    const order = [];

    const failing = limit(async () => {
      order.push('fail');
      throw new Error('boom');
    });
    const succeeding = limit(async () => {
      order.push('ok');
      return 42;
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(succeeding).resolves.toBe(42);
    expect(order).toEqual(['fail', 'ok']);
  });

  it('releases the slot and admits the next task before settling the completed task', async () => {
    const { createLimiter } = await getConcurrency();
    const limit = createLimiter(1);
    let releaseFirst;
    let secondStarted = false;

    const first = limit(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = limit(async () => {
      secondStarted = true;
      return 'second';
    });

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    releaseFirst('first');

    await expect(first).resolves.toBe('first');
    expect(secondStarted).toBe(true);
    await expect(second).resolves.toBe('second');
  });

  it('releases the slot before propagating a task rejection', async () => {
    const { createLimiter } = await getConcurrency();
    const limit = createLimiter(1);
    const failure = new Error('first failed');
    let rejectFirst;
    let secondStarted = false;

    const first = limit(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const firstAssertion = expect(first).rejects.toBe(failure);
    const second = limit(async () => {
      secondStarted = true;
      return 'second';
    });

    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    rejectFirst(failure);

    await firstAssertion;
    expect(secondStarted).toBe(true);
    await expect(second).resolves.toBe('second');
  });

  it('runs queued tasks in FIFO order under a limit of 1', async () => {
    const { createLimiter } = await getConcurrency();
    const limit = createLimiter(1);
    const order = [];
    await Promise.all(
      [1, 2, 3].map((x) =>
        limit(async () => {
          order.push(x);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('treats a limit of 0 or NaN as a limit of 1 instead of stalling forever', async () => {
    const { createLimiter } = await getConcurrency();
    for (const badLimit of [0, NaN]) {
      const limit = createLimiter(badLimit);
      let active = 0;
      let maxActive = 0;
      const task = async (x) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return x;
      };

      const res = await Promise.all([1, 2, 3].map((x) => limit(() => task(x))));
      expect(res).toEqual([1, 2, 3]);
      expect(maxActive).toBe(1);
    }
  });
});

describe('createAdjustableLimiter', () => {
  it('reserves capacity for priority work without exceeding the aggregate cap', async () => {
    const { createAdjustableLimiter } = await getConcurrency();
    const limiter = createAdjustableLimiter(4, { reservedPrioritySlots: 1 });
    const releases = [];
    const started = [];
    const run = (id, priority = false) =>
      limiter.run(
        () =>
          new Promise((resolve) => {
            started.push(id);
            releases.push(resolve);
          }),
        undefined,
        { priority },
      );

    const standardTasks = [run('pipeline-1'), run('pipeline-2'), run('pipeline-3')];
    const queuedStandard = run('pipeline-4');
    await vi.waitFor(() => expect(started).toEqual(['pipeline-1', 'pipeline-2', 'pipeline-3']));

    const chatTask = run('chat', true);
    await vi.waitFor(() =>
      expect(started).toEqual(['pipeline-1', 'pipeline-2', 'pipeline-3', 'chat']),
    );

    // Four tasks are active: the shared aggregate limit is still enforced.
    expect(started).not.toContain('pipeline-4');
    releases.shift()();
    await vi.waitFor(() => expect(started).toContain('pipeline-4'));
    releases.forEach((release) => release());
    await Promise.all([...standardTasks, queuedStandard, chatTask]);
  });

  it('keeps standard work enabled when a one-slot limit cannot reserve capacity', async () => {
    const { createAdjustableLimiter } = await getConcurrency();
    const limiter = createAdjustableLimiter(1, { reservedPrioritySlots: 1 });

    await expect(limiter.run(async () => 'pipeline')).resolves.toBe('pipeline');
  });

  it('applies a lower limit to queued tasks without replacing the queue', async () => {
    const { createAdjustableLimiter } = await getConcurrency();
    const limiter = createAdjustableLimiter(2);
    const releases = [];
    const started = [];
    const task = (id) =>
      limiter.run(
        () =>
          new Promise((resolve) => {
            started.push(id);
            releases[id] = resolve;
          }),
      );

    const tasks = [task(0), task(1), task(2), task(3)];
    await vi.waitFor(() => expect(started).toEqual([0, 1]));

    limiter.setLimit(1);
    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    releases[1]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases[2]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[3]();
    await Promise.all(tasks);
  });

  it('raises the limit and admits queued tasks immediately', async () => {
    const { createAdjustableLimiter } = await getConcurrency();
    const limiter = createAdjustableLimiter(1);
    const releases = [];
    const started = [];
    const task = (id) =>
      limiter.run(
        () =>
          new Promise((resolve) => {
            started.push(id);
            releases[id] = resolve;
          }),
      );

    const tasks = [task(0), task(1), task(2)];
    await vi.waitFor(() => expect(started).toEqual([0]));
    limiter.setLimit(3);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases.forEach((release) => release());
    await Promise.all(tasks);
  });

  it('rejects with AbortError and never calls fn when the signal is already aborted', async () => {
    const { createAdjustableLimiter } = await getConcurrency();
    const limiter = createAdjustableLimiter(2);
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'result');

    await expect(limiter.run(fn, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a queued task the moment its signal aborts, leaving slot accounting intact', async () => {
    const { createAdjustableLimiter } = await getConcurrency();
    const limiter = createAdjustableLimiter(1);
    let releaseA;
    // Occupy the only slot with a running, signal-less task.
    const taskA = limiter.run(
      () =>
        new Promise((resolve) => {
          releaseA = () => resolve('A result');
        }),
    );

    const controllerB = new AbortController();
    const fnB = vi.fn(async () => 'B result');
    // Queued behind the full limiter — never gets a slot before it aborts.
    const taskB = limiter.run(fnB, controllerB.signal);

    controllerB.abort();
    await expect(taskB).rejects.toMatchObject({ name: 'AbortError' });
    expect(fnB).not.toHaveBeenCalled();

    // A later-queued task still runs once the slot frees, proving `active`
    // was never touched by the queued cancellation above.
    const fnC = vi.fn(async () => 'C result');
    const taskC = limiter.run(fnC);

    releaseA();
    await expect(taskA).resolves.toBe('A result');
    await expect(taskC).resolves.toBe('C result');
    expect(fnC).toHaveBeenCalledTimes(1);
  });

  it('runs a queued task normally when slot frees and cleans up its abort listener', async () => {
    const { createAdjustableLimiter } = await getConcurrency();
    const limiter = createAdjustableLimiter(1);
    let releaseA;
    const taskA = limiter.run(() => new Promise((r) => (releaseA = r)));

    const controllerB = new AbortController();
    const fnB = vi.fn(async () => 'B result');
    const taskB = limiter.run(fnB, controllerB.signal);

    // Let the event loop / microtask queue run to initialize releaseA
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseA();
    await expect(taskA).resolves.toBeUndefined();
    await expect(taskB).resolves.toBe('B result');
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});
