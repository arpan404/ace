function nextCause(value: unknown): unknown | undefined {
  if (!value || typeof value !== "object" || !("cause" in value)) {
    return undefined;
  }

  const cause = (value as { cause?: unknown }).cause;
  return cause === value ? undefined : cause;
}

export function causeChain(cause: unknown): ReadonlyArray<unknown> {
  const chain: Array<unknown> = [];
  let current: unknown = cause;
  let depth = 0;

  while (current !== undefined && depth < 8) {
    chain.push(current);
    current = nextCause(current);
    depth += 1;
  }

  return chain;
}

const EFFECT_TRY_WRAPPER_MESSAGES = new Set([
  "An error occurred in Effect.try",
  "An error occurred in Effect.tryPromise",
]);

/**
 * JSON/API-style error payloads (`{ message }`, `{ error: { message } }`) are common in
 * provider SDK event data. Do not treat `Error` instances here — leave those to {@link causeChain}.
 */
export function pickErrorLikeMessageFromUnknown(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value instanceof Error) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nested = record.error;
  if (nested !== undefined && nested !== value) {
    const fromNested = pickErrorLikeMessageFromUnknown(nested, depth + 1);
    if (fromNested) {
      return fromNested;
    }
  }
  const direct = record.message;
  if (typeof direct === "string") {
    const trimmed = direct.trim();
    if (trimmed.length > 0 && !EFFECT_TRY_WRAPPER_MESSAGES.has(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

export function meaningfulErrorMessage(cause: unknown, fallback: string): string {
  const fromPayload = pickErrorLikeMessageFromUnknown(cause);
  if (fromPayload) {
    return fromPayload;
  }

  for (const candidate of causeChain(cause)) {
    if (!(candidate instanceof Error)) {
      continue;
    }

    const message = candidate.message.trim();
    if (message.length > 0 && !EFFECT_TRY_WRAPPER_MESSAGES.has(message)) {
      return message;
    }
  }

  return fallback;
}
