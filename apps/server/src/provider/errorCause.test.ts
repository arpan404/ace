import assert from "node:assert";
import { describe, it } from "vitest";

import { describeCursorAdapterCause } from "./Layers/CursorAdapterErrors.ts";
import { meaningfulErrorMessage, pickErrorLikeMessageFromUnknown } from "./errorCause.ts";

describe("pickErrorLikeMessageFromUnknown", () => {
  it("reads nested error.message before top-level message", () => {
    assert.strictEqual(
      pickErrorLikeMessageFromUnknown({
        message: "outer",
        error: { message: "inner failure" },
      }),
      "inner failure",
    );
  });

  it("falls back to top-level message when nested has none", () => {
    assert.strictEqual(
      pickErrorLikeMessageFromUnknown({
        message: "Rate limited",
        error: {},
      }),
      "Rate limited",
    );
  });

  it("ignores Error instances", () => {
    assert.strictEqual(pickErrorLikeMessageFromUnknown(new Error("x")), undefined);
  });
});

describe("meaningfulErrorMessage", () => {
  it("unwraps Effect.try wrapper messages in the Error chain", () => {
    const inner = new Error("CLI refused connection");
    const outer = new Error("An error occurred in Effect.tryPromise", { cause: inner });
    assert.strictEqual(meaningfulErrorMessage(outer, "fallback"), "CLI refused connection");
  });

  it("uses JSON-style payloads when no Error is involved", () => {
    assert.strictEqual(
      meaningfulErrorMessage({ error: { message: "token expired" } }, "fallback"),
      "token expired",
    );
  });

  it("returns fallback for empty payloads", () => {
    assert.strictEqual(meaningfulErrorMessage({}, "none"), "none");
  });
});

describe("describeCursorAdapterCause", () => {
  it("uses nested messages like meaningfulErrorMessage", () => {
    assert.strictEqual(
      describeCursorAdapterCause({ error: { message: "rpc failed" } }),
      "rpc failed",
    );
  });

  it("normalizes null and undefined", () => {
    assert.strictEqual(describeCursorAdapterCause(undefined), "An unexpected error occurred.");
    assert.strictEqual(describeCursorAdapterCause(null), "An unexpected error occurred.");
  });
});
