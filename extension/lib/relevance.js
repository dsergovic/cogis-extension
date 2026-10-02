/**
 * Match-evidence scoring — the precision layer between an adapter and the UI.
 *
 * Every lab hands back metadata explaining *why* a conversation matched, and
 * until now Cogis dropped all of it on the floor and rendered whatever came
 * back. None of that metadata is body text: Grok names the query words it
 * matched, Claude gives character ranges into the conversation *title* plus a
 * semantic distance, ChatGPT says whether the hit was title- or content-side.
 * Normalizing those three shapes into one `MatchEvidence` lets this file cut
 * the noise without Cogis ever holding a message body — the privacy rule and
 * the precision fix don't trade against each other here.
 *
 * Measured against the live `devops vs github` probe of 2026-09-17:
 *   - Claude 25 -> 3   (four "<x> vs <y>" titles matched only the stopword;
 *                       the rest were semantic neighbors at distance .37-.49
 *                       against the true hit's .251)
 *   - Grok   60 -> ~10 (the dropped ones matched nothing but "vs")
 *
 * The bar is deliberately "drop what we can *show* is weak", not "keep only
 * what we can prove is strong". A lab that reports a keyword hit in a message
 * body without saying which word matched is kept: unprovable is not the same
 * as bad, and full-text recall is the point of the tool.
 */

import { STOPWORDS, titleContainsPhrase, titleCoversTerms, tokenize } from './query.js';

/**
 * Semantic-distance cutoff for a result with no lexical evidence.
 *
 * Calibrated on the live probe: the single true hit scored .251 while every
 * unrelated neighbor scored .369 or worse, so the gap is wide and .35 sits in
 * it. Only applied when the lab actually ranked the hit semantically — a null
 * rank means the match was lexical and this number says nothing about it.
 */
export const SEMANTIC_DISTANCE_MAX = 0.35;

/** @typedef {'strong'|'unverified'|'weak'} Tier */

export const TIER = Object.freeze({
  /** Shown normally. */
  STRONG: 'strong',
  /** A phrase the lab claims to have matched in a body Cogis can't see. Shown, collapsed. */
  UNVERIFIED: 'unverified',
  /** Demonstrably weak — dropped before render. */
  WEAK: 'weak',
});

/**
 * @typedef {object} MatchEvidence
 * @property {string[]|null} matchedWords  query words the lab says it matched, or null if it doesn't report them
 * @property {number|null} semanticDistance
 * @property {number|null} semanticRank    null when the hit wasn't semantically ranked
 * @property {string[]} sources            retrieval channels, e.g. `keyword_transcript`, `semantic_summary`
 * @property {string|null} matchKind       `title` | `content`, for labs that say which
 * @property {boolean} wordsSpanConversation  true when `matchedWords` covers the whole
 *   conversation (Grok), false when it only covers the title (Claude)
 */

/**
 * Coerce an adapter's raw evidence into the common shape. Unknown or absent
 * fields become null/empty rather than throwing — every lab reports a
 * different subset and that's expected.
 * @param {Partial<MatchEvidence>|null|undefined} raw
 * @returns {MatchEvidence}
 */
export function normalizeEvidence(raw) {
  const matchedWords = Array.isArray(raw?.matchedWords)
    ? raw.matchedWords.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.toLowerCase())
    : null;
  const distance = typeof raw?.semanticDistance === 'number' ? raw.semanticDistance : null;
  const rank = typeof raw?.semanticRank === 'number' ? raw.semanticRank : null;
  const sources = Array.isArray(raw?.sources)
    ? raw.sources.filter((s) => typeof s === 'string' && s)
    : [];
  const matchKind = typeof raw?.matchKind === 'string' ? raw.matchKind : null;
  const wordsSpanConversation = raw?.wordsSpanConversation === true;
  return {
    matchedWords,
    semanticDistance: distance,
    semanticRank: rank,
    sources,
    matchKind,
    wordsSpanConversation,
  };
}

/** Words the lab matched that aren't stopwords. */
function meaningfulMatches(evidence) {
  if (!evidence.matchedWords) return [];
  return evidence.matchedWords.filter((w) => !STOPWORDS.has(w));
}

/**
 * True when the lab itemized every word it matched anywhere in the
 * conversation and one of the phrase's content words is missing. Then the
 * phrase can't be in there, whatever the lab ranked it. Grok OR-matches the
 * words, so `"ezra collective"` returned chats that held only one of them.
 * A matched word may extend the term (`collectives`), never shorten it.
 * @param {MatchEvidence} evidence
 * @param {import('./query.js').ParsedQuery} parsed
 */
function phraseWordMissing(evidence, parsed) {
  if (!evidence.wordsSpanConversation || !evidence.matchedWords) return false;
  const needed = parsed.phrases.flatMap(tokenize).filter((t) => !STOPWORDS.has(t));
  return needed.some((term) => !evidence.matchedWords.some((w) => w.startsWith(term)));
}

/** True when any retrieval channel was lexical rather than semantic. */
function hasKeywordSource(evidence) {
  return evidence.sources.some((s) => s.startsWith('keyword'));
}

/**
 * Decide whether a hit's evidence is demonstrably weak.
 *
 * Rule order matters: the stopword check has to run before the keyword-source
 * fallback (Claude reports `keyword_summary` for a title that matched nothing
 * but "vs"), and the semantic cutoff has to run before it too (Claude reports
 * keyword sources on pure semantic neighbors as well).
 * @param {MatchEvidence} evidence
 * @param {import('./query.js').ParsedQuery} parsed
 * @returns {boolean}
 */
export function isWeakMatch(evidence, parsed) {
  const meaningful = meaningfulMatches(evidence);

  // A query made only of stopwords ("what is the") is taken at face value —
  // there is no content word available to demand.
  const queryHasContentWords = (parsed?.requiredTerms?.length ?? 0) > 0;

  if (queryHasContentWords && evidence.matchedWords?.length && meaningful.length === 0) {
    return true; // matched the query's stopwords and nothing else
  }
  if (meaningful.length > 0) return false;

  if (
    evidence.semanticRank !== null &&
    evidence.semanticDistance !== null &&
    evidence.semanticDistance > SEMANTIC_DISTANCE_MAX
  ) {
    return true; // a distant semantic neighbor, not a match
  }

  // Lexical hit the lab won't itemize (Claude's null-rank keyword rows,
  // ChatGPT's `content`): unprovable, so kept.
  if (hasKeywordSource(evidence) || evidence.matchKind) return false;

  if (evidence.sources.length > 0) return true; // semantic-only channels

  return false; // no evidence reported at all (DOM-scraped labs) — keep
}

/**
 * Assign a tier to one pointer.
 *
 * A quoted search can only be *verified* against the title, because that's
 * the only text Cogis holds. Anything else the lab returned for that phrase
 * is surfaced as `unverified` rather than silently dropped or silently
 * promoted.
 * @param {import('./messaging.js').PointerRecord} pointer
 * @param {import('./query.js').ParsedQuery} parsed
 * @returns {Tier}
 */
export function classifyPointer(pointer, parsed) {
  const title = pointer?.title ?? '';
  const evidence = normalizeEvidence(pointer?.evidence);

  if (parsed?.hasPhrase) {
    const everyPhraseInTitle = parsed.phrases.every((p) => titleContainsPhrase(title, p));
    if (everyPhraseInTitle) return TIER.STRONG;
    if (phraseWordMissing(evidence, parsed)) return TIER.WEAK;
    return isWeakMatch(evidence, parsed) ? TIER.WEAK : TIER.UNVERIFIED;
  }

  if (titleCoversTerms(title, parsed)) return TIER.STRONG;
  return isWeakMatch(evidence, parsed) ? TIER.WEAK : TIER.STRONG;
}

/**
 * Tier a platform's pointers and drop the weak ones, preserving the lab's own
 * ordering within each tier and floating verified title hits to the top.
 * `evidence` is stripped on the way out — it exists to make this decision and
 * has no business reaching the UI or outliving the request.
 * @param {import('./messaging.js').PointerRecord[]} pointers
 * @param {import('./query.js').ParsedQuery} parsed
 * @returns {{ kept: import('./messaging.js').PointerRecord[], droppedCount: number }}
 */
export function filterPointers(pointers, parsed) {
  const list = Array.isArray(pointers) ? pointers : [];
  const strong = [];
  const unverified = [];
  let droppedCount = 0;

  for (const pointer of list) {
    if (!pointer) continue;
    const tier = classifyPointer(pointer, parsed);
    if (tier === TIER.WEAK) {
      droppedCount += 1;
      continue;
    }
    const rest = { ...pointer };
    delete rest.evidence;
    (tier === TIER.STRONG ? strong : unverified).push({ ...rest, tier });
  }

  return { kept: [...strong, ...unverified], droppedCount };
}
