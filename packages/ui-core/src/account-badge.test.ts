import { expect, test } from "vitest";
import { accountBadge, accountBadgePreview } from "./account-badge.ts";

test("account marks use initials and bound longer legacy values to two letters", () => {
  expect(accountBadge("Personal")).toBe("P");
  expect(accountBadge("Your CLI login")).toBe("Y");
  expect(accountBadge("Work", "ABC")).toBe("AB");
});

test("a stored emoji badge falls back to the account's initial", () => {
  expect(accountBadge("Work", "💼")).toBe("W");
  expect(accountBadge("Home", "🏠")).toBe("H");
});

test("the badge preview follows each edit and says what the save sends", () => {
  expect(accountBadgePreview({ label: "Work", shortLabel: "" })).toEqual({
    text: "W",
    icon: null,
    color: "neutral",
    problem: null,
    save: { shortLabel: undefined, badgeUsesInitial: true, badgeColor: "neutral", badgeIcon: null },
  });
  expect(
    accountBadgePreview({ label: "Work", shortLabel: " wk ", color: "blue", icon: "rocket" }),
  ).toMatchObject({
    text: "wk",
    icon: "rocket",
    color: "blue",
    save: { shortLabel: "wk", badgeUsesInitial: false, badgeColor: "blue", badgeIcon: "rocket" },
  });
});

test("a badge that can't be saved shows a question mark and says why", () => {
  for (const shortLabel of ["ABC", "💼", "a b"])
    expect(accountBadgePreview({ label: "Work", shortLabel })).toMatchObject({
      text: "?",
      problem: "Use up to two letters, or pick an icon.",
    });
});
