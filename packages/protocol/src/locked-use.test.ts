import { expect, test } from "vitest";
import { ClientMessage, ServerMessage } from "./wire.ts";

test("a status from a newer daemon keeps fields this client doesn't know", () => {
  const message = ServerMessage.parse({
    type: "lockedUse.changed",
    subscriptionId: "mac",
    revision: 3,
    status: { state: "installFailed", reason: "Signature mismatch", detail: { code: 7 } },
    extra: true,
  });
  expect(message).toEqual({
    type: "lockedUse.changed",
    subscriptionId: "mac",
    revision: 3,
    status: { state: "installFailed", reason: "Signature mismatch", detail: { code: 7 } },
  });
});

test("requests with fields this daemon doesn't know still decode", () => {
  expect(
    ClientMessage.parse({ type: "lockedUse.install", requestId: "install", reason: "later" }),
  ).toEqual({ type: "lockedUse.install", requestId: "install" });
});

test("a failed state without its reason is rejected", () => {
  expect(
    ServerMessage.safeParse({
      type: "lockedUse.result",
      requestId: "repair",
      ok: false,
      status: { state: "driftRepairNeeded" },
    }).success,
  ).toBe(false);
});

test("a pushed change without its revision is rejected, so it can't be ordered wrongly", () => {
  expect(
    ServerMessage.safeParse({
      type: "lockedUse.changed",
      subscriptionId: "mac",
      status: { state: "on" },
    }).success,
  ).toBe(false);
});
