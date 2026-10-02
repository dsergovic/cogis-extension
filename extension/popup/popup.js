import {
  MSG,
  createSearchRequest,
  createSearchCancel,
  shouldApplyChunk,
  normalizeQuery,
} from '../lib/messaging.js';
import { PLATFORM_ORDER, getPlatform, FOOTNOTE_TEXT, loginRequiredCopy } from '../lib/platforms.js';
import { resolveResultHref, truncateTitle } from '../lib/results.js';
import { parseQuery, highlightTarget } from '../lib/query.js';
import { POPUP_WATCHDOG_MS } from '../lib/timeouts.js';
import { perplexityPrefillUrl } from '../lib/perplexity-adapter.js';
import {
  toggleDisabledPlatform,
  loadDisabledPlatforms,
  saveDisabledPlatforms,
} from '../lib/settings.js';

/** Per-platform prefill URL builders, for platforms whose adapter supports one. */
const PREFILL_BUILDERS = {
  perplexity: perplexityPrefillUrl,
};

const form = document.getElementById('search-form');
const input = document.getElementById('query-input');
const resultsEl = document.getElementById('results');
const emptyHintEl = document.getElementById('empty-hint');
const hintSeparatorEl = document.getElementById('hint-separator');
const footnoteEl = document.getElementById('footnote');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const settingsRows = document.getElementById('settings-rows');
const appHeader = document.getElementById('app-header');

let activeRequestId = null;
let activeQuery = '';
/** Parsed form of `activeQuery` — phrases and terms, for link highlighting. */
let activeParsed = null;
let watchdogTimer = null;
/** @type {Record<string, { status: string, results: import('../lib/messaging.js').PointerRecord[], message?: string, loginUrl?: string }>} */
let groups = {};

/** Platforms the user has collapsed. Session-only UI state — cleared at the start of each new search. */
const collapsedPlatforms = new Set();

/** Platforms excluded from search via the settings panel. Loaded from storage at startup. */
let disabledPlatforms = new Set();

function enabledPlatformIds() {
  return PLATFORM_ORDER.filter((id) => !disabledPlatforms.has(id));
}

/**
 * @param {'idle'|'loading'} status
 */
function resetGroups(status) {
  groups = {};
  for (const platformId of enabledPlatformIds()) {
    groups[platformId] = { status, results: [] };
  }
}

/**
 * Build the `<ul>` of result links for one tier of one platform's hits.
 * @param {import('../lib/messaging.js').PointerRecord[]} hits
 * @param {string} platformId
 * @param {import('../lib/platforms.js').PlatformDef|null} platform
 */
function buildResultList(hits, platformId, platform) {
  const list = document.createElement('ul');
  for (const hit of hits) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    const prefillUrl = PREFILL_BUILDERS[platformId]?.(activeParsed?.bare ?? activeQuery) ?? null;
    // Highlight the quoted phrase itself when there is one, so arriving on the
    // page scrolls to the phrase rather than to a stray quote character.
    a.href = resolveResultHref(
      hit,
      prefillUrl,
      platform?.origin ?? '#',
      activeParsed ? highlightTarget(activeParsed) : activeQuery,
    );
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = hit.title;
    a.textContent = truncateTitle(hit.title);
    const extIcon = document.createElement('span');
    extIcon.className = 'ext-icon';
    extIcon.setAttribute('aria-hidden', 'true');
    extIcon.textContent = ' ↗';
    a.appendChild(extIcon);
    li.appendChild(a);
    list.appendChild(li);
  }
  return list;
}

function render() {
  resultsEl.replaceChildren();

  if (PLATFORM_ORDER.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No labs configured yet.';
    resultsEl.appendChild(p);
    footnoteEl.hidden = true;
    return;
  }

  const enabledIds = enabledPlatformIds();
  const anyTitleMatch = enabledIds.some((id) => getPlatform(id)?.capability === 'title-match');
  footnoteEl.hidden = !anyTitleMatch;
  footnoteEl.textContent = FOOTNOTE_TEXT;

  for (const platformId of enabledIds) {
    const platform = getPlatform(platformId);
    const group = groups[platformId] ?? { status: 'idle', results: [] };
    const isCollapsed = collapsedPlatforms.has(platformId);

    const section = document.createElement('div');
    section.className = 'group';

    const toggleCollapse = () => {
      if (collapsedPlatforms.has(platformId)) {
        collapsedPlatforms.delete(platformId);
      } else {
        collapsedPlatforms.add(platformId);
      }
      render();
    };

    const heading = document.createElement('h2');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = platform?.label ?? platformId;
    nameSpan.tabIndex = 0;
    nameSpan.setAttribute('role', 'button');
    nameSpan.setAttribute('aria-expanded', String(!isCollapsed));
    nameSpan.setAttribute(
      'aria-label',
      `${isCollapsed ? 'Expand' : 'Collapse'} ${platform?.label ?? platformId}`,
    );
    nameSpan.addEventListener('click', toggleCollapse);
    nameSpan.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleCollapse();
      }
    });
    heading.appendChild(nameSpan);
    if (platform) {
      const capSpan = document.createElement('span');
      capSpan.className = 'capability';
      capSpan.textContent = platform.capability === 'full-text' ? 'full-text' : 'title-match';
      heading.appendChild(capSpan);
    }
    section.appendChild(heading);

    const content = document.createElement('div');
    content.className = 'group-content';
    content.hidden = isCollapsed;

    if (group.status === 'idle') {
      const note = document.createElement('p');
      note.className = 'status-note';
      note.textContent = 'Ready…';
      content.appendChild(note);
    } else if (group.status === 'loading') {
      const note = document.createElement('p');
      note.className = 'status-note';
      note.textContent = 'Searching…';
      content.appendChild(note);
    } else if (group.status === 'login_required') {
      const note = document.createElement('p');
      note.className = 'status-note';
      const loginUrl = group.loginUrl || platform?.loginUrl;
      if (loginUrl) {
        const link = document.createElement('a');
        link.href = loginUrl;
        link.textContent = `Log in to ${platform?.label ?? platformId}`;
        link.addEventListener('click', (event) => {
          event.preventDefault();
          window.open(loginUrl, '_blank', 'noopener,noreferrer,width=1024,height=768');
        });
        note.appendChild(link);
      } else {
        note.textContent = group.message || loginRequiredCopy(platformId);
      }
      content.appendChild(note);
    } else if (group.status === 'unavailable' || group.status === 'timeout') {
      const note = document.createElement('p');
      note.className = 'status-note';
      note.textContent =
        group.message ||
        (group.status === 'timeout'
          ? `${platform?.label ?? platformId} timed out.`
          : `${platform?.label ?? platformId} is temporarily unavailable.`);
      content.appendChild(note);
    } else if (group.status === 'empty') {
      const note = document.createElement('p');
      note.className = 'status-note';
      note.textContent = 'No results.';
      content.appendChild(note);
    } else if (group.status === 'ready') {
      // A quoted search can only be *verified* against the title — body text
      // never reaches the popup. Hits the lab claims for the phrase but Cogis
      // can't confirm are kept, just held back in a collapsed block so the
      // top of the list stays trustworthy.
      const verified = group.results.filter((hit) => hit.tier !== 'unverified');
      const unverified = group.results.filter((hit) => hit.tier === 'unverified');

      if (verified.length) {
        content.appendChild(buildResultList(verified, platformId, platform));
      }

      if (unverified.length) {
        const details = document.createElement('details');
        details.className = 'unverified';
        // Nothing confirmed? Open it, rather than showing an empty group with
        // a closed drawer under it.
        details.open = verified.length === 0;

        const summary = document.createElement('summary');
        summary.textContent = `Unverified matches (${unverified.length})`;
        details.appendChild(summary);

        const note = document.createElement('p');
        note.className = 'unverified-note';
        note.textContent = `${platform?.label ?? platformId} matched these inside the conversation, where Cogis can't confirm the exact phrase.`;
        details.appendChild(note);

        details.appendChild(buildResultList(unverified, platformId, platform));
        content.appendChild(details);
      }
    }

    section.appendChild(content);
    resultsEl.appendChild(section);
  }
}

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

/** Tell the background to stop the active search, so its hidden lab windows close now rather than at timeout. */
function cancelActiveSearch() {
  if (!activeRequestId) return;
  chrome.runtime.sendMessage(createSearchCancel({ requestId: activeRequestId })).catch(() => {});
}

function startSearch(query) {
  cancelActiveSearch();
  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  activeQuery = query;
  activeParsed = parseQuery(query);
  collapsedPlatforms.clear();
  document.body.classList.add('has-searched');
  closeSettingsPanel();
  resetGroups('loading');
  render();

  chrome.runtime
    .sendMessage(createSearchRequest({ requestId, query, platforms: enabledPlatformIds() }))
    .catch(() => {});

  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    if (activeRequestId !== requestId) return;
    for (const platformId of enabledPlatformIds()) {
      if (groups[platformId]?.status === 'loading') {
        groups[platformId] = { status: 'timeout', results: [] };
      }
    }
    render();
  }, POPUP_WATCHDOG_MS);
}

/**
 * Rebuild the settings-panel checkboxes from the current disabled-platform
 * set. Toggling one persists immediately (no separate save step) and, if no
 * search has run yet, refreshes the idle placeholder list to match.
 */
function renderSettingsPanel() {
  settingsRows.replaceChildren();
  for (const platformId of PLATFORM_ORDER) {
    const platform = getPlatform(platformId);
    const isEnabled = !disabledPlatforms.has(platformId);
    const enabledCount = PLATFORM_ORDER.length - disabledPlatforms.size;

    const row = document.createElement('label');
    row.className = 'settings-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isEnabled;
    checkbox.disabled = isEnabled && enabledCount <= 1;
    checkbox.addEventListener('change', () => {
      const next = toggleDisabledPlatform(PLATFORM_ORDER, [...disabledPlatforms], platformId);
      disabledPlatforms = new Set(next);
      saveDisabledPlatforms(next).catch(() => {});
      renderSettingsPanel();
      if (!document.body.classList.contains('has-searched')) {
        resetGroups('idle');
        render();
      }
    });

    row.appendChild(checkbox);
    row.appendChild(document.createTextNode(platform?.label ?? platformId));
    settingsRows.appendChild(row);
  }
}

function closeSettingsPanel() {
  settingsPanel.hidden = true;
  settingsToggle.setAttribute('aria-expanded', 'false');
}

settingsToggle.addEventListener('click', () => {
  const nextHidden = !settingsPanel.hidden;
  settingsPanel.hidden = nextHidden;
  settingsToggle.setAttribute('aria-expanded', String(!nextHidden));
});

settingsClose.addEventListener('click', closeSettingsPanel);

// Clicking the wordmark reloads and resets the popup, like a site logo —
// but it's deliberately not styled as a link (no accent color, no
// underline): it's just given a pointer cursor so it still reads as
// clickable.
appHeader.addEventListener('click', () => {
  location.reload();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = normalizeQuery(input.value);
  if (!query) return;
  emptyHintEl.hidden = true;
  hintSeparatorEl.hidden = true;
  startSearch(query);
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return;
  if (!shouldApplyChunk(activeRequestId, message)) return;

  if (message.type === MSG.SEARCH_RESULT_CHUNK) {
    groups[message.platform] = {
      status: message.status,
      results: message.results ?? [],
      message: message.message,
      loginUrl: message.loginUrl,
    };
    render();
  } else if (message.type === MSG.SEARCH_PLATFORM_DONE) {
    if (groups[message.platform]) {
      groups[message.platform].status = message.status;
    }
    render();
  }
});

// The popup is now its own small centered window (background/service-worker.js
// opens it via chrome.windows.create), not the toolbar's anchored dropdown, so
// it doesn't get the dropdown's built-in focus behavior for free. It also
// intentionally does NOT close on blur — opening a result via right-click ->
// "Open in new tab" (or just alt-tabbing away) shouldn't lose your results;
// Escape is the explicit way to dismiss it.
input.focus();

window.addEventListener('pagehide', cancelActiveSearch);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close();
});

async function init() {
  const stored = await loadDisabledPlatforms();
  disabledPlatforms = new Set(stored.filter((id) => PLATFORM_ORDER.includes(id)));
  renderSettingsPanel();
  resetGroups('idle');
  render();
}

init();
