import { expect, test } from "vitest";
import { hostedReferenceAddress } from "./hosted-reference-address.ts";

const gitlab = { forge: "gitlab", host: "gitlab.example.com", owner: "acme", name: "api" } as const;
const origin = { forge: "origin", host: "origin.cursor.com", owner: "acme", name: "api" } as const;

test.each([
  [origin, "issue", "#7", "https://cursor.com/codebase/acme/api/pull/7"],
  [origin, "issue", "acme/api#7", "https://cursor.com/codebase/acme/api/pull/7"],
  [origin, "issue", "other/repo#7", undefined],
  [origin, "mention", "sam", undefined],
  [gitlab, "issue", "#7", "https://gitlab.example.com/acme/api/-/issues/7"],
  [gitlab, "issue", "other/repo#7", undefined],
  [gitlab, "commit", "abc1234", "https://gitlab.example.com/acme/api/-/commit/abc1234"],
  [gitlab, "mention", "sam", "https://gitlab.example.com/sam"],
  [gitlab, "mention", "..", undefined],
] as const)("%o %s %s links to %s", (repository, kind, target, address) => {
  expect(hostedReferenceAddress({ kind, target }, repository)).toBe(address);
});
