import { expect, it } from "vitest";
import { isSecureWindowApplied } from "./secure-window.ts";

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
