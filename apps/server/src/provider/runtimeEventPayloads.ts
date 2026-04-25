import type { RuntimeErrorClass, RuntimeErrorPayload, RuntimeWarningPayload } from "@ace/contracts";
import { Schema } from "effect";

import { meaningfulErrorMessage } from "./errorCause.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "./Errors.ts";

const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isProviderAdapterSessionClosedError = Schema.is(ProviderAdapterSessionClosedError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);

function nextCause(value: unknown): unknown | undefined {
  if (!value || typeof value !== "object" || !("cause" in value)) {
    return undefined;
  }
  const cause = (value as { readonly cause?: unknown }).cause;
  return cause === value ? undefined : cause;
}

function causeChain(cause: unknown): ReadonlyArray<unknown> {
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

export function inferRuntimeErrorClassFromCause(
  cause: unknown,
  fallback: RuntimeErrorClass = "unknown",
): RuntimeErrorClass {
  for (const candidate of causeChain(cause)) {
    if (isProviderAdapterValidationError(candidate)) {
      return "validation_error";
    }
    if (
      isProviderAdapterSessionNotFoundError(candidate) ||
      isProviderAdapterSessionClosedError(candidate) ||
      isProviderAdapterRequestError(candidate) ||
      isProviderAdapterProcessError(candidate)
    ) {
      return "provider_error";
    }
  }
  return fallback;
}

export function buildRuntimeErrorPayload(input: {
  readonly message: string;
  readonly cause?: unknown;
  readonly detail?: unknown;
  readonly class?: RuntimeErrorClass;
  readonly fallbackClass?: RuntimeErrorClass;
}): RuntimeErrorPayload {
  return {
    message: input.message,
    class:
      input.class ?? inferRuntimeErrorClassFromCause(input.cause, input.fallbackClass ?? "unknown"),
    ...((input.detail ?? input.cause) !== undefined ? { detail: input.detail ?? input.cause } : {}),
  };
}

export function buildRuntimeWarningPayload(
  message: string,
  detail?: unknown,
): RuntimeWarningPayload {
  return {
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}

export function describeRuntimeCause(cause: unknown, fallback: string): string {
  return meaningfulErrorMessage(cause, fallback);
}
