import { expect, test } from "vitest";
import { accountBadge } from "./account-badge.ts";

test("account marks use initials and bound longer legacy values to two letters", () => {
  expect(accountBadge("Personal")).toBe("P");
  expect(accountBadge("Your CLI login")).toBe("Y");
  expect(accountBadge("Work", "ABC")).toBe("AB");
});

test("a stored emoji badge falls back to the account's initial", () => {
  expect(accountBadge("Work", "💼")).toBe("W");
  expect(accountBadge("Home", "🏠")).toBe("H");
});
