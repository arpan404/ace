import { expect, test } from "vitest";
import { prRemote } from "./pr-worktree-resolution.ts";
const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;

test("PR fetches use the selected base repository even when origin points at a fork", () => {
  expect(
    prRemote(
      [
        { name: "origin", fetchUrls: ["git@github.com:contributor/ace.git"] },
        { name: "upstream", fetchUrls: ["https://github.com/octo/ace.git"] },
      ],
      repository,
    ),
  ).toBe("upstream");
  expect(() =>
    prRemote([{ name: "origin", fetchUrls: ["https://github.com/octo/other.git"] }], repository),
  ).toThrow("repository_mismatch");
});
