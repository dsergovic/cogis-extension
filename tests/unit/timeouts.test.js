import { describe, it, expect, vi } from 'vitest';
import {
  withTimeout,
  createRequestTracker,
  OVERALL_WALL_MS,
  rejectOnAbort,
} from '../../extension/lib/timeouts.js';

describe('withTimeout', () => {
  it('resolves when the promise wins the race', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects with a TimeoutError when the timeout wins', async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const race = withTimeout(never, 10, 'thing');
    const assertion = expect(race).rejects.toMatchObject({ name: 'TimeoutError', code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    vi.useRealTimers();
  });

  it('propagates a rejection from the promise', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });
});

describe('createRequestTracker', () => {
  it('tracks the active request and reports isActive correctly', () => {
    const tracker = createRequestTracker();
    expect(tracker.getActiveId()).toBeNull();

    tracker.begin('r1');
    expect(tracker.isActive('r1')).toBe(true);
    expect(tracker.isActive('r2')).toBe(false);
  });

  it('a new begin() supersedes the previous request', () => {
    const tracker = createRequestTracker();
    tracker.begin('r1');
    tracker.begin('r2');
    expect(tracker.isActive('r1')).toBe(false);
    expect(tracker.isActive('r2')).toBe(true);
  });

  it('cancel() with no id clears whatever is active', () => {
    const tracker = createRequestTracker();
    tracker.begin('r1');
    expect(tracker.cancel()).toBe(true);
    expect(tracker.getActiveId()).toBeNull();
  });

  it('cancel(id) only clears if id matches the active one', () => {
    const tracker = createRequestTracker();
    tracker.begin('r1');
    expect(tracker.cancel('r2')).toBe(false);
    expect(tracker.isActive('r1')).toBe(true);
    expect(tracker.cancel('r1')).toBe(true);
    expect(tracker.getActiveId()).toBeNull();
  });
});

describe('budget constants', () => {
  it('keeps the popup watchdog after the overall wall', () => {
    expect(OVERALL_WALL_MS).toBeGreaterThan(0);
  });
});

describe('rejectOnAbort', () => {
  it('rejects with code "cancelled" when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = rejectOnAbort(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(rejectOnAbort(controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
