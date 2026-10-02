/**
 * Host page for lib/hidden-frame.js: one iframe per lab, opened and closed
 * on request from the service worker. Desktop-sized so labs render their
 * desktop layout (Muse's search button only exists there). This page never
 * reads anything from the frames; the lab's content script talks to the
 * service worker directly over a port.
 */

const OFFSCREEN_TARGET = 'cogis-offscreen';
const ALLOWED_ORIGINS = [
  'https://www.perplexity.ai',
  'https://gemini.google.com',
  'https://muse.ai',
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== OFFSCREEN_TARGET) return false;
  const id = `cogis-frame-${message.lab}`;
  document.getElementById(id)?.remove();

  if (message.type === 'open') {
    let origin = '';
    try {
      origin = new URL(message.url).origin;
    } catch {
      // fall through to the rejection below
    }
    if (!ALLOWED_ORIGINS.includes(origin)) {
      sendResponse({ ok: false });
      return false;
    }
    const frame = document.createElement('iframe');
    frame.id = id;
    frame.src = message.url;
    frame.style.width = '1280px';
    frame.style.height = '800px';
    frame.style.border = '0';
    document.body.appendChild(frame);
  }
  sendResponse({ ok: true });
  return false;
});
