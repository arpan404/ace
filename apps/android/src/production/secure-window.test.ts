import { expect, it } from "vitest";
import { isSecureWindowApplied, isSecureWindowAppliedAsync } from "./secure-window.ts";

it("confirms the native guard only when it reports true", () => {
  expect(isSecureWindowApplied({ secureWindowApplied: () => true })).toBe(true);
  expect(isSecureWindowApplied({ secureWindowApplied: () => false })).toBe(false);
});

it("fails closed when the native entry is missing or throws", () => {
  expect(isSecureWindowApplied({})).toBe(false);
  expect(isSecureWindowApplied(null)).toBe(false);
  expect(isSecureWindowApplied(undefined)).toBe(false);
  expect(
    isSecureWindowApplied({
      secureWindowApplied: () => {
        throw new Error("gone");
      },
    }),
  ).toBe(false);
  expect(isSecureWindowApplied({ secureWindowApplied: "yes" })).toBe(false);
});

it("never claims success for an unsettled native result synchronously", () => {
  expect(isSecureWindowApplied({ secureWindowApplied: () => Promise.resolve(true) })).toBe(false);
  expect(
    isSecureWindowApplied({
      secureWindowApplied: () => ({
        // eslint-disable-next-line unicorn/no-thenable
        then: (onFulfilled: (value: boolean) => void) => onFulfilled(true),
      }),
    }),
  ).toBe(false);
});

it("async helper awaits the native UI-thread read", async () => {
  await expect(
    isSecureWindowAppliedAsync({ secureWindowApplied: () => Promise.resolve(true) }),
  ).resolves.toBe(true);
  await expect(
    isSecureWindowAppliedAsync({ secureWindowApplied: () => Promise.resolve(false) }),
  ).resolves.toBe(false);
  await expect(
    isSecureWindowAppliedAsync({
      secureWindowApplied: () => Promise.reject(new Error("gone")),
    }),
  ).resolves.toBe(false);
});

it("async helper accepts then-only thenables and fails closed otherwise", async () => {
  const thenOnly = {
    // eslint-disable-next-line unicorn/no-thenable
    then(onFulfilled: (value: boolean) => void) {
      onFulfilled(true);
    },
  };
  await expect(isSecureWindowAppliedAsync({ secureWindowApplied: () => thenOnly })).resolves.toBe(
    true,
  );
  await expect(isSecureWindowAppliedAsync({})).resolves.toBe(false);
  await expect(isSecureWindowAppliedAsync(null)).resolves.toBe(false);
  await expect(
    isSecureWindowAppliedAsync({
      secureWindowApplied: () => {
        throw new Error("gone");
      },
    }),
  ).resolves.toBe(false);
});

it("a hung native guard fails closed on timeout and ignores the late settlement", async () => {
  // Deferred real edge: the native UI-thread read never settles. The helper
  // must still present the recoverable failure (false → insecure-window copy
  // with Retry) instead of stalling the opener, and the late settlement must
  // change nothing and leak no unhandled rejection.
  let resolveLate!: (value: boolean) => void;
  const hanging = new Promise<boolean>((resolve) => {
    resolveLate = resolve;
  });
  // Swallow the late settlement branch so no unhandled rejection can escape
  // when the orphan eventually settles after the timeout wins.
  hanging.then(undefined, () => undefined);
  const seen = await isSecureWindowAppliedAsync({ secureWindowApplied: () => hanging }, 10);
  expect(seen).toBe(false);
  resolveLate(true);
  await hanging;
  // Late success after the timeout stays failed-closed: a fresh hung read
  // still times out even after the previous orphan resolved late.
  const stillHanging = new Promise<boolean>(() => undefined);
  stillHanging.then(undefined, () => undefined);
  await expect(
    isSecureWindowAppliedAsync({ secureWindowApplied: () => stillHanging }, 10),
  ).resolves.toBe(false);

  let rejectLate!: (error: unknown) => void;
  const hangingReject = new Promise<boolean>((_, reject) => {
    rejectLate = reject;
  });
  hangingReject.then(undefined, () => undefined);
  const rejected = await isSecureWindowAppliedAsync(
    { secureWindowApplied: () => hangingReject },
    10,
  );
  expect(rejected).toBe(false);
  rejectLate(new Error("late gone"));
  await Promise.resolve();
  await Promise.resolve();
});
