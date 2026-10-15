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

test("Work on PR on a configured Enterprise host resolves the PR remote", () => {
  const enterprise = { ...repository, host: "git.example.com" };
  expect(
    prRemote(
      [
        { name: "origin", fetchUrls: ["https://github.com/octo/ace.git"] },
        { name: "work", fetchUrls: ["git@git.example.com:octo/ace.git"] },
      ],
      enterprise,
    ),
  ).toBe("work");
});

test("a PR remote behind an SSH host alias matches its real host", () => {
  expect(
    prRemote([{ name: "origin", fetchUrls: ["git@github-work:octo/ace.git"] }], repository, {
      "github-work": "github.com",
    }),
  ).toBe("origin");
});
