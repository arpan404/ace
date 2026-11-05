import { expect, test } from "vitest";
import { prUrl } from "./pr-reference.ts";

test("existing GitHub and GitLab review links retain their provider URL", () => {
  expect(
    prUrl({
      repository: { forge: "github", host: "github.com", owner: "team", name: "repo" },
      number: 7,
    }),
  ).toBe("https://github.com/team/repo/pull/7");
  expect(
    prUrl({
      repository: { forge: "gitlab", host: "gitlab.com", owner: "team/subgroup", name: "repo" },
      number: 7,
    }),
  ).toBe("https://gitlab.com/team/subgroup/repo/-/merge_requests/7");
});

test.each(["gitbucket", "bitbucket", "gitea", "forgejo"] as const)(
  "%s is never rendered as a GitLab review link",
  (forge) => {
    expect(() =>
      prUrl({
        repository: { forge, host: "git.example.com", owner: "team", name: "repo" },
        number: 7,
      }),
    ).toThrow("unsupported");
  },
);

test("Cursor Origin review links use the codebase URL rather than the Git transport host", async () => {
  const { prFromUrl } = await import("./pr-reference.ts");
  const ref = {
    repository: {
      forge: "origin" as const,
      host: "origin.cursor.com",
      owner: "team",
      name: "repo",
    },
    number: 7,
  };
  expect(prUrl(ref)).toBe("https://cursor.com/codebase/team/repo/pull/7");
  expect(prFromUrl(prUrl(ref))).toEqual(ref);
});

test("GitLab subgroup links keep their namespace and use the configured host", async () => {
  const { prFromUrl, prRepository } = await import("./pr-reference.ts");
  const fallback = {
    forge: "gitlab" as const,
    host: "git.example.com",
    owner: "team",
    name: "repo",
  };
  expect(prRepository("team/subgroup/repo", fallback)).toEqual({
    ...fallback,
    owner: "team/subgroup",
  });
  expect(
    prFromUrl("https://git.example.com/team/subgroup/repo/-/merge_requests/17", [fallback.host]),
  ).toEqual({ repository: { ...fallback, owner: "team/subgroup" }, number: 17 });
});
