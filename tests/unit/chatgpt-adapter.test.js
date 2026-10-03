import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chatgptDeepLink,
  normalizeChatgptHit,
  searchChatgpt,
} from '../../extension/lib/chatgpt-adapter.js';

describe('chatgptDeepLink', () => {
  it('builds a /c/{id} url', () => {
    expect(chatgptDeepLink('abc-123')).toBe('https://chatgpt.com/c/abc-123');
  });

  it('returns null for invalid input', () => {
    expect(chatgptDeepLink('')).toBeNull();
    expect(chatgptDeepLink('   ')).toBeNull();
    expect(chatgptDeepLink(null)).toBeNull();
  });
});

describe('normalizeChatgptHit', () => {
  const baseItem = {
    id: 'conversation:conv-1:title',
    source_type: 'conversation',
    title: 'Fajita Peppers and Onions',
    update_time: 1700000000,
    match_kind: 'title',
    payload: { kind: 'conversation', conversation_id: 'conv-1', message_id: null },
  };

  it('normalizes a conversation search hit', () => {
    expect(normalizeChatgptHit(baseItem)).toEqual({
      platform: 'chatgpt',
      title: 'Fajita Peppers and Onions',
      dateIso: new Date(1700000000 * 1000).toISOString(),
      deepLinkUrl: 'https://chatgpt.com/c/conv-1',
      prefillSupported: false,
      evidence: { matchKind: 'title' },
    });
  });

  it('ignores non-conversation source types (e.g. library documents)', () => {
    expect(normalizeChatgptHit({ ...baseItem, source_type: 'library' })).toBeNull();
  });

  it('drops a hit missing a conversation id or title', () => {
    expect(
      normalizeChatgptHit({
        ...baseItem,
        payload: { kind: 'conversation', conversation_id: null },
      }),
    ).toBeNull();
    expect(normalizeChatgptHit({ ...baseItem, title: '' })).toBeNull();
  });

  it('never leaks the snippet field onto the pointer', () => {
    const withSnippet = { ...baseItem, snippet: 'message body content' };
    const pointer = normalizeChatgptHit(withSnippet);
    expect(pointer).not.toHaveProperty('snippet');
  });

  it('returns null for non-object input', () => {
    expect(normalizeChatgptHit(null)).toBeNull();
  });
});

describe('searchChatgpt session mapping', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('treats a non-401 session failure as an outage, not a sign-out', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 }));
    const outcome = await searchChatgpt('anything');
    expect(outcome.status).toBe('unavailable');
    expect(outcome.message).toContain('503');
  });

  it('treats a 401 session response as logged out', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 }));
    expect((await searchChatgpt('anything')).status).toBe('login_required');
  });

  it('treats a session without an access token as logged out', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({}));
    expect((await searchChatgpt('anything')).status).toBe('login_required');
  });
});
