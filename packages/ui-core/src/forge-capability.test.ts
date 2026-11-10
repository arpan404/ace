import { expect, test } from "vitest";
import { can } from "./forge-capability.ts";

test("older daemons keep GitHub controls and other hosts' review reads", () => {
  expect(can({ forge: "github" }, "reviews.merge")).toBe(true);
  expect(can({ forge: "gitlab" }, "reviews.files")).toBe(true);
  expect(can({ forge: "gitlab" }, "reviews.comments.write")).toBe(false);
  expect(can({ forge: "origin" }, "issues.read")).toBe(false);
});

test("explicit capabilities enable host controls and can withdraw GitHub controls", () => {
  expect(
    can(
      { repository: { forge: "gitlab" }, capabilities: ["reviews.comments.write"] },
      "reviews.comments.write",
    ),
  ).toBe(true);
  expect(can({ forge: "github", capabilities: [] }, "reviews.merge")).toBe(false);
  expect(
    can(
      { status: { ref: { repository: { forge: "gitlab" } } }, capabilities: ["reviews.checks"] },
      "reviews.checks",
    ),
  ).toBe(true);
  expect(can(undefined, "reviews.read")).toBe(false);
});
