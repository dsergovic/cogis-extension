/** @typedef {'full-text' | 'title-match'} Capability */

/**
 * @typedef {object} PlatformDef
 * @property {string} id
 * @property {string} label
 * @property {Capability} capability
 * @property {string} origin
 * @property {string} loginUrl
 * @property {string[]} hostPatterns
 */

/**
 * Registered lab adapters. Filled in one lab at a time, only after that
 * lab's live contract has been verified — see the restart plan.
 * @type {Record<string, PlatformDef>}
 */
export const PLATFORMS = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    capability: 'full-text',
    origin: 'https://chatgpt.com',
    loginUrl: 'https://chatgpt.com/',
    hostPatterns: ['https://chatgpt.com/*'],
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    capability: 'full-text',
    origin: 'https://claude.ai',
    loginUrl: 'https://claude.ai/login',
    hostPatterns: ['https://claude.ai/*'],
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    capability: 'full-text',
    origin: 'https://www.perplexity.ai',
    loginUrl: 'https://www.perplexity.ai/',
    hostPatterns: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    capability: 'full-text',
    origin: 'https://gemini.google.com',
    loginUrl: 'https://gemini.google.com/app',
    hostPatterns: ['https://gemini.google.com/*'],
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    capability: 'full-text',
    origin: 'https://grok.com',
    loginUrl: 'https://grok.com/',
    hostPatterns: ['https://grok.com/*'],
  },
  muse: {
    id: 'muse',
    label: 'Muse',
    capability: 'full-text',
    origin: 'https://muse.ai',
    loginUrl: 'https://muse.ai/',
    hostPatterns: ['https://muse.ai/*'],
  },
};

/** UI group order for implemented platforms, filled in as adapters land. */
export const PLATFORM_ORDER = ['chatgpt', 'claude', 'perplexity', 'gemini', 'grok', 'muse'];

export const FOOTNOTE_TEXT = 'Some AIs do not support full-text search.';

/**
 * @param {string} id
 * @returns {PlatformDef|null}
 */
export function getPlatform(id) {
  return PLATFORMS[id] ?? null;
}

/**
 * @param {string} platformId
 */
export function loginRequiredCopy(platformId) {
  const platform = getPlatform(platformId);
  const name = platform?.label ?? platformId;
  return `Please log in to ${name}`;
}

/**
 * @param {string} platformId
 */
export function unavailableCopy(platformId) {
  const platform = getPlatform(platformId);
  const name = platform?.label ?? platformId;
  return `${name} is temporarily unavailable.`;
}
