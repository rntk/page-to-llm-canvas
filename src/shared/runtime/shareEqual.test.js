import { describe, it, expect } from 'vitest';
import { shareEqual } from './shareEqual.js';

describe('shareEqual', () => {
  it('returns prev when next deep-equals it', () => {
    const prev = { a: [1, { b: 'x' }], c: null };
    expect(shareEqual(prev, structuredClone(prev))).toBe(prev);
  });

  it('shares unchanged branches and replaces changed ones', () => {
    const prev = { same: { v: 1 }, changed: { v: 1 }, list: [{ k: 1 }, { k: 2 }] };
    const next = { same: { v: 1 }, changed: { v: 2 }, list: [{ k: 1 }, { k: 3 }] };
    const out = shareEqual(prev, next);
    expect(out).not.toBe(prev);
    expect(out).toEqual(next);
    expect(out.same).toBe(prev.same);
    expect(out.changed).not.toBe(prev.changed);
    expect(out.list).not.toBe(prev.list);
    expect(out.list[0]).toBe(prev.list[0]);
  });

  it('treats added, removed and undefined-valued keys as changes', () => {
    expect(shareEqual({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(shareEqual({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    const prev = { a: undefined };
    const next = { b: undefined };
    expect(shareEqual(prev, next)).not.toBe(prev);
  });

  it('treats array length changes and type changes as changes', () => {
    const prev = [1, 2];
    expect(shareEqual(prev, [1])).toEqual([1]);
    expect(shareEqual(prev, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(shareEqual([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(shareEqual({ a: 1 }, null)).toBeNull();
  });
});
