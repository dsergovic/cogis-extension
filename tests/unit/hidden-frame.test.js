import { describe, it, expect, beforeEach, vi } from 'vitest';

function fakeChrome({ connectFrame = true, reply = { status: 'ok' } } = {}) {
  const session = {};
  const connectListeners = [];
  const chrome = {
    storage: {
      session: {
        get: vi.fn(async (key) => ({ [key]: session[key] })),
        set: vi.fn(async (obj) => Object.assign(session, obj)),
      },
    },
    tabs: { TAB_ID_NONE: -1 },
    declarativeNetRequest: { updateSessionRules: vi.fn(async () => {}) },
    offscreen: { createDocument: vi.fn(async () => {}) },
    runtime: {
      getURL: (p) => `chrome-extension://id/${p}`,
      getContexts: vi.fn(async () => []),
      onConnect: { addListener: (fn) => connectListeners.push(fn) },
      sendMessage: vi.fn(async (msg) => {
        if (msg.type !== 'open' || !connectFrame) return;
        const msgListeners = [];
        const port = {
          name: `cogis-frame:${msg.lab}`,
          sender: {},
          onMessage: { addListener: (fn) => msgListeners.push(fn) },
          onDisconnect: { addListener: () => {} },
          postMessage: () =>
            Promise.resolve().then(() => msgListeners.forEach((fn) => fn({ response: reply }))),
          disconnect: () => {},
        };
        Promise.resolve().then(() => connectListeners.forEach((fn) => fn(port)));
      }),
    },
  };
  return { chrome, session };
}

const opts = (overrides = {}) => ({
  lab: 'muse',
  url: 'https://muse.ai/',
  domains: ['muse.ai'],
  message: { type: 'COGIS_MUSE_TAB_SEARCH', query: 'x' },
  looksLoggedOut: (r) => r.status !== 'ok',
  ...overrides,
});

describe('tryHiddenFrame', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns the frame response and strips frame headers only for tab-less sub_frames', async () => {
    const { chrome } = fakeChrome({ reply: { status: 'ok', items: [] } });
    globalThis.chrome = chrome;
    const { tryHiddenFrame } = await import('../../extension/lib/hidden-frame.js');
    expect(await tryHiddenFrame(opts())).toEqual({ status: 'ok', items: [] });
    const rule = chrome.declarativeNetRequest.updateSessionRules.mock.calls[0][0].addRules[0];
    expect(rule.condition).toEqual({
      requestDomains: ['muse.ai'],
      resourceTypes: ['sub_frame'],
      tabIds: [-1],
    });
    expect(chrome.offscreen.createDocument).toHaveBeenCalledOnce();
  });

  it('falls back and remembers the lab when the frame comes up logged out', async () => {
    const { chrome, session } = fakeChrome({ reply: { status: 'login_required' } });
    globalThis.chrome = chrome;
    const { tryHiddenFrame } = await import('../../extension/lib/hidden-frame.js');
    expect(await tryHiddenFrame(opts())).toBeNull();
    expect(session.cogisHiddenFrameFailedLabs).toEqual(['muse']);

    chrome.runtime.sendMessage.mockClear();
    expect(await tryHiddenFrame(opts())).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back when the frame never connects', async () => {
    vi.useFakeTimers();
    const { chrome, session } = fakeChrome({ connectFrame: false });
    globalThis.chrome = chrome;
    const { tryHiddenFrame } = await import('../../extension/lib/hidden-frame.js');
    const pending = tryHiddenFrame(opts());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toBeNull();
    expect(session.cogisHiddenFrameFailedLabs).toEqual(['muse']);
    vi.useRealTimers();
  });
});
