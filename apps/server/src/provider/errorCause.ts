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

export function meaningfulErrorMessage(cause: unknown, fallback: string): string {
  for (const candidate of causeChain(cause)) {
    if (!(candidate instanceof Error)) {
      continue;
    }

    const message = candidate.message.trim();
    if (
      message.length > 0 &&
      message !== "An error occurred in Effect.try" &&
      message !== "An error occurred in Effect.tryPromise"
    ) {
      return message;
    }
  }

  return fallback;
}
