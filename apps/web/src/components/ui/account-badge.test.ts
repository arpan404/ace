import { expect, test } from "vitest";
import { accountBadge } from "./account-badge.ts";

test("account marks use initials and bound legacy values without splitting emoji", () => {
  expect(accountBadge("Personal")).toBe("P");
  expect(accountBadge("Your CLI login")).toBe("YC");
  expect(accountBadge("Work", "ABC")).toBe("AB");
  expect(accountBadge("Work", "👩‍💻")).toBe("👩‍💻");
  expect(accountBadge("Work", "🇺🇸")).toBe("🇺🇸");
});
