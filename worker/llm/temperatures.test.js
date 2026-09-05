import { describe, it, expect } from 'vitest';
import {
  normalizeProviderTemperatures,
  resolveProviderTemperature,
  temperatureTaskForTaskType,
  TemperatureTask,
} from './temperatures.js';

describe('temperatureTaskForTaskType', () => {
  it('maps every issued task type onto a configurable task group', () => {
    expect(temperatureTaskForTaskType('article_summary')).toBe(TemperatureTask.SUMMARIES);
    expect(temperatureTaskForTaskType('article_summary_merge')).toBe(TemperatureTask.SUMMARIES);
    expect(temperatureTaskForTaskType('topic_summary_from_source')).toBe(TemperatureTask.SUMMARIES);
    expect(temperatureTaskForTaskType('chat_answer')).toBe(TemperatureTask.CHAT);
    expect(temperatureTaskForTaskType('chat_synthesis')).toBe(TemperatureTask.CHAT);
    expect(temperatureTaskForTaskType('topic_ranges')).toBe(TemperatureTask.SPLITTING);
  });

  it('returns undefined for unknown or missing task types', () => {
    expect(temperatureTaskForTaskType('unknown')).toBeUndefined();
    expect(temperatureTaskForTaskType(undefined)).toBeUndefined();
  });
});

describe('normalizeProviderTemperatures', () => {
  it('parses numeric strings and keeps zero', () => {
    expect(normalizeProviderTemperatures({ summaries: '0.8', chat: 0, splitting: '2' })).toEqual({
      summaries: 0.8,
      chat: 0,
      splitting: 2,
    });
  });

  it('treats empty, null and undefined as unset', () => {
    expect(normalizeProviderTemperatures({ summaries: '  ', chat: null })).toBeUndefined();
    expect(normalizeProviderTemperatures(undefined)).toBeUndefined();
    expect(normalizeProviderTemperatures(null)).toBeUndefined();
  });

  it('rejects non-objects and out-of-range values', () => {
    expect(() => normalizeProviderTemperatures('0.5')).toThrow(/object/);
    expect(() => normalizeProviderTemperatures({ chat: '-1' })).toThrow(/Temperature \(chat\)/);
    expect(() => normalizeProviderTemperatures({ chat: '2.1' })).toThrow(/Temperature \(chat\)/);
    expect(() => normalizeProviderTemperatures({ chat: 'warm' })).toThrow(/Temperature \(chat\)/);
  });
});

describe('resolveProviderTemperature', () => {
  const provider = { temperatures: { summaries: 0.8, chat: 0 } };

  it('returns the temperature configured for the task group', () => {
    expect(resolveProviderTemperature(provider, 'article_summary')).toBe(0.8);
    expect(resolveProviderTemperature(provider, 'chat_synthesis')).toBe(0);
  });

  it('returns undefined when the task, provider or value is unset', () => {
    expect(resolveProviderTemperature(provider, 'topic_ranges')).toBeUndefined();
    expect(resolveProviderTemperature(provider, 'unknown')).toBeUndefined();
    expect(resolveProviderTemperature(null, 'chat_answer')).toBeUndefined();
    expect(resolveProviderTemperature({}, 'chat_answer')).toBeUndefined();
  });
});
