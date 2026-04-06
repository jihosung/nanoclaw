import { describe, expect, it } from 'vitest';

import { formatRateLimitsMessage } from './codex-account.js';

describe('formatRateLimitsMessage', () => {
  it('formats primary as 5h and secondary as 7d using unix reset timestamps', () => {
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-04-07T00:00:00Z');

    const text = formatRateLimitsMessage({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: {
            usedPercent: 82,
            windowDurationMins: 15,
            resetsAt: Math.floor(Date.parse('2026-04-07T05:12:00Z') / 1000),
          },
          secondary: {
            usedPercent: 72,
            windowDurationMins: 60,
            resetsAt: Math.floor(Date.parse('2026-04-12T18:00:00Z') / 1000),
          },
        },
      },
    });

    Date.now = realNow;

    expect(text).toBe(
      'Codex account usage:\n' +
        'Primary (15m)[████████░░] 82% | resets in 5h 12m (14:12)\n' +
        'Secondary (1h)[███████░░░] 72% | resets in 5d 18h (03:00 in 04/13(Mon))',
    );
  });

  it('handles missing secondary and missing reset time clearly', () => {
    const text = formatRateLimitsMessage({
      rateLimits: {
        limitId: 'codex',
        primary: {
          usedPercent: 14,
          windowDurationMins: 15,
        },
        secondary: null,
      },
    });

    expect(text).toBe(
      'Codex account usage:\n' +
        'Primary (15m)[█░░░░░░░░░] 14% | resets in reset time unavailable\n' +
        'Secondary: unavailable | resets in reset time unavailable',
    );
  });
});
