import { describe, it, expect, vi } from 'vitest';
import { MSG } from '../../../shared/runtime/messages.js';
import { createChatHandlers } from './chatHandlers.js';

function makeHandlers(decisionService) {
  const chatService = { complete: vi.fn(), cancelTurn: vi.fn() };
  const handlers = createChatHandlers({
    chatRepository: {},
    chatService,
    providerRepository: { getActiveProvider: vi.fn() },
    decisionService,
  });
  return { handlers, chatService };
}

describe('chat handlers: project chat page scan', () => {
  it('cancels both completions and decisions for a chat turn', async () => {
    const decisionService = { cancelTurn: vi.fn() };
    const { handlers, chatService } = makeHandlers(decisionService);
    expect(await handlers[MSG.cancelChatTurn].handle({ turnId: 't1' })).toEqual({ ok: true });
    expect(chatService.cancelTurn).toHaveBeenCalledWith('t1');
    expect(decisionService.cancelTurn).toHaveBeenCalledWith('t1');
  });

  it('still cancels a turn without a decision service', async () => {
    const { handlers, chatService } = makeHandlers(undefined);
    await handlers[MSG.cancelChatTurn].handle({ turnId: 't1' });
    expect(chatService.cancelTurn).toHaveBeenCalledWith('t1');
  });

  it('serves the scan config to extension pages only', async () => {
    const decisionService = { getConfig: vi.fn(async () => ({ ok: true, mode: 'decision' })) };
    const { handlers } = makeHandlers(decisionService);
    const entry = handlers[MSG.getProjectChatScanConfig];
    expect(entry.requiresExtensionPage).toBe(true);
    expect(entry.validate({})).toBeNull();
    expect(await entry.handle({})).toEqual({ ok: true, mode: 'decision' });
  });

  it('falls back to the completion LLM scan without a decision service', async () => {
    const { handlers } = makeHandlers(undefined);
    expect(await handlers[MSG.getProjectChatScanConfig].handle({})).toEqual({
      ok: true,
      mode: 'llm',
    });
    expect(await handlers[MSG.projectChatDecide].handle({ questions: { q: {} } })).toMatchObject({
      ok: false,
    });
  });

  it('validates and forwards a decision request', async () => {
    const result = { ok: true, answers: { q: { answer: 'yes' } } };
    const decisionService = { decide: vi.fn(async () => result) };
    const { handlers } = makeHandlers(decisionService);
    const entry = handlers[MSG.projectChatDecide];
    expect(entry.requiresExtensionPage).toBe(true);
    expect(entry.validate({})).toBe('questions must be an object');
    expect(entry.validate({ questions: [] })).toBe('questions must be an object');
    expect(entry.validate({ questions: 'q' })).toBe('questions must be an object');
    expect(entry.validate({ questions: {} })).toBe('questions must not be empty');
    expect(entry.validate({ questions: { q: {} }, chatTurnId: 3 })).toBe('invalid chatTurnId');
    expect(entry.validate({ questions: { q: {} }, chatTurnId: 't1' })).toBeNull();
    expect(entry.validate({ questions: { q: {} } })).toBeNull();

    const msg = { state: 'page', questions: { q: { type: 'choice' } }, chatTurnId: 't1' };
    expect(await entry.handle(msg)).toBe(result);
    expect(decisionService.decide).toHaveBeenCalledWith({
      state: 'page',
      questions: msg.questions,
      chatTurnId: 't1',
    });
  });
});
