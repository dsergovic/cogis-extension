import { describe, it, expect } from 'vitest';
import { grokDeepLink, normalizeGrokHit } from '../../extension/lib/grok-adapter.js';

describe('grokDeepLink', () => {
  it('builds a /c/{id} url', () => {
    expect(grokDeepLink('conv-1')).toBe('https://grok.com/c/conv-1');
  });

  it('returns null for invalid input', () => {
    expect(grokDeepLink('')).toBeNull();
    expect(grokDeepLink('   ')).toBeNull();
    expect(grokDeepLink(null)).toBeNull();
  });
});

describe('normalizeGrokHit', () => {
  const baseMatch = {
    conversation: {
      conversationId: 'aa984215-4c18-48bd-b3b1-7a1b169f8a32',
      title: 'Cursor Handoff 07: Stripe DEV Wire + Verify',
      starred: false,
      createTime: '2026-08-14T11:54:52.178355Z',
      modifyTime: '2026-08-14T19:45:44.794Z',
      workspaceId: '77b4d87f-b1f7-4794-a7ae-2b6960178f9e',
    },
    matchType: 'CONTENT',
    matchedResponseId: 'resp-1',
    highlight: 'message body snippet content',
    matchedWords: ['stripe'],
  };

  it('normalizes a search match from the nested conversation object', () => {
    expect(normalizeGrokHit(baseMatch)).toEqual({
      platform: 'grok',
      title: 'Cursor Handoff 07: Stripe DEV Wire + Verify',
      dateIso: '2026-08-14T19:45:44.794Z',
      deepLinkUrl: 'https://grok.com/c/aa984215-4c18-48bd-b3b1-7a1b169f8a32',
      prefillSupported: false,
      evidence: { matchedWords: ['stripe'], matchKind: 'content', wordsSpanConversation: true },
    });
  });

  it('keeps the query words it matched but never the body highlight', () => {
    const hit = normalizeGrokHit({
      ...baseMatch,
      matchedWords: ['vs'],
      matchType: 'MATCH_MESSAGE',
    });
    expect(hit.evidence).toEqual({
      matchedWords: ['vs'],
      matchKind: 'content',
      wordsSpanConversation: true,
    });
    expect(JSON.stringify(hit)).not.toContain('message body snippet content');
  });

  it('falls back to createTime when modifyTime is missing', () => {
    const match = {
      conversation: { ...baseMatch.conversation, modifyTime: undefined },
    };
    expect(normalizeGrokHit(match)?.dateIso).toBe('2026-08-14T11:54:52.178Z');
  });

  it('drops a hit missing a conversationId or title', () => {
    expect(normalizeGrokHit({ conversation: { conversationId: null, title: 'x' } })).toBeNull();
    expect(normalizeGrokHit({ conversation: { conversationId: 'id-1', title: '' } })).toBeNull();
  });

  it('never leaks the highlight field onto the pointer', () => {
    const pointer = normalizeGrokHit(baseMatch);
    expect(pointer).not.toHaveProperty('highlight');
  });

  it('returns null for non-object input or a missing conversation field', () => {
    expect(normalizeGrokHit(null)).toBeNull();
    expect(normalizeGrokHit({})).toBeNull();
  });
});
