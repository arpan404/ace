// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { requestFailure } from "./native-session.ts";

/** A failure's mapped fields, as `CursorHost.request`'s catch sets them (`host.ts:215`). */
const fields = (error: Error) =>
  error as Error & { code?: string; detail?: string; refused?: boolean };

it("a refused reply keeps the refusal mark and the script's prose", () => {
  const mapped = requestFailure("send", new Error('{"code":-32603,"data":{"refused":true}}'), {});
  expect(mapped.message).toBe(
    "Cursor SDK send failed; delivery may be uncertain. Inspect history before resending.",
  );
  expect(fields(mapped).code).toBe("discovery_failed");
  expect(fields(mapped).refused).toBe(true);
});

it("the host's last prose prefixes open, send and cancel only", () => {
  const state = { errorMessage: "rate limited" };
  expect(requestFailure("open", new Error("x"), state).message).toBe(
    "rate limited Cursor SDK open failed; delivery may be uncertain. Inspect history before resending.",
  );
  expect(requestFailure("configure", new Error("x"), state).message).toBe(
    "Cursor SDK configure failed; delivery may be uncertain. Inspect history before resending.",
  );
});

it("a closed pipe names the exit and the metadata's last detail", () => {
  const mapped = requestFailure("models", new Error("EOF"), {
    exit: { code: 1, reason: "exit" },
    metadataFailureDetail: "boom",
  });
  expect(fields(mapped).code).toBe("discovery_failed");
  expect(fields(mapped).detail).toBe("Cursor SDK host ended with code 1 (exit). boom");
});

it("a spawn error is not_configured and carries no detail", () => {
  const mapped = requestFailure("models", new Error("EOF"), {
    exit: { code: null, reason: "spawn-error" },
  });
  expect(fields(mapped).code).toBe("not_configured");
  expect(fields(mapped).detail).toBeUndefined();
});

it("the metadata's code wins over the fallback", () => {
  const mapped = requestFailure("models", new Error("x"), {
    metadataFailureCode: "auth_expired",
  });
  expect(fields(mapped).code).toBe("auth_expired");
  expect(fields(mapped).detail).toBeUndefined();
});
