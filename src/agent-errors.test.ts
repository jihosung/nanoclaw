import { describe, expect, it } from 'vitest';

import { parseAgentError, toUserFacingAgentError } from './agent-errors.js';

describe('parseAgentError', () => {
  it('extracts nested provider error messages', () => {
    const parsed = parseAgentError(
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The o4-mini model is not supported."}}',
    );

    expect(parsed).toEqual({
      status: 400,
      type: 'invalid_request_error',
      message: 'The o4-mini model is not supported.',
    });
  });

  it('falls back to the raw string for non-JSON errors', () => {
    expect(parseAgentError('plain failure')).toEqual({
      message: 'plain failure',
    });
  });
});

describe('toUserFacingAgentError', () => {
  it('turns unsupported model errors into actionable Discord text', () => {
    const result = toUserFacingAgentError(
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'o4-mini\' model is not supported when using Codex with a ChatGPT account."}}',
    );

    expect(result).toEqual({
      text:
        "Model error: The 'o4-mini' model is not supported when using Codex with a ChatGPT account.\n" +
        'Use `/model <supported-model>` and resend your message. Example: `/model gpt-5`.',
      suppressRetry: true,
    });
  });

  it('maps generic invalid request errors to a retry-suppressing message', () => {
    const result = toUserFacingAgentError(
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Bad input."}}',
    );

    expect(result).toEqual({
      text:
        'Request error: Bad input.\n' +
        'Fix the request and resend. If this is a model issue, try `/model <supported-model>`.',
      suppressRetry: true,
    });
  });

  it('returns null for transient-looking errors', () => {
    expect(toUserFacingAgentError('ECONNRESET')).toBeNull();
  });
});
