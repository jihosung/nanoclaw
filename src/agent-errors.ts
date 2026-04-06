export interface ParsedAgentError {
  status?: number;
  type?: string;
  message: string;
}

export interface UserFacingAgentError {
  text: string;
  suppressRetry: boolean;
}

interface StructuredAgentError {
  type?: string;
  status?: number;
  error?: {
    type?: string;
    message?: string;
  };
  message?: string;
}

export function parseAgentError(raw: string): ParsedAgentError {
  try {
    const parsed = JSON.parse(raw) as StructuredAgentError;
    return {
      status: parsed.status,
      type: parsed.error?.type || parsed.type,
      message: parsed.error?.message || parsed.message || raw,
    };
  } catch {
    return { message: raw };
  }
}

export function toUserFacingAgentError(
  raw: string,
): UserFacingAgentError | null {
  const parsed = parseAgentError(raw);
  const message = parsed.message.trim();

  if (
    /not supported when using Codex with a ChatGPT account/i.test(message) ||
    /model .* not supported/i.test(message)
  ) {
    return {
      text:
        `Model error: ${message}\n` +
        'Use `/model <supported-model>` and resend your message. Example: `/model gpt-5`.',
      suppressRetry: true,
    };
  }

  if (
    parsed.type === 'invalid_request_error' ||
    parsed.status === 400 ||
    /invalid_request_error/i.test(raw)
  ) {
    return {
      text:
        `Request error: ${message}\n` +
        'Fix the request and resend. If this is a model issue, try `/model <supported-model>`.',
      suppressRetry: true,
    };
  }

  return null;
}
