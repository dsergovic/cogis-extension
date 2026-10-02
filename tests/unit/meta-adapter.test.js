import { describe, it, expect } from 'vitest';
import { searchMeta } from '../../extension/lib/meta-adapter.js';
import { PLATFORMS, PLATFORM_ORDER } from '../../extension/lib/platforms.js';

describe('Meta AI placeholder', () => {
  it('is registered but stays out of the popup until its contract is verified', () => {
    expect(PLATFORMS.meta?.label).toBe('Meta AI');
    expect(PLATFORM_ORDER).not.toContain('meta');
  });

  it('reports unavailable without touching the network', async () => {
    const outcome = await searchMeta('anything');
    expect(outcome.status).toBe('unavailable');
    expect(outcome.results).toBeUndefined();
  });
});
