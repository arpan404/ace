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

test.each(["gitbucket", "bitbucket"] as const)(
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

test.each(["gitea", "forgejo"] as const)(
  "%s review links use the host's own pulls path, never GitLab's",
  (forge) => {
    expect(
      prUrl({
        repository: { forge, host: "git.example.com", owner: "team", name: "repo" },
        number: 7,
      }),
    ).toBe("https://git.example.com/team/repo/pulls/7");
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

test("an address reads by its host's provider, not by its path shape", async () => {
  const { prFromUrl } = await import("./pr-reference.ts");
  // gitlab.com is GitLab: a /pull/ path there is not a GitHub pull request.
  expect(() => prFromUrl("https://gitlab.com/team/repo/pull/7")).toThrow("invalid_data");
  // A configured GitHub Enterprise host never turns a merge request path into GitLab.
  expect(() =>
    prFromUrl("https://ghe.example.com/team/repo/-/merge_requests/7", [
      { host: "ghe.example.com", forge: "github" },
    ]),
  ).toThrow("invalid_data");
  // A host saved without a provider before providers existed keeps reading as GitHub.
  expect(
    prFromUrl("https://ghe.example.com/team/repo/pull/7", [{ host: "ghe.example.com" }]),
  ).toEqual({
    repository: { forge: "github", host: "ghe.example.com", owner: "team", name: "repo" },
    number: 7,
  });
  // gitlab.com saved without a provider is GitLab.
  expect(
    prFromUrl("https://gitlab.com/group/sub/repo/-/merge_requests/3", [{ host: "gitlab.com" }]),
  ).toEqual({
    repository: { forge: "gitlab", host: "gitlab.com", owner: "group/sub", name: "repo" },
    number: 3,
  });
  expect(() => prFromUrl("https://unlisted.example.com/team/repo/pull/7")).toThrow("invalid_data");
});

test("a cross-host repository takes that host's provider", async () => {
  const { prRepository } = await import("./pr-reference.ts");
  const fallback = { forge: "github" as const, host: "github.com", owner: "a", name: "b" };
  expect(prRepository("gitlab.com/team/repo", fallback)).toEqual({
    forge: "gitlab",
    host: "gitlab.com",
    owner: "team",
    name: "repo",
  });
  expect(
    prRepository("git.example.com/team/repo", fallback, [
      { host: "git.example.com", forge: "gitlab" },
    ]),
  ).toEqual({ forge: "gitlab", host: "git.example.com", owner: "team", name: "repo" });
  expect(() => prRepository("unknown.example.com/team/repo", fallback)).toThrow("invalid_data");
});
