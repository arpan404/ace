import { describe, expect, it } from "vitest";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "./Errors.ts";
import {
  buildRuntimeErrorPayload,
  buildRuntimeWarningPayload,
  inferRuntimeErrorClassFromCause,
} from "./runtimeEventPayloads.ts";

describe("runtimeEventPayloads", () => {
  it("maps adapter validation failures to validation_error", () => {
    const cause = new ProviderAdapterValidationError({
      provider: "cursor",
      operation: "sendTurn",
      issue: "bad input",
    });

    expect(inferRuntimeErrorClassFromCause(cause)).toBe("validation_error");
    expect(
      buildRuntimeErrorPayload({
        message: "Validation failed",
        cause,
      }),
    ).toMatchObject({
      message: "Validation failed",
      class: "validation_error",
      detail: cause,
    });
  });

  it("maps provider-owned adapter failures to provider_error", () => {
    const causes = [
      new ProviderAdapterSessionNotFoundError({
        provider: "gemini",
        threadId: "thread-1",
      }),
      new ProviderAdapterSessionClosedError({
        provider: "gemini",
        threadId: "thread-1",
      }),
      new ProviderAdapterRequestError({
        provider: "gemini",
        method: "session/prompt",
        detail: "prompt failed",
      }),
      new ProviderAdapterProcessError({
        provider: "gemini",
        threadId: "thread-1",
        detail: "process died",
      }),
    ];

    for (const cause of causes) {
      expect(inferRuntimeErrorClassFromCause(cause)).toBe("provider_error");
    }
  });

  it("preserves explicit classes for transport errors", () => {
    const cause = new Error("socket closed");
    expect(
      buildRuntimeErrorPayload({
        message: "Transport failed",
        cause,
        class: "transport_error",
      }),
    ).toMatchObject({
      message: "Transport failed",
      class: "transport_error",
      detail: cause,
    });
  });

  it("builds warnings without classes", () => {
    expect(buildRuntimeWarningPayload("Heads up", { retry: true })).toEqual({
      message: "Heads up",
      detail: { retry: true },
    });
  });
});
