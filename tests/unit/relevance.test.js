import { describe, it, expect } from 'vitest';
import {
  normalizeEvidence,
  isWeakMatch,
  classifyPointer,
  filterPointers,
  SEMANTIC_DISTANCE_MAX,
  TIER,
} from '../../extension/lib/relevance.js';
import { parseQuery } from '../../extension/lib/query.js';

/**
 * Fixtures below are the real shapes returned by the labs for `devops vs
 * github` on 2026-09-17 — the probe that motivated this layer.
 */
const query = parseQuery('devops vs github');

function pointer(title, evidence) {
  return {
    platform: 'claude',
    title,
    dateIso: '2026-08-13T00:00:00.000Z',
    deepLinkUrl: `https://claude.ai/chat/${encodeURIComponent(title)}`,
    prefillSupported: false,
    evidence,
  };
}

describe('normalizeEvidence', () => {
  it('lowercases matched words and defaults missing fields', () => {
    expect(normalizeEvidence({ matchedWords: ['GitHub', 'VS'] })).toEqual({
      matchedWords: ['github', 'vs'],
      semanticDistance: null,
      semanticRank: null,
      sources: [],
      matchKind: null,
      wordsSpanConversation: false,
    });
  });

  it('distinguishes "reported nothing" from "reported an empty list"', () => {
    expect(normalizeEvidence({}).matchedWords).toBeNull();
    expect(normalizeEvidence({ matchedWords: [] }).matchedWords).toEqual([]);
  });

  it('survives junk input', () => {
    expect(normalizeEvidence(null).sources).toEqual([]);
    expect(normalizeEvidence({ sources: 'nope', matchedWords: 7 }).matchedWords).toBeNull();
  });
});

describe('isWeakMatch', () => {
  it('rejects a hit whose only matched word is a stopword', () => {
    // Grok returned 60 of these: "Toyota Highlander Starter Issues" matching on "vs".
    const evidence = normalizeEvidence({ matchedWords: ['vs'], matchKind: 'content' });
    expect(isWeakMatch(evidence, query)).toBe(true);
  });

  it('keeps a hit that matched a content word', () => {
    const evidence = normalizeEvidence({ matchedWords: ['GitHub'], matchKind: 'content' });
    expect(isWeakMatch(evidence, query)).toBe(false);
  });

  it('rejects a distant semantic neighbor even when keyword channels are listed', () => {
    // Claude reports keyword sources on pure semantic neighbors too, so the
    // distance check has to run before the keyword-source fallback.
    const evidence = normalizeEvidence({
      matchedWords: [],
      semanticDistance: 0.48,
      semanticRank: 38,
      sources: ['keyword_summary', 'keyword_transcript', 'semantic_summary'],
    });
    expect(isWeakMatch(evidence, query)).toBe(true);
  });

  it('keeps a lexical hit the lab did not rank semantically', () => {
    // dist/rank null + a keyword source = matched in the body, lab won't say
    // which word. Unprovable is not the same as weak.
    const evidence = normalizeEvidence({
      matchedWords: [],
      semanticDistance: null,
      semanticRank: null,
      sources: ['keyword_transcript'],
    });
    expect(isWeakMatch(evidence, query)).toBe(false);
  });

  it('rejects a semantic-only hit', () => {
    const evidence = normalizeEvidence({
      matchedWords: [],
      semanticDistance: 0.454,
      semanticRank: 9,
      sources: ['semantic_summary'],
    });
    expect(isWeakMatch(evidence, query)).toBe(true);
  });

  it('keeps a ChatGPT content match, which reports no per-word detail', () => {
    expect(isWeakMatch(normalizeEvidence({ matchKind: 'content' }), query)).toBe(false);
  });

  it('keeps a hit from a lab that reports no evidence at all', () => {
    // Gemini and Perplexity are DOM-scraped; there is nothing to judge.
    expect(isWeakMatch(normalizeEvidence({}), query)).toBe(false);
  });

  it('does not demand a content word when the query has none', () => {
    const allStopwords = parseQuery('what is the');
    const evidence = normalizeEvidence({ matchedWords: ['the'] });
    expect(isWeakMatch(evidence, allStopwords)).toBe(false);
  });

  it('treats the distance cutoff as exclusive', () => {
    const atCutoff = normalizeEvidence({
      matchedWords: [],
      semanticDistance: SEMANTIC_DISTANCE_MAX,
      semanticRank: 2,
      sources: ['keyword_transcript', 'semantic_summary'],
    });
    expect(isWeakMatch(atCutoff, query)).toBe(false);
  });
});

describe('classifyPointer — unquoted', () => {
  it('marks a title covering every content term as strong', () => {
    const hit = pointer('GitHub vs DevOps for project management', {
      matchedWords: ['GitHub', 'vs', 'DevOps'],
      semanticDistance: 0.251,
      semanticRank: 1,
      sources: ['keyword_summary', 'keyword_transcript', 'semantic_summary'],
    });
    expect(classifyPointer(hit, query)).toBe(TIER.STRONG);
  });

  it('drops a "<x> vs <y>" title that shares only the stopword', () => {
    const hit = pointer('Percolator vs French press vs drip coffee', {
      matchedWords: ['vs', 'vs'],
      semanticDistance: 0.48,
      semanticRank: 38,
      sources: ['keyword_summary', 'keyword_transcript', 'semantic_summary'],
    });
    expect(classifyPointer(hit, query)).toBe(TIER.WEAK);
  });

  it('keeps a body match whose title says nothing', () => {
    const hit = pointer('Switch Repo from Azure DevOps to GitHub', { matchKind: 'content' });
    expect(classifyPointer(hit, query)).toBe(TIER.STRONG);
  });
});

describe('classifyPointer — quoted', () => {
  const quoted = parseQuery('"devops vs github"');

  it('verifies a phrase only against the title', () => {
    const hit = pointer('Notes on DevOps vs GitHub for teams', { matchKind: 'content' });
    expect(classifyPointer(hit, quoted)).toBe(TIER.STRONG);
  });

  it('demotes a body match it cannot confirm', () => {
    // The lab says the phrase is in the conversation; Cogis holds no body
    // text, so it can't agree or disagree.
    const hit = pointer('Switch Repo from Azure DevOps to GitHub', { matchKind: 'content' });
    expect(classifyPointer(hit, quoted)).toBe(TIER.UNVERIFIED);
  });

  it('still drops demonstrably weak evidence', () => {
    const hit = pointer('Toyota Highlander Starter Issues', {
      matchedWords: ['vs'],
      matchKind: 'content',
    });
    expect(classifyPointer(hit, quoted)).toBe(TIER.WEAK);
  });

  it('drops a Grok hit that matched only some of the phrase words', () => {
    const ezra = parseQuery('"ezra collective"');
    const hit = pointer('Humidifier White Dust: Causes and Prevention', {
      matchedWords: ['collective'],
      matchKind: 'content',
      wordsSpanConversation: true,
    });
    expect(classifyPointer(hit, ezra)).toBe(TIER.WEAK);
  });

  it('keeps a Grok hit that matched every phrase word, plurals included', () => {
    const ezra = parseQuery('"ezra collective"');
    const hit = pointer('Jazz picks for the weekend', {
      matchedWords: ['Ezra', 'collectives'],
      matchKind: 'content',
      wordsSpanConversation: true,
    });
    expect(classifyPointer(hit, ezra)).toBe(TIER.UNVERIFIED);
  });

  it('does not apply the word check to title-only matched words', () => {
    // Claude's matchedWords come from the title, so a body hit lists none.
    const hit = pointer('Switch Repo from Azure DevOps to GitHub', {
      matchedWords: [],
      sources: ['keyword_transcript'],
    });
    expect(classifyPointer(hit, quoted)).toBe(TIER.UNVERIFIED);
  });

  it('requires every phrase when more than one is given', () => {
    const two = parseQuery('"deep link" "text fragment"');
    const onlyOne = pointer('Deep link handling notes', { matchKind: 'content' });
    expect(classifyPointer(onlyOne, two)).toBe(TIER.UNVERIFIED);
  });
});

describe('filterPointers', () => {
  it('drops weak hits, counts them, and strips evidence from what survives', () => {
    const input = [
      pointer('GitHub vs DevOps for project management', {
        matchedWords: ['GitHub', 'vs', 'DevOps'],
        semanticDistance: 0.251,
        semanticRank: 1,
        sources: ['keyword_summary'],
      }),
      pointer('Smoke detector vs combination unit', {
        matchedWords: ['vs'],
        semanticDistance: 0.474,
        semanticRank: 29,
        sources: ['keyword_summary'],
      }),
      pointer('Counting calendar meetings on iPhone', {
        matchedWords: [],
        semanticDistance: 0.489,
        semanticRank: 49,
        sources: ['semantic_transcript_legacy'],
      }),
    ];

    const { kept, droppedCount } = filterPointers(input, query);

    expect(droppedCount).toBe(2);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('GitHub vs DevOps for project management');
    expect(kept[0].tier).toBe(TIER.STRONG);
    expect(kept[0]).not.toHaveProperty('evidence');
  });

  it('floats verified hits above unverified ones', () => {
    const quoted = parseQuery('"azure devops"');
    const input = [
      pointer('Body mention only', { matchKind: 'content' }),
      pointer('Azure DevOps migration', { matchKind: 'title' }),
    ];

    const { kept } = filterPointers(input, quoted);

    expect(kept.map((k) => k.tier)).toEqual([TIER.STRONG, TIER.UNVERIFIED]);
    expect(kept[0].title).toBe('Azure DevOps migration');
  });

  it('handles junk input', () => {
    expect(filterPointers(null, query)).toEqual({ kept: [], droppedCount: 0 });
    expect(filterPointers([null], query).kept).toEqual([]);
  });
});
