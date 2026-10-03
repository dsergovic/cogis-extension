import { describe, it, expect } from 'vitest';
import {
  museThreadLink,
  parseMuseItemValue,
  parseMuseRelativeDate,
  normalizeMuseItems,
  MUSE_MAIN_CHAT_URL,
} from '../../extension/lib/muse-adapter.js';

const NOW = new Date('2026-10-02T15:00:00.000Z');

// Shapes copied from a live palette capture (2026-10-02); titles and ids are synthetic.
const THREAD_A = '2aceb733-89cd-4d8a-a603-febc8918b1b8';
const THREAD_B = '8a8ef837-fc74-4374-9ff5-5dc95ffc5835';
const items = [
  {
    value: 'chat:message:assistant-msg-d4b3b1f2-b2e6-4584-820e-b1124344d6bf:13496',
    title: 'Pricing [Ops]',
    dateText: '12h ago',
  },
  {
    value: 'chat:message:assistant-msg-f5142d6d-d1c4-4e3a-8689-031fa79ac2cf:13470',
    title: 'Main chat',
    dateText: '12h ago',
  },
  {
    value: 'chat:message:8c416f2b-1dca-4f33-9fbd-72f414558953:12254',
    title: 'Pricing [Ops]',
    dateText: '1d ago',
  },
  { value: 'chat:message:assistant-msg-0000:100', title: 'Room Not Listed', dateText: '2d ago' },
  { value: 'chat:main', title: 'Main chat', dateText: '18m ago' },
  { value: `chat:thread:${THREAD_B}`, title: 'Pricing [Ops]', dateText: '37m ago' },
  { value: `chat:thread:${THREAD_A}`, title: 'Recipes', dateText: '39m ago' },
  { value: 'ask-hatch', title: 'pro plan', dateText: '' },
];

describe('museThreadLink', () => {
  it('builds a /thread/{id} url', () => {
    expect(museThreadLink(THREAD_A)).toBe(`https://muse.ai/thread/${THREAD_A}`);
  });

  it('returns null for invalid input', () => {
    expect(museThreadLink('')).toBeNull();
    expect(museThreadLink(null)).toBeNull();
  });
});

describe('parseMuseItemValue', () => {
  it('classifies each palette row kind', () => {
    expect(parseMuseItemValue('chat:message:abc:1')).toEqual({ kind: 'message' });
    expect(parseMuseItemValue('chat:main')).toEqual({ kind: 'main' });
    expect(parseMuseItemValue(`chat:thread:${THREAD_A}`)).toEqual({
      kind: 'thread',
      threadId: THREAD_A,
    });
    expect(parseMuseItemValue('ask-hatch')).toEqual({ kind: 'other' });
    expect(parseMuseItemValue(undefined)).toEqual({ kind: 'other' });
  });
});

describe('parseMuseRelativeDate', () => {
  it('parses relative ages', () => {
    expect(parseMuseRelativeDate('18m ago', NOW)).toBe('2026-10-02T14:42:00.000Z');
    expect(parseMuseRelativeDate('12h ago', NOW)).toBe('2026-10-02T03:00:00.000Z');
    expect(parseMuseRelativeDate('1d ago', NOW)).toBe('2026-10-01T15:00:00.000Z');
    expect(parseMuseRelativeDate('2mo ago', NOW)).toBe('2026-08-03T15:00:00.000Z');
    expect(parseMuseRelativeDate('just now', NOW)).toBe(NOW.toISOString());
  });

  it('parses month-day forms', () => {
    expect(parseMuseRelativeDate('Sep 12', NOW)).toBe('2026-09-12T00:00:00.000Z');
    expect(parseMuseRelativeDate('Dec 30', NOW)).toBe('2025-12-30T00:00:00.000Z');
    expect(parseMuseRelativeDate('May 2, 2025', NOW)).toBe('2025-05-02T00:00:00.000Z');
  });

  it('returns null for anything else', () => {
    expect(parseMuseRelativeDate('', NOW)).toBeNull();
    expect(parseMuseRelativeDate('soon', NOW)).toBeNull();
    expect(parseMuseRelativeDate(null, NOW)).toBeNull();
  });
});

describe('normalizeMuseItems', () => {
  it('links message hits to their room, one pointer per room, newest first', () => {
    const out = normalizeMuseItems(items, 'pro plan', NOW);
    expect(out).toEqual([
      {
        platform: 'muse',
        title: 'Pricing [Ops]',
        dateIso: '2026-10-02T03:00:00.000Z',
        deepLinkUrl: `https://muse.ai/thread/${THREAD_B}`,
        prefillSupported: false,
        evidence: { matchKind: 'content' },
      },
      {
        platform: 'muse',
        title: 'Main chat',
        dateIso: '2026-10-02T03:00:00.000Z',
        deepLinkUrl: MUSE_MAIN_CHAT_URL,
        prefillSupported: false,
        evidence: { matchKind: 'content' },
      },
    ]);
  });

  it('drops message hits whose room has no known link', () => {
    const out = normalizeMuseItems(items, 'pro plan', NOW);
    expect(out.some((p) => p.title === 'Room Not Listed')).toBe(false);
  });

  it('does not treat listed threads as hits unless the title carries the query', () => {
    expect(normalizeMuseItems(items, 'pro plan', NOW).some((p) => p.title === 'Recipes')).toBe(
      false,
    );
    const titleHit = normalizeMuseItems(items, 'recipes', NOW).find((p) => p.title === 'Recipes');
    expect(titleHit?.deepLinkUrl).toBe(`https://muse.ai/thread/${THREAD_A}`);
    expect(titleHit?.evidence).toEqual({ matchKind: 'title' });
  });

  it('drops a message hit when two threads share its room name', () => {
    const dup = [
      { value: 'chat:message:x:1', title: 'Twins', dateText: '1h ago' },
      { value: `chat:thread:${THREAD_A}`, title: 'Twins', dateText: '1h ago' },
      { value: `chat:thread:${THREAD_B}`, title: 'Twins', dateText: '2h ago' },
    ];
    expect(normalizeMuseItems(dup, 'anything', NOW)).toEqual([]);
  });

  it('never carries forbidden fields through', () => {
    const out = normalizeMuseItems(
      [
        { value: 'chat:main', title: 'Main chat', snippet: 'secret', body: 'secret' },
        { value: 'chat:message:a:1', title: 'Main chat', content: 'secret' },
      ],
      'x',
      NOW,
    );
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('tolerates junk input', () => {
    expect(normalizeMuseItems(null, 'x')).toEqual([]);
    expect(normalizeMuseItems([null, 42, {}], 'x')).toEqual([]);
  });
});
