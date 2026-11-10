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

test("repository controls use the matching entry's declaration across case differences", async () => {
  const { repositoryCapabilities } = await import("./forge-capability.ts");
  const repository = { forge: "gitlab" as const, host: "gitlab.com", owner: "ACME", name: "Ace" };
  const source = repositoryCapabilities(repository, [
    {
      repository: { ...repository, owner: "acme", name: "ace" },
      capabilities: ["issues.write"],
    },
  ]);
  expect(can(source, "issues.write")).toBe(true);
  expect(can(source, "reviews.read")).toBe(false);
  expect(can(repositoryCapabilities(repository, []), "reviews.read")).toBe(true);
});
