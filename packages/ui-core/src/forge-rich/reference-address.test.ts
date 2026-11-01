import { expect, test } from "vitest";
import { forgeReferenceAddress } from "./reference-address.ts";

const repository = { host: "github.example.com", owner: "acme", name: "ace" };
const sha = "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";

test.each([
  ["issue", "#231", "https://github.example.com/acme/ace/issues/231"],
  ["issue", "acme/billing-api#74", "https://github.example.com/acme/billing-api/issues/74"],
  ["commit", sha, `https://github.example.com/acme/ace/commit/${sha}`],
  ["commit", "octo/tools@4f2a9c1", "https://github.example.com/octo/tools/commit/4f2a9c1"],
  ["mention", "octocat", "https://github.example.com/octocat"],
  ["mention", "github/docs", "https://github.example.com/orgs/github/teams/docs"],
])("a %s reference %s points at its page on the repository's host", (kind, target, address) => {
  expect(forgeReferenceAddress({ kind, target }, repository)).toBe(address);
});

test("without a repository, only references that name their own point anywhere", () => {
  expect(forgeReferenceAddress({ kind: "issue", target: "#231" }, undefined)).toBeUndefined();
  expect(forgeReferenceAddress({ kind: "commit", target: sha }, undefined)).toBeUndefined();
  expect(forgeReferenceAddress({ kind: "issue", target: "acme/ace#2" }, undefined)).toBe(
    "https://github.com/acme/ace/issues/2",
  );
  expect(forgeReferenceAddress({ kind: "mention", target: "octocat" }, undefined)).toBe(
    "https://github.com/octocat",
  );
});

test("references that aren't forge references, or carry odd targets, point nowhere", () => {
  expect(forgeReferenceAddress({ kind: "file", target: "src/a.ts" }, repository)).toBeUndefined();
  expect(forgeReferenceAddress({ kind: "issue", target: "#x" }, repository)).toBeUndefined();
  expect(forgeReferenceAddress({ kind: "mention", target: "a/b/c" }, repository)).toBeUndefined();
  expect(forgeReferenceAddress({ kind: "mention", target: "../x" }, repository)).toBeUndefined();
});
