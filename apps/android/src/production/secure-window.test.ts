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
